import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "agent-link-core";
import { captureRun } from "../src/workflow/capture.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { renderEvidenceReport, type WorkflowEvidence } from "../src/workflow/report.ts";

test("a report can be regenerated from retained evidence without captured transcripts", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-report-"));
	const root: SessionRecord = {
		id: "root",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "root",
		harness: "pihouse",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: "missing-transcript",
		transcript: undefined,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	const store = openMemory(join(home, "memory"));
	captureRun([root], root, store, { by: "planner" });
	const stored = JSON.parse(readFileSync(join(home, "memory/runs/root/run.json"), "utf8"));
	const runDir = join(home, "memory/runs/root");
	mkdirSync(join(runDir, "transcripts"), { recursive: true });
	writeFileSync(join(runDir, "transcripts/captured.json"), "captured private body");
	const nativeFixture = join(home, "native-session.jsonl");
	writeFileSync(nativeFixture, "native private body");
	writeFileSync(join(runDir, "report.md"), "stale report");
	rmSync(join(runDir, "transcripts"), { recursive: true });
	rmSync(nativeFixture);
	rmSync(join(runDir, "report.md"));
	const regenerated = renderEvidenceReport(stored.evidence);
	assert.match(regenerated, /Workflow evidence: workflow-planner/);
	assert.match(regenerated, /Usage unavailable/);
	assert.match(regenerated, /pihouse/);
	assert.match(regenerated, /no transcript/);
	assert.doesNotMatch(regenerated, /private body|stale report|Time and tokens per message/);
});

test("structured reports retain participant breakdowns, tool errors, unknowns, and no bodies", () => {
	const evidence: WorkflowEvidence = {
		lineage: "run-1",
		title: "workflow-planner",
		project: "/synthetic/project",
		plan: "docs/plans/example.md",
		cursor: { planner: "cursor-a", executor: "cursor-b", worker: "cursor-c" },
		metrics: { newTokens: 46, cacheRead: 17, activeMs: 9000, wallMs: 12000, agents: 3, messages: 4 },
		participants: [
			{
				id: "planner",
				parent: null,
				role: "planner",
				harness: "pihouse",
				model: "luna",
				taskId: null,
				taskTitle: null,
				assignedSkills: [],
				loadedSkills: ["planner"],
				usage: { input: 10, output: 20, cacheRead: 7, cacheWrite: 1 },
				activeMs: 3000,
				messages: 2,
				missing: null,
				summary: { assistantMessages: 1, slowestMs: 3000, failedToolCalls: 1, toolCalls: 3 },
			},
			{
				id: "executor",
				parent: "planner",
				role: "executor",
				harness: "codex",
				model: "gpt",
				taskId: "T4",
				taskTitle: "capture evidence",
				assignedSkills: ["test-driven-development"],
				loadedSkills: ["test-driven-development"],
				usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 0 },
				activeMs: 4000,
				messages: 1,
				missing: null,
				summary: { assistantMessages: 1, slowestMs: 4000, failedToolCalls: 0, toolCalls: 2 },
			},
			{
				id: "worker",
				parent: "executor",
				role: "worker",
				harness: "unknown-harness",
				model: "",
				taskId: null,
				taskTitle: null,
				assignedSkills: [],
				loadedSkills: [],
				usage: {},
				activeMs: 0,
				messages: 0,
				missing: "source unavailable",
				summary: null,
			},
		],
	};
	const report = renderEvidenceReport(evidence);
	for (const expected of [
		"docs/plans/example.md",
		"planner",
		"executor",
		"worker",
		"pihouse",
		"codex",
		"test-driven-development",
		"Tool errors",
		"| 1 |",
		"source unavailable",
		"New tokens 46",
	]) {
		assert.ok(report.includes(expected), `report should include ${expected}`);
	}
	assert.doesNotMatch(report, /conversation body|secret prompt|tool result text/);
});

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
