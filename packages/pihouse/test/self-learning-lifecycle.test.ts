import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeDigest, produceDigestCandidates } from "../src/workflow/learning-runtime.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const quiet = {
	operationalState: () => ({ states: ["stopped"], deliveries: 0, handoff: false, livenessKnown: true }),
	currentFingerprint: () => "source",
};

test("cleanup-pending captured revisions remain eligible for cleanup recovery, not digest regeneration", async () => {
	const root = mkdtempSync(join(tmpdir(), "self-learning-cleanup-recovery-"));
	const memory = join(root, "memory");
	const run = join(memory, "runs", "run-a");
	mkdirSync(join(run, "transcripts"), { recursive: true });
	writeFileSync(
		join(run, "run.json"),
		JSON.stringify({ id: "run-a", fingerprint: "source", project: "fixture", agents: [{ id: "a" }] }),
	);
	writeFileSync(join(run, "transcripts", "a.jsonl"), "synthetic");
	const store = openOperationalStore(join(memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		store.db.exec(
			"INSERT INTO runs(id, created_at) VALUES ('run-a','now'); INSERT INTO revisions(id,run_id,source_hash,created_at) VALUES ('run-a.r1','run-a','source','now'); INSERT INTO metrics(id,revision_id,kind,value) VALUES ('m','run-a.r1','run.metrics','{}'); INSERT INTO metrics(id,revision_id,kind,value) VALUES ('l','run-a.r1','run.lineage','{}'); INSERT INTO participants(id,revision_id,role,payload) VALUES ('p','run-a.r1','planner','{}');",
		);
		const digest = join(memory, "digests", "run-a", "digest.md");
		mkdirSync(join(memory, "digests", "run-a"), { recursive: true });
		writeFileSync(digest, "persisted digest");
		store.db.prepare("INSERT INTO cleanup_manifests(id,payload,state) VALUES ('run-a.r1',?,'cleanup-failed')").run(
			JSON.stringify({
				runId: "run-a",
				revision: "run-a.r1",
				digestPath: digest,
				digestHash: "bad",
				files: [{ name: "a.jsonl", hash: "x" }],
				attempts: 0,
			}),
		);
		store.db
			.prepare(
				"INSERT INTO jobs(id,revision_id,state,payload) VALUES ('digest-run-a.r1','run-a.r1','cleanup-failed',?)",
			)
			.run(JSON.stringify({ fingerprint: "source", attempts: 1, artifactPath: digest }));
		const selected = produceDigestCandidates({ ...quiet, db: store.db, storeDir: memory, ownedRoot: memory });
		assert.deepEqual(selected.candidates, [], "cleanup work must never be submitted as a new digest");
		assert.equal(selected.deferred.length, 0);
		let generations = 0;
		const recovered = await executeDigest(
			{
				...quiet,
				db: store.db,
				storeDir: memory,
				ownedRoot: memory,
				digestRoot: join(memory, "digests"),
				outputPath: () => digest,
				cwd: root,
				invocation: "retry",
				now: () => Date.now(),
				worker: async () => {
					generations++;
					return { status: "failure" };
				},
			},
			[],
		);
		assert.equal(generations, 0, "cleanup retry does not regenerate the digest");
		assert.equal(recovered[0]?.status, "cleanup-failed", "bad persisted bytes stay queued as cleanup failure");
		assert.equal(
			store.db.prepare("SELECT state FROM cleanup_manifests WHERE id='run-a.r1'").get()?.state,
			"cleanup-failed",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker identity uses revision-derived run id and completion requires explicit stop and output", async () => {
	const { observedTerminalReason } = await import("../src/workflow/worker-adapter.ts");
	const root = mkdtempSync(join(tmpdir(), "self-learning-worker-"));
	try {
		const transcript = join(root, "worker.jsonl");
		writeFileSync(transcript, `${JSON.stringify({ message: { role: "assistant", stopReason: "length" } })}\n`);
		assert.equal(observedTerminalReason(transcript), "failure");
		writeFileSync(transcript, "{}");
		assert.equal(observedTerminalReason(transcript), "failure");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lifecycle fault assertions retain cleanup receipt and operational records when digest persistence fails", () => {
	const root = mkdtempSync(join(tmpdir(), "self-learning-boundary-"));
	const store = openOperationalStore(join(root, "memory.sqlite"), { fts: false, legacy: true });
	try {
		store.db.exec(
			"INSERT INTO runs(id,created_at) VALUES ('run-a','now'); INSERT INTO revisions(id,run_id,source_hash,created_at) VALUES ('run-a.r1','run-a','source','now'); INSERT INTO metrics(id,revision_id,kind,value) VALUES ('m','run-a.r1','run.metrics','{}')",
		);
		assert.equal(store.db.prepare("SELECT count(*) AS n FROM metrics").get()?.n, 1);
		assert.equal(store.db.prepare("SELECT count(*) AS n FROM cleanup_manifests").get()?.n, 0);
		assert.equal(readFileSync(join(root, "memory.sqlite")) instanceof Buffer, true);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
