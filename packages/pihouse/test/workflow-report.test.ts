import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import workflow from "../src/extensions/workflow.ts";
import { renderReport } from "../src/workflow/report.ts";
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
