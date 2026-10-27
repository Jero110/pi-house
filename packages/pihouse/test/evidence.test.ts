import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "agent-link-core";
import { captureRun } from "../src/workflow/capture.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { ACTIVE_MARKER } from "../src/workflow/migration.ts";
import { renderEvidenceReport, type WorkflowEvidence } from "../src/workflow/report.ts";
import { appendRoutingDecision } from "../src/workflow/routing-profiles.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

test("activated verified capture persists operational rows and repeats idempotently", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-activation-"));
	const source = join(home, "native-session.jsonl");
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: "native-a", cwd: home })}\n${JSON.stringify({ type: "message", id: "message-a", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "synthetic" } })}\n`,
	);
	const root: SessionRecord = {
		id: "root-activation",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "root-activation",
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
	const memoryDir = join(home, "memory");
	const store = openMemory(memoryDir);
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(join(memoryDir, ACTIVE_MARKER), JSON.stringify({ active: true }));
	assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
	assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
	const operational = openOperationalStore(join(memoryDir, "memory.sqlite"), { fts: false, legacy: true });
	try {
		assert.equal(operational.db.prepare("SELECT count(*) AS n FROM runs WHERE id = ?").get("root-activation")?.n, 1);
		assert.equal(
			operational.db.prepare("SELECT count(*) AS n FROM revisions WHERE run_id = ?").get("root-activation")?.n,
			1,
		);
		assert.equal(operational.db.prepare("SELECT count(*) AS n FROM participants").get()?.n, 1);
		assert.ok(Number(operational.db.prepare("SELECT count(*) AS n FROM metrics").get()?.n) > 0);
	} finally {
		operational.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("unactivated capture does not create an operational database", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-unactivated-"));
	const root: SessionRecord = {
		id: "root-unactivated",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "root-unactivated",
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
	const memoryDir = join(home, "memory");
	const store = openMemory(memoryDir);
	assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
	assert.equal(existsSync(join(memoryDir, "memory.sqlite")), false);
	rmSync(home, { recursive: true, force: true });
});

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
					message: {
						role: "assistant",
						content: [{ type: "text", text: `synthetic ${id}` }],
						usage: { input: id === "message-1" ? 10 : 5, output: 2, cacheRead: 3, cacheWrite: 0 },
					},
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
	assert.equal(first.evidence.metrics.newTokens, 12, "the initial captured usage is retained structurally");
	assert.equal(first.evidence.participants[0].activeMs, null, "absent answer durations remain unknown");
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
	assert.equal(appended.metrics.messages, 2, "structured totals accumulate the delta once");
	assert.equal(appended.evidence.participants[0].messages, 2);
	assert.equal(
		appended.evidence.metrics.newTokens,
		19,
		"appended token usage accumulates once, not from the old prefix",
	);
	assert.equal(appended.evidence.metrics.cacheRead, 6);
	assert.deepEqual(appended.evidence.cursor.root.appendedRecordIds, ["message-2"]);
	assert.equal(appended.evidence.cursor.root.byteOffset, Buffer.byteLength(readFileSync(source)));
	const capturedDelta = readFileSync(join(home, "memory/runs/root/transcripts/root.json"), "utf8");
	assert.match(capturedDelta, /synthetic message-2/);
	assert.doesNotMatch(capturedDelta, /synthetic message-1/, "discarded source prefix must not be reimported");
	assert.equal(
		existsSync(join(home, "memory/runs/root/transcripts/root.jsonl")),
		false,
		"old raw transcript copy is not recreated",
	);
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

// Routing in captured evidence: the decision that chose a worker stays in the body-free evidence after its raw copies
// are gone, and an unrouted run keeps the fingerprint it had before routing was recorded.
function routedRun(home: string): { root: SessionRecord; worker: SessionRecord } {
	const root: SessionRecord = {
		id: "root-routed",
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: "root-routed",
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
	const worker: SessionRecord = {
		...root,
		id: "worker-w2",
		name: "w-2",
		parent: root.id,
		parentName: root.name,
		depth: 1,
		model: "anthropic/claude-sonnet-5-5",
		sessionId: undefined,
		startedAt: "2026-01-01T00:00:30.000Z",
	};
	return { root, worker };
}

test("a routed worker keeps the decision that chose it in captured evidence, and the report regenerates it", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-routing-"));
	try {
		const { root, worker } = routedRun(home);
		appendRoutingDecision(home, {
			time: Date.parse("2026-01-01T00:00:10Z"),
			profile: "build",
			task: "T1",
			agent: "w-2",
			model: "anthropic/claude-sonnet-5-5",
			account: "claude",
			billing: "subscription",
			reason: "authorized alternative (usage endpoint, observed 5s ago)",
			failure: "exhausted",
			checkpoint: null,
		});
		const store = openMemory(join(home, "memory"));
		assert.equal(captureRun([root, worker], root, store, { by: "planner" }), "written");
		const stored = JSON.parse(readFileSync(join(home, "memory/runs/root-routed/run.json"), "utf8"));
		const participants = stored.evidence.participants as { id: string; routing?: unknown }[];
		assert.deepEqual(participants.find((p) => p.id === "worker-w2")?.routing, {
			profile: "build",
			model: "anthropic/claude-sonnet-5-5",
			account: "claude",
			reason: "authorized alternative (usage endpoint, observed 5s ago)",
			failure: "exhausted",
			decidedAt: "2026-01-01T00:00:10.000Z",
		});
		assert.equal(
			participants.some((p) => p.id === "root-routed" && "routing" in p),
			false,
			"an unrouted participant carries no routing key",
		);
		assert.match(
			renderEvidenceReport(stored.evidence),
			/## Routing decisions[\s\S]*\| worker-w2 \| build \| anthropic\/claude-sonnet-5-5 \| anthropic\/claude-sonnet-5-5 \| claude \|/,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("an unrouted run keeps its evidence fingerprint when a routing journal exists for other agents", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-evidence-fingerprint-"));
	try {
		// A verifiable pi JSONL source, so a second capture of the same run is a re-capture, not a deferral.
		const source = join(home, "native-session.jsonl");
		writeFileSync(
			source,
			`${JSON.stringify({ type: "session", id: "native-fp", cwd: home })}\n${JSON.stringify({ type: "message", id: "message-fp", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "synthetic" } })}\n`,
		);
		const root: SessionRecord = {
			id: "root-fingerprint",
			name: "workflow-planner",
			parent: null,
			parentName: null,
			root: "root-fingerprint",
			harness: "pihouse",
			model: null,
			cwd: home,
			state: "exited",
			depth: 0,
			sessionId: "native-fp",
			transcript: source,
			startedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:01:00.000Z",
		};
		const store = openMemory(join(home, "memory"));
		assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
		const file = join(home, "memory/runs/root-fingerprint/run.json");
		const before = JSON.parse(readFileSync(file, "utf8"));
		appendRoutingDecision(home, {
			time: Date.parse("2026-01-01T00:00:10Z"),
			profile: "build",
			task: "T1",
			agent: "someone-else",
			model: "openai-codex/gpt-6-luna",
			account: "openai",
			billing: "subscription",
			reason: "available",
			failure: null,
			checkpoint: null,
		});
		assert.equal(captureRun([root], root, store, { by: "planner" }), "written");
		const after = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(after.fingerprint, before.fingerprint, "no decision for this run leaves the evidence unchanged");
		assert.equal(after.revision, before.revision);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
