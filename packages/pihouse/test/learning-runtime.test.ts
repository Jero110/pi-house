import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isQuiescent } from "../src/workflow/jobs.ts";
import { activateLearningStore, executeDigest, produceDigestCandidates } from "../src/workflow/learning-runtime.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";
import { coordinatorWorkerAdapter, observedTerminalReason } from "../src/workflow/worker-adapter.ts";

test("quiescence is conservative for active, pending-delivery, handoff and unknown states", () => {
	assert.equal(isQuiescent({ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: true }), true);
	for (const snapshot of [
		{ states: ["working"], deliveries: 0, handoff: false, livenessKnown: true },
		{ states: ["idle"], deliveries: 1, handoff: false, livenessKnown: true },
		{ states: ["idle"], deliveries: 0, handoff: null, livenessKnown: true },
		{ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: false },
	])
		assert.equal(isQuiescent(snapshot), false);
});

test("candidate production requires an operational revision, retained complete package and stable known liveness", () => {
	const root = mkdtempSync(join(tmpdir(), "learning-runtime-"));
	const store = openOperationalStore(join(root, "memory.sqlite"), { fts: false });
	try {
		const owned = join(root, "owned");
		const run = join(owned, "runs", "run-one");
		mkdirSync(join(run, "transcripts"), { recursive: true });
		writeFileSync(
			join(run, "run.json"),
			JSON.stringify({ id: "run-one", fingerprint: "source-hash", project: "fixture", agents: [{ id: "a" }] }),
		);
		writeFileSync(join(run, "transcripts", "a.json"), "{}\n");
		writeFileSync(join(run, "transcripts", "a.jsonl"), "{}\n");
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('run-one', 'now')").run();
		store.db
			.prepare(
				"INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES ('run-one.r1', 'run-one', 'source-hash', 'now')",
			)
			.run();
		const options = {
			storeDir: join(root, "legacy"),
			db: store.db,
			ownedRoot: owned,
			operationalState: () => ({ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: true }),
			currentFingerprint: () => "source-hash",
		};
		const result = produceDigestCandidates(options);
		assert.equal(result.candidates.length, 1);
		assert.equal(result.candidates[0].revision, "run-one.r1");
		assert.deepEqual(result.deferred, []);
		assert.deepEqual(result.candidates[0].expectedFiles, ["a.json", "a.jsonl"]);
		assert.equal(
			produceDigestCandidates({
				...options,
				operationalState: () => ({ states: ["idle"], deliveries: null, handoff: false, livenessKnown: false }),
			}).candidates.length,
			0,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("execution defers cleanup when the run becomes active after digest commit", async () => {
	const root = mkdtempSync(join(tmpdir(), "learning-live-cleanup-"));
	const store = openOperationalStore(join(root, "memory.sqlite"), { fts: false });
	try {
		const owned = join(root, "owned");
		const run = join(owned, "runs", "run-one");
		mkdirSync(join(run, "transcripts"), { recursive: true });
		mkdirSync(join(root, "digests"), { recursive: true });
		writeFileSync(
			join(run, "run.json"),
			JSON.stringify({ id: "run-one", fingerprint: "source-hash", project: "fixture", agents: [{ id: "a" }] }),
		);
		writeFileSync(join(run, "transcripts", "a.jsonl"), "synthetic evidence\\n");
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('run-one', 'now')").run();
		store.db
			.prepare(
				"INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES ('run-one.r1', 'run-one', 'source-hash', 'now')",
			)
			.run();
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES ('m1', 'run-one.r1', 'run', '{}')")
			.run();
		store.db
			.prepare("INSERT INTO participants(id, revision_id, role, payload) VALUES ('p1', 'run-one.r1', 'planner', '{}')")
			.run();
		let active = false;
		const options = {
			storeDir: join(root, "legacy"),
			db: store.db,
			ownedRoot: owned,
			operationalState: () => ({
				states: [active ? "working" : "idle"],
				deliveries: 0,
				handoff: false,
				livenessKnown: true,
			}),
			currentFingerprint: () => "source-hash",
		};
		const candidate = produceDigestCandidates(options).candidates[0];
		const sections = Object.fromEntries(
			[
				"objective",
				"participants",
				"decisions",
				"failures",
				"validations",
				"artifacts",
				"limitations",
				"candidates",
			].map((key) => [key, key]),
		);
		const result = await executeDigest(
			{
				...options,
				digestRoot: join(root, "digests"),
				outputPath: () => join(root, "out"),
				cwd: root,
				invocation: "x",
				now: Date.now,
				worker: async (job) => {
					const output = JSON.stringify({
						schemaVersion: 1,
						runId: "run-one",
						project: "fixture",
						revision: job.revision,
						sections,
					});
					writeFileSync(job.outputPath, output);
					active = true;
					return { status: "success", outputPath: job.outputPath, outputText: output };
				},
			},
			[candidate],
		);
		assert.equal(result[0].status, "deferred");
		assert.ok(existsSync(join(run, "transcripts", "a.jsonl")));
		assert.equal(
			store.db.prepare("SELECT state FROM cleanup_manifests WHERE id='run-one.r1'").get()?.state,
			"committed",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("verified synthetic digest execution commits then fences cleanup against a fresh source fingerprint", async () => {
	const root = mkdtempSync(join(tmpdir(), "learning-execute-"));
	const store = openOperationalStore(join(root, "memory.sqlite"), { fts: false });
	try {
		const owned = join(root, "owned");
		const run = join(owned, "runs", "run-one");
		mkdirSync(join(run, "transcripts"), { recursive: true });
		mkdirSync(join(root, "digests"), { recursive: true });
		const cursor = {
			"run-one": { sourceKind: "jsonl", sourceId: "native-one", byteOffset: 16, prefixFingerprint: "p" },
		};
		writeFileSync(
			join(run, "run.json"),
			JSON.stringify({ id: "run-one", fingerprint: "source-hash", project: "fixture", agents: [{ id: "a" }], cursor }),
		);
		writeFileSync(join(run, "transcripts", "a.jsonl"), "synthetic evidence\\n");
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('run-one', 'now')").run();
		store.db
			.prepare(
				"INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES ('run-one.r1', 'run-one', 'source-hash', 'now')",
			)
			.run();
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES ('m1', 'run-one.r1', 'run', '{}')")
			.run();
		store.db
			.prepare("INSERT INTO participants(id, revision_id, role, payload) VALUES ('p1', 'run-one.r1', 'planner', '{}')")
			.run();
		const options = {
			storeDir: join(root, "legacy"),
			db: store.db,
			ownedRoot: owned,
			operationalState: () => ({ states: ["idle"], deliveries: 0, handoff: false, livenessKnown: true }),
			currentFingerprint: () => "source-hash",
		};
		const candidate = produceDigestCandidates(options).candidates[0];
		const sections = Object.fromEntries(
			[
				"objective",
				"participants",
				"decisions",
				"failures",
				"validations",
				"artifacts",
				"limitations",
				"candidates",
			].map((key) => [key, `synthetic ${key}`]),
		);
		const result = await executeDigest(
			{
				...options,
				digestRoot: join(root, "digests"),
				outputPath: () => join(root, "worker-output.json"),
				cwd: root,
				invocation: "manual-1",
				now: Date.now,
				worker: async (job) => {
					const output = JSON.stringify({
						schemaVersion: 1,
						runId: "run-one",
						project: "fixture",
						revision: job.revision,
						sections,
					});
					writeFileSync(job.outputPath, output);
					return { status: "success", outputPath: job.outputPath, outputText: output };
				},
			},
			[candidate],
		);
		assert.equal(result[0].status, "cleaned");
		assert.equal(store.db.prepare("SELECT state FROM cleanup_manifests WHERE id='run-one.r1'").get()?.state, "cleaned");
		// The receipt keeps the package's cursors, so a later capture can resume from this revision.
		const receipt = JSON.parse(
			String(store.db.prepare("SELECT payload FROM cleanup_manifests WHERE id='run-one.r1'").get()?.payload),
		);
		assert.deepEqual(receipt.cursors, cursor);
		assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(candidate.id)?.state, "cleaned");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("terminal observation uses only the latest assistant message and fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "worker-terminal-"));
	try {
		const path = join(root, "child.jsonl");
		writeFileSync(
			path,
			[
				'{"type":"message","message":{"role":"assistant","stopReason":"stop"}}',
				'{"type":"message","message":{"role":"assistant","stopReason":"max_tokens"}}',
			].join("\n"),
		);
		assert.equal(observedTerminalReason(path), "failure");
		writeFileSync(path, '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}');
		assert.equal(observedTerminalReason(path), "stop");
		assert.equal(observedTerminalReason(undefined), "failure");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker children are spawned under a dedicated pull coordinator and never read a parent inbox", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-coordinator-"));
	const journal = join(root, "journal");
	mkdirSync(journal);
	const transcript = join(root, "worker.jsonl");
	const sections = Object.fromEntries(
		["objective", "participants", "decisions", "failures", "validations", "artifacts", "limitations", "candidates"].map(
			(key) => [key, key],
		),
	);
	let spawnFrom = "";
	let coordinator = "";
	let exited = false;
	let cancelled = false;
	let spawnedOutput = "";
	const client = {
		register: async (body: { pull: boolean }) => {
			assert.equal(body.pull, true);
			coordinator = "workflow-coordinator";
			return { name: coordinator, identity: { agent: coordinator, hub: "", token: "", depth: 0 } };
		},
		spawn: async (body: { from: string; task: string; name: string; cwd: string }) => {
			spawnFrom = body.from;
			const outputPath = body.task.match(/Output: ([^\n]+)/)?.[1];
			assert.ok(outputPath);
			spawnedOutput = outputPath;
			writeFileSync(
				outputPath,
				JSON.stringify({ schemaVersion: 1, runId: "run-one", project: "fixture", revision: "run-one.r1", sections }),
			);
			writeFileSync(
				transcript,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "maliciously long generated report" }],
					},
				}),
			);
			assert.equal(observedTerminalReason(transcript), "stop");
			writeFileSync(
				join(journal, "child.json"),
				JSON.stringify({
					id: `20260101T000000Z-${body.name}`,
					name: body.name,
					parent: coordinator,
					parentName: coordinator,
					root: coordinator,
					harness: "pihouse",
					model: null,
					cwd: body.cwd,
					task: body.task,
					state: "done",
					depth: 1,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					transcript,
				}),
			);
			return { name: body.name };
		},
		cancel: async () => {
			cancelled = true;
			return { ok: true };
		},
		event: async () => {
			exited = true;
			return { ok: true };
		},
		inbox: async () => {
			throw new Error("coordinator inbox must not be consumed");
		},
	};
	try {
		const worker = coordinatorWorkerAdapter(client as never, {
			cwd: root,
			backend: "tmux",
			journalDir: journal,
			timeoutMs: 1000,
			pollMs: 20,
		});
		const result = await worker({
			stage: "digest",
			id: "digest-run-one.r1",
			revision: "run-one.r1",
			project: "fixture",
			inputPath: join(root, "evidence"),
			outputPath: join(root, "digest.json"),
			cwd: root,
		});
		assert.equal(result.status, "success");
		assert.ok(!existsSync(spawnedOutput));
		assert.equal(spawnFrom, coordinator);
		assert.equal(cancelled, true);
		assert.equal(exited, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy migration is explicit and creates activation only when called", () => {
	const root = mkdtempSync(join(tmpdir(), "learning-activation-"));
	try {
		assert.equal(activateLearningStore(root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
