import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
	applyProposal,
	approveProposal,
	createProposal,
	getProposal,
	mergeEvidence,
	rejectProposal,
	rollbackProposal,
} from "../src/workflow/proposals.ts";

test("approval pins the displayed version and rejection persists across reopening", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL)");
	const proposal = createProposal(db, { id: "p1", target: "skill", before: "old", after: "new", evidence: ["run1"] });
	assert.throws(() => approveProposal(db, "p1", "stale"), /version/);
	assert.equal(approveProposal(db, "p1", proposal.version).state, "approved");
	assert.equal(rejectProposal(db, "p1", "not needed").state, "rejected");
	assert.equal(getProposal(db, "p1").state, "rejected");
	db.close();
});

test("rejected recommendations require an explicit material-evidence decision to reopen", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL)");
	const p = createProposal(db, { id: "p", target: "skill", before: "old", after: "new", evidence: ["r1"] });
	rejectProposal(db, "p", "no");
	assert.throws(() => mergeEvidence(db, "p", ["r1"], { kind: "reopen", explanation: "new facts" }), /new evidence/);
	assert.equal(getProposal(db, "p").state, "rejected");
	const reopened = mergeEvidence(db, "p", ["r1", "r2", "r2"], { kind: "reopen", explanation: "independent new fact" });
	assert.deepEqual(reopened.evidence, ["r1", "r2"]);
	assert.equal(reopened.state, "open");
	assert.notEqual(reopened.version, p.version);
	assert.throws(() => approveProposal(db, "p", p.version), /version/);
	db.close();
});

test("application requires observed changed bytes and validation; rollback refuses user edits", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY, proposal_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)",
	);
	const p = createProposal(db, { id: "p", target: "skill", before: "old", after: "new", evidence: ["run"] });
	approveProposal(db, "p", p.version);
	let bytes = "old";
	const target = {
		read: async () => bytes,
		compareAndSwap: async (expected: string, next: string) => {
			if (bytes !== expected) return false;
			bytes = next;
			return true;
		},
		validate: async () => true,
	};
	assert.equal((await applyProposal(db, "p", target)).state, "applied");
	assert.equal(db.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 1);
	bytes = "user edit";
	await assert.rejects(rollbackProposal(db, "p", target), /changed/);
	assert.equal(bytes, "user edit");
	bytes = "new";
	await rollbackProposal(db, "p", target);
	assert.equal(bytes, "old");
	db.close();
});

test("no-op, stale and failed validation never become applied", async () => {
	for (const mode of ["noop", "stale", "invalid"]) {
		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY, proposal_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		const p = createProposal(db, { id: "p", target: "skill", before: "old", after: "new", evidence: ["run"] });
		approveProposal(db, "p", p.version);
		let bytes = mode === "stale" ? "user edit" : "old";
		const target = {
			read: async () => bytes,
			compareAndSwap: async (_expected: string, next: string) => {
				if (mode !== "noop") bytes = next;
				return true;
			},
			validate: async () => mode !== "invalid",
		};
		assert.equal((await applyProposal(db, "p", target)).state, "failed");
		assert.equal(db.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
		db.close();
	}
});
