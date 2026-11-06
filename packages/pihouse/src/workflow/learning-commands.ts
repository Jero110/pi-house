// /workflow review, /workflow proposals <id> and the compact tool behind /workflow ask, wired to the agent-link hub and
// pi's model registry. The session that asks gets code-computed status lines and paths: no review text and no model
// turn. Every model call happens in a child agent this module starts through the hub, one per job. Spec:
// docs/specs/self-learning/vault-review.md, "Commands".
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type HubClient, identityFromEnv } from "agent-link-core";
import { compactRevisions } from "./compact-run.ts";
import { isQuiescent } from "./jobs.ts";
import { activateLearningStore } from "./learning-runtime.ts";
import { getProposal, listProposals, resolveProposalId, shortVersion } from "./proposals.ts";
import { type ReviewPlan, type ReviewResult, runReview } from "./review-run.ts";
import { uncompactedForProject } from "./run-stages.ts";
import { runtimePorts } from "./runtime-ports.ts";
import { type OperationalStore, openOperationalStore } from "./storage.ts";
import { unifiedDiff } from "./unified-diff.ts";
import { nativeWorkerAdapter, type WorkerJob, type WorkerResult } from "./worker-adapter.ts";

/** The model every learning child runs, as pi's `provider/model-id`. Overridden by this environment variable only. */
export const LEARNING_MODEL_ENV = "PIHOUSE_LEARNING_MODEL";
const DEFAULT_LEARNING_MODEL = "claude-bridge/claude-sonnet-5-5";

/**
 * Bounds on the time one child may take. Problem: a child that never answers would hold the command and its lease
 * forever. Solution: a ten-minute cap per child and a lease that outlives it.
 */
const WORKER_TIMEOUT_MS = 600_000;
const LEASE_MS = WORKER_TIMEOUT_MS + 60_000;

const NO_HUB =
	"/workflow review and the compact tool need the agent-link hub: run them from a pihouse session started through pih. Nothing was started.";

export interface LearningDeps {
	/** The vault root (the workflow memory folder): the store, the conversations, the compacts and the reviews. */
	memory: string;
	/** The agent-link journal folder (`<agent-link home>/sessions`). */
	journalDir: string;
	/** The environment the session runs with: the agent-link identity and the learning model setting. */
	env: NodeJS.ProcessEnv;
	/** The folder the session works in; children start in the vault, not here. */
	cwd: string;
	/** The pane backend from pihouse's config; undefined when pihouse was never set up. */
	backend: "cmux" | "tmux" | undefined;
	/** Whether a model id resolves in pi's registry with configured auth. */
	modelAvailable: (model: string) => boolean;
	/** Progress while the work runs; the caller shows it with ctx.ui.notify. */
	progress: (text: string) => void;
	/**
	 * Asks the user to go ahead, with the plan's counts. Absent when there is no dialog and no `--yes`: the command then
	 * reports the counts and starts nothing (the two-call fallback).
	 */
	confirm?: (plan: ReviewPlan) => boolean | Promise<boolean>;
	/** Test seams: the hub client, a ready-made child, the run checks and the clock and waits of the worker adapter. */
	client?: HubClient;
	worker?: (job: WorkerJob) => Promise<WorkerResult>;
	isActive?: (runId: string) => boolean;
	currentFingerprint?: (runId: string) => string | undefined;
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
	const model = learningModel(deps.env);
	if (deps.worker) return { ok: true, model, worker: deps.worker };
	if (!identityFromEnv(deps.env)) return { level: "warning", text: NO_HUB };
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

/** Runs `work` on the activated store's operational database, closed afterwards. */
async function withStore<T>(deps: LearningDeps, work: (store: OperationalStore) => Promise<T>): Promise<T> {
	activateLearningStore(deps.memory);
	const store = openOperationalStore(join(deps.memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		return await work(store);
	} finally {
		store.close();
	}
}

interface RunChecks {
	isActive: (runId: string) => boolean;
	currentFingerprint: (runId: string) => string | undefined;
}

/**
 * What the journal says about the runs. Problem: the deletion gate needs the live fingerprint of a run, and the ports
 * of the retired digest flow take a revision id, not a run id. Example: `run-a` has revisions r1 and r2; asking the
 * port for "run-a" would answer nothing and block every deletion. Solution: ask for the run's newest revision.
 */
function checksOf(deps: LearningDeps, db: DatabaseSync): RunChecks {
	const ports = runtimePorts({ storeDir: deps.memory, journalDir: deps.journalDir });
	const newest = (runId: string): string | undefined => {
		const row = db
			.prepare("SELECT id FROM revisions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.get(runId);
		return typeof row?.id === "string" ? row.id : undefined;
	};
	return {
		isActive: deps.isActive ?? ((runId) => !isQuiescent(ports.operationalState(runId))),
		currentFingerprint:
			deps.currentFingerprint ??
			((runId) => {
				const revision = newest(runId);
				return revision === undefined ? undefined : ports.currentFingerprint(revision);
			}),
	};
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The shortest prefix that tells `id` from every other id, at least 8 characters. `approve` accepts it.
 * Problem: the review's ids all start with "proposal-", so 8 characters ("proposal") match every one of them.
 * Example: two proposals listed as "proposal" and "proposal" cannot be approved by their listed id. Solution: keep six
 * characters of the hash as well.
 */
export function idPrefix(ids: readonly string[], id: string): string {
	const least = id.startsWith("proposal-") ? "proposal-".length + 6 : 8;
	for (let length = Math.min(least, id.length); length < id.length; length++) {
		const prefix = id.slice(0, length);
		if (ids.filter((other) => other.startsWith(prefix)).length === 1) return prefix;
	}
	return id;
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The payload fields the intake adds to a proposal. */
function extras(
	db: DatabaseSync,
	id: string,
): { kind: string; scope: string; uncertainty: string; validation: string } {
	const row = db.prepare("SELECT payload FROM proposals WHERE id = ?").get(id);
	const value: unknown = typeof row?.payload === "string" ? JSON.parse(row.payload) : {};
	const text = (key: string): string => {
		const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
		return typeof field === "string" ? field : "";
	};
	return { kind: text("kind"), scope: text("scope"), uncertainty: text("uncertainty"), validation: text("validation") };
}

/** The path a proposal changes: the file itself for `file:`, else the target as the proposal names it. */
const pathOf = (target: string): string => (target.startsWith("file:") ? target.slice(5) : target);

/**
 * The numbered list that ends a review: the open proposals, each with its id prefix, short version, target path and a
 * one-line reason.
 * Problem: the review's proposals carry no stored reason, only what is uncertain about them. Example: a proposal
 * supported by two runs with "two runs only" as its uncertainty. Solution: the reason line is its kind, its supporting
 * runs and that uncertainty, all from the stored proposal; nothing is invented.
 */
function proposalLines(db: DatabaseSync): string[] {
	const open = listProposals(db, { states: ["open"], limit: 100 });
	const ids = (db.prepare("SELECT id FROM proposals").all() as { id: string }[]).map((row) => row.id);
	return open.map((row, index) => {
		const info = extras(db, row.id);
		const why = [info.kind, plural(row.supportingRuns, "run")].filter(Boolean).join(", ");
		const doubt = info.uncertainty ? `: ${oneLine(info.uncertainty, 100)}` : "";
		return `${index + 1}. ${idPrefix(ids, row.id)}  v${row.version}  ${pathOf(row.target)}  ${why}${doubt}`;
	});
}

function reviewedText(result: Extract<ReviewResult, { status: "reviewed" }>, db: DatabaseSync): string {
	const cleaned = result.cleanup.filter((c) => c.status === "cleaned").length;
	const blocked = result.cleanup.filter((c) => c.status === "blocked");
	const lines = [
		`Reviewed ${plural(result.covered.length, "run")} (${result.compacted} compacted now). Review: ${result.reviewPath}`,
		`Proposals: ${result.intake.created} created, ${result.intake.merged} merged, ${result.intake.suppressed} suppressed. Nothing is applied by this command.`,
		`Conversations deleted: ${cleaned} of ${result.cleanup.length}; the compacts stay.`,
	];
	if (blocked.length > 0)
		lines.push(`Kept for the next review: ${blocked.map((b) => `${b.id} (${b.reason})`).join("; ")}.`);
	if (result.deferred.length > 0)
		lines.push(`Waiting for the next review (the input was full): ${result.deferred.length}.`);
	if (result.stale.length > 0) lines.push(`Changed while the review ran, still pending: ${result.stale.join(", ")}.`);
	const proposals = proposalLines(db);
	if (proposals.length > 0)
		lines.push(
			"Open proposals:",
			...proposals,
			"See one with /workflow proposals <id>; approve with /workflow approve <id> <version>, or /workflow reject <id> [reason].",
		);
	else lines.push("No open proposals.");
	return lines.join("\n");
}

/**
 * `/workflow review`: count what is pending, ask once, compact what lacks a compact, review everything together and
 * list the proposals. Declining, or having nothing pending, starts no agent and writes nothing.
 */
export async function reviewCommand(deps: LearningDeps): Promise<LearningOutcome> {
	const ready = gate(deps);
	if ("level" in ready) return ready;
	return withStore(deps, async (store) => {
		const checks = checksOf(deps, store.db);
		const result = await runReview({
			root: deps.memory,
			db: store.db,
			cwd: deps.memory,
			worker: ready.worker,
			isActive: checks.isActive,
			currentFingerprint: checks.currentFingerprint,
			now: () => new Date((deps.now ?? Date.now)()),
			invocation: randomUUID(),
			leaseMs: LEASE_MS,
			confirm: async (plan) => {
				if (!deps.confirm) return false;
				const go = await deps.confirm(plan);
				if (go) deps.progress(`Reviewing ${plural(plan.pending, "run")} with ${ready.model}.`);
				return go;
			},
		});
		if (result.status === "nothing-pending")
			return { level: "info", text: "Nothing to review: no saved run is waiting. /workflow log saves this session." };
		if (result.status === "declined") {
			const counts = `${plural(result.plan.pending, "saved run")} waiting (${result.plan.missing} still need a compact; each costs one model call, plus one for the review).`;
			return {
				level: "info",
				text: deps.confirm
					? `${counts} Review cancelled. Nothing was started.`
					: `${counts} Run /workflow review --yes to start. Nothing was started.`,
			};
		}
		if (result.status === "failed")
			return {
				level: "warning",
				text: `Review stopped at the ${result.step} step: ${result.reason}. Nothing was marked reviewed and no conversation was deleted; the compacts made so far stay. Run /workflow review again to resume.`,
			};
		return { level: "info", text: reviewedText(result, store.db) };
	});
}

/**
 * `/workflow proposals <id>`: one proposal in full, with the path it changes and a unified diff of before into after.
 * No model turn.
 */
export function proposalDetail(db: DatabaseSync, prefix: string): LearningOutcome {
	const found = resolveProposalId(db, prefix);
	if (found.status === "none")
		return { level: "warning", text: `No proposal matches "${prefix}". /workflow proposals lists them.` };
	if (found.status === "ambiguous")
		return { level: "warning", text: `"${prefix}" matches ${found.matches.join(", ")}. Use a longer prefix.` };
	const proposal = getProposal(db, found.proposal.id);
	const info = extras(db, proposal.id);
	const path = pathOf(proposal.target);
	const diff = unifiedDiff(proposal.before, proposal.after, path, path);
	const lines = [
		`Proposal ${proposal.id}: ${proposal.state}, version ${shortVersion(proposal.version)}`,
		`Path: ${path}`,
		`Kind: ${info.kind || "-"}; scope: ${info.scope || "-"}; supported by ${plural(new Set(proposal.evidence).size, "run")}: ${proposal.evidence.join(", ") || "-"}`,
	];
	if (info.uncertainty) lines.push(`Uncertain: ${info.uncertainty}`);
	if (info.validation) lines.push(`How to check: ${info.validation}`);
	if (proposal.reason) lines.push(`Reason on record: ${proposal.reason}`);
	lines.push("", diff || "(before and after are the same text)", "");
	if (proposal.state === "open")
		lines.push(
			`Approve: /workflow approve ${proposal.id} ${shortVersion(proposal.version)} · Reject: /workflow reject ${proposal.id} [reason]`,
		);
	return { level: "info", text: lines.join("\n") };
}

export interface CompactToolResult extends LearningOutcome {
	compacted: number;
	failed: number;
	skipped: number;
}

/**
 * The `workflow_compact` tool: compact every uncompacted run of one project, so `/workflow ask` can read them.
 * Problem: ask would answer from raw conversations, or from nothing, when the runs are not compacted yet. Example: a
 * project with three saved runs and no review. Solution: the same compact children as the review, marked `ask`. This
 * never deletes a conversation and never marks a revision reviewed, so a later review still covers every run.
 */
export async function compactProjectCommand(deps: LearningDeps, project: string): Promise<CompactToolResult> {
	const none = (text: string, level: "info" | "warning"): CompactToolResult => ({
		level,
		text,
		compacted: 0,
		failed: 0,
		skipped: 0,
	});
	const ready = gate(deps);
	if ("level" in ready) return none(ready.text, ready.level);
	return withStore(deps, async (store) => {
		const checks = checksOf(deps, store.db);
		const revisions = uncompactedForProject(store.db, project, { root: deps.memory, isActive: checks.isActive });
		if (revisions.length === 0)
			return none("Nothing to compact: every saved run of this project has a compact.", "info");
		deps.progress(`Compacting ${plural(revisions.length, "run")} with ${ready.model}.`);
		const outcomes = await compactRevisions({
			root: deps.memory,
			db: store.db,
			revisions,
			compactedBy: "ask",
			worker: ready.worker,
			cwd: deps.memory,
			isActive: checks.isActive,
			now: () => new Date((deps.now ?? Date.now)()),
			invocation: randomUUID(),
			leaseMs: LEASE_MS,
		});
		const count = (statuses: string[]) => outcomes.filter((o) => statuses.includes(o.status)).length;
		const compacted = count(["compacted"]);
		const failed = count(["failed", "cancelled"]);
		const skipped = outcomes.length - compacted - failed;
		const text = `Compacted ${plural(compacted, "run")} of this project; ${failed} failed, ${skipped} skipped (active, deferred or already done). No conversation was deleted and nothing was marked reviewed.`;
		return { level: failed > 0 ? "warning" : "info", text, compacted, failed, skipped };
	});
}
