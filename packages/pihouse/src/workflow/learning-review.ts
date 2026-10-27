import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { validateDigest } from "./digest-contract.ts";
import { commitArtifact } from "./documents.ts";
import { claimJob, type DispatchInput, type DispatchOptions, dispatchJobs, enqueueJob, finishJob } from "./jobs.ts";
import { type IntakeResult, ingestReview } from "./proposal-intake.ts";

// One self-learning invocation: prepare missing digests, scan the retained ones, review the batch in a separate agent.
// The invocation is the authorization for all three steps; nothing here applies a change (proposal approval and
// application in proposals.ts stay separate). Agents are reached through an injected port that carries only ids and
// paths, and the caller gets back statuses and paths, never generated text.

export const MAX_RUNS_PER_BATCH = 10;
export const DEFAULT_MAX_INPUT_CHARS = 60_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const MAX_PRIOR = 50;
const MAX_GROUPS = 50;
const MAX_REFS = 20;

export interface AgentRequest {
	stage: "scan" | "review";
	batchId: string;
	manifestPath: string;
	outputPath: string;
	/** Review only: the persisted, code-checked scan summary. */
	scanSummaryPath?: string;
	/** Review agents must emit this exact machine-readable proposal envelope. */
	outputContract?: string;
}
export type AgentResponse = { status: "success"; artifactPath: string } | { status: "failure" | "cancelled" };

export interface SelfLearningOptions {
	invocation: string;
	now: () => number;
	leaseMs: number;
	reviewRoot: string;
	/** Run lineage from the evidence record (T4); a fork child shares its parent's lineage. */
	lineageOf: (runId: string) => string | undefined;
	missing: DispatchInput[];
	digestAdapter: DispatchOptions["adapter"];
	/** Optional: persist a generated digest (commitDigest) before candidates are collected. */
	commit?: (generated: { id: string; path: string }) => Promise<void> | void;
	agent: (request: AgentRequest) => Promise<AgentResponse>;
	project?: string;
	maxRuns?: number;
	maxInputChars?: number;
	maxOutputChars?: number;
	maxDigestJobs?: number;
	maxAttempts?: number;
	/** Proposal intake is injected so review tests and production wiring share no model dependency. */
	intake?: (reviewId: string, artifact: string) => IntakeResult | Promise<IntakeResult>;
}

export interface GroupSummary {
	id: string;
	scope: string;
	supportRuns: number;
	supportLineages: number;
	opposeLineages: number;
	contradicted: boolean;
	priorRejected: boolean;
	priorProposals: string[];
}

export interface SelfLearningResult {
	status: "reviewed" | "nothing-to-review" | "scan-failed" | "review-failed" | "blocked";
	reason?: string;
	queue: { missing: number; generated: number; failed: number };
	batchId?: string;
	manifestPath?: string;
	summaryPath?: string;
	reviewPath?: string;
	selected: number;
	groups: GroupSummary[];
	excluded: { id: string; reason: string }[];
	overflow: { revision: string; reason: string }[];
}

interface Item {
	runId: string;
	revision: string;
	lineage: string;
	project: string;
	digestPath: string;
	digestHash: string;
	chars: number;
}
interface Prior {
	id: string;
	version: string;
	state: string;
}
interface Manifest {
	batchId: string;
	items: Item[];
	prior: Prior[];
	priorOverflow: number;
	overflow: { revision: string; reason: string }[];
	excluded: { id: string; reason: string }[];
	budgets: { maxRuns: number; maxInputChars: number; maxOutputChars: number };
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function transaction<T>(db: DatabaseSync, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readJson(path: string): unknown {
	try {
		return parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Problem: a digest edited after pinning would be reviewed under its old hash. Solution: re-read it against the pin. */
function pinnedDigestIntact(item: Item): boolean {
	try {
		return sha256(readFileSync(item.digestPath)) === item.digestHash;
	} catch {
		return false;
	}
}

function collectCandidates(
	db: DatabaseSync,
	options: SelfLearningOptions,
): { items: Item[]; excluded: { id: string; reason: string }[] } {
	const excluded: { id: string; reason: string }[] = [];
	const taken = new Set(
		db
			.prepare("SELECT item_id FROM batch_members")
			.all()
			.map((row) => String(row.item_id)),
	);
	const rows = db
		.prepare(
			"SELECT m.id, m.payload, r.run_id FROM cleanup_manifests m JOIN revisions r ON r.id = m.id ORDER BY r.created_at, r.rowid",
		)
		.all();
	const latest = new Map<string, Item>();
	for (const row of rows) {
		const revision = String(row.id);
		if (taken.has(revision)) continue;
		const receipt = parse(String(row.payload));
		if (!record(receipt) || typeof receipt.digestPath !== "string" || typeof receipt.digestHash !== "string") {
			excluded.push({ id: revision, reason: "digest receipt invalid" });
			continue;
		}
		const runId = String(row.run_id);
		let text: string;
		try {
			const bytes = readFileSync(receipt.digestPath);
			if (sha256(bytes) !== receipt.digestHash) throw new Error("hash mismatch");
			text = bytes.toString("utf8");
		} catch {
			excluded.push({ id: revision, reason: "digest unreadable or changed" });
			continue;
		}
		const body = parse(text);
		const project = record(body) && typeof body.project === "string" ? body.project : "";
		if (!validateDigest(text, { runId, project, revision }, "stop", text.length).ok) {
			excluded.push({ id: revision, reason: "digest incomplete" });
			continue;
		}
		if (options.project !== undefined && project !== options.project) continue;
		const lineage = options.lineageOf(runId);
		// Counting an unknown lineage as its own would inflate support when it is really a fork of another run.
		if (!lineage) {
			excluded.push({ id: revision, reason: "lineage unknown" });
			continue;
		}
		const earlier = latest.get(runId);
		if (earlier) excluded.push({ id: earlier.revision, reason: "superseded revision" });
		latest.set(runId, {
			runId,
			revision,
			lineage,
			project,
			digestPath: receipt.digestPath,
			digestHash: receipt.digestHash,
			chars: text.length,
		});
	}
	return { items: [...latest.values()].sort((a, b) => (a.revision < b.revision ? -1 : 1)), excluded };
}

function selectBatch(items: Item[], maxRuns: number, maxChars: number) {
	const selected: Item[] = [];
	const overflow: Manifest["overflow"] = [];
	let used = 0;
	for (const item of items) {
		// Whole digests only: a truncated digest would silently misrepresent its run.
		if (selected.length >= maxRuns) overflow.push({ revision: item.revision, reason: "run limit" });
		else if (used + item.chars > maxChars) overflow.push({ revision: item.revision, reason: "character budget" });
		else {
			selected.push(item);
			used += item.chars;
		}
	}
	return { selected, overflow };
}

function priorDecisions(db: DatabaseSync): { prior: Prior[]; overflow: number } {
	const all: Prior[] = [];
	for (const row of db.prepare("SELECT id, payload FROM proposals ORDER BY id").all()) {
		const proposal = parse(String(row.payload));
		if (record(proposal) && typeof proposal.version === "string" && typeof proposal.state === "string")
			all.push({ id: String(row.id), version: proposal.version, state: proposal.state });
	}
	return { prior: all.slice(0, MAX_PRIOR), overflow: Math.max(0, all.length - MAX_PRIOR) };
}

/** Run one stage as a leased, attempt-bounded job; its artifact counts only after `accept` validates it. */
async function stage(
	db: DatabaseSync,
	options: SelfLearningOptions,
	input: { jobId: string; fingerprint: string; request: AgentRequest; accept: (path: string) => boolean },
): Promise<boolean> {
	enqueueJob(db, input.jobId, null, input.fingerprint);
	const row = db.prepare("SELECT state FROM jobs WHERE id = ?").get(input.jobId);
	// A generated stage is reused on restart instead of asking the agent again.
	if (row?.state === "generated") return existsSync(input.request.outputPath) && input.accept(input.request.outputPath);
	const claim = claimJob(db, input.jobId, options.invocation, options.now(), options.leaseMs, options.maxAttempts);
	if (!claim) return false;
	let response: AgentResponse;
	try {
		response = await options.agent(input.request);
	} catch {
		response = { status: "failure" };
	}
	const valid =
		response.status === "success" &&
		resolve(response.artifactPath) === resolve(input.request.outputPath) &&
		input.accept(input.request.outputPath);
	const outcome = valid ? "success" : response.status === "cancelled" ? "cancelled" : "failure";
	const finished = finishJob(db, claim, outcome, input.fingerprint, options.now(), input.request.outputPath);
	return finished && valid;
}

function withinBudget(path: string, max: number): boolean {
	try {
		const size = statSync(path).size;
		return size > 0 && size <= max;
	} catch {
		return false;
	}
}

function scopeOf(group: Record<string, unknown>): { text: string; project?: string } | undefined {
	const value = group.scope;
	if (!record(value)) return undefined;
	if (value.kind === "global") return { text: "global" };
	if (value.kind === "project" && typeof value.project === "string" && value.project)
		return { text: `project:${value.project}`, project: value.project };
	return undefined;
}

/**
 * Decision contract for the semantic step.
 * Problem: matching words cannot show that two suggestions mean the same thing; example: "retry flaky tests" and
 * "rerun unstable specs" share no words. Solution: the scan agent returns groups of digest revisions, and code only
 * checks that every reference is real and computes lineage support from the pinned evidence.
 */
function validateScan(path: string, manifest: Manifest): GroupSummary[] | undefined {
	const value = readJson(path);
	if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS)
		return undefined;
	const byRevision = new Map(manifest.items.map((item) => [item.revision, item]));
	const priorById = new Map(manifest.prior.map((entry) => [entry.id, entry]));
	const groups: GroupSummary[] = [];
	const seen = new Set<string>();
	for (const raw of value.groups) {
		if (!record(raw) || typeof raw.id !== "string" || !raw.id || raw.id.length > 64 || seen.has(raw.id))
			return undefined;
		seen.add(raw.id);
		if (typeof raw.claim !== "string" || raw.claim.length > 500) return undefined;
		const refs = (key: string, required: boolean): string[] | undefined => {
			const list = raw[key] ?? [];
			if (!Array.isArray(list) || list.length > MAX_REFS || (required && list.length === 0)) return undefined;
			return list.every((entry) => typeof entry === "string") ? [...new Set(list as string[])] : undefined;
		};
		const scope = scopeOf(raw);
		const supporters = refs("supporters", true);
		const opposers = refs("opposers", false);
		const priors = refs("priorProposals", false);
		if (!scope || !supporters || !opposers || !priors) return undefined;
		const support = supporters.map((revision) => byRevision.get(revision));
		const oppose = opposers.map((revision) => byRevision.get(revision));
		if (!support.every((item) => item) || !oppose.every((item) => item)) return undefined;
		if (opposers.some((revision) => supporters.includes(revision))) return undefined;
		const supportItems = support as Item[];
		const opposeItems = oppose as Item[];
		if (scope.project !== undefined && supportItems.some((item) => item.project !== scope.project)) return undefined;
		if (!priors.every((id) => priorById.has(id))) return undefined;
		groups.push({
			id: raw.id,
			scope: scope.text,
			supportRuns: new Set(supportItems.map((item) => item.runId)).size,
			supportLineages: new Set(supportItems.map((item) => item.lineage)).size,
			opposeLineages: new Set(opposeItems.map((item) => item.lineage)).size,
			contradicted: opposeItems.length > 0,
			priorRejected: priors.some((id) => priorById.get(id)?.state === "rejected"),
			priorProposals: priors,
		});
	}
	return groups;
}

async function prepareDigests(db: DatabaseSync, options: SelfLearningOptions, result: SelfLearningResult) {
	if (options.missing.length === 0) return;
	const dispatched = await dispatchJobs(db, options.missing, {
		invocation: options.invocation,
		now: options.now,
		leaseMs: options.leaseMs,
		maxJobs: options.maxDigestJobs ?? 10,
		maxAttempts: options.maxAttempts,
		adapter: options.digestAdapter,
	});
	for (const entry of dispatched) {
		if (entry.status !== "generated") {
			result.queue.failed++;
			result.excluded.push({ id: entry.id, reason: `digest ${entry.status === "failed" ? "failed" : entry.status}` });
			continue;
		}
		result.queue.generated++;
		try {
			await options.commit?.({ id: entry.id, path: entry.path });
		} catch {
			// Reported below: without a committed receipt the digest is not a candidate.
		}
		if (!db.prepare("SELECT 1 AS hit FROM cleanup_manifests WHERE id = ?").get(entry.id))
			result.excluded.push({ id: entry.id, reason: "digest not committed" });
	}
	const handled = new Set(dispatched.map((entry) => entry.id));
	for (const job of options.missing)
		if (!handled.has(job.id)) {
			result.queue.failed++;
			result.excluded.push({ id: job.id, reason: "digest not prepared" });
		}
}

/** One open batch at a time: resume it rather than build a second one that could repeat its members. */
function resumeOpenBatch(db: DatabaseSync, id: string): { manifest: Manifest; path: string } | undefined {
	const commit = db.prepare("SELECT path, hash FROM artifact_commits WHERE id = ?").get(`manifest-${id}`);
	if (!commit) return undefined;
	let bytes: Buffer;
	try {
		bytes = readFileSync(String(commit.path));
	} catch {
		return undefined;
	}
	const stored = parse(bytes.toString("utf8"));
	if (sha256(bytes) !== commit.hash || !record(stored) || !Array.isArray(stored.items)) return undefined;
	const manifest = stored as unknown as Manifest;
	const members = db.prepare("SELECT item_id FROM batch_members WHERE batch_id = ? ORDER BY item_id").all(id);
	const pinned = manifest.items.map((item) => item.revision).sort();
	if (pinned.join("\0") !== members.map((row) => String(row.item_id)).join("\0")) return undefined;
	return { manifest, path: String(commit.path) };
}

export async function runSelfLearning(db: DatabaseSync, options: SelfLearningOptions): Promise<SelfLearningResult> {
	const maxRuns = options.maxRuns ?? MAX_RUNS_PER_BATCH;
	const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	if (
		!Number.isInteger(maxRuns) ||
		maxRuns < 1 ||
		maxRuns > MAX_RUNS_PER_BATCH ||
		!Number.isSafeInteger(maxInputChars) ||
		maxInputChars < 1 ||
		!Number.isSafeInteger(maxOutputChars) ||
		maxOutputChars < 1
	)
		throw new Error("Invalid review budget");

	const result: SelfLearningResult = {
		status: "nothing-to-review",
		queue: { missing: options.missing.length, generated: 0, failed: 0 },
		selected: 0,
		groups: [],
		excluded: [],
		overflow: [],
	};
	await prepareDigests(db, options, result);

	let manifest: Manifest;
	let manifestPath: string;
	const open = db.prepare("SELECT id FROM batches WHERE state = 'open' ORDER BY created_at, id LIMIT 1").get();
	if (open) {
		const resumed = resumeOpenBatch(db, String(open.id));
		if (!resumed)
			return {
				...result,
				status: "blocked",
				reason: "open batch manifest is missing or inconsistent",
				batchId: String(open.id),
			};
		manifest = resumed.manifest;
		manifestPath = resumed.path;
		result.overflow = manifest.overflow;
	} else {
		const collected = collectCandidates(db, options);
		result.excluded.push(...collected.excluded);
		const { selected, overflow } = selectBatch(collected.items, maxRuns, maxInputChars);
		result.overflow = overflow;
		if (selected.length === 0) return result;
		// The id derives from the pinned members, so a crash before the rows exist rebuilds the same batch.
		const batchId = `batch-${sha256(JSON.stringify(selected.map((item) => [item.revision, item.digestHash]))).slice(0, 16)}`;
		const { prior, overflow: priorOverflow } = priorDecisions(db);
		manifest = {
			batchId,
			items: selected,
			prior,
			priorOverflow,
			overflow,
			excluded: result.excluded,
			budgets: { maxRuns, maxInputChars, maxOutputChars },
		};
		const committed = commitArtifact({
			root: options.reviewRoot,
			id: batchId,
			kind: "manifest",
			content: JSON.stringify(manifest, null, 1),
		});
		manifestPath = committed.path;
		const at = new Date(options.now()).toISOString();
		transaction(db, () => {
			db.prepare("INSERT OR IGNORE INTO batches(id, created_at, state) VALUES (?, ?, 'open')").run(batchId, at);
			for (const item of selected)
				db.prepare("INSERT OR IGNORE INTO batch_members(batch_id, item_id) VALUES (?, ?)").run(batchId, item.revision);
			db.prepare(
				"INSERT INTO artifact_commits(id, path, hash, state, created_at) VALUES (?, ?, ?, 'committed', ?) ON CONFLICT(id) DO NOTHING",
			).run(`manifest-${batchId}`, committed.path, committed.hash, at);
		});
	}
	const batchId = manifest.batchId;
	result.batchId = batchId;
	result.manifestPath = manifestPath;
	result.selected = manifest.items.length;
	const changed = manifest.items.filter((item) => !pinnedDigestIntact(item)).map((item) => item.revision);
	if (changed.length > 0)
		return { ...result, status: "blocked", reason: `pinned digest changed: ${changed.join(", ")}` };

	const fingerprint = sha256(readFileSync(manifestPath));
	const scanPath = join(options.reviewRoot, "scans", `${batchId}.json`);
	const scanned = await stage(db, options, {
		jobId: `scan:${batchId}`,
		fingerprint,
		request: { stage: "scan", batchId, manifestPath, outputPath: scanPath },
		accept: (path) => withinBudget(path, maxOutputChars) && validateScan(path, manifest) !== undefined,
	});
	if (!scanned) return { ...result, status: "scan-failed", reason: "scan produced no valid decision" };
	result.groups = validateScan(scanPath, manifest) ?? [];
	const summary = commitArtifact({
		root: options.reviewRoot,
		id: batchId,
		kind: "summary",
		content: JSON.stringify(
			{ batchId, queue: result.queue, groups: result.groups, excluded: result.excluded, overflow: result.overflow },
			null,
			1,
		),
	});
	result.summaryPath = summary.path;

	const reviewPath = join(options.reviewRoot, "reviews", `${batchId}.md`);
	const reviewed = await stage(db, options, {
		jobId: `review:${batchId}`,
		fingerprint,
		request: {
			stage: "review",
			batchId,
			manifestPath,
			outputPath: reviewPath,
			scanSummaryPath: summary.path,
			outputContract:
				'Include exactly one fenced ```json block with {"schemaVersion":1,"proposals":[...]}. Each proposal has kind, scope (project|global), target, before, after, supporting (digest revision IDs), opposing (digest revision IDs), conditions (strings), uncertainty, validation, and optional reopen explanation. Emit [] when there are no actionable proposals.',
		},
		accept: (path) => withinBudget(path, maxOutputChars),
	});
	if (!reviewed) return { ...result, status: "review-failed", reason: "review produced no valid artifact" };
	if (!manifest.items.every(pinnedDigestIntact))
		return { ...result, status: "blocked", reason: "a pinned digest changed during review" };
	// Problem: a completed review was previously only prose; example: its fenced proposal block was never persisted as decisions.
	// Solution: intake runs only after the review artifact is accepted and pinned inputs remain intact.
	const review = readFileSync(reviewPath, "utf8");
	const intake = (await options.intake?.(batchId, review)) ?? ingestReview(db, batchId, review);
	if (intake.status === "failed")
		return { ...result, status: "review-failed", reason: `proposal intake failed: ${intake.reason}` };
	// Only the pinned members are reviewed. Failed and overflow inputs have no membership and stay pending.
	db.prepare("UPDATE batches SET state = 'reviewed' WHERE id = ? AND state = 'open'").run(batchId);
	return { ...result, status: "reviewed", reviewPath };
}
