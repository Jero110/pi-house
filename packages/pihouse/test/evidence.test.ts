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
		"## By role",
		"## By harness",
		"partial; some participants unavailable",
		"unknown",
		"| 1 |",
		"source unavailable",
		"New tokens 46",
	]) {
		assert.ok(report.includes(expected), `report should include ${expected}`);
	}
	assert.doesNotMatch(report, /conversation body|secret prompt|tool result text/);
});

test("verified JSONL append advances a revision at the same journal timestamp and keeps stable lineage", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-append-"));
	const source = join(home, "native-session.jsonl");
	const record: SessionRecord = {
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
		sessionId: "native-a",
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	const writeSource = (items: string[]) =>
		writeFileSync(
			source,
			`${[
				{ type: "session", id: "native-a", cwd: home },
				...items.map((id) => ({
					type: "message",
					id,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: `synthetic ${id}` },
				})),
			]
				.map((item) => JSON.stringify(item))
				.join("\n")}\n`,
		);
	const store = openMemory(join(home, "memory"));
	writeSource(["message-1"]);
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const file = join(home, "memory/runs/root/run.json");
	const first = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const repeated = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(repeated.revision, first.revision, "same source prefix remains idempotent");
	assert.equal(repeated.fingerprint, first.fingerprint);
	rmSync(join(home, "memory/runs/root/transcripts"), { recursive: true });
	writeSource(["message-1", "message-2"]);
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const appended = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(appended.id, first.id);
	assert.equal(appended.revision, first.revision + 1);
	assert.deepEqual(appended.evidence.cursor.root.appendedRecordIds, ["message-2"]);
	assert.equal(appended.evidence.cursor.root.byteOffset, Buffer.byteLength(readFileSync(source)));
});

test("truncation and unknown native cursor provenance defer without replacing retained evidence", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-rotation-"));
	const source = join(home, "native-session.jsonl");
	const record: SessionRecord = {
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
		sessionId: "native-a",
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	const writeSource = (items: string[]) =>
		writeFileSync(
			source,
			`${[
				{ type: "session", id: "native-a" },
				...items.map((id) => ({
					type: "message",
					id,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: id },
				})),
			]
				.map((item) => JSON.stringify(item))
				.join("\n")}\n`,
		);
	const store = openMemory(join(home, "memory"));
	writeSource(["message-1", "message-2"]);
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const file = join(home, "memory/runs/root/run.json");
	const before = readFileSync(file, "utf8");
	writeSource(["replacement"]);
	assert.equal(captureRun([record], record, store, { by: "planner" }), "deferred");
	assert.equal(readFileSync(file, "utf8"), before, "rotation must not overwrite retained evidence");
});

test("unverifiable native source captures labeled evidence once then defers recapture", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-native-"));
	const source = join(home, "claude-session.jsonl");
	writeFileSync(
		source,
		`${[
			{
				type: "user",
				sessionId: "claude-a",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { content: "synthetic request" },
			},
			{
				type: "assistant",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					id: "a1",
					content: [{ type: "text", text: "synthetic response" }],
					usage: { input_tokens: 4, output_tokens: 2 },
				},
			},
		]
			.map((item) => JSON.stringify(item))
			.join("\n")}\n`,
	);
	const record: SessionRecord = {
		id: "native-root",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "native-root",
		harness: "claude",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: "claude-a",
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const store = openMemory(join(home, "memory"));
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const file = join(home, "memory/runs/native-root/run.json");
	const before = readFileSync(file, "utf8");
	const stored = JSON.parse(before);
	assert.equal(stored.evidence.cursor["native-root"].sourceKind, "unknown");
	assert.equal(captureRun([record], record, store, { by: "planner" }), "deferred");
	assert.equal(readFileSync(file, "utf8"), before);
});

test("observable JSONL fork preserves the ancestor lineage and defers destructive eligibility", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-fork-lineage-"));
	const store = openMemory(join(home, "memory"));
	const baseSource = join(home, "base.jsonl");
	writeFileSync(
		baseSource,
		`${JSON.stringify({ type: "session", id: "base-session" })}\n${JSON.stringify({ type: "message", id: "base-entry", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "base" } })}\n`,
	);
	const base: SessionRecord = {
		id: "base-root",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "base-root",
		harness: "pihouse",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: "base-session",
		transcript: baseSource,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	assert.equal(captureRun([base], base, store, { by: "planner" }), "written");
	const forkSource = join(home, "fork.jsonl");
	writeFileSync(
		forkSource,
		`${JSON.stringify({ type: "session", id: "fork-session", parentSessionId: "base-session" })}\n${JSON.stringify({ type: "message", id: "fork-entry", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "fork" } })}\n`,
	);
	const fork: SessionRecord = {
		...base,
		id: "fork-root",
		root: "fork-root",
		sessionId: "fork-session",
		transcript: forkSource,
	};
	assert.equal(captureRun([fork], fork, store, { by: "planner" }), "written");
	const stored = JSON.parse(readFileSync(join(home, "memory/runs/fork-root/run.json"), "utf8"));
	assert.equal(stored.evidence.lineage, "base-root");
	assert.equal(stored.evidence.lineageStatus, "fork-parent-lineage-resolved");
	assert.equal(stored.evidence.forkProvenance, "base-session");
	assert.equal(stored.evidence.destructiveEligibility, "deferred");
});

test("fork provenance stays unknown when the source does not expose its parent", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-fork-"));
	const source = join(home, "native-session.jsonl");
	const record: SessionRecord = {
		id: "fork-root",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "fork-root",
		harness: "pihouse",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: "fork-session",
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	writeFileSync(source, `${JSON.stringify({ type: "session", id: "fork-session" })}\n`);
	const store = openMemory(join(home, "memory"));
	assert.equal(captureRun([record], record, store, { by: "planner" }), "written");
	const stored = JSON.parse(readFileSync(join(home, "memory/runs/fork-root/run.json"), "utf8"));
	assert.equal(stored.evidence.forkProvenance, "unknown");
	assert.equal(stored.evidence.destructiveEligibility, "deferred");
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
	assert.equal(first.evidence.metrics.newTokens, null, "missing source usage remains unknown, not zero");
	assert.equal(first.evidence.metrics.wallMs, null, "missing source timing remains unknown, not zero");
	assert.equal(first.evidence.participants[0].activeMs, null, "missing participant duration remains unknown");
	assert.ok(!JSON.stringify(first).includes("secret body"));
	assert.equal(
		captureRun([root], root, store, { by: "planner" }),
		"deferred",
		"unknown source cursors cannot be re-imported",
	);
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
	assert.equal(
		captureRun([continued], continued, store, { by: "planner" }),
		"deferred",
		"updatedAt alone is not a source cursor",
	);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).revision, 1);
});
