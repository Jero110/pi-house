import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingestReview } from "../src/workflow/proposal-intake.ts";
import { listProposals, rejectProposal } from "../src/workflow/proposals.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const entry = (refs: string[], reopen?: string) => ({
	kind: "skill",
	scope: "project",
	target: "skill:sample",
	before: "old",
	after: "new",
	supporting: refs,
	opposing: [],
	conditions: [],
	uncertainty: "low",
	validation: "npm test",
	...(reopen ? { reopen } : {}),
});
const review = (entries: unknown[]) =>
	`Review output\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, proposals: entries })}\n\`\`\``;
const block = (refs: string[], reopen?: string) => review([entry(refs, reopen)]);

test("intake deduplicates run lineage evidence, is idempotent and records failed malformed intake", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-intake-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		for (const [rev, run] of [
			["r1", "run1"],
			["r2", "run2"],
			["r3", "run3"],
		]) {
			store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(run, "now");
			store.db
				.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(rev, run, "h", "now");
		}
		const review = block(["r1", "r2", "r3"]);
		assert.deepEqual(ingestReview(store.db, "review1", review), {
			status: "ingested",
			created: 1,
			merged: 0,
			suppressed: 0,
		});
		assert.deepEqual(ingestReview(store.db, "review1", review), {
			status: "ingested",
			created: 1,
			merged: 0,
			suppressed: 0,
		});
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 1);
		assert.deepEqual(ingestReview(store.db, "broken", "no contract"), {
			status: "failed",
			reason: "Error: expected exactly one fenced JSON block",
		});
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'intake-failure'").get()?.n, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("support counts distinct runs, not digest revisions of the same run", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-support-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		for (const [ref, run] of [
			["a1", "run-a"],
			["b1", "run-b"],
			["c1", "run-c"],
			["a2", "run-a"],
			["a3", "run-a"],
		]) {
			store.db.prepare("INSERT OR IGNORE INTO runs(id, created_at) VALUES (?, ?)").run(run, "now");
			store.db
				.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(ref, run, ref, "now");
		}
		assert.equal(ingestReview(store.db, "three-runs", block(["a1", "b1", "c1"])).status, "ingested");
		assert.equal(listProposals(store.db)[0]?.supportingRuns, 3);
		assert.equal(
			ingestReview(store.db, "one-run", review([{ ...entry(["a1", "a2", "a3"]), target: "skill:another" }])).status,
			"ingested",
		);
		const proposals = listProposals(store.db);
		assert.equal(proposals.length, 2);
		assert.deepEqual(proposals.map((proposal) => proposal.supportingRuns).sort(), [1, 3]);
		const threeRunId = proposals.find((proposal) => proposal.supportingRuns === 3)?.id;
		assert.ok(threeRunId);
		const threeRun = store.db.prepare("SELECT payload FROM proposals WHERE id = ?").get(threeRunId);
		assert.equal(new Set(JSON.parse(String(threeRun?.payload)).evidence).size, 3);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("separate reviews merge evidence into one proposal and preserve merge history", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-merge-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		for (const run of ["run-a", "run-b"]) {
			store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(run, "now");
			store.db
				.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(`r-${run}`, run, "h", "now");
		}
		ingestReview(store.db, "review-a", block(["r-run-a"]));
		ingestReview(store.db, "review-b", block(["r-run-b"]));
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 1);
		const proposal = listProposals(store.db)[0];
		assert.equal(proposal?.supportingRuns, 2);
		const payload = JSON.parse(
			String(store.db.prepare("SELECT payload FROM proposals WHERE id = ?").get(proposal?.id)?.payload),
		);
		assert.equal(payload.history.length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejection suppresses matching reviews; reopen requires explicit explanation and new run evidence", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-reopen-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		for (const run of ["run-a", "run-b"]) {
			store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(run, "now");
			store.db
				.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(`r-${run}`, run, "h", "now");
		}
		ingestReview(store.db, "original", block(["r-run-a"]));
		const proposalId = String(store.db.prepare("SELECT id FROM proposals").get()?.id);
		rejectProposal(store.db, proposalId, "not actionable");
		assert.deepEqual(ingestReview(store.db, "suppressed", block(["r-run-b"])), {
			status: "ingested",
			created: 0,
			merged: 0,
			suppressed: 1,
		});
		assert.deepEqual(ingestReview(store.db, "same-reopen", block(["r-run-a"], "new evidence")), {
			status: "ingested",
			created: 0,
			merged: 0,
			suppressed: 1,
		});
		assert.equal(
			JSON.parse(String(store.db.prepare("SELECT payload FROM proposals WHERE id = ?").get(proposalId)?.payload)).state,
			"rejected",
		);
		assert.deepEqual(ingestReview(store.db, "new-reopen", block(["r-run-b"], "material new independent run")), {
			status: "ingested",
			created: 0,
			merged: 1,
			suppressed: 0,
		});
		const reopened = JSON.parse(
			String(store.db.prepare("SELECT payload FROM proposals WHERE id = ?").get(proposalId)?.payload),
		);
		assert.equal(reopened.state, "open");
		assert.equal(reopened.history.length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unknown digest reference fails atomically and records the intake failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-unknown-ref-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('run-a', 'now')").run();
		store.db
			.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES ('r-known', 'run-a', 'h', 'now')")
			.run();
		const invalidEntries = review([entry(["r-known"]), { ...entry(["missing"]), target: "skill:other" }]);
		assert.equal(ingestReview(store.db, "unknown-ref", invalidEntries).status, "failed");
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 0);
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'intake-failure'").get()?.n, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
