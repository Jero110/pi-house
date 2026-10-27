import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { approveProposal, createProposal, getProposal, rejectProposal } from "../src/workflow/proposals.ts";

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
