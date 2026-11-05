import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Transcript, TranscriptMessage } from "agent-transcripts";
import { COMPACT_SECTIONS } from "../src/workflow/compact-contract.ts";
import { type CompactOutcome, compactRevisions } from "../src/workflow/compact-run.ts";
import { commitArtifact } from "../src/workflow/documents.ts";
import { evidenceFingerprint, persistEvidence, revisionIdFor } from "../src/workflow/evidence-store.ts";
import { openMemory } from "../src/workflow/memory.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
import { markReviewed, pendingForReview, stageOf } from "../src/workflow/run-stages.ts";
import { searchMemory, syncSearchIndex } from "../src/workflow/search.ts";
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

interface Seen {
	job: WorkerJob;
	prompt: string;
	contract: string;
}

/** A fake child. It reads the input file like a real child, and answers with `reply` or a valid compact. */
function fakeWorker(
	f: Fixture,
	reply?: (job: WorkerJob, seen: Seen) => string | WorkerResult | Promise<string | WorkerResult>,
) {
	const seen: Seen[] = [];
	let running = 0;
	let peak = 0;
	const worker = async (job: WorkerJob): Promise<WorkerResult> => {
		const entry: Seen = { job, prompt: readFileSync(job.inputPath, "utf8"), contract: job.contract ?? "" };
		seen.push(entry);
		running++;
		peak = Math.max(peak, running);
		try {
			await new Promise((resolve) => setTimeout(resolve, 15));
			const out = reply ? await reply(job, entry) : valid(f, job);
			if (typeof out !== "string") return out;
			return { status: "success", outputPath: job.outputPath, outputText: out };
		} finally {
			running--;
		}
	};
	return { worker, seen, peak: () => peak };
}

function valid(
	f: Fixture,
	job: WorkerJob,
	patch: Record<string, unknown> = {},
	sections: Record<string, unknown> = {},
) {
	const row = f.store.db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(job.revision);
	return JSON.stringify({
		schemaVersion: 1,
		runId: row?.run_id,
		revision: job.revision,
		fingerprint: row?.source_hash,
		project: PROJECT,
		sections: {
			...Object.fromEntries(COMPACT_SECTIONS.map((key) => [key, `text of ${key} with the word narwhalpattern`])),
			...sections,
		},
		...patch,
	});
}

const run = (f: Fixture, worker: (job: WorkerJob) => Promise<WorkerResult>, extra: Record<string, unknown> = {}) =>
	compactRevisions({
		root: f.root,
		db: f.store.db,
		revisions: f.revisions(),
		compactedBy: "review",
		worker,
		cwd: f.root,
		now: () => new Date("2026-11-05T14:30:00.000Z"),
		...extra,
	});

const compactFiles = (f: Fixture) => readdirSync(vaultPaths(f.root).compactDir).filter((name) => !name.startsWith("."));

test("a valid child output produces the file, the stage row and a searchable document", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		const { worker } = fakeWorker(f);
		const [outcome] = await run(f, worker);
		assert.equal(outcome.status, "compacted", outcome.reason ?? "");
		const rel = `workflow/compact/${r.id}.md`;
		const text = f.read(rel);
		assert.match(text, /^# Compact: run-a\.r1\n/);
		assert.ok(text.length <= 6_000);
		const row = f.store.db.prepare("SELECT * FROM run_stages WHERE revision_id = ?").get(r.id);
		assert.equal(row?.compact_path, rel);
		assert.equal(row?.compact_hash, sha(text));
		assert.equal(row?.compact_fingerprint, r.fingerprint);
		assert.equal(row?.compacted_by, "review");
		assert.equal(row?.compacted_at, "2026-11-05T14:30:00.000Z");
		assert.equal(stageOf(f.store.db, r.id), "compacted");
		f.store.close();
		assert.equal(syncSearchIndex(f.root).indexed, 1);
		const hits = searchMemory(f.root, "narwhalpattern", { project: "app", trusts: ["derived"] });
		assert.deepEqual(
			hits.map((h) => [h.id, h.kind]),
			[[`compact:${r.id}`, "compact"]],
		);
	} finally {
		f.close();
	}
});

test("a compact made for ask records ask", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		const [outcome] = await run(f, fakeWorker(f).worker, { compactedBy: "ask" });
		assert.equal(outcome.status, "compacted");
		assert.equal(
			f.store.db.prepare("SELECT compacted_by FROM run_stages WHERE revision_id = ?").get(r.id)?.compacted_by,
			"ask",
		);
		assert.match(f.read(`workflow/compact/${r.id}.md`), /- Compacted by: ask\n/);
	} finally {
		f.close();
	}
});

test("each invalid output writes nothing, counts as failed and leaves the revision uncompacted", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		const cases: Array<[string, (job: WorkerJob) => string | WorkerResult]> = [
			["not JSON", () => "I could not do it"],
			["a missing section", (job) => valid(f, job, {}, { decisions: undefined })],
			["a wrong identity", (job) => valid(f, job, { fingerprint: "0".repeat(64) })],
			["a wrong run", (job) => valid(f, job, { runId: "other" })],
			["over 6,000 characters once rendered", (job) => valid(f, job, {}, { objective: "x".repeat(7_000) })],
			["over 12,000 characters", (job) => valid(f, job, {}, { objective: "x".repeat(13_000) })],
			["a worker that failed", () => ({ status: "failure" })],
		];
		for (const [name, reply] of cases) {
			const [outcome] = await run(f, fakeWorker(f, reply).worker);
			assert.equal(outcome.status, "failed", name);
			assert.ok(outcome.reason, `${name} says why`);
			assert.deepEqual(compactFiles(f), [], `${name}: nothing written`);
			assert.equal(f.store.db.prepare("SELECT 1 FROM run_stages WHERE revision_id = ?").get(r.id), undefined, name);
			assert.equal(stageOf(f.store.db, r.id), "captured", name);
		}
	} finally {
		f.close();
	}
});

test("the facts come from the transcripts' usage even when the child output contradicts them", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		const lie = (job: WorkerJob) =>
			valid(f, job, { facts: { newTokens: 999_999 } }, { objective: "Tokens: 999999 new, 88 agents" });
		const [outcome] = await run(f, fakeWorker(f, lie).worker);
		assert.equal(outcome.status, "compacted");
		const text = f.read(`workflow/compact/${r.id}.md`);
		// Two participants with 1,500 new tokens each in their transcripts; the evidence said 1.
		assert.match(text, /- Tokens: 3\.0k new, 80k cache read \(2 agents\)/);
		assert.match(text, /\| planner \| planner \| claude \| claude-sonnet-5-5 \| 1\.5k \| 2 \(0\) \|/);
		assert.match(text, /- Plan: docs\/plans\/p\.md/);
		assert.match(text, /- Duration: 10m 0s wall, 2m 0s active/);
		assert.match(text, /- Skills loaded: spec-driven-development/);
		assert.ok(!text.includes("999999 new, 88 agents\n\n## Facts"), "the lie sits in a section, not in the facts");
	} finally {
		f.close();
	}
});

test("the prompt holds no tool output, no edit or write content, no report and no raw jsonl", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const probe = fakeWorker(f);
		const [outcome] = await run(f, probe.worker);
		assert.equal(outcome.status, "compacted");
		assert.equal(probe.seen.length, 1);
		const { prompt, contract, job } = probe.seen[0];
		for (const secret of ["TOOL_OUTPUT_SECRET", "TOOL_CONTENT_SECRET", "REPORT_SECRET", "RAW_JSONL_SECRET"]) {
			assert.ok(!prompt.includes(secret) && !contract.includes(secret), secret);
		}
		assert.ok(prompt.includes("HUMAN_ASK please add a login page"));
		assert.match(prompt, /untrusted/i);
		assert.match(prompt, /tool: bash ok npm test/);
		assert.match(prompt, /tool: write ok \/work\/app\/login\.ts/);
		assert.ok(contract.includes("run-a.r1") && contract.includes(PROJECT));
		assert.equal(job.stage, "review");
		assert.equal(job.maxOutputBytes, 12_000);
		assert.ok(!existsSync(job.inputPath), "the input file is removed afterwards");
	} finally {
		f.close();
	}
});

test("a participant without a transcript is missing evidence and its tokens are not guessed", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a", 1, [{ id: "planner" }, { id: "ghost", role: "worker", messages: "none" }]);
		const probe = fakeWorker(f);
		const [outcome] = await run(f, probe.worker);
		assert.equal(outcome.status, "compacted", outcome.reason ?? "");
		assert.match(probe.seen[0].prompt, /ghost[^\n]*\nno transcript: missing evidence/);
		const text = f.read(`workflow/compact/${r.id}.md`);
		assert.match(text, /\| ghost \| worker \| claude \| claude-sonnet-5-5 \| unknown \| missing transcript \|/);
		assert.match(text, /- Tokens: 1\.5k new, 40k cache read \(2 agents; 1 with unknown usage: ghost\)/);
	} finally {
		f.close();
	}
});

test("with 7 revisions never more than 3 children run at once, and a failed one does not stop the others", async () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 7; i++) f.capture(`run-${i}`);
		const probe = fakeWorker(f, (job) => (job.revision === "run-4.r1" ? { status: "failure" } : valid(f, job)));
		const outcomes = await run(f, probe.worker);
		assert.equal(probe.peak(), 3);
		assert.equal(probe.seen.length, 7);
		assert.deepEqual(
			outcomes.map((o) => o.status),
			["compacted", "compacted", "compacted", "failed", "compacted", "compacted", "compacted"],
		);
		assert.equal(compactFiles(f).length, 6);
	} finally {
		f.close();
	}
});

test("a revision whose run is still active is skipped and reported, not compacted", async () => {
	const f = fixture();
	try {
		f.capture("run-live");
		f.capture("run-done");
		const probe = fakeWorker(f);
		const outcomes = await run(f, probe.worker, { isActive: (runId: string) => runId === "run-live" });
		const byRun = Object.fromEntries(outcomes.map((o: CompactOutcome) => [o.runId, o.status]));
		assert.deepEqual(byRun, { "run-live": "skipped-active", "run-done": "compacted" });
		assert.equal(probe.seen.length, 1);
	} finally {
		f.close();
	}
});

test("running twice does not repeat the model call for a valid compact", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const first = fakeWorker(f);
		await run(f, first.worker);
		const second = fakeWorker(f);
		const [again] = await run(f, second.worker);
		assert.equal(again.status, "already-valid");
		assert.equal(second.seen.length, 0);
	} finally {
		f.close();
	}
});

test("a compact edited by hand is stale and is made again", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		await run(f, fakeWorker(f).worker);
		writeFileSync(join(f.root, `workflow/compact/${r.id}.md`), "# edited by hand\n");
		const again = fakeWorker(f);
		const [outcome] = await run(f, again.worker);
		assert.equal(outcome.status, "compacted", outcome.reason ?? "");
		assert.equal(again.seen.length, 1);
		assert.match(f.read(`workflow/compact/${r.id}.md`), /^# Compact: run-a\.r1/);
	} finally {
		f.close();
	}
});

test("a reviewed revision is never compacted again", async () => {
	const f = fixture();
	try {
		const r = f.capture("run-a");
		await run(f, fakeWorker(f).worker);
		markReviewed(f.store.db, [r.id], "review-20261105T150000Z");
		const probe = fakeWorker(f);
		const [outcome] = await compactRevisions({
			root: f.root,
			db: f.store.db,
			revisions: [
				{ revisionId: r.id, runId: "run-a", project: PROJECT, fingerprint: r.fingerprint, stage: "compacted" },
			],
			compactedBy: "ask",
			worker: probe.worker,
			cwd: f.root,
		});
		assert.equal(outcome.status, "already-reviewed");
		assert.equal(probe.seen.length, 0);
	} finally {
		f.close();
	}
});

test("a run that changes while the child works is not compacted", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const probe = fakeWorker(f, (job) => {
			writeFileSync(join(vaultPaths(f.root).transcripts("run-a"), "planner.json"), JSON.stringify({ messages: [] }));
			return valid(f, job);
		});
		const [outcome] = await run(f, probe.worker);
		assert.equal(outcome.status, "failed");
		assert.match(outcome.reason ?? "", /changed/);
		assert.deepEqual(compactFiles(f), []);
	} finally {
		f.close();
	}
});

test("a run package that does not match the revision is refused before any model call", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		writeFileSync(vaultPaths(f.root).runJson("run-a"), JSON.stringify({ id: "run-a", fingerprint: "0".repeat(64) }));
		const probe = fakeWorker(f);
		const [outcome] = await run(f, probe.worker);
		assert.equal(outcome.status, "failed");
		assert.equal(probe.seen.length, 0);
	} finally {
		f.close();
	}
});

test("a worker that reports a cancel counts as cancelled and writes nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const [outcome] = await run(f, fakeWorker(f, () => ({ status: "cancelled" })).worker);
		assert.equal(outcome.status, "cancelled");
		assert.deepEqual(compactFiles(f), []);
	} finally {
		f.close();
	}
});

test("revision ids stay what the stage code makes", () => {
	assert.equal(revisionIdFor("run-a", 2), "run-a.r2");
});

test("commitArtifact can set an exact file name and refuses a path in it; the default name is unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-commit-"));
	try {
		const named = commitArtifact({ root: dir, id: "run-a.r2", kind: "compact", content: "x", fileName: "run-a.r2.md" });
		assert.equal(named.path, join(dir, "run-a.r2.md"));
		assert.equal(readFileSync(named.path, "utf8"), "x");
		const plain = commitArtifact({ root: dir, id: "run-b", kind: "review", content: "y" });
		assert.equal(plain.path, join(dir, "review-run-b.md"));
		for (const bad of ["../escape.md", "a/b.md", "no-extension", ".hidden.md", "x.txt"])
			assert.throws(
				() => commitArtifact({ root: dir, id: "run-c", kind: "compact", content: "z", fileName: bad }),
				/file name/,
			);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
