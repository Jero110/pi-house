import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Transcript, TranscriptMessage } from "agent-transcripts";
import { COMPACT_SECTIONS } from "../src/workflow/compact-contract.ts";
import { evidenceFingerprint, persistEvidence } from "../src/workflow/evidence-store.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { createProposalTarget } from "../src/workflow/proposal-target.ts";
import { applyProposal, approveProposal, getProposal, listProposals } from "../src/workflow/proposals.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
import { REVIEW_INPUT_MAX_CHARS, REVIEW_SECTIONS } from "../src/workflow/review-contract.ts";
import { planReview, type ReviewResult, runReview } from "../src/workflow/review-run.ts";
import { pendingForReview, stageOf } from "../src/workflow/run-stages.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";
import { vaultPaths } from "../src/workflow/vault-paths.ts";
import type { WorkerJob, WorkerResult } from "../src/workflow/worker-adapter.ts";

// Every test uses a temporary vault and a fake worker port: no hub, no model, no real token.

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const PROJECT = "/work/app";

interface AgentSpec {
	id: string;
	role?: "planner" | "executor" | "worker";
	/** "none": the participant has no transcript file at all. */
	messages?: TranscriptMessage[] | "none";
}

function msg(index: number, partial: Partial<TranscriptMessage>): TranscriptMessage {
	return { index, at: 1_000 + index, role: "assistant", text: "", tools: [], skills: [], ...partial };
}

const DEFAULT_MESSAGES = (): TranscriptMessage[] => [
	msg(0, { role: "user", origin: "human", text: "HUMAN_ASK please add a login page" }),
	msg(1, {
		text: "I will start with a failing test.",
		usage: { input: 1_000, output: 500, cacheRead: 40_000, cacheWrite: 0 },
		tools: [
			{ name: "bash", ok: true, input: { command: "npm test" }, output: "TOOL_OUTPUT_SECRET" } as never,
			{ name: "write", ok: true, input: { file_path: "/work/app/login.ts", content: "TOOL_CONTENT_SECRET" } },
		],
	}),
];

function evidence(project: string, tag: string, agents: AgentSpec[]): WorkflowEvidence {
	return {
		lineage: `lineage-${tag}`,
		lineageStatus: "root-id",
		forkProvenance: "unknown",
		destructiveEligibility: "deferred",
		title: tag,
		project,
		plan: "docs/plans/p.md",
		participants: agents.map((a, i) => ({
			id: a.id,
			parent: i === 0 ? null : agents[0].id,
			role: a.role ?? (i === 0 ? "planner" : "worker"),
			harness: "claude",
			model: "claude-sonnet-5-5",
			taskId: null,
			taskTitle: null,
			assignedSkills: [],
			loadedSkills: i === 0 ? ["spec-driven-development"] : [],
			// The evidence says 1 token; the transcript says more. Facts must follow the transcript.
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
			activeMs: 1,
			messages: 1,
			missing: a.messages === "none" ? "no transcript" : null,
			summary: null,
		})),
		metrics: { newTokens: 1, cacheRead: 0, activeMs: 120_000, wallMs: 600_000, agents: agents.length, messages: 2 },
		cursor: {},
	};
}

interface Fixture {
	root: string;
	store: OperationalStore;
	/** Captures one revision of a run: evidence in the database, run.json and transcripts on disk. */
	capture(runId: string, revision?: number, agents?: AgentSpec[]): { id: string; fingerprint: string; runId: string };
	revisions(): ReturnType<typeof pendingForReview>;
	read(rel: string): string;
	close(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pihouse-compact-"));
	openMemory(root);
	const store = openOperationalStore(join(root, "memory.sqlite"), { legacy: true });
	const paths = vaultPaths(root);
	return {
		root,
		store,
		capture(runId, revision = 1, agents = [{ id: "planner" }, { id: "executor", role: "executor" }]) {
			const ev = evidence(PROJECT, `${runId}-${revision}`, agents);
			const fingerprint = evidenceFingerprint(ev);
			const id = persistEvidence(store.db, {
				runId,
				revision,
				fingerprint,
				evidence: ev,
				capturedAt: `2026-11-05T10:0${revision}:00Z`,
			});
			mkdirSync(paths.transcripts(runId), { recursive: true });
			writeFileSync(paths.runJson(runId), JSON.stringify({ id: runId, fingerprint, project: PROJECT, revision }));
			writeFileSync(paths.runReport(runId), "# Report\n\nREPORT_SECRET\n");
			for (const agent of agents) {
				if (agent.messages === "none") continue;
				const t: Transcript = {
					harness: "claude",
					sessionId: agent.id,
					source: `/raw/${agent.id}.jsonl`,
					model: "claude-sonnet-5-5",
					messages: agent.messages ?? DEFAULT_MESSAGES(),
				};
				writeFileSync(join(paths.transcripts(runId), `${agent.id}.json`), JSON.stringify(t));
				writeFileSync(join(paths.transcripts(runId), `${agent.id}.jsonl`), "RAW_JSONL_SECRET\n");
			}
			return { id, fingerprint, runId };
		},
		revisions: () => pendingForReview(store.db),
		read: (rel) => readFileSync(join(root, rel), "utf8"),
		close() {
			try {
				store.close();
			} catch {
				// A test closed it to let the search code open its own connection.
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

interface Calls {
	compact: WorkerJob[];
	review: WorkerJob[];
	reviewInput: string[];
}

interface Script {
	/** Called inside the review child, before it answers. */
	during?: (job: WorkerJob) => void;
	/** Replaces the review child's output. */
	review?: (job: WorkerJob, base: Record<string, unknown>) => string | WorkerResult;
	compact?: (job: WorkerJob) => string | WorkerResult;
	proposals?: unknown[];
}

/** A fake child for both stages. It reads its input file like a real child. */
function fakeWorker(f: Fixture, script: Script = {}) {
	const calls: Calls = { compact: [], review: [], reviewInput: [] };
	const worker = async (job: WorkerJob): Promise<WorkerResult> => {
		const input = readFileSync(job.inputPath, "utf8");
		const ok = (text: string): WorkerResult => ({ status: "success", outputPath: job.outputPath, outputText: text });
		if (job.id.startsWith("compact-")) {
			calls.compact.push(job);
			const custom = script.compact?.(job);
			if (custom !== undefined) return typeof custom === "string" ? ok(custom) : custom;
			const row = f.store.db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(job.revision);
			return ok(
				JSON.stringify({
					schemaVersion: 1,
					runId: row?.run_id,
					revision: job.revision,
					fingerprint: row?.source_hash,
					project: PROJECT,
					sections: Object.fromEntries(COMPACT_SECTIONS.map((key) => [key, `compact ${job.revision} ${key}`])),
				}),
			);
		}
		calls.review.push(job);
		calls.reviewInput.push(input);
		script.during?.(job);
		const contract = job.contract ?? "";
		const json = contract.slice(contract.indexOf("{"), contract.indexOf("\n}\n") + 2);
		const shape = JSON.parse(json) as { reviewId: string; covered: string[]; previousReview: string | null };
		const base = {
			schemaVersion: 1,
			reviewId: shape.reviewId,
			covered: shape.covered,
			previousReview: shape.previousReview,
			sections: Object.fromEntries(REVIEW_SECTIONS.map((key) => [key, `review ${key} of ${shape.covered.join("+")}`])),
			proposals: script.proposals ?? [],
		};
		const custom = script.review?.(job, base);
		if (custom !== undefined) return typeof custom === "string" ? ok(custom) : custom;
		return ok(JSON.stringify(base));
	};
	return { worker, calls };
}

const proposalFor = (supporting: string[]) => ({
	kind: "memory-rule",
	scope: "project",
	target: "memory:rules/tests-first",
	before: "",
	after: "Write the failing test first.",
	supporting,
	opposing: [],
	conditions: [],
	uncertainty: "two runs only",
	validation: "read the next run",
});

const options = (f: Fixture, worker: (job: WorkerJob) => Promise<WorkerResult>, at = "2026-11-05T14:30:00.000Z") => ({
	root: f.root,
	db: f.store.db,
	worker,
	cwd: f.root,
	confirm: () => true,
	now: () => new Date(at),
});

const transcriptsOf = (f: Fixture, runId: string) => {
	const dir = vaultPaths(f.root).transcripts(runId);
	return existsSync(dir) ? readdirSync(dir) : [];
};
const reviewFiles = (f: Fixture) => readdirSync(vaultPaths(f.root).reviewsDir).filter((name) => !name.startsWith("."));
const failedStep = (result: ReviewResult) => (result.status === "failed" ? result.step : result.status);

test("with nothing pending it says so and starts no agent", async () => {
	const f = fixture();
	try {
		const { worker, calls } = fakeWorker(f);
		let asked = 0;
		const result = await runReview({
			...options(f, worker),
			confirm: () => {
				asked++;
				return true;
			},
		});
		assert.deepEqual(result, { status: "nothing-pending" });
		assert.equal(asked, 0);
		assert.equal(calls.compact.length + calls.review.length, 0);
	} finally {
		f.close();
	}
});

test("planReview counts pending runs and the ones without a valid compact", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const { worker } = fakeWorker(f);
		await runReview({ ...options(f, worker), confirm: () => false });
		const plan = planReview({ root: f.root, db: f.store.db });
		assert.equal(plan.pending, 2);
		assert.equal(plan.missing, 2);
	} finally {
		f.close();
	}
});

test("a declined confirmation starts no agent and writes nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const { worker, calls } = fakeWorker(f);
		const result = await runReview({ ...options(f, worker), confirm: () => false });
		assert.equal(result.status, "declined");
		if (result.status === "declined") assert.deepEqual([result.plan.pending, result.plan.missing], [1, 1]);
		assert.equal(calls.compact.length + calls.review.length, 0);
		assert.deepEqual(reviewFiles(f), []);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "captured");
	} finally {
		f.close();
	}
});

test("a run with a valid compact is not compacted again", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const warm = fakeWorker(f);
		// run-b is busy, so the first review compacts and reviews run-a alone.
		const result1 = await runReview({ ...options(f, warm.worker), isActive: (run) => run === "run-b" });
		assert.equal(result1.status, "reviewed");
		assert.deepEqual(
			warm.calls.compact.map((j) => j.revision),
			["run-a.r1"],
		);
		const cold = fakeWorker(f);
		const result2 = await runReview({ ...options(f, cold.worker, "2026-11-05T15:00:00.000Z") });
		assert.equal(result2.status, "reviewed");
		assert.deepEqual(
			cold.calls.compact.map((j) => j.revision),
			["run-b.r1"],
		);
	} finally {
		f.close();
	}
});

test("a valid review writes the file, creates the proposals, marks exactly the covered revisions and cleans them", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const { worker } = fakeWorker(f, { proposals: [proposalFor(["run-a.r1", "run-b.r1"])] });
		const result = await runReview(options(f, worker));
		assert.equal(result.status, "reviewed", JSON.stringify(result));
		if (result.status !== "reviewed") return;
		assert.equal(result.reviewId, "review-20261105T143000Z");
		assert.deepEqual(result.covered, ["run-a.r1", "run-b.r1"]);
		assert.deepEqual(reviewFiles(f), ["review-20261105T143000Z.md"]);
		const text = f.read("workflow/reviews/review-20261105T143000Z.md");
		assert.match(text, /- Covered: run-a\.r1, run-b\.r1/);
		const committed = f.store.db.prepare("SELECT hash FROM artifact_commits WHERE id = ?").get(result.reviewId);
		assert.equal(committed?.hash, sha(text), "search checks the review against this hash");
		assert.ok(f.store.db.prepare("SELECT 1 FROM index_entries WHERE id = ?").get(`review:${result.reviewId}`));
		assert.deepEqual({ created: result.intake.created, merged: result.intake.merged }, { created: 1, merged: 0 });
		assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 1);
		for (const id of ["run-a.r1", "run-b.r1"]) assert.equal(stageOf(f.store.db, id), "reviewed");
		const row = f.store.db.prepare("SELECT review_id FROM run_stages WHERE revision_id = 'run-a.r1'").get();
		assert.equal(row?.review_id, "review-20261105T143000Z");
		assert.deepEqual(
			result.cleanup.map((c) => c.status),
			["cleaned", "cleaned"],
		);
		assert.deepEqual(transcriptsOf(f, "run-a"), []);
		assert.deepEqual(transcriptsOf(f, "run-b"), []);
		assert.ok(existsSync(join(f.root, "workflow", "compact", "run-a.r1.md")), "compacts stay");
		assert.ok(existsSync(join(f.root, "conversations", "run-a", "run.json")), "run.json stays");
		assert.deepEqual(pendingForReview(f.store.db), []);
	} finally {
		f.close();
	}
});

test("the review input holds no transcript path, no report and no older compact than the pending ones", async () => {
	const f = fixture();
	try {
		f.capture("run-a", 1);
		const first = fakeWorker(f);
		await runReview({ ...options(f, first.worker), confirm: () => true, isActive: () => false, project: PROJECT });
		// run-a.r1 is now reviewed; the run continues and is captured again as r2.
		f.capture("run-a", 2);
		f.capture("run-b", 1);
		const { worker, calls } = fakeWorker(f);
		const result = await runReview(options(f, worker, "2026-11-05T15:00:00.000Z"));
		assert.equal(result.status, "reviewed", JSON.stringify(result));
		const input = calls.reviewInput[0];
		assert.doesNotMatch(input, /transcripts/);
		assert.doesNotMatch(input, /\.jsonl/);
		assert.doesNotMatch(input, /report\.md/);
		assert.doesNotMatch(input, /compact run-a\.r1 /, "the reviewed r1 compact is older than the pending ones");
		assert.match(input, /compact run-a\.r2 objective/);
		assert.match(input, /compact run-b\.r1 objective/);
		assert.match(input, /## Previous review: review-20261105T143000Z/);
		assert.deepEqual(calls.review[0].readDirs?.length, 1);
		for (const dir of calls.review[0].readDirs ?? []) assert.doesNotMatch(dir, /conversations|workflow/);
	} finally {
		f.close();
	}
});

const invalidCases: [string, (f: Fixture) => Script, string][] = [
	["a child output that is not JSON", () => ({ review: () => "not json" }), "validate"],
	[
		"a child output that names another review",
		() => ({ review: (_job, base) => JSON.stringify({ ...base, reviewId: "review-other" }) }),
		"validate",
	],
	["a failed child", () => ({ review: () => ({ status: "failure" }) }), "child"],
	["a cancelled child", () => ({ review: () => ({ status: "cancelled" }) }), "child"],
	["proposals that cite an unknown revision", () => ({ proposals: [proposalFor(["nope.r9"])] }), "intake"],
	["a proposal that changes nothing", () => ({ proposals: [{ ...proposalFor(["run-a.r1"]), after: "" }] }), "intake"],
];
for (const [name, script, step] of invalidCases) {
	test(`${name} leaves every revision unreviewed and every conversation present`, async () => {
		const f = fixture();
		try {
			f.capture("run-a");
			f.capture("run-b");
			const { worker } = fakeWorker(f, script(f));
			const result = await runReview(options(f, worker));
			assert.equal(failedStep(result), step, JSON.stringify(result));
			for (const id of ["run-a.r1", "run-b.r1"]) assert.equal(stageOf(f.store.db, id), "compacted");
			assert.deepEqual(
				transcriptsOf(f, "run-a").sort(),
				["planner.json", "planner.jsonl", "executor.json", "executor.jsonl"].sort(),
			);
			assert.equal(transcriptsOf(f, "run-b").length, 4);
			assert.deepEqual(reviewFiles(f), [], "no review file is left behind");
			assert.ok(existsSync(join(f.root, "workflow", "compact", "run-a.r1.md")), "compacts stay");
			assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 0);
		} finally {
			f.close();
		}
	});
}

test("a failed compact stops the review at the compact step and keeps the compacts that succeeded", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const { worker, calls } = fakeWorker(f, {
			compact: (job) => (job.revision === "run-b.r1" ? "garbage" : undefined) as never,
		});
		const result = await runReview(options(f, worker));
		assert.equal(failedStep(result), "compact", JSON.stringify(result));
		assert.equal(calls.review.length, 0);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "compacted");
		assert.equal(stageOf(f.store.db, "run-b.r1"), "captured");
	} finally {
		f.close();
	}
});

test("a second review reads the latest review and the new compacts, and keeps the carried-forward section", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const first = fakeWorker(f);
		await runReview(options(f, first.worker));
		f.capture("run-b");
		const second = fakeWorker(f, {
			review: (_job, base) =>
				JSON.stringify({
					...base,
					sections: { ...(base.sections as object), carriedForward: "From review-20261105T143000Z: tests come first." },
				}),
		});
		const result = await runReview(options(f, second.worker, "2026-11-12T09:00:00.000Z"));
		assert.equal(result.status, "reviewed", JSON.stringify(result));
		const input = second.calls.reviewInput[0];
		assert.match(input, /review carriedForward of run-a\.r1/, "the first review text is in the input");
		assert.match(input, /compact run-b\.r1 objective/);
		assert.doesNotMatch(input, /compact run-a\.r1 objective/, "run-a is reviewed; its compact is not an input again");
		const text = f.read("workflow/reviews/review-20261112T090000Z.md");
		assert.match(text, /- Previous review: review-20261105T143000Z/);
		assert.match(text, /## Carried forward\nFrom review-20261105T143000Z: tests come first\./);
		assert.deepEqual(reviewFiles(f).sort(), ["review-20261105T143000Z.md", "review-20261112T090000Z.md"]);
	} finally {
		f.close();
	}
});

test("a revision captured again while the review ran is not marked reviewed with its stale compact", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const { worker } = fakeWorker(f, { during: () => void f.capture("run-a", 2) });
		const result = await runReview(options(f, worker));
		assert.equal(failedStep(result), "stale", JSON.stringify(result));
		assert.equal(stageOf(f.store.db, "run-a.r1"), "compacted");
		assert.equal(stageOf(f.store.db, "run-a.r2"), "captured");
		assert.equal(stageOf(f.store.db, "run-b.r1"), "compacted");
		assert.deepEqual(reviewFiles(f), []);
		assert.equal(transcriptsOf(f, "run-b").length, 4);
	} finally {
		f.close();
	}
});

test("a conversation whose evidence changed after the review is kept, even though the revision is marked", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const { worker } = fakeWorker(f);
		const result = await runReview({ ...options(f, worker), currentFingerprint: () => "f".repeat(64) });
		assert.equal(result.status, "reviewed");
		if (result.status === "reviewed") assert.equal(result.cleanup[0]?.status, "blocked");
		assert.equal(transcriptsOf(f, "run-a").length, 4);
	} finally {
		f.close();
	}
});

test("more compacts than the input bound leave the rest for the next review", async () => {
	const f = fixture();
	try {
		for (let i = 0; i < 12; i++) f.capture(`run-${String(i).padStart(2, "0")}`);
		// Each compact is padded close to its 6,000 character limit through the facts-free sections.
		const big = (job: WorkerJob) => {
			const row = f.store.db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(job.revision);
			return JSON.stringify({
				schemaVersion: 1,
				runId: row?.run_id,
				revision: job.revision,
				fingerprint: row?.source_hash,
				project: PROJECT,
				sections: Object.fromEntries(COMPACT_SECTIONS.map((key) => [key, `${key} ${"x".repeat(700)}`])),
			});
		};
		const { worker, calls } = fakeWorker(f, { compact: big });
		const result = await runReview(options(f, worker));
		assert.equal(result.status, "reviewed", JSON.stringify(result));
		if (result.status !== "reviewed") return;
		assert.ok(calls.reviewInput[0].length <= REVIEW_INPUT_MAX_CHARS);
		assert.ok(result.deferred.length > 0);
		assert.equal(result.covered.length + result.deferred.length, 12);
		for (const id of result.deferred) assert.equal(stageOf(f.store.db, id), "compacted");
		for (const id of result.covered) assert.equal(stageOf(f.store.db, id), "reviewed");
	} finally {
		f.close();
	}
});

test("smoke: capture, compact, review, approve a file proposal; transcripts go, compacts stay", async () => {
	const f = fixture();
	// macOS temp folders sit behind symlinks, which `file:` rightly refuses.
	const dir = mkdtempSync(join(realpathSync(tmpdir()), "vault-smoke-"));
	try {
		const file = join(dir, "notes.md");
		writeFileSync(file, "old\n");
		f.capture("run-a");
		f.capture("run-b");
		const { worker } = fakeWorker(f, {
			proposals: [
				{
					...proposalFor(["run-a.r1", "run-b.r1"]),
					kind: "edit-file",
					target: `file:${file}`,
					before: "old\n",
					after: "new\n",
				},
			],
		});
		const result = await runReview(options(f, worker));
		assert.equal(result.status, "reviewed", JSON.stringify(result));
		assert.deepEqual(transcriptsOf(f, "run-a"), []);
		assert.ok(existsSync(join(f.root, "workflow", "compact", "run-b.r1.md")));
		const [listed] = listProposals(f.store.db);
		assert.ok(listed, "the review created a proposal");
		const proposal = getProposal(f.store.db, listed.id);
		approveProposal(f.store.db, proposal.id, proposal.version);
		const target = createProposalTarget({
			repoRoot: f.root,
			storeRoot: join(f.root, "store"),
			target: `file:${file}`,
			proposalId: proposal.id,
			home: dir,
		});
		const applied = await applyProposal(f.store.db, proposal.id, target);
		assert.equal(applied.state, "applied");
		assert.equal(readFileSync(file, "utf8"), "new\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		f.close();
	}
});
