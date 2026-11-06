import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createProposalTarget } from "../src/workflow/proposal-target.ts";
import { applyProposal, approveProposal, createProposal, rollbackProposal } from "../src/workflow/proposals.ts";

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

test("target drift before apply fails without touching user bytes or creating a receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-drift-"));
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
		const userBytes = "---\nname: sample\n---\nuser edit\n";
		writeFileSync(join(skill, "SKILL.md"), before);
		const proposal = createProposal(db, {
			id: "drift",
			target: "skill:sample",
			before,
			after: "---\nname: sample\n---\nnew\n",
			evidence: ["run"],
		});
		approveProposal(db, proposal.id, proposal.version);
		writeFileSync(join(skill, "SKILL.md"), userBytes);
		const target = createProposalTarget({
			repoRoot: root,
			storeRoot: join(root, "store"),
			target: proposal.target,
			proposalId: proposal.id,
		});
		assert.equal((await applyProposal(db, proposal.id, target)).state, "failed");
		assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), userBytes);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'application'").get()?.n, 0);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback refuses a real skill file changed after application", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-rollback-"));
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
		writeFileSync(join(skill, "SKILL.md"), "---\nname: sample\n---\nold\n");
		const proposal = createProposal(db, {
			id: "rollback",
			target: "skill:sample",
			before: "---\nname: sample\n---\nold\n",
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
		const userBytes = "---\nname: sample\n---\nuser edit\n";
		writeFileSync(join(skill, "SKILL.md"), userBytes);
		await assert.rejects(rollbackProposal(db, proposal.id, target), /changed/);
		assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), userBytes);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("memory approved-record target is writable; unsafe kinds and traversal are refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-memory-target-"));
	try {
		const records = join(root, "workflow", "approved-records", "preference");
		mkdirSync(records, { recursive: true });
		writeFileSync(join(records, "x.md"), "before");
		const target = createProposalTarget({
			repoRoot: root,
			storeRoot: root,
			target: "memory:preference/x",
			proposalId: "p",
		});
		assert.equal(await target.compareAndSwap("before", "after"), true);
		assert.equal(await target.read(), "after");
		assert.throws(() =>
			createProposalTarget({ repoRoot: root, storeRoot: root, target: "memory:../x", proposalId: "p" }),
		);
		assert.throws(() =>
			createProposalTarget({ repoRoot: root, storeRoot: root, target: "memory:other/x", proposalId: "p" }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a leftover lock fails application with actionable recovery guidance", async () => {
	const root = mkdtempSync(join(tmpdir(), "proposal-stale-lock-"));
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
			id: "locked",
			target: "skill:sample",
			before,
			after: "---\nname: sample\n---\nnew\n",
			evidence: ["run"],
		});
		approveProposal(db, proposal.id, proposal.version);
		writeFileSync(join(skill, "SKILL.md.pihouse-lock"), "crashed writer");
		const target = createProposalTarget({
			repoRoot: root,
			storeRoot: join(root, "store"),
			target: proposal.target,
			proposalId: proposal.id,
		});
		const result = await applyProposal(db, proposal.id, target);
		assert.equal(result.state, "failed");
		assert.match(result.reason ?? "", /lock file exists.*verify no application is active.*remove it manually/i);
		assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), before);
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

const fileDb = () => {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY, proposal_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)",
	);
	return db;
};
// macOS temp folders sit behind symlinks (/var -> /private/var), which `file:` rightly refuses.
const realTmp = () => mkdtempSync(join(realpathSync(tmpdir()), "file-target-"));
const fileTarget = (root: string, path: string, id: string, home?: string) =>
	createProposalTarget({
		repoRoot: root,
		storeRoot: join(root, "store"),
		target: `file:${path}`,
		proposalId: id,
		home,
	});

test("file target is created, approved with its version, applied; the backup holds the old bytes", async () => {
	const root = realTmp();
	const db = fileDb();
	try {
		const file = join(root, "notes.txt");
		writeFileSync(file, "old\n");
		const proposal = createProposal(db, {
			id: "f1",
			target: `file:${file}`,
			before: "old\n",
			after: "new\n",
			evidence: ["r"],
		});
		approveProposal(db, proposal.id, proposal.version);
		const applied = await applyProposal(db, "f1", fileTarget(root, file, "f1"));
		assert.equal(applied.state, "applied");
		assert.equal(readFileSync(file, "utf8"), "new\n");
		const found = readdirSync(join(root, "store"), { recursive: true }).map(String);
		const backup = found.find((name) => name.endsWith(".before"));
		assert.ok(backup, found.join(","));
		assert.equal(readFileSync(join(root, "store", backup), "utf8"), "old\n");
		assert.equal(applied.before, "old\n");
		assert.equal(applied.after, "new\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("file target refuses relative, missing, directory, symlink, parent symlink and forbidden paths", () => {
	const root = realTmp();
	try {
		mkdirSync(join(root, "dir"));
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "a.txt"), "x");
		symlinkSync(join(root, "real", "a.txt"), join(root, "link.txt"));
		symlinkSync(join(root, "real"), join(root, "linkdir"));
		const forbidden = [
			"auth.json",
			"mcp-auth.json",
			".env",
			".env.local",
			"k.pem",
			"id_rsa",
			"id_rsa.pub",
			"id_ed25519",
		];
		for (const name of forbidden) writeFileSync(join(root, name), "x");
		writeFileSync(join(root, ".env.example"), "x");
		const home = join(root, "home");
		for (const dir of [".ssh", ".aws", ".gnupg", ".pihouse/agent", ".pi/agent"]) {
			mkdirSync(join(home, dir), { recursive: true });
			writeFileSync(join(home, dir, "auth.txt"), "x");
		}
		writeFileSync(join(home, ".pihouse", "agent", "auth-extra.txt"), "x");
		const inHome = [
			".ssh/auth.txt",
			".aws/auth.txt",
			".gnupg/auth.txt",
			".pihouse/agent/auth-extra.txt",
			".pi/agent/auth.txt",
		];
		for (const bad of [
			"relative.txt",
			"./a.txt",
			join(root, "missing.txt"),
			join(root, "dir"),
			join(root, "link.txt"),
			join(root, "linkdir", "a.txt"),
			`${root}/real/../real/a.txt`,
			...inHome.map((path) => join(home, path)),
			...forbidden.map((name) => join(root, name)),
		])
			assert.throws(() => fileTarget(root, bad, "p", home), Error, bad);
		assert.doesNotThrow(() => fileTarget(root, join(root, ".env.example"), "p", home));
		assert.doesNotThrow(() => fileTarget(root, join(root, "real", "a.txt"), "p", home));
		assert.equal(readdirSync(root).includes("store"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("file target apply refuses when the file changed since the proposal", async () => {
	const root = realTmp();
	const db = fileDb();
	try {
		const file = join(root, "n.txt");
		writeFileSync(file, "old");
		const proposal = createProposal(db, {
			id: "f2",
			target: `file:${file}`,
			before: "old",
			after: "new",
			evidence: ["r"],
		});
		approveProposal(db, proposal.id, proposal.version);
		writeFileSync(file, "edited by someone");
		const result = await applyProposal(db, "f2", fileTarget(root, file, "f2"));
		assert.equal(result.state, "failed");
		assert.equal(readFileSync(file, "utf8"), "edited by someone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("file target validation: invalid JSON restores the original, empty files are rejected, valid JSON applies", async () => {
	const root = realTmp();
	const db = fileDb();
	try {
		const run = async (name: string, before: string, after: string) => {
			const file = join(root, name);
			writeFileSync(file, before);
			const proposal = createProposal(db, { id: `v-${name}`, target: `file:${file}`, before, after, evidence: ["r"] });
			approveProposal(db, proposal.id, proposal.version);
			const result = await applyProposal(db, proposal.id, fileTarget(root, file, proposal.id));
			return { state: result.state, bytes: readFileSync(file, "utf8") };
		};
		assert.deepEqual(await run("bad.json", '{"a":1}', '{"a":'), { state: "failed", bytes: '{"a":1}' });
		assert.deepEqual(await run("empty.txt", "something", "  \n"), { state: "failed", bytes: "something" });
		assert.deepEqual(await run("good.json", '{"a":1}', '{"a":2}'), { state: "applied", bytes: '{"a":2}' });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
