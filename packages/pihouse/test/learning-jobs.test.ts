import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { claimJob, enqueueJob, finishJob, isQuiescent } from "../src/workflow/jobs.ts";

test("claims are exclusive and expired leases recover without accepting stale results", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
	enqueueJob(db, "job", "revision", "hash");
	const first = claimJob(db, "job", "manual", 0, 10);
	assert.ok(first);
	assert.equal(claimJob(db, "job", "manual", 1, 10), null);
	const second = claimJob(db, "job", "manual", 11, 10);
	assert.ok(second);
	assert.equal(finishJob(db, first, "success", "hash", 12), false);
	assert.equal(finishJob(db, second, "success", "changed", 12), true);
	assert.equal(db.prepare("SELECT state FROM jobs WHERE id = ?").get("job")?.state, "deferred");
	db.close();
});

test("a different process cannot claim a live lease and can recover it after expiry", () => {
	const dir = mkdtempSync(join(tmpdir(), "learning-jobs-"));
	try {
		const path = join(dir, "jobs.sqlite");
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
		enqueueJob(db, "job", "revision", "hash");
		assert.ok(claimJob(db, "job", "manual", 0, 10));
		const module = new URL("../src/workflow/jobs.ts", import.meta.url).href;
		const script = `import { DatabaseSync } from 'node:sqlite'; import { claimJob } from ${JSON.stringify(module)}; const db = new DatabaseSync(process.argv[1]); console.log(JSON.stringify(claimJob(db, 'job', 'manual', Number(process.argv[2]), 10))); db.close();`;
		const child = (now: number) =>
			spawnSync(process.execPath, ["--input-type=module", "-e", script, path, String(now)], { encoding: "utf8" });
		const blocked = child(1);
		assert.equal(blocked.status, 0, blocked.stderr);
		assert.equal(JSON.parse(blocked.stdout), null);
		const recovered = child(11);
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.ok(JSON.parse(recovered.stdout).token);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cancellation is free and completed failures are bounded per invocation", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
	enqueueJob(db, "job", "revision", "hash");
	const cancelled = claimJob(db, "job", "manual", 0, 10);
	assert.ok(cancelled);
	assert.ok(finishJob(db, cancelled, "cancelled", "hash", 1));
	for (let i = 0; i < 2; i++) {
		const claim = claimJob(db, "job", "manual", 2, 10);
		assert.ok(claim);
		assert.ok(finishJob(db, claim, "failure", "hash", 3));
	}
	assert.equal(claimJob(db, "job", "manual", 4, 10), null);
	assert.ok(claimJob(db, "job", "next-manual", 4, 10));
	db.close();
});

test("only known idle participants and settled delivery state are quiescent", () => {
	assert.equal(isQuiescent({ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: true }), true);
	for (const state of ["working", "starting", "asking", "unknown"]) {
		assert.equal(isQuiescent({ states: [state], deliveries: 0, handoff: false, livenessKnown: true }), false);
	}
	assert.equal(isQuiescent({ states: ["idle"], deliveries: 1, handoff: false, livenessKnown: true }), false);
	assert.equal(isQuiescent({ states: ["idle"], deliveries: 0, handoff: true, livenessKnown: true }), false);
	assert.equal(isQuiescent({ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: false }), false);
});
