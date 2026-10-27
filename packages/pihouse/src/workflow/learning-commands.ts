// /workflow digest and /workflow self-learning, wired to the agent-link hub and pi's model registry. The session that
// asks gets code-computed status lines and artifact paths: no digest text and no model turn. Every model call happens
// in a child agent this module spawns through the hub, one per job.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type HubClient, identityFromEnv } from "agent-link-core";
import {
	type AgentRequest,
	type AgentResponse,
	DEFAULT_MAX_OUTPUT_CHARS,
	runSelfLearning,
	type SelfLearningResult,
} from "./learning-review.ts";
import {
	activateLearningStore,
	executeDigest,
	produceDigestCandidates,
	type RuntimeOptions,
} from "./learning-runtime.ts";
import { type IntakeResult, ingestReview } from "./proposal-intake.ts";
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

/**
 * The scan's output, as learning-review validates it. Problem: the child sees only this text, so a shape that differs
 * from validateScan is rejected after the child has already run. Example: "supporters" written as "runs". Solution:
 * the same field names and rules, written out for the child; validateScan stays the authority.
 */
const SCAN_CONTRACT = [
	'Write one JSON object: {"schemaVersion":1,"groups":[...]}. Each group is {"id": a short unique string, "claim": one sentence of at most 500 characters, "scope": {"kind":"global"} or {"kind":"project","project":"<name>"}, "supporters": [digest revision ids that support the claim, at least one], "opposers": [digest revision ids that contradict it], "priorProposals": [proposal ids from the manifest that it concerns]}.',
	'Use only the revision ids and proposal ids listed in the manifest. Group paraphrases of one suggestion into one group; a supporter and an opposer are never the same id. A project scope needs every supporter from that project. Emit {"schemaVersion":1,"groups":[]} when nothing repeats. No prose.',
].join("\n");

const NO_HUB =
	"/workflow digest and /workflow self-learning need the agent-link hub: run them from a pihouse session started through pih. Nothing was started.";

export interface LearningDeps {
	/** The workflow memory folder: the store, its operational database, its digests and its batches. */
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

/**
 * Runs `work` on the activated store's operational database, closed afterwards.
 * Problem: the digest and the review both need the database, and each opened it on its own. Example: a self-learning
 * run that digests first and then reviews would hold two handles to the same file. Solution: one handle for both.
 */
async function withStore<T>(deps: LearningDeps, work: (store: OperationalStore) => Promise<T>): Promise<T> {
	activateLearningStore(deps.memory);
	const store = openOperationalStore(join(deps.memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		return await work(store);
	} finally {
		store.close();
	}
}

function runtimeOf(deps: LearningDeps, store: OperationalStore): RuntimeOptions {
	const ports = deps.ports ?? runtimePorts({ storeDir: deps.memory, journalDir: deps.journalDir });
	return { storeDir: deps.memory, db: store.db, ownedRoot: deps.memory, ...ports };
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
 * The digest step: produce the eligible candidates, run one isolated child each, commit, then clean up.
 * Problem: a failed or deferred run must not stop the others, and a retry must not repeat the model call.
 * Example: run A's child fails, run B digests; run A is retried by the next invocation only.
 * Solution: the runtime's per-job results are counted here by code; nothing is re-run inside this call.
 */
async function digestStep(deps: LearningDeps, ready: Ready, options: RuntimeOptions): Promise<DigestSummary> {
	const summary: DigestSummary = {
		generated: [],
		cleaned: 0,
		cleanupPending: 0,
		failed: 0,
		deferred: [],
		notStarted: 0,
	};
	const produced = produceDigestCandidates(options);
	summary.deferred.push(...produced.deferred.map((entry) => entry.reason));
	const cleanupRevisions = new Set(
		options.db
			.prepare("SELECT revision_id FROM jobs WHERE state IN ('generated', 'cleanup-failed')")
			.all()
			.map((row) => String(row.revision_id)),
	);

	const digestRoot = join(deps.memory, "digests");
	const total = Math.min(produced.candidates.length, DIGEST_JOBS_PER_INVOCATION);
	let started = 0;
	const results = await executeDigest(
		{
			...options,
			digestRoot,
			outputPath: (candidate) => join(digestRoot, ".attempts", `${candidate.revision}.md`),
			// Problem: a worker launched from the user's project may access project files by its normal cwd permissions.
			// Solution: start it in the pihouse memory store; this separates working directories, not a security sandbox.
			cwd: deps.memory,
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
	const digestResults = results.filter((result) => !cleanupRevisions.has(result.revision));
	summary.notStarted = Math.max(0, produced.candidates.length - digestResults.length);
	for (const result of results) {
		if (cleanupRevisions.has(result.revision)) {
			if (result.status === "cleaned") summary.cleaned++;
			else summary.cleanupPending++;
			continue;
		}
		if (result.path) summary.generated.push(result.path);
		if (result.status === "cleaned") summary.cleaned++;
		else if (result.path) summary.cleanupPending++;
		else if (result.status === "deferred")
			summary.deferred.push("source changed or run became active during the digest");
		else summary.failed++;
	}
	return summary;
}

function countBy(values: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()];
}

/**
 * The status the session sees. Problem: a long list of digest paths, reasons and counts is easy to misread as a
 * summary the model wrote. Example: a reader who takes "deferred" for a failure. Solution: one count line, then the
 * paths, then each deferral reason once with its count.
 */
function digestLines(summary: DigestSummary): string[] {
	const lines = [
		`Digest: ${summary.generated.length} generated, ${summary.cleaned} cleaned, ${summary.cleanupPending} cleanup pending, ${summary.failed} failed, ${summary.deferred.length} deferred, ${summary.notStarted} not started.`,
	];
	for (const path of summary.generated) lines.push(`  ${path}`);
	for (const [reason, count] of countBy(summary.deferred)) lines.push(`  deferred: ${reason} (${count})`);
	if (summary.notStarted > 0) lines.push("  Not started runs wait for the next /workflow digest.");
	return lines;
}

/** `/workflow digest`: digest the eligible run revisions, one isolated child each, and report the counts. */
export async function digestCommand(deps: LearningDeps): Promise<LearningOutcome> {
	const ready = gate(deps);
	if ("level" in ready) return ready;
	return withStore(deps, async (store) => {
		const summary = await digestStep(deps, ready, runtimeOf(deps, store));
		return { level: summary.failed > 0 ? "warning" : "info", text: digestLines(summary).join("\n") };
	});
}

/**
 * The run's lineage, from its newest revision's metrics. Problem: a fork without a recorded lineage would count as an
 * independent run. Example: a worker forked from another run whose parent is no longer retained. Solution: no lineage,
 * no support; the run is excluded and the review says so.
 */
function lineageOf(db: DatabaseSync, runId: string): string | undefined {
	const row = db
		.prepare(
			"SELECT m.value FROM metrics m JOIN revisions r ON r.id = m.revision_id WHERE r.run_id = ? AND m.kind = 'run.lineage' ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1",
		)
		.get(runId);
	if (!row) return undefined;
	try {
		const value: unknown = JSON.parse(String(row.value));
		const lineage: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "lineage") : undefined;
		return typeof lineage === "string" && lineage ? lineage : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The review port: each scan and review is one child that reads the manifest and writes the stage's artifact.
 * Problem: the child could read anything the hub allows, including raw transcripts the digests already replaced.
 * Example: a review that opens a run folder to check a claim. Solution: its read dirs are the batch and the digests
 * only; the run folders are not among them.
 */
function agentPort(deps: LearningDeps, ready: Ready, digestRoot: string, reviewRoot: string) {
	return async (request: AgentRequest): Promise<AgentResponse> => {
		const label = request.stage === "scan" ? "Scan" : "Review";
		deps.progress(`${label} of batch ${request.batchId} with ${ready.model}.`);
		const outcome = await ready.worker({
			stage: request.stage,
			id: `${request.stage}-${request.batchId}`,
			revision: request.batchId,
			inputPath: request.manifestPath,
			outputPath: request.outputPath,
			// Workers run from pihouse's store, never the user's project; this is not a sandbox.
			cwd: deps.memory,
			maxOutputBytes: DEFAULT_MAX_OUTPUT_CHARS,
			inputs: request.scanSummaryPath ? [request.scanSummaryPath] : [],
			contract: request.stage === "scan" ? SCAN_CONTRACT : request.outputContract,
			readDirs: [reviewRoot, digestRoot],
		});
		if (outcome.status === "success") return { status: "success", artifactPath: outcome.outputPath };
		return { status: outcome.status === "cancelled" ? "cancelled" : "failure" };
	};
}

function selfLearningOutcome(
	digest: DigestSummary,
	learned: SelfLearningResult,
	intake: IntakeResult | undefined,
): LearningOutcome {
	const failed = learned.status === "scan-failed" || learned.status === "review-failed" || learned.status === "blocked";
	const stage = learned.status === "scan-failed" ? "scan" : "review";
	const lines: string[] = [];
	if (learned.status === "blocked") lines.push(`Self-learning blocked: ${learned.reason}. Nothing was applied.`);
	else if (failed)
		lines.push(
			`Self-learning stopped at the ${stage}: ${learned.reason}. Nothing was applied; batch ${learned.batchId} stays open and the next /workflow self-learning resumes it.`,
		);
	else if (learned.status === "nothing-to-review")
		lines.push("Self-learning: nothing to review; no digest is waiting.");
	else lines.push(`Self-learning batch ${learned.batchId}: reviewed ${learned.selected} run(s).`);
	lines.push(...digestLines(digest));
	if (learned.groups.length > 0) {
		const contradicted = learned.groups.filter((group) => group.contradicted).length;
		const rejected = learned.groups.filter((group) => group.priorRejected).length;
		lines.push(
			`Groups: ${learned.groups.length}, contradicted: ${contradicted}, against a rejected proposal: ${rejected}.`,
		);
	}
	if (intake?.status === "ingested")
		lines.push(
			`Proposals: ${intake.created} created, ${intake.merged} merged, ${intake.suppressed} suppressed. List them with /workflow proposals; approve one with /workflow approve <id>. Nothing is applied by this command.`,
		);
	if (learned.excluded.length > 0)
		for (const [reason, count] of countBy(learned.excluded.map((entry) => entry.reason)))
			lines.push(`Excluded: ${reason} (${count}).`);
	if (learned.overflow.length > 0) lines.push(`Waiting for a later batch: ${learned.overflow.length}.`);
	if (learned.reviewPath) lines.push(`Review: ${learned.reviewPath}`);
	if (learned.summaryPath) lines.push(`Summary: ${learned.summaryPath}`);
	return { level: failed ? "warning" : "info", text: lines.join("\n") };
}

/**
 * `/workflow self-learning`: digest what is missing, then scan and review one batch in separate children. The
 * invocation authorizes the review only; it applies nothing.
 */
export async function selfLearningCommand(deps: LearningDeps): Promise<LearningOutcome> {
	const ready = gate(deps);
	if ("level" in ready) return ready;
	return withStore(deps, async (store) => {
		const options = runtimeOf(deps, store);
		const digest = await digestStep(deps, ready, options);
		const digestRoot = join(deps.memory, "digests");
		const reviewRoot = join(deps.memory, "batches");
		let intake: IntakeResult | undefined;
		const learned = await runSelfLearning(store.db, {
			invocation: randomUUID(),
			now: deps.now ?? Date.now,
			leaseMs: LEASE_MS,
			reviewRoot,
			lineageOf: (runId) => lineageOf(store.db, runId),
			// The digest step above prepared every eligible revision, so no digest job is left for the review.
			missing: [],
			digestAdapter: async () => ({ status: "failure" }),
			agent: agentPort(deps, ready, digestRoot, reviewRoot),
			intake: (reviewId, text) => {
				intake = ingestReview(store.db, reviewId, text);
				return intake;
			},
		});
		return selfLearningOutcome(digest, learned, intake);
	});
}
