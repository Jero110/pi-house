import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createProposalTarget } from "../src/workflow/proposal-target.ts";
import { applyProposal, approveProposal, createProposal } from "../src/workflow/proposals.ts";

test("catalog skill target applies with same-directory CAS and preserves a private backup", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-target-"));
	try {
		const skill = join(root, "skills", "build", "sample");
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(root, "skills", "catalog.json"),
			JSON.stringify({ groups: [{ id: "build" }], skills: [{ name: "sample", group: "build" }] }),
		);
		writeFileSync(join(skill, "SKILL.md"), "---\nname: sample\n---\nold\n");
		const target = createProposalTarget({
			repoRoot: root,
			storeRoot: join(root, "store"),
			target: "skill:sample",
			proposalId: "p1",
		});
		const before = await target.read();
		assert.equal(await target.compareAndSwap(before, "---\nname: sample\n---\nnew\n"), true);
		assert.equal(await target.validate(), true);
		assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "---\nname: sample\n---\nnew\n");
		assert.equal(await target.compareAndSwap(before, "clobber"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("approval and application create a verified receipt against a real skill file", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-apply-"));
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY, proposal_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)",
	);
	try {
		const skill = join(root, "skills", "build", "sample");
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(root, "skills", "catalog.json"),
			JSON.stringify({ groups: [{ id: "build" }], skills: [{ name: "sample", group: "build" }] }),
		);
		const before = "---\nname: sample\n---\nold\n";
		writeFileSync(join(skill, "SKILL.md"), before);
		const proposal = createProposal(db, {
			id: "real",
			target: "skill:sample",
			before,
			after: "---\nname: sample\n---\nnew\n",
			evidence: ["run"],
		});
		approveProposal(db, proposal.id, proposal.version);
		const target = createProposalTarget({
			repoRoot: root,
			storeRoot: join(root, "store"),
			target: proposal.target,
			proposalId: proposal.id,
		});
		assert.equal((await applyProposal(db, proposal.id, target)).state, "applied");
		const receipt = JSON.parse(String(db.prepare("SELECT payload FROM receipts WHERE id = 'real'").get()?.payload));
		assert.equal(typeof receipt.beforeHash, "string");
		assert.equal(typeof receipt.afterHash, "string");
		assert.equal(receipt.validation, true);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("unsafe, unlisted and symlink targets are refused", () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-target-"));
	try {
		mkdirSync(join(root, "skills", "build", "listed"), { recursive: true });
		writeFileSync(
			join(root, "skills", "catalog.json"),
			JSON.stringify({ groups: [{ id: "build" }], skills: [{ name: "listed", group: "build" }] }),
		);
		writeFileSync(join(root, "skills", "build", "listed", "SKILL.md"), "---\nname: listed\n---\n");
		mkdirSync(join(root, "outside"), { recursive: true });
		writeFileSync(join(root, "outside", "SKILL.md"), "---\nname: listed\n---\n");
		symlinkSync(join(root, "outside"), join(root, "skills", "build", "linked"));
		writeFileSync(
			join(root, "skills", "catalog.json"),
			JSON.stringify({ groups: [{ id: "build" }], skills: [{ name: "linked", group: "build" }] }),
		);
		assert.throws(
			() => createProposalTarget({ repoRoot: root, storeRoot: root, target: "skill:linked", proposalId: "p" }),
			/Symlink/,
		);
		for (const name of ["../outside", "/tmp/no", "missing"])
			assert.throws(() =>
				createProposalTarget({ repoRoot: root, storeRoot: root, target: `skill:${name}`, proposalId: "p" }),
			);
		assert.throws(() =>
			createProposalTarget({ repoRoot: root, storeRoot: root, target: "unknown:x", proposalId: "p" }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
