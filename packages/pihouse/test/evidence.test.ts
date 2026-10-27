import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "agent-link-core";
import { captureRun } from "../src/workflow/capture.ts";
import { openMemory } from "../src/workflow/memory.ts";

test("capture persists body-free stable revisions and is idempotent", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-"));
	const root: SessionRecord = {
		id: "root",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "root",
		harness: "unsupported",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: "unknown",
		transcript: undefined,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
		task: "secret body must not persist",
	};
	const store = openMemory(join(home, "memory"));
	assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
	const file = join(home, "memory/runs/root/run.json");
	const first = JSON.parse(readFileSync(file, "utf8"));
	assert.ok(first.fingerprint);
	assert.equal(first.revision, 1);
	assert.ok(!JSON.stringify(first).includes("secret body"));
	assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
	const repeated = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(repeated.fingerprint, first.fingerprint);
	assert.equal(repeated.revision, 1);
	assert.match(repeated.agents[0].missing, /no transcript/);
	assert.equal(createHash("sha256").update(JSON.stringify(repeated.evidence)).digest("hex"), repeated.fingerprint);
	assert.match(repeated.agents[0].missing, /no transcript reader/);
	const reportPath = join(home, "memory/runs/root/report.md");
	const report = readFileSync(reportPath, "utf8");
	assert.ok(!report.includes("secret body"));
	assert.match(report, /Usage unavailable/);
	const continued = { ...root, updatedAt: "2026-01-01T00:02:00.000Z" };
	assert.equal(captureRun([continued], continued, store, { by: "planner" }), "written");
	const next = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(next.id, first.id, "continued capture preserves lineage");
	assert.equal(next.revision, 2);
	assert.notEqual(next.fingerprint, first.fingerprint);
	assert.equal(next.cursor.root, continued.updatedAt);
	assert.equal(captureRun([continued], continued, store, { by: "planner" }), "written");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).revision, 2);
});
