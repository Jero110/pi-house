import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { claimJob, dispatchCleanup, dispatchJobs, enqueueJob, finishJob, isQuiescent } from "../src/workflow/jobs.ts";

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

test("isolated bounded dispatch continues past failure and persists attempts across restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "learning-dispatch-"));
	try {
		const path = join(dir, "jobs.sqlite");
		let db = new DatabaseSync(path);
		db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
		enqueueJob(db, "a", "r1", "hash1");
		enqueueJob(db, "b", "r2", "hash2");
		const requests: unknown[] = [];
		const jobs = [
			{ id: "a", revision: "r1", evidencePath: "/evidence/a", fingerprint: "hash1" },
			{ id: "b", revision: "r2", evidencePath: "/evidence/b", fingerprint: "hash2" },
		];
		const adapter = async (request: { id: string; revision: string; evidencePath: string }) => {
			requests.push(request);
			if (request.id === "a") throw new Error("private error detail");
			return { status: "success" as const, artifactPath: "/digests/b", fingerprint: "hash2" };
		};
		const first = await dispatchJobs(db, jobs, {
			invocation: "manual",
			now: () => 1,
			leaseMs: 10,
			maxJobs: 2,
			adapter,
		});
		assert.deepEqual(first, [
			{ id: "a", status: "failed" },
			{ id: "b", status: "generated", path: "/digests/b" },
		]);
		assert.deepEqual(
			requests,
			jobs.map(({ id, revision, evidencePath }) => ({ id, revision, evidencePath })),
		);
		db.close();
		db = new DatabaseSync(path);
		assert.equal(claimJob(db, "a", "manual", 2, 10, 1), null);
		assert.equal(claimJob(db, "b", "manual", 2, 10), null);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dispatch enforces its job and evidence path bounds", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
	enqueueJob(db, "a", "r1", "hash");
	enqueueJob(db, "b", "r2", "hash");
	let launches = 0;
	const adapter = async () => {
		launches++;
		return { status: "success" as const, artifactPath: "/digest", fingerprint: "hash" };
	};
	const jobs = [
		{ id: "a", revision: "r1", evidencePath: "/a", fingerprint: "hash" },
		{ id: "b", revision: "r2", evidencePath: "/b", fingerprint: "hash" },
	];
	assert.equal(
		(await dispatchJobs(db, jobs, { invocation: "m", now: () => 1, leaseMs: 10, maxJobs: 1, adapter })).length,
		1,
	);
	assert.equal(launches, 1);
	assert.deepEqual(
		await dispatchJobs(db, [{ ...jobs[1], evidencePath: `/${"x".repeat(1024)}` }], {
			invocation: "m",
			now: () => 1,
			leaseMs: 10,
			maxJobs: 1,
			adapter,
		}),
		[],
	);
	assert.equal(launches, 1);
	db.close();
});

test("cleanup retries persist separately and never relaunch generation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "learning-cleanup-"));
	try {
		const path = join(dir, "jobs.sqlite");
		let db = new DatabaseSync(path);
		db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, revision_id TEXT, state TEXT NOT NULL, payload TEXT NOT NULL)");
		enqueueJob(db, "a", "r1", "hash");
		let launches = 0;
		const jobs = [{ id: "a", revision: "r1", evidencePath: "/evidence/a", fingerprint: "hash" }];
		const options = {
			invocation: "manual",
			now: () => 1,
			leaseMs: 10,
			maxJobs: 1,
			adapter: async () => {
				launches++;
				return { status: "success" as const, artifactPath: "/digests/a", fingerprint: "hash" };
			},
		};
		await dispatchJobs(db, jobs, options);
		const failure = await dispatchCleanup(db, "a", {
			invocation: "manual",
			now: () => 2,
			leaseMs: 10,
			adapter: async () => {
				throw new Error("failure");
			},
		});
		assert.equal(failure.status, "cleanup-failed");
		db.close();
		db = new DatabaseSync(path);
		assert.deepEqual(await dispatchJobs(db, jobs, options), []);
		const success = await dispatchCleanup(db, "a", {
			invocation: "manual",
			now: () => 3,
			leaseMs: 10,
			adapter: async () => "success",
		});
		assert.equal(success.status, "cleaned");
		assert.equal(launches, 1);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
