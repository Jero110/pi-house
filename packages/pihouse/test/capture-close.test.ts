import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workflow from "../src/extensions/workflow.ts";
import { addFlag, readFlags } from "../src/workflow/capture.ts";

// A fake pi and a fake native session file only: no hub, no real model, no real home.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Fixture {
	home: string;
	memory: string;
	session: string;
	handlers: Map<string, Handler[]>;
	command: (raw: string) => Promise<void>;
	notes: { text: string; level: string }[];
	names: string[];
	sent: unknown[];
	ctx: ExtensionContext;
}

function setup(t: { after: (fn: () => void) => void }, sessionId = "s1"): Fixture {
	const saved = Object.entries(process.env).filter(([key]) => key.startsWith("AGENT_LINK_") || key === "PIHOUSE_HOME");
	for (const [key] of saved) delete process.env[key];
	const home = mkdtempSync(join(tmpdir(), "pihouse-close-"));
	process.env.PIHOUSE_HOME = home;
	process.env.AGENT_LINK_HOME = join(home, "link");
	t.after(() => {
		delete process.env.PIHOUSE_HOME;
		delete process.env.AGENT_LINK_HOME;
		for (const [key, value] of saved) process.env[key] = value;
		rmSync(home, { recursive: true, force: true });
	});
	const session = join(home, "native.jsonl");
	writeFileSync(
		session,
		`${[
			JSON.stringify({ type: "session", id: sessionId, cwd: home }),
			JSON.stringify({
				type: "message",
				id: "m1",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "How do I rename a branch?" },
			}),
		].join("\n")}\n`,
	);
	const handlers = new Map<string, Handler[]>();
	const names: string[] = [];
	const sent: unknown[] = [];
	let name: string | undefined;
	const commands = new Map<string, (raw: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (n: string, spec: { handler: (raw: string, ctx: ExtensionCommandContext) => void }) =>
			commands.set(n, spec.handler),
		sendMessage: (...args: unknown[]) => sent.push(args),
		sendUserMessage: (...args: unknown[]) => sent.push(args),
		getSessionName: () => name,
		setSessionName: (n: string) => {
			name = n;
			names.push(n);
		},
	} as unknown as ExtensionAPI;
	const notes: { text: string; level: string }[] = [];
	const ctx = {
		ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => session },
		cwd: home,
	} as unknown as ExtensionContext;
	workflow(pi);
	const handler = commands.get("workflow");
	assert.ok(handler);
	return {
		home,
		memory: join(home, "memory"),
		session,
		handlers,
		command: async (raw) => {
			await handler(raw, ctx as unknown as ExtensionCommandContext);
		},
		notes,
		names,
		sent,
		ctx,
	};
}

const emit = async (f: Fixture, event: string, ctx: ExtensionContext = f.ctx) => {
	for (const handler of f.handlers.get(event) ?? []) await handler({ type: event }, ctx);
};

const runJson = (f: Fixture) => join(f.memory, "conversations", "local-s1", "run.json");

function tree(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true }).map(String).sort();
}

test("session_shutdown on a flagged session writes what agent_end writes, and a second capture adds no revision", async (t) => {
	const f = setup(t);
	mkdirSync(f.memory, { recursive: true });
	addFlag(f.memory, "local-s1", { by: "planner" });
	await emit(f, "session_shutdown");
	const files = tree(join(f.memory, "conversations", "local-s1"));
	assert.ok(files.includes("run.json") && files.includes("report.md"), files.join(","));
	assert.ok(files.some((file) => file.startsWith("transcripts")));
	const closed = readFileSync(runJson(f), "utf8");
	assert.equal(JSON.parse(closed).revision, 1);

	const g = setup(t);
	mkdirSync(g.memory, { recursive: true });
	addFlag(g.memory, "local-s1", { by: "planner" });
	await emit(g, "agent_end");
	assert.deepEqual(tree(join(g.memory, "conversations", "local-s1")), files);

	await emit(g, "session_shutdown");
	const after = JSON.parse(readFileSync(runJson(g), "utf8"));
	assert.equal(after.revision, 1, "the same fingerprint adds no revision");
	assert.deepEqual(tree(join(g.memory, "conversations", "local-s1")), files);
});

test("a shutdown handler that throws never blocks the shutdown", async (t) => {
	const f = setup(t);
	const broken = {
		...f.ctx,
		sessionManager: {
			getSessionId: () => {
				throw new Error("boom");
			},
			getSessionFile: () => f.session,
		},
	} as unknown as ExtensionContext;
	await assert.doesNotReject(emit(f, "session_shutdown", broken));
	assert.equal(existsSync(runJson(f)), false);
});

test("an unflagged session that closes captures nothing", async (t) => {
	const f = setup(t);
	await emit(f, "session_shutdown");
	assert.equal(existsSync(join(f.memory, "conversations", "local-s1")), false);
});

test("/workflow log flags by log, renames the session, captures, and a second run does not duplicate", async (t) => {
	const f = setup(t);
	await f.command("log good branch advice");
	assert.deepEqual(f.names, ["workflow-saved · good branch advice"]);
	assert.equal(readFlags(f.memory).runs["local-s1"]?.by, "log");
	assert.equal(readFlags(f.memory).runs["local-s1"]?.reason, "good branch advice");
	const first = readFileSync(runJson(f), "utf8");
	assert.equal(JSON.parse(first).flaggedBy, "log");
	const files = tree(join(f.memory, "conversations", "local-s1"));

	await f.command("log good branch advice");
	assert.equal(readFileSync(runJson(f), "utf8"), first, "same evidence, same package");
	assert.deepEqual(tree(join(f.memory, "conversations", "local-s1")), files);
	assert.equal(f.names.length, 1, "already renamed");
	assert.equal(f.sent.length, 0, "no model turn");
});

test("an automatic flag after /workflow log does not downgrade it", async (t) => {
	const f = setup(t);
	await f.command("log keep this");
	addFlag(f.memory, "local-s1", { by: "planner" });
	assert.equal(readFlags(f.memory).runs["local-s1"]?.by, "log");
});

test("/workflow save and /workflow report answer with replacement guidance and write nothing", async (t) => {
	const f = setup(t);
	await f.command("save something");
	await f.command("report --last");
	assert.equal(f.notes.length, 2);
	assert.match(f.notes[0]?.text ?? "", /\/workflow save was retired.*\/workflow log/);
	assert.match(f.notes[1]?.text ?? "", /\/workflow report was retired.*conversations/);
	assert.ok(f.notes.every((n) => n.level === "warning"));
	assert.equal(f.sent.length, 0);
	assert.equal(f.names.length, 0);
	assert.equal(existsSync(join(f.home, "reports")), false);
	assert.equal(existsSync(join(f.memory, "conversations")), false);
	assert.equal(existsSync(join(f.memory, "flags.json")), false);
});
