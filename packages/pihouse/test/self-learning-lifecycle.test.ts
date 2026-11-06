import assert from "node:assert/strict";
import {
	appendFileSync,
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
import type { SessionRecord } from "agent-link-core";
import { askContext, proposalCommand } from "../src/extensions/workflow.ts";
import { captureRun, captureRunOutcome } from "../src/workflow/capture.ts";
import { COMPACT_SECTIONS } from "../src/workflow/compact-contract.ts";
import { type LearningDeps, reviewCommand } from "../src/workflow/learning-commands.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { getProposal, shortVersion } from "../src/workflow/proposals.ts";
import { REVIEW_SECTIONS } from "../src/workflow/review-contract.ts";
import { pendingForReview, stageOf } from "../src/workflow/run-stages.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";
import type { WorkerJob, WorkerResult } from "../src/workflow/worker-adapter.ts";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-review-lifecycle-")));
	const memory = join(root, "memory");
	const journal = join(root, "journal");
	mkdirSync(journal);
	migrateLegacyStore(memory);
	return { root, memory, journal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function nativeMessage(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text },
	});
}

function captureSyntheticRun(
	f: ReturnType<typeof fixture>,
	id: string,
	time: number,
): { root: SessionRecord; source: string } {
	const source = join(f.root, `${id}.jsonl`);
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: `session-${id}`, cwd: f.root })}\n${nativeMessage(`${id}-1`, `${id} original evidence`)}\n`,
	);
	const root: SessionRecord = {
		id,
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: id,
		harness: "pihouse",
		model: null,
		cwd: f.root,
		state: "exited",
		depth: 0,
		sessionId: `session-${id}`,
		transcript: source,
		startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, time)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, time)).toISOString(),
	};
	const store = openMemory(f.memory);
	assert.equal(
		captureRun([root], root, store, { by: "planner", now: new Date(Date.UTC(2026, 0, 1, 0, 2, time)) }),
		"written",
	);
	return { root, source };
}

/** A fake child for both stages, answering like a real one from the revisions in the store and the contract it was given. */
function fakeWorker(f: ReturnType<typeof fixture>, target: string) {
	const jobs: string[] = [];
	const worker = async (job: WorkerJob): Promise<WorkerResult> => {
		jobs.push(job.id);
		const ok = (text: string): WorkerResult => ({ status: "success", outputPath: job.outputPath, outputText: text });
		const db = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		try {
			if (job.id.startsWith("compact-")) {
				const row = db.db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(job.revision);
				const project = JSON.parse(
					String(
						db.db.prepare("SELECT value FROM metrics WHERE revision_id = ? AND kind = 'run.lineage'").get(job.revision)
							?.value,
					),
				) as { project: string };
				return ok(
					JSON.stringify({
						schemaVersion: 1,
						runId: row?.run_id,
						revision: job.revision,
						fingerprint: row?.source_hash,
						project: project.project,
						sections: Object.fromEntries(
							COMPACT_SECTIONS.map((key) => [key, `the zebra layout ${key} of ${job.revision}`]),
						),
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
					sections: Object.fromEntries(
						REVIEW_SECTIONS.map((key) => [key, `review ${key} of ${shape.covered.join("+")}`]),
					),
					proposals: [
						{
							kind: "edit-file",
							scope: "global",
							target: `file:${target}`,
							before: "existing preference\n",
							after: "Run focused tests before committing.\n",
							supporting: shape.covered,
							opposing: [],
							conditions: [],
							uncertainty: "three runs only",
							validation: "read the next run",
						},
					],
				}),
			);
		} finally {
			db.close();
		}
	};
	return { worker, jobs };
}

function learningDeps(f: ReturnType<typeof fixture>, worker: LearningDeps["worker"]): LearningDeps {
	return {
		memory: f.memory,
		journalDir: f.journal,
		env: {},
		cwd: f.root,
		backend: "tmux",
		modelAvailable: () => true,
		progress: () => {},
		confirm: () => true,
		worker,
		isActive: () => false,
		currentFingerprint: (runId) => packageFingerprint(f, runId),
		now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
	};
}

function packageFingerprint(f: ReturnType<typeof fixture>, runId: string): string {
	return (
		JSON.parse(readFileSync(join(f.memory, "conversations", runId, "run.json"), "utf8")) as { fingerprint: string }
	).fingerprint;
}

test("lifecycle: capture, review with one confirmation, approve a file proposal, ask from the compacts, reopen a run", async () => {
	const f = fixture();
	try {
		const first = captureSyntheticRun(f, "run-a", 1);
		captureSyntheticRun(f, "run-b", 2);
		captureSyntheticRun(f, "run-c", 3);
		for (const id of ["run-a", "run-b", "run-c"]) {
			assert.ok(existsSync(join(f.memory, "conversations", id, "report.md")), "capture writes the computed report");
			assert.ok(existsSync(join(f.memory, "conversations", id, "transcripts")));
		}
		const target = join(f.root, "preferences.md");
		writeFileSync(target, "existing preference\n");
		const { worker, jobs } = fakeWorker(f, target);

		const outcome = await reviewCommand(learningDeps(f, worker));
		assert.equal(outcome.level, "info", outcome.text);
		assert.match(outcome.text, /Reviewed 3 runs \(3 compacted now\)/);
		assert.equal(jobs.filter((id) => id.startsWith("compact-")).length, 3);
		assert.equal(jobs.filter((id) => id.startsWith("review-")).length, 1, "one review for all three runs");
		const line = outcome.text.split("\n").find((l) => l.startsWith("1. "));
		assert.ok(line?.includes(target), "the numbered line names the target path");
		assert.doesNotMatch(outcome.text, /original evidence/);

		// Conversations are gone, the compacts and the computed reports stay, and every revision is reviewed.
		for (const id of ["run-a", "run-b", "run-c"]) {
			assert.equal(existsSync(join(f.memory, "conversations", id, "transcripts")), false, `${id} transcripts deleted`);
			assert.ok(existsSync(join(f.memory, "workflow", "compact", `${id}.r1.md`)), `${id} compact stays`);
			assert.ok(existsSync(join(f.memory, "conversations", id, "report.md")), `${id} report stays`);
		}
		const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		let proposalId = "";
		let version = "";
		try {
			for (const id of ["run-a", "run-b", "run-c"]) assert.equal(stageOf(store.db, `${id}.r1`), "reviewed");
			assert.deepEqual(pendingForReview(store.db), []);
			const row = store.db.prepare("SELECT id FROM proposals").get();
			proposalId = String(row?.id);
			const proposal = getProposal(store.db, proposalId);
			version = shortVersion(proposal.version);
			assert.equal(proposal.target, `file:${target}`);
			assert.equal(proposal.evidence.length, 3);
		} finally {
			store.close();
		}

		// A second review has nothing to do and asks nothing.
		let asked = 0;
		const again = await reviewCommand({
			...learningDeps(f, worker),
			confirm: () => {
				asked += 1;
				return true;
			},
		});
		assert.match(again.text, /Nothing to review/);
		assert.equal(asked, 0);

		// The proposal shows its diff, then approval writes the file and records a receipt.
		const detail = await proposalCommand("proposals", [proposalId], { memory: f.memory, repoRoot: f.root });
		assert.match(detail.text, /^-existing preference$/m);
		assert.match(detail.text, /^\+Run focused tests before committing\.$/m);
		const approved = await proposalCommand("approve", [proposalId, version], { memory: f.memory, repoRoot: f.root });
		assert.equal(approved.level, "info", approved.text);
		assert.match(approved.text, /Applied .*Receipt recorded/);
		assert.equal(readFileSync(target, "utf8"), "Run focused tests before committing.\n");

		// Ask answers from the compact and the review, never from a conversation.
		const answer = await askContext(
			"what happened with the zebra layout?",
			{ PIHOUSE_HOME: f.root, AGENT_LINK_HOME: join(f.root, "hub") },
			{ memoryDir: f.memory, cwd: f.root, isActive: () => false },
		);
		assert.match(answer, /compact:run-/);
		assert.match(answer, /zebra layout/);
		assert.doesNotMatch(answer, /original evidence|transcripts\/.*jsonl/);

		// New evidence in a reviewed run reopens it as a new revision, pending again.
		appendFileSync(first.source, `${nativeMessage("run-a-2", "new appended delta only")}\n`);
		const reopenedOutcome = captureRunOutcome([first.root], first.root, openMemory(f.memory), { by: "planner" });
		assert.deepEqual(reopenedOutcome, { status: "written" });
		const reopened = JSON.parse(readFileSync(join(f.memory, "conversations", "run-a", "run.json"), "utf8")) as {
			revision: number;
		};
		assert.equal(reopened.revision, 2);
		const pending = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		try {
			assert.deepEqual(
				pendingForReview(pending.db).map((r) => r.revisionId),
				["run-a.r2"],
			);
		} finally {
			pending.close();
		}
		assert.ok(
			readdirSync(join(f.memory, "conversations", "run-a", "transcripts")).length > 0,
			"the reopened run has its new conversation again",
		);
	} finally {
		f.cleanup();
	}
});
