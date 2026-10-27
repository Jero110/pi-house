// /workflow digest and /workflow self-learning, wired to the agent-link hub and pi's model registry. The session that
// asks gets code-computed status lines and artifact paths: no digest text and no model turn. Every model call happens
// in a child agent this module spawns through the hub, one per job.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type HubClient, identityFromEnv } from "agent-link-core";
import {
	activateLearningStore,
	executeDigest,
	produceDigestCandidates,
	type RuntimeOptions,
} from "./learning-runtime.ts";
import { runtimePorts } from "./runtime-ports.ts";
import { type OperationalStore, openOperationalStore } from "./storage.ts";
import { nativeWorkerAdapter, type WorkerJob, type WorkerResult } from "./worker-adapter.ts";

/** The model every learning child runs, as pi's `provider/model-id`. Overridden by this environment variable only. */
export const LEARNING_MODEL_ENV = "PIHOUSE_LEARNING_MODEL";
const DEFAULT_LEARNING_MODEL = "openai-codex/gpt-6-luna";

/**
 * Bounds on the work one invocation starts. Problem: a single command could launch one child per run in the store,
 * each a model call. Example: forty eligible runs and a command that digests them all at once. Solution: two digest
 * jobs per invocation, a ten-minute cap per child, and a lease that outlives that cap; the rest wait for the next call.
 */
const DIGEST_JOBS_PER_INVOCATION = 2;
const WORKER_TIMEOUT_MS = 600_000;
const LEASE_MS = WORKER_TIMEOUT_MS + 60_000;

const NO_HUB =
	"/workflow digest and /workflow self-learning need the agent-link hub: run them from a pihouse session started through pih. Nothing was started.";

export interface LearningDeps {
	/** The workflow memory folder: the store, its operational database and its digests. */
	memory: string;
	/** The agent-link journal folder (`<agent-link home>/sessions`). */
	journalDir: string;
	/** The environment the session runs with: the agent-link identity and the learning model setting. */
	env: NodeJS.ProcessEnv;
	/** The folder the session works in; children start there. */
	cwd: string;
	/** The pane backend from pihouse's config; undefined when pihouse was never set up. */
	backend: "cmux" | "tmux" | undefined;
	/** Whether a model id resolves in pi's registry with configured auth. */
	modelAvailable: (model: string) => boolean;
	/** Progress while the work runs; the caller shows it with ctx.ui.notify. */
	progress: (text: string) => void;
	/** Test seams: the hub client, the store's runtime ports and the clock and waits of the worker adapter. */
	client?: HubClient;
	ports?: Pick<RuntimeOptions, "operationalState" | "currentFingerprint">;
	now?: () => number;
	pollMs?: number;
	timeoutMs?: number;
	wait?: (ms: number) => Promise<void>;
}

export interface LearningOutcome {
	level: "info" | "warning";
	text: string;
}

/**
 * The model the children run. Problem: a hard-coded name goes stale when the provider renames a model, and a silent
 * fallback to another model spends quota the user did not choose. Example: a blank or mistyped setting. Solution: the
 * setting is the only source; a blank value means the default, and an unresolvable one stops the command.
 */
export function learningModel(env: NodeJS.ProcessEnv): string {
	return env[LEARNING_MODEL_ENV]?.trim() || DEFAULT_LEARNING_MODEL;
}

type Ready = { ok: true; model: string; worker: (job: WorkerJob) => Promise<WorkerResult> };

/**
 * Every check that must pass before anything starts: the hub identity, the configured model and the pane backend.
 * Problem: a check after the first spawn would leave a child running for a command that then reports failure.
 * Example: a model that does not resolve found only after a worker opened its pane. Solution: all checks run first.
 */
function gate(deps: LearningDeps): Ready | LearningOutcome {
	if (!identityFromEnv(deps.env)) return { level: "warning", text: NO_HUB };
	const model = learningModel(deps.env);
	if (!deps.modelAvailable(model))
		return {
			level: "warning",
			text: `Model ${model} is not available with configured auth. Set ${LEARNING_MODEL_ENV} to a configured model or sign in to its provider. Nothing was started.`,
		};
	if (!deps.backend)
		return {
			level: "warning",
			text: "No pane backend is configured (cmux or tmux): run pih setup first. Nothing was started.",
		};
	const worker = nativeWorkerAdapter({
		env: deps.env,
		client: deps.client,
		cwd: deps.cwd,
		backend: deps.backend,
		journalDir: deps.journalDir,
		model,
		timeoutMs: deps.timeoutMs ?? WORKER_TIMEOUT_MS,
		pollMs: deps.pollMs,
		now: deps.now,
		wait: deps.wait,
	});
	return worker ? { ok: true, model, worker } : { level: "warning", text: NO_HUB };
}

interface DigestSummary {
	generated: string[];
	cleaned: number;
	cleanupPending: number;
	failed: number;
	deferred: string[];
	notStarted: number;
}

/**
 * The digest step: produce the eligible candidates, run one isolated child per job, commit, then clean up.
 * Problem: a failed or deferred run must not stop the others, and a retry must not repeat the model call.
 * Example: run A's child fails, run B digests; run A is retried by the next invocation only.
 * Solution: the runtime's per-job results are counted here by code; nothing is re-run inside this call.
 */
async function digestStep(deps: LearningDeps, ready: Ready): Promise<DigestSummary> {
	activateLearningStore(deps.memory);
	const store: OperationalStore = openOperationalStore(join(deps.memory, "memory.sqlite"), {
		fts: false,
		legacy: true,
	});
	const summary: DigestSummary = {
		generated: [],
		cleaned: 0,
		cleanupPending: 0,
		failed: 0,
		deferred: [],
		notStarted: 0,
	};
	try {
		const ports = deps.ports ?? runtimePorts({ storeDir: deps.memory, journalDir: deps.journalDir });
		const options: RuntimeOptions = { storeDir: deps.memory, db: store.db, ownedRoot: deps.memory, ...ports };
		const produced = produceDigestCandidates(options);
		summary.deferred.push(...produced.deferred.map((entry) => entry.reason));
		if (produced.candidates.length === 0) return summary;

		const digestRoot = join(deps.memory, "digests");
		const total = Math.min(produced.candidates.length, DIGEST_JOBS_PER_INVOCATION);
		let started = 0;
		const results = await executeDigest(
			{
				...options,
				digestRoot,
				outputPath: (candidate) => join(digestRoot, ".attempts", `${candidate.revision}.md`),
				cwd: deps.cwd,
				invocation: randomUUID(),
				now: deps.now ?? Date.now,
				leaseMs: LEASE_MS,
				maxJobs: DIGEST_JOBS_PER_INVOCATION,
				worker: async (job) => {
					started++;
					deps.progress(`Digest ${started} of ${total}: ${job.revision} with ${ready.model}.`);
					return ready.worker(job);
				},
			},
			produced.candidates,
		);
		summary.notStarted = produced.candidates.length - results.length;
		for (const result of results) {
			if (result.path) summary.generated.push(result.path);
			if (result.status === "cleaned") summary.cleaned++;
			else if (result.path) summary.cleanupPending++;
			else if (result.status === "deferred")
				summary.deferred.push("source changed or run became active during the digest");
			else summary.failed++;
		}
		return summary;
	} finally {
		store.close();
	}
}

/**
 * The status the session sees. Problem: a long list of digest paths, reasons and counts is easy to misread as a
 * summary the model wrote. Example: a reader who takes "deferred" for a failure. Solution: one count line, then the
 * paths, then each deferral reason once with its count.
 */
function digestText(summary: DigestSummary): string {
	const lines = [
		`Digest: ${summary.generated.length} generated, ${summary.cleaned} cleaned, ${summary.cleanupPending} cleanup pending, ${summary.failed} failed, ${summary.deferred.length} deferred, ${summary.notStarted} not started.`,
	];
	for (const path of summary.generated) lines.push(`  ${path}`);
	for (const [reason, count] of countBy(summary.deferred)) lines.push(`  deferred: ${reason} (${count})`);
	if (summary.notStarted > 0) lines.push("  Not started runs wait for the next /workflow digest.");
	return lines.join("\n");
}

function countBy(values: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()];
}

/** `/workflow digest`: digest the eligible run revisions, one isolated child each, and report the counts. */
export async function digestCommand(deps: LearningDeps): Promise<LearningOutcome> {
	const ready = gate(deps);
	if ("level" in ready) return ready;
	const summary = await digestStep(deps, ready);
	return {
		level: summary.failed > 0 ? "warning" : "info",
		text: digestText(summary),
	};
}
