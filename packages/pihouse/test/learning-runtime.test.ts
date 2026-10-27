import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isQuiescent } from "../src/workflow/jobs.ts";
import { activateLearningStore, produceDigestCandidates } from "../src/workflow/learning-runtime.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

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
		writeFileSync(join(run, "run.json"), JSON.stringify({ id: "run-one", project: "fixture", agents: [{ id: "a" }] }));
		writeFileSync(join(run, "transcripts", "a.json"), "{}\n");
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

test("legacy migration is explicit and creates activation only when called", () => {
	const root = mkdtempSync(join(tmpdir(), "learning-activation-"));
	try {
		assert.equal(
			activateLearningStore({
				storeDir: root,
				db: {} as never,
				ownedRoot: root,
				operationalState: () => ({ states: [], deliveries: null, handoff: null, livenessKnown: false }),
				currentFingerprint: () => undefined,
			}),
			undefined,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
