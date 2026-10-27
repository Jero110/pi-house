import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "agent-link-core";
import workflow from "../src/extensions/workflow.ts";
import { renderReport } from "../src/workflow/report.ts";
import { appendRoutingDecision, type RoutingDecision } from "../src/workflow/routing-profiles.ts";
import { buildRun } from "../src/workflow/run.ts";

test("a local session can render a partial code-only report without inventing usage", () => {
	const root = {
		id: "local",
		root: "local",
		parent: null,
		parentName: null,
		name: "ordinary chat",
		task: undefined,
		harness: "pihouse",
		model: "unknown",
		cwd: process.cwd(),
		state: "working" as const,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		depth: 0,
		sessionId: "local-session",
		transcript: undefined,
	};
	const report = renderReport(buildRun([root], root));
	assert.match(report, /PARTIAL/i);
	assert.match(report, /unknown|unavailable/i);
});

/** A fake pi that records every message and user turn the extension sends. */
function fakePi() {
	const commands = new Map<string, { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
	const sent: unknown[][] = [];
	const users: unknown[][] = [];
	const pi = {
		on: () => {},
		registerCommand: (
			name: string,
			spec: { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> | void },
		) => commands.set(name, spec),
		sendMessage: (...args: unknown[]) => sent.push(args),
		sendUserMessage: (...args: unknown[]) => users.push(args),
		getSessionName: () => undefined,
		setSessionName: () => {},
	} as unknown as ExtensionAPI;
	return { pi, commands, sent, users };
}

test("/workflow review is removed: it points to report, starts no model turn and writes no report", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "workflow-review-removed-"));
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const { pi, commands, sent, users } = fakePi();
	const notes: { text: string; level: string }[] = [];
	const ctx = {
		ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
		sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
		cwd: home,
	} as unknown as ExtensionCommandContext;
	workflow(pi);
	const handler = commands.get("workflow")?.handler;
	assert.ok(handler);

	await handler("review", ctx);
	await handler("review --last", ctx);

	assert.equal(notes.length, 2);
	for (const note of notes) {
		assert.equal(note.level, "warning");
		assert.match(note.text, /\/workflow review was removed/);
		assert.match(note.text, /\/workflow report/);
	}
	assert.equal(sent.length, 0, "no sendMessage: no model turn");
	assert.equal(users.length, 0, "no sendUserMessage: no model turn");
	assert.equal(existsSync(join(home, "reports")), false, "no report is written");
});

test("/workflow ask still starts a model turn, which is what the review check above must not match", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "workflow-ask-turn-"));
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const { pi, commands, sent } = fakePi();
	workflow(pi);
	const handler = commands.get("workflow")?.handler;
	assert.ok(handler);

	await handler("ask what did I save last week?", {} as ExtensionCommandContext);

	assert.equal(sent.length, 1);
	assert.equal((sent[0]?.[1] as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);
});

// Routing in the live report: each worker shows the decision that chose it, with the account and reason that were
// authorized. The journal is passed in, so no real pihouse home is read.
const T0 = Date.parse("2026-01-01T00:00:00Z");

function worker(name: string, startedAt: string, model: string | null = null): SessionRecord {
	return {
		id: `${startedAt.replace(/\D/g, "")}-${name}`,
		name,
		parent: "planner",
		parentName: "workflow-planner",
		root: "planner",
		harness: "pihouse",
		model,
		cwd: process.cwd(),
		state: "exited",
		depth: 1,
		task: "Task T1 of docs/plans/x.md: Build the thing\nSkills: build",
		startedAt,
		updatedAt: startedAt,
	};
}

function decision(over: Partial<RoutingDecision>): RoutingDecision {
	return {
		time: T0,
		profile: "build",
		task: "T1",
		agent: "w-1",
		model: "openai-codex/gpt-6-luna",
		account: "openai",
		billing: "subscription",
		reason: "available (usage endpoint, observed 30s ago)",
		failure: null,
		checkpoint: null,
		...over,
	};
}

const planner: SessionRecord = {
	id: "planner",
	name: "workflow-planner",
	parent: null,
	parentName: null,
	root: "planner",
	harness: "pihouse",
	model: null,
	cwd: process.cwd(),
	state: "exited",
	depth: 0,
	task: "/skill:executor docs/plans/x.md",
	startedAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:10:00.000Z",
	sessionId: "planner-session",
};
const w1 = worker("w-1", "2026-01-01T00:00:05.000Z");
const w2 = worker("w-2", "2026-01-01T00:00:40.000Z", "openai-codex/gpt-6-luna");

test("each worker shows the routing decision that chose it, with its account and reason, latest before its start", () => {
	const decisions = [
		decision({ time: T0 - 3600_000, agent: "w-1", account: "claude", model: "anthropic/claude-sonnet-5-5" }),
		decision({ time: T0 + 1000, agent: "w-1" }),
		// Made after w-1 had started: it cannot have chosen that worker.
		decision({ time: T0 + 60_000, agent: "w-1", account: "late-account" }),
		decision({
			time: T0 + 30_000,
			agent: "w-2",
			model: "anthropic/claude-sonnet-5-5",
			account: "claude",
			reason: "authorized alternative (usage endpoint, observed 5s ago)",
			failure: "exhausted",
		}),
	];
	const run = buildRun([planner, w1, w2], planner);
	const report = renderReport(run, { routing: { decisions, skipped: 0 }, messages: false });
	assert.match(report, /## Routing decisions/);
	const w1Row = report.split("\n").find((line) => line.startsWith("| w-1 |")) ?? "";
	// w-1 has no journal model and no transcript, so the journal column is unknown, not the routed model.
	assert.match(w1Row, /\| build \| openai-codex\/gpt-6-luna \| - \| openai \|/);
	assert.doesNotMatch(report, /late-account/);
	assert.doesNotMatch(
		report,
		/anthropic\/claude-sonnet-5-5 \| openai \|/,
		"an older decision for w-1 is not its decision",
	);
	const w2Row = report.split("\n").find((line) => line.startsWith("| w-2 |")) ?? "";
	assert.match(
		w2Row,
		/\| build \| anthropic\/claude-sonnet-5-5 \| openai-codex\/gpt-6-luna \(switched after routing\) \| claude \|/,
	);
	assert.match(w2Row, /\| exhausted \|/);
});

test("a run whose workers have no routing decision shows no routing section", () => {
	const run = buildRun([planner, w1], planner);
	const report = renderReport(run, { routing: { decisions: [], skipped: 0 }, messages: false });
	assert.doesNotMatch(report, /Routing decisions/);
});

test("corrupt journal lines are counted in the report, and the decisions around them still show", () => {
	const run = buildRun([planner, w1], planner);
	const report = renderReport(run, { routing: { decisions: [decision({})], skipped: 2 }, messages: false });
	assert.match(report, /2 unreadable routing journal line\(s\) skipped/);
	assert.match(report, /\| w-1 \| build \| openai-codex\/gpt-6-luna \|/);
});

test("a paused decision shows that no model or account was chosen, and its reason", () => {
	const paused = decision({
		model: null,
		account: null,
		billing: null,
		reason: "openai-codex/gpt-6-luna on openai: exhausted",
		failure: "exhausted",
		checkpoint: "/tmp/x.json",
	});
	const run = buildRun([planner, w1], planner);
	const report = renderReport(run, { routing: { decisions: [paused], skipped: 0 }, messages: false });
	assert.match(report, /\| w-1 \| build \| none \(paused\) \|[^\n]*\| none \|/);
});

test("without an explicit journal the report reads the pihouse home it is run from", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-report-home-"));
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = home;
	try {
		appendRoutingDecision(home, decision({ agent: "w-1", account: "from-home" }));
		const report = renderReport(buildRun([planner, w1], planner), { messages: false });
		assert.match(report, /from-home/);
	} finally {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});
