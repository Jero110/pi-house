// `/workflow review`, `/workflow proposals <id>` and the compact tool behind `/workflow ask`, against a temp vault and a
// fake child. No hub, no model, no network: the worker is a function that writes what a real child would.
import assert from "node:assert/strict";
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
import type { Transcript } from "agent-transcripts";
import { COMPACT_SECTIONS } from "../src/workflow/compact-contract.ts";
import { evidenceFingerprint, persistEvidence } from "../src/workflow/evidence-store.ts";
import {
	compactProjectCommand,
	LEARNING_MODEL_ENV,
	type LearningDeps,
	learningModel,
	proposalDetail,
	reviewCommand,
} from "../src/workflow/learning-commands.ts";
import { openMemory } from "../src/workflow/memory.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
import { REVIEW_SECTIONS } from "../src/workflow/review-contract.ts";
import type { ReviewPlan } from "../src/workflow/review-run.ts";
import { stageOf } from "../src/workflow/run-stages.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";
import { unifiedDiff } from "../src/workflow/unified-diff.ts";
import { vaultPaths } from "../src/workflow/vault-paths.ts";
import type { WorkerJob, WorkerResult } from "../src/workflow/worker-adapter.ts";

const PROJECT = "/work/app";
const OTHER = "/work/other";

function evidence(project: string, tag: string): WorkflowEvidence {
	return {
		lineage: `lineage-${tag}`,
		lineageStatus: "root-id",
		forkProvenance: "unknown",
		destructiveEligibility: "deferred",
		title: tag,
		project,
		plan: null,
		participants: [
			{
				id: `${tag}-agent`,
				parent: null,
				role: "planner",
				harness: "claude",
				model: "claude-sonnet-5-5",
				taskId: null,
				taskTitle: null,
				assignedSkills: [],
				loadedSkills: [],
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
				activeMs: 1,
				messages: 1,
				missing: null,
				summary: null,
			},
		],
		metrics: { newTokens: 1, cacheRead: 0, activeMs: 1, wallMs: 1, agents: 1, messages: 1 },
		cursor: {},
	};
}

function fixture() {
	// The real path: a `file:` target refuses a folder that is a symlink, and /var is one on macOS.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "review-command-")));
	openMemory(root);
	const store = openOperationalStore(join(root, "memory.sqlite"), { legacy: true });
	const paths = vaultPaths(root);
	const capture = (runId: string, project = PROJECT) => {
		const ev = evidence(project, runId);
		const fingerprint = evidenceFingerprint(ev);
		const id = persistEvidence(store.db, {
			runId,
			revision: 1,
			fingerprint,
			evidence: ev,
			capturedAt: "2026-11-05T10:01:00Z",
		});
		mkdirSync(paths.transcripts(runId), { recursive: true });
		writeFileSync(paths.runJson(runId), JSON.stringify({ id: runId, fingerprint, project, revision: 1 }));
		const t: Transcript = {
			harness: "claude",
			sessionId: `${runId}-agent`,
			source: "/raw/x.jsonl",
			model: "claude-sonnet-5-5",
			messages: [{ index: 0, at: 1, role: "user", origin: "human", text: "please add login", tools: [], skills: [] }],
		};
		writeFileSync(join(paths.transcripts(runId), `${runId}-agent.json`), JSON.stringify(t));
		writeFileSync(join(paths.transcripts(runId), `${runId}-agent.jsonl`), "RAW\n");
		return id;
	};
	return {
		root,
		store,
		capture,
		transcripts: (runId: string) => (existsSync(paths.transcripts(runId)) ? readdirSync(paths.transcripts(runId)) : []),
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

type Fixture = ReturnType<typeof fixture>;

/** A fake child for compact and review jobs. `proposals` are what the review child proposes. */
function fakeWorker(f: Fixture, proposals: unknown[] = []) {
	const jobs: string[] = [];
	const worker = async (job: WorkerJob): Promise<WorkerResult> => {
		jobs.push(job.id);
		const ok = (text: string): WorkerResult => ({ status: "success", outputPath: job.outputPath, outputText: text });
		if (job.id.startsWith("compact-")) {
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
		const contract = job.contract ?? "";
		const shape = JSON.parse(contract.slice(contract.indexOf("{"), contract.indexOf("\n}\n") + 2)) as {
			reviewId: string;
			covered: string[];
			previousReview: string | null;
		};
		return ok(
			JSON.stringify({
				schemaVersion: 1,
				reviewId: shape.reviewId,
				covered: shape.covered,
				previousReview: shape.previousReview,
				sections: Object.fromEntries(REVIEW_SECTIONS.map((key) => [key, `review ${key}`])),
				proposals,
			}),
		);
	};
	return { worker, jobs };
}

function deps(f: Fixture, extra: Partial<LearningDeps> = {}): LearningDeps {
	return {
		memory: f.root,
		journalDir: join(f.root, "journal"),
		env: {},
		cwd: PROJECT,
		backend: "tmux",
		modelAvailable: () => true,
		progress: () => {},
		isActive: () => false,
		currentFingerprint: (runId) => {
			const row = f.store.db
				.prepare("SELECT source_hash FROM revisions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
				.get(runId);
			return typeof row?.source_hash === "string" ? row.source_hash : undefined;
		},
		now: () => 1_793_000_000_000,
		...extra,
	};
}

const filePlan = (file: string, supporting: string[]) => ({
	kind: "edit-file",
	scope: "project",
	target: `file:${file}`,
	before: "old line\nkept line\n",
	after: "new line\nkept line\n",
	supporting,
	opposing: [],
	conditions: [],
	uncertainty: "two runs only",
	validation: "read the next run",
});

test("the default learning model is the Claude bridge Sonnet, changed only by the environment variable", () => {
	assert.equal(LEARNING_MODEL_ENV, "PIHOUSE_LEARNING_MODEL");
	assert.equal(learningModel({}), "claude-bridge/claude-sonnet-5-5");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "  " }), "claude-bridge/claude-sonnet-5-5");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "openai/gpt-x" }), "openai/gpt-x");
});

test("review without the hub says so, starts nothing and writes nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const outcome = await reviewCommand(deps(f));
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /need the agent-link hub.*Nothing was started/);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "captured");
	} finally {
		f.close();
	}
});

test("review with a model that does not resolve starts nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const outcome = await reviewCommand(
			deps(f, {
				env: { AGENT_LINK_AGENT: "c", AGENT_LINK_HUB: "/nonexistent/hub.sock", AGENT_LINK_TOKEN: "t" },
				modelAvailable: () => false,
			}),
		);
		assert.match(
			outcome.text,
			/claude-bridge\/claude-sonnet-5-5 is not available.*PIHOUSE_LEARNING_MODEL.*Nothing was started/,
		);
	} finally {
		f.close();
	}
});

test("review with nothing pending says so and does not ask", async () => {
	const f = fixture();
	try {
		const { worker, jobs } = fakeWorker(f);
		let asked = 0;
		const outcome = await reviewCommand(
			deps(f, {
				worker,
				confirm: () => {
					asked++;
					return true;
				},
			}),
		);
		assert.equal(outcome.level, "info");
		assert.match(outcome.text, /Nothing to review/);
		assert.equal(asked, 0);
		assert.equal(jobs.length, 0);
	} finally {
		f.close();
	}
});

test("a declined confirmation reports the counts, starts no agent and writes nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		const { worker, jobs } = fakeWorker(f);
		let seen: ReviewPlan | undefined;
		const outcome = await reviewCommand(
			deps(f, {
				worker,
				confirm: (plan) => {
					seen = plan;
					return false;
				},
			}),
		);
		assert.equal(seen?.pending, 2);
		assert.equal(seen?.missing, 2);
		assert.match(outcome.text, /2 saved runs.*Nothing was started/);
		assert.equal(jobs.length, 0);
		assert.equal(readdirSync(vaultPaths(f.root).reviewsDir).length, 0);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "captured");
		assert.deepEqual(f.transcripts("run-a").sort(), ["run-a-agent.json", "run-a-agent.jsonl"]);
	} finally {
		f.close();
	}
});

test("without a confirmation dialog the count is reported and --yes is the second call", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const { worker, jobs } = fakeWorker(f);
		const outcome = await reviewCommand(deps(f, { worker }));
		assert.match(outcome.text, /1 saved run.*\/workflow review --yes.*Nothing was started/);
		assert.equal(jobs.length, 0);
	} finally {
		f.close();
	}
});

test("a confirmed review ends with the numbered proposals: id, version, target path and a reason", async () => {
	const f = fixture();
	const target = join(f.root, "notes.md");
	try {
		writeFileSync(target, "old line\nkept line\n");
		f.capture("run-a");
		f.capture("run-b");
		const { worker, jobs } = fakeWorker(f, [filePlan(target, ["run-a.r1", "run-b.r1"])]);
		const outcome = await reviewCommand(deps(f, { worker, confirm: () => true }));
		assert.equal(outcome.level, "info", outcome.text);
		assert.equal(jobs.filter((id) => id.startsWith("compact-")).length, 2);
		assert.match(outcome.text, /Reviewed 2 runs/);
		const line = outcome.text.split("\n").find((l) => l.startsWith("1. "));
		assert.ok(line, `a numbered line in:\n${outcome.text}`);
		assert.match(line, /proposal-[0-9a-f]+/);
		assert.ok(line.includes(target), "the target path is on the line");
		assert.match(line, /two runs only/);
		assert.match(outcome.text, /\/workflow proposals <id>/);
		// Reviewed revisions lost their conversations; the compacts stayed.
		assert.deepEqual(f.transcripts("run-a"), []);
		assert.ok(existsSync(vaultPaths(f.root).compactFile("run-a.r1")));
		assert.equal(stageOf(f.store.db, "run-a.r1"), "reviewed");
	} finally {
		f.close();
	}
});

test("a failed review names the step and leaves conversations and stages alone", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const outcome = await reviewCommand(deps(f, { worker: async () => ({ status: "failure" }), confirm: () => true }));
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /stopped at the compact step/);
		assert.match(outcome.text, /Nothing was marked reviewed/);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "captured");
		assert.equal(f.transcripts("run-a").length, 2);
	} finally {
		f.close();
	}
});

test("proposals <id> shows one proposal in full with the path and a unified diff", async () => {
	const f = fixture();
	const target = join(f.root, "notes.md");
	try {
		writeFileSync(target, "old line\nkept line\n");
		f.capture("run-a");
		const { worker } = fakeWorker(f, [filePlan(target, ["run-a.r1"])]);
		const reviewed = await reviewCommand(deps(f, { worker, confirm: () => true }));
		const id = /(proposal-[0-9a-f]+)/.exec(reviewed.text)?.[1];
		assert.ok(id);
		const shown = proposalDetail(f.store.db, id.slice(0, 14));
		assert.equal(shown.level, "info");
		assert.ok(shown.text.includes(target));
		assert.match(shown.text, /^--- .*notes\.md$/m);
		assert.match(shown.text, /^\+\+\+ .*notes\.md$/m);
		assert.match(shown.text, /^-old line$/m);
		assert.match(shown.text, /^\+new line$/m);
		assert.match(shown.text, /^ kept line$/m);
		assert.match(shown.text, /version [0-9a-f]{8}/);
		assert.match(shown.text, /two runs only/);
		assert.equal(proposalDetail(f.store.db, "nope").level, "warning");
	} finally {
		f.close();
	}
});

test("unifiedDiff marks added, removed and unchanged lines, and says nothing for equal text", () => {
	assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x", "x"), "");
	const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\nd\n", "before", "after");
	assert.match(diff, /^--- before\n\+\+\+ after\n@@ /);
	assert.match(diff, /\n a\n-b\n\+B\n c\n\+d/);
});

test("the compact tool compacts only this project's runs, marked ask, and never deletes or marks reviewed", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		f.capture("run-b");
		f.capture("run-x", OTHER);
		const { worker, jobs } = fakeWorker(f);
		const result = await compactProjectCommand(deps(f, { worker }), PROJECT);
		assert.equal(result.compacted, 2);
		assert.match(result.text, /Compacted 2 runs/);
		assert.deepEqual(jobs.sort(), ["compact-run-a.r1", "compact-run-b.r1"]);
		for (const id of ["run-a.r1", "run-b.r1"]) {
			const row = f.store.db.prepare("SELECT compacted_by, reviewed_at FROM run_stages WHERE revision_id = ?").get(id);
			assert.equal(row?.compacted_by, "ask");
			assert.equal(row?.reviewed_at, null);
			assert.equal(stageOf(f.store.db, id), "compacted");
		}
		assert.equal(stageOf(f.store.db, "run-x.r1"), "captured");
		for (const run of ["run-a", "run-b", "run-x"]) assert.equal(f.transcripts(run).length, 2, `${run} keeps its files`);
	} finally {
		f.close();
	}
});

test("the compact tool without the hub starts nothing", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const result = await compactProjectCommand(deps(f), PROJECT);
		assert.equal(result.compacted, 0);
		assert.match(result.text, /need the agent-link hub.*Nothing was started/);
		assert.equal(stageOf(f.store.db, "run-a.r1"), "captured");
	} finally {
		f.close();
	}
});

test("readFileSync of the review file keeps the reviewed conversation out of it", async () => {
	const f = fixture();
	try {
		f.capture("run-a");
		const { worker } = fakeWorker(f);
		const outcome = await reviewCommand(deps(f, { worker, confirm: () => true }));
		assert.equal(outcome.level, "info");
		const file = readdirSync(vaultPaths(f.root).reviewsDir).find((name) => /^review-.*\.md$/.test(name));
		assert.ok(file);
		assert.doesNotMatch(readFileSync(join(vaultPaths(f.root).reviewsDir, file), "utf8"), /please add login|RAW/);
	} finally {
		f.close();
	}
});
