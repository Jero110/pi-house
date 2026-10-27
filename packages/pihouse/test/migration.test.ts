import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openMemory, type RunPackage } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";

const T0 = Date.parse("2026-10-26T12:00:00Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function run(id: string): RunPackage {
	return {
		schema: 1,
		id,
		project: "/abs/p",
		projectSlug: "p",
		flaggedBy: "save",
		capturedAt: new Date(T0).toISOString(),
		title: `Run ${id}`,
		metrics: { newTokens: 1, cacheRead: 0, activeMs: 1, wallMs: 1, agents: 1, messages: 2 },
		agents: [],
	};
}

/** A legacy JSON store: pending, processed, claimed, rejected and applied records, a consulted note, flags. */
function legacy(): { dir: string; fingerprint: string } {
	const dir = join(mkdtempSync(join(tmpdir(), "pihouse-migration-")), "memory");
	const clock = { t: T0 };
	const store = openMemory(dir, { now: () => new Date(clock.t++) });
	const transcripts = [{ agentId: "a1", normalized: { messages: ["SECRET TRANSCRIPT"] } }];
	for (const id of ["pend", "done", "claim"]) store.writeRun(run(id), transcripts);
	store.markProcessed(["done"], "b-old");
	store.writeDigest("done", "---\nsummary: short old digest\n---\n\nshort");
	store.claimBatch(["claim"]);
	store.writeConsulted(
		{ id: "src1", title: "Source", project: "/abs/p", projectSlug: "p", source: "https://x" },
		"full consulted text",
		"consulted summary",
	);
	store.writeIdea({ id: "idea1", title: "Idea", project: "/abs/p", projectSlug: "p" }, "idea body");
	const rej = store.propose({ kind: "memory-rule", target: "m", change: "Rule to reject", evidence: "e" });
	const app = store.propose({ kind: "memory-rule", target: "m", change: "Rule applied", evidence: "e" });
	store.propose({ kind: "memory-rule", target: "m", change: "Rule left open", evidence: "e" });
	assert.equal(rej.result, "created");
	assert.equal(app.result, "created");
	if (rej.result !== "created" || app.result !== "created") throw new Error("setup");
	store.decide(rej.id, "rejected", "no");
	store.decide(app.id, "approved");
	store.markApplied(app.id);
	writeFileSync(join(dir, "flags.json"), JSON.stringify({ schema: 1, runs: { pend: { by: "save" } } }));
	store.writeWorkflowMemory("# memory\n");
	return { dir, fingerprint: rej.fingerprint };
}

const count = (db: DatabaseSync, table: string) =>
	(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const TABLES = [
	"index_entries",
	"rejected_fingerprints",
	"flags",
	"legacy_records",
	"runs",
	"revisions",
	"batches",
	"batch_members",
	"proposals",
	"receipts",
	"legacy_migrations",
];
function counts(dir: string): Record<string, number> {
	const db = new DatabaseSync(join(dir, "memory.sqlite"));
	try {
		return Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
	} finally {
		db.close();
	}
}
const crashAt = (name: string) => ({
	onBoundary: (b: string) => {
		if (b === name) throw new Error(`crash at ${b}`);
	},
});

test("imports every record kind with preserved ids, hashes and legacy coverage", () => {
	const { dir } = legacy();
	const before = openMemory(dir).readIndex();
	const result = migrateLegacyStore(dir);
	assert.equal(result.state, "active");
	const after = openMemory(dir).readIndex();
	assert.deepEqual(after, before, "ids and fields are preserved");
	const db = new DatabaseSync(join(dir, "memory.sqlite"));
	const rec = (id: string) =>
		db.prepare("SELECT * FROM legacy_records WHERE id = ?").get(id) as Record<string, unknown>;
	const runJson = readFileSync(join(dir, "runs/done/run.json"), "utf8");
	assert.equal(rec("run:done").source_sha256, sha(runJson));
	assert.equal(rec("run:pend").coverage, "legacy-unknown");
	assert.equal(rec("run:claim").legacy, 1);
	assert.equal(count(db, "batches"), 1);
	assert.equal(count(db, "flags"), 1);
	assert.ok(existsSync(join(dir, "migration-backup/manifest.json")));
	assert.ok(existsSync(join(dir, "index.json")), "source data is never deleted");
	db.close();
});

test("a rejection still blocks the same proposal after migration", () => {
	const { dir, fingerprint } = legacy();
	migrateLegacyStore(dir);
	const again = openMemory(dir).propose({ kind: "memory-rule", target: "m", change: "rule  to REJECT", evidence: "x" });
	assert.deepEqual(again, { result: "rejected-before", fingerprint });
});

test("consulted summary is reconciled and keeps the body hash", () => {
	const { dir } = legacy();
	migrateLegacyStore(dir);
	const db = new DatabaseSync(join(dir, "memory.sqlite"));
	const row = db.prepare("SELECT payload FROM legacy_records WHERE id = 'consulted:src1'").get() as { payload: string };
	const p = JSON.parse(row.payload) as Record<string, string>;
	assert.equal(p.indexSummary, "consulted summary");
	assert.match(p.fileSummary, /consulted summary/);
	assert.equal(p.bodySha256, sha("full consulted text"));
	db.close();
});

test("legacy processed run has no deletion authority and no transcript is read", () => {
	const { dir } = legacy();
	migrateLegacyStore(dir);
	const db = new DatabaseSync(join(dir, "memory.sqlite"));
	const r = db.prepare("SELECT * FROM legacy_records WHERE id = 'run:done'").get() as Record<string, unknown>;
	assert.equal(r.legacy, 1);
	assert.equal(r.coverage, "legacy-unknown");
	assert.equal(r.deletion_authority, "none");
	db.close();
});

test("a legacy applied proposal is unverified and has no receipt", () => {
	const { dir } = legacy();
	migrateLegacyStore(dir);
	const db = new DatabaseSync(join(dir, "memory.sqlite"));
	const states = (db.prepare("SELECT state FROM proposals").all() as { state: string }[]).map((r) => r.state).sort();
	assert.deepEqual(states, ["legacy-applied-unverified", "open", "rejected"]);
	assert.equal(count(db, "receipts"), 0);
	db.close();
});

for (const boundary of [
	"backup-copied",
	"backup-manifest",
	"backup-complete",
	"import-mid",
	"imported",
	"activating",
]) {
	test(`crash at ${boundary} then resume converges without duplicates`, () => {
		const { dir } = legacy();
		const clean = legacy();
		migrateLegacyStore(clean.dir);
		assert.throws(() => migrateLegacyStore(dir, crashAt(boundary)), /crash at/);
		assert.equal(migrateLegacyStore(dir).state, "active");
		assert.deepEqual(counts(dir), counts(clean.dir));
		assert.equal(migrateLegacyStore(dir).state, "active", "idempotent");
		assert.deepEqual(counts(dir), counts(clean.dir));
		const db = new DatabaseSync(join(dir, "memory.sqlite"));
		assert.equal(count(db, "receipts"), 0, "no false applied receipt");
		db.close();
		assert.equal(
			openMemory(dir).propose({ kind: "memory-rule", target: "m", change: "rule to reject", evidence: "" }).result,
			"rejected-before",
		);
	});
}

test("an incomplete backup of changed live files is replaced; a matching one is finished", () => {
	const { dir } = legacy();
	assert.throws(() => migrateLegacyStore(dir, crashAt("backup-copied")), /crash at/);
	writeFileSync(join(dir, "workflow-memory.md"), "# changed after the crash\n");
	assert.equal(migrateLegacyStore(dir).state, "active");
	const backed = readFileSync(join(dir, "migration-backup/files/workflow-memory.md"), "utf8");
	assert.equal(backed, "# changed after the crash\n");
});

test("drift after a completed backup is refused and nothing is imported", () => {
	const { dir } = legacy();
	assert.throws(() => migrateLegacyStore(dir, crashAt("backup-complete")), /crash at/);
	writeFileSync(join(dir, "workflow-memory.md"), "# drifted\n");
	assert.throws(() => migrateLegacyStore(dir), /drift/i);
	assert.ok(!existsSync(join(dir, "migration-active.json")));
	assert.equal(readFileSync(join(dir, "migration-backup/files/workflow-memory.md"), "utf8"), "# memory\n");
});

test("concurrent mutations from two processes after activation lose nothing", async () => {
	const { dir } = legacy();
	migrateLegacyStore(dir);
	const base = openMemory(dir).readIndex().length;
	const code = `import { openMemory } from ${JSON.stringify(new URL("../src/workflow/memory.ts", import.meta.url).href)};
const s = openMemory(process.argv[1]);
for (let i = 0; i < 25; i++) s.writeIdea({ id: "child" + i, title: "t", project: "p", projectSlug: "p" }, "b");`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code, dir], { stdio: "inherit" });
	const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
	const mine = openMemory(dir);
	for (let i = 0; i < 25; i++) mine.writeIdea({ id: `parent${i}`, title: "t", project: "p", projectSlug: "p" }, "b");
	assert.equal(await done, 0);
	assert.equal(openMemory(dir).readIndex().length, base + 50);
});

test("a corrupt or missing sqlite file after activation is a diagnosed error, not an empty memory", () => {
	const { dir } = legacy();
	migrateLegacyStore(dir);
	writeFileSync(join(dir, "memory.sqlite"), "not a database");
	assert.throws(() => openMemory(dir).readIndex(), /memory\.sqlite/);
	rmSync(join(dir, "memory.sqlite"));
	assert.throws(() => openMemory(dir), /memory\.sqlite/);
	mkdirSync(dir, { recursive: true });
});
