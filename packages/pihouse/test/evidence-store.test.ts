import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistEvidence } from "../src/workflow/evidence-store.ts";
import type { WorkflowEvidence, WorkflowEvidenceParticipant } from "../src/workflow/report.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function participant(overrides: Partial<WorkflowEvidenceParticipant> = {}): WorkflowEvidenceParticipant {
	return {
		id: "planner",
		parent: null,
		role: "planner",
		harness: "pihouse",
		model: "luna",
		taskId: null,
		taskTitle: null,
		assignedSkills: ["planner"],
		loadedSkills: [],
		usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1 },
		activeMs: 4000,
		messages: 2,
		missing: null,
		summary: { assistantMessages: 2, slowestMs: 3000, failedToolCalls: 0, toolCalls: 4 },
		...overrides,
	};
}

function evidence(title: string): WorkflowEvidence {
	return {
		lineage: `lineage-${title}`,
		lineageStatus: "root-id",
		forkProvenance: "unknown",
		destructiveEligibility: "deferred",
		title,
		project: `/synthetic/${title}`,
		plan: `docs/plans/${title}.md`,
		participants: [
			participant(),
			participant({
				id: "worker",
				parent: "planner",
				role: "worker",
				harness: "codex",
				model: "",
				taskId: "T1",
				taskTitle: "synthetic task",
				assignedSkills: ["test-driven-development"],
				loadedSkills: ["test-driven-development"],
				usage: {},
				activeMs: null,
				messages: null,
				missing: "source unavailable",
				summary: null,
			}),
		],
		metrics: {
			newTokens: 16,
			cacheRead: 3,
			activeMs: 4000,
			wallMs: 6000,
			agents: 2,
			messages: 2,
		},
		cursor: { planner: { sourceId: "cursor-secret", appendedRecordIds: ["record-secret"] } },
	};
}

const fingerprint = (value: WorkflowEvidence) => sha(JSON.stringify(value));

interface Fixture {
	dir: string;
	store: OperationalStore;
}

function fixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-evidence-store-"));
	return { dir, store: openOperationalStore(join(dir, "memory.sqlite"), { fts: false }) };
}

function done(f: Fixture): void {
	f.store.close();
	rmSync(f.dir, { recursive: true, force: true });
}

const count = (f: Fixture, table: string) =>
	Number(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1);

const persist = (
	f: Fixture,
	input: { runId: string; revision: number; evidence: WorkflowEvidence; capturedAt?: string; fingerprint?: string },
) =>
	persistEvidence(f.store.db, {
		runId: input.runId,
		revision: input.revision,
		fingerprint: input.fingerprint ?? fingerprint(input.evidence),
		evidence: input.evidence,
		capturedAt: input.capturedAt ?? "2026-10-26T10:00:00.000Z",
	});

test("two distinct runs both at revision 1 receive globally distinct safe revision ids", () => {
	const f = fixture();
	try {
		const first = evidence("alpha");
		const second = evidence("beta");
		const firstId = persist(f, { runId: "run-alpha", revision: 1, evidence: first });
		const secondId = persist(f, { runId: "run-beta", revision: 1, evidence: second });
		assert.notEqual(firstId, secondId);
		assert.ok(firstId.includes("run-alpha"));
		assert.ok(secondId.includes("run-beta"));
		assert.match(firstId, /^[a-z0-9][a-z0-9._-]*$/i);
		assert.doesNotMatch(firstId, /:/);
		assert.deepEqual(
			f.store.db
				.prepare("SELECT id, run_id FROM revisions ORDER BY id")
				.all()
				.map((row) => [row.id, row.run_id]),
			[
				[firstId, "run-alpha"],
				[secondId, "run-beta"],
			],
		);
		assert.equal(count(f, "runs"), 2);
	} finally {
		done(f);
	}
});

test("the same immutable snapshot is idempotent and adds no duplicate rows", () => {
	const f = fixture();
	try {
		const value = evidence("idempotent");
		const first = persist(f, { runId: "run-idempotent", revision: 1, evidence: value });
		const rows = {
			runs: count(f, "runs"),
			revisions: count(f, "revisions"),
			participants: count(f, "participants"),
			metrics: count(f, "metrics"),
		};
		const second = persist(f, { runId: "run-idempotent", revision: 1, evidence: value });
		assert.equal(second, first);
		assert.deepEqual(
			{
				runs: count(f, "runs"),
				revisions: count(f, "revisions"),
				participants: count(f, "participants"),
				metrics: count(f, "metrics"),
			},
			rows,
		);
	} finally {
		done(f);
	}
});

test("drift under the same immutable revision is refused and rolls back every row", () => {
	const f = fixture();
	try {
		const original = evidence("stable");
		const revision = persist(f, { runId: "run-stable", revision: 1, evidence: original });
		const rows = {
			runs: count(f, "runs"),
			revisions: count(f, "revisions"),
			participants: count(f, "participants"),
			metrics: count(f, "metrics"),
		};
		const drift = evidence("changed");
		assert.throws(() => persist(f, { runId: "run-stable", revision: 1, evidence: drift }), /immutable|conflict/i);
		assert.deepEqual(
			{
				runs: count(f, "runs"),
				revisions: count(f, "revisions"),
				participants: count(f, "participants"),
				metrics: count(f, "metrics"),
			},
			rows,
		);
		assert.equal(
			f.store.db.prepare("SELECT source_hash FROM revisions WHERE id = ?").get(revision)?.source_hash,
			fingerprint(original),
		);
	} finally {
		done(f);
	}
});

test("participant metrics and lineage remain readable for the cleanup contract, with unknown as null", () => {
	const f = fixture();
	try {
		const value = evidence("readable");
		const revision = persist(f, { runId: "run-readable", revision: 1, evidence: value });
		const metrics = f.store.db
			.prepare("SELECT kind, value FROM metrics WHERE revision_id = ? ORDER BY id")
			.all(revision);
		const lineages = f.store.db
			.prepare("SELECT role, payload FROM participants WHERE revision_id = ? ORDER BY id")
			.all(revision);
		assert.ok(metrics.length > 0);
		assert.ok(lineages.length > 0);
		for (const row of metrics) assert.doesNotThrow(() => JSON.parse(String(row.value)));
		for (const row of lineages) assert.doesNotThrow(() => JSON.parse(String(row.payload)));

		const workerLineage = JSON.parse(String(lineages[1].payload));
		assert.equal(workerLineage.parent, "planner");
		assert.equal(workerLineage.role, "worker");
		assert.equal(workerLineage.harness, "codex");
		assert.equal(workerLineage.model, "");
		assert.equal(workerLineage.missing, "source unavailable");
		assert.equal(workerLineage.validation, "unknown");

		const workerMetrics = metrics
			.filter((row) => String(row.kind).startsWith("participant.2."))
			.map((row) => [row.kind, JSON.parse(String(row.value))] as const);
		const usage = workerMetrics.find(([kind]) => String(kind).endsWith(".usage"))?.[1];
		const activity = workerMetrics.find(([kind]) => String(kind).endsWith(".activity"))?.[1];
		assert.deepEqual(usage, {
			participantId: "worker",
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
		});
		assert.deepEqual(activity, {
			participantId: "worker",
			activeMs: null,
			messages: null,
			summary: null,
		});

		const runMetrics = JSON.parse(String(metrics.find((row) => row.kind === "run.metrics")?.value));
		assert.equal(runMetrics.agents, 2);
		const validation = JSON.parse(String(metrics.find((row) => row.kind === "validation")?.value));
		assert.equal(validation.outcome, "unknown");
		assert.equal(count(f, "cleanup_manifests"), 0, "this helper has no deletion authority");
	} finally {
		done(f);
	}
});

test("null run metrics stay null instead of becoming zero", () => {
	const f = fixture();
	try {
		const value = evidence("unknown-metrics");
		value.metrics = { newTokens: null, cacheRead: null, activeMs: null, wallMs: null, agents: 2, messages: null };
		const revision = persist(f, { runId: "run-unknown", revision: 1, evidence: value });
		const row = f.store.db
			.prepare("SELECT value FROM metrics WHERE revision_id = ? AND kind = 'run.metrics'")
			.get(revision);
		assert.deepEqual(JSON.parse(String(row?.value)), {
			newTokens: null,
			cacheRead: null,
			activeMs: null,
			wallMs: null,
			agents: 2,
			messages: null,
		});
	} finally {
		done(f);
	}
});

test("the fingerprint must be the canonical evidence JSON hash, and cursor or transcript text is not stored", () => {
	const f = fixture();
	try {
		const value = evidence("fingerprint");
		const fileStyleHash = sha(`${JSON.stringify(value)}\n`);
		assert.throws(
			() => persist(f, { runId: "run-fingerprint", revision: 1, evidence: value, fingerprint: fileStyleHash }),
			/fingerprint/i,
		);
		assert.equal(count(f, "runs"), 0);
		const revision = persist(f, { runId: "run-fingerprint", revision: 1, evidence: value });
		const stored = f.store.db
			.prepare(
				"SELECT value AS text FROM metrics WHERE revision_id = ? UNION ALL SELECT payload AS text FROM participants WHERE revision_id = ?",
			)
			.all(revision, revision)
			.map((row) => String(row.text))
			.join("\n");
		assert.doesNotMatch(stored, /cursor-secret|record-secret/);
	} finally {
		done(f);
	}
});
