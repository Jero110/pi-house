import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
	locateTranscript,
	readTranscript,
	selectMessages,
	skillsInText,
	skillsInToolCall,
	summarize,
	type TranscriptRoots,
} from "../src/index.ts";

const lines = (...objs: object[]) => `${objs.map((o) => JSON.stringify(o)).join("\n")}\n`;

function roots(t: { after: (fn: () => void) => void }): TranscriptRoots {
	const home = mkdtempSync(join(tmpdir(), "at-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return {
		claude: join(home, "claude"),
		codex: join(home, "codex"),
		opencodeDb: join(home, "opencode.db"),
		pi: join(home, "pi"),
		pihouse: join(home, "pihouse"),
	};
}

test("skills are found in SKILL.md reads, skill tool calls, /skill commands and Claude's injected body", () => {
	assert.deepEqual(skillsInToolCall("read", { path: "/repo/skills/build/test-driven-development/SKILL.md" }), [
		"test-driven-development",
	]);
	assert.deepEqual(skillsInToolCall("Skill", { skill: "grilling" }), ["grilling"]);
	assert.deepEqual(skillsInToolCall("bash", { command: 'for d in x; do cat "$d/SKILL.md"; done' }), []);
	assert.deepEqual(skillsInText("/skill:planner build a todo app"), ["planner"]);
	assert.deepEqual(skillsInText("Base directory for this skill: /home/u/.claude/skills/executor"), ["executor"]);
});

test("a worker's session: every typed message came from its parent, though none carries a sender tag", (t) => {
	const r = roots(t);
	const dir = join(r.claude, "-work");
	mkdirSync(dir, { recursive: true });
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	writeFileSync(
		join(dir, "w-1.jsonl"),
		lines(
			{ type: "user", timestamp: at(0), message: { content: "Task T4: review greet.mjs" } },
			{ type: "assistant", timestamp: at(2), message: { id: "m1", content: [{ type: "text", text: "Done." }] } },
			{ type: "user", timestamp: at(3), message: { content: "also check package.json" } },
		),
	);
	const origins = (worker: boolean) =>
		readTranscript({ harness: "claude", sessionId: "w-1", worker }, r)
			.messages.filter((m) => m.role === "user")
			.map((m) => m.origin);
	assert.deepEqual(origins(true), ["agent", "agent"]);
	assert.deepEqual(origins(false), ["human", "human"]);
});

test("Claude: one message per message id, usage of the last line, tool results, durations, session from the file", (t) => {
	const r = roots(t);
	const dir = join(r.claude, "-work");
	mkdirSync(dir, { recursive: true });
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
	writeFileSync(
		join(dir, "sid-1.jsonl"),
		lines(
			{ type: "user", sessionId: "sid-1", cwd: "/work", timestamp: at(0), message: { content: "build it" } },
			{
				type: "assistant",
				timestamp: at(4),
				message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "On it." }], usage },
			},
			{
				type: "assistant",
				timestamp: at(6),
				message: {
					id: "m1",
					model: "claude-sonnet-5-5",
					content: [
						{
							type: "tool_use",
							id: "tu1",
							name: "Read",
							input: { file_path: "/s/build/spec-driven-development/SKILL.md" },
						},
					],
					usage: { ...usage, output_tokens: 9 },
				},
			},
			{
				type: "user",
				timestamp: at(7),
				message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] },
			},
			{ type: "user", timestamp: at(8), message: { content: "<system-reminder>x</system-reminder>" } },
			{ type: "user", timestamp: at(9), message: { content: "[agent-link] codex (codex) finished:\n\ndone" } },
		),
	);
	const tr = readTranscript({ harness: "claude", sessionId: "sid-1" }, r);
	assert.equal(tr.cwd, "/work");
	assert.deepEqual(
		tr.messages.map((m) => [m.role, m.origin ?? ""]),
		[
			["user", "human"],
			["assistant", ""],
			["user", "agent"],
		],
	);
	const a = tr.messages[1];
	assert.equal(a?.durationMs, 6000);
	assert.deepEqual(a?.usage, { input: 10, output: 9, cacheRead: 100, cacheWrite: 20 });
	assert.equal(a?.tools[0]?.ok, false);
	assert.deepEqual(a?.skills, ["spec-driven-development"]);
	const s = summarize(tr);
	assert.equal(s.totalTokens, 139);
	assert.equal(s.failedToolCalls, 1);
	assert.deepEqual(s.models, ["claude-sonnet-5-5"]);
	assert.deepEqual(
		selectMessages(tr, { search: "finished" }).map((m) => m.index),
		[2],
	);
	assert.deepEqual(
		selectMessages(tr, { limit: 1 }).map((m) => m.index),
		[2],
	);
});

test("Codex: found by thread id in date folders, prompts from UserMessage items, cached input split out", (t) => {
	const r = roots(t);
	const dir = join(r.codex, "2026", "10", "23");
	mkdirSync(dir, { recursive: true });
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	writeFileSync(
		join(dir, "rollout-2026-10-23T10-00-00-th-1.jsonl"),
		lines(
			{ type: "session_meta", timestamp: at(0), payload: { id: "th-1", cwd: "/w" } },
			{ type: "turn_context", timestamp: at(0), payload: { model: "gpt-6" } },
			{
				type: "event_msg",
				timestamp: at(1),
				payload: {
					type: "item_completed",
					item: { type: "UserMessage", content: [{ type: "input_text", text: "fix the test" }] },
				},
			},
			{
				type: "response_item",
				timestamp: at(2),
				payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"cmd":"npm test"}' },
			},
			{
				type: "response_item",
				timestamp: at(3),
				payload: { type: "function_call_output", call_id: "c1", output: "Process exited with code 1" },
			},
			{
				type: "response_item",
				timestamp: at(5),
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] },
			},
			{
				type: "token_usage_record",
				timestamp: at(5),
				payload: { usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } },
			},
		),
	);
	assert.match(locateTranscript({ harness: "codex", sessionId: "th-1" }, r) ?? "", /th-1\.jsonl$/);
	const tr = readTranscript({ harness: "codex", sessionId: "th-1" }, r);
	assert.equal(tr.messages[0]?.text, "fix the test");
	const a = tr.messages[1];
	assert.equal(a?.text, "Fixed.");
	assert.equal(a?.tools[0]?.ok, false);
	assert.deepEqual(a?.usage, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
	assert.equal(a?.model, "gpt-6");
});

test("pi and pihouse: same format, different folders; agent-link messages come from an agent", (t) => {
	const r = roots(t);
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	const body = lines(
		{ type: "session", id: "ps-1", cwd: "/w", timestamp: at(0) },
		{ type: "model_change", id: "e0", timestamp: at(0), provider: "anthropic", modelId: "claude-sonnet-5-5" },
		{ type: "custom_message", id: "e1", timestamp: at(1), customType: "agent-link", content: "Task T1: go" },
		{
			type: "message",
			id: "e2",
			timestamp: at(3),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "k1", name: "read", arguments: { path: "skills/build/executor/SKILL.md" } }],
				usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
			},
		},
		{ type: "message", id: "e3", timestamp: at(4), message: { role: "toolResult", toolCallId: "k1", isError: false } },
	);
	for (const [h, dir] of [
		["pi", r.pi],
		["pihouse", r.pihouse],
	] as const) {
		mkdirSync(join(dir, "--w--"), { recursive: true });
		writeFileSync(join(dir, "--w--", "2026-10-23T10-00-00-000Z_ps-1.jsonl"), body);
		const tr = readTranscript({ harness: h, sessionId: "ps-1" }, r);
		assert.equal(tr.harness, h);
		assert.equal(tr.messages[0]?.origin, "agent");
		assert.deepEqual(tr.messages[1]?.skills, ["executor"]);
		assert.equal(tr.messages[1]?.tools[0]?.ok, true);
		assert.equal(tr.messages[1]?.model, "anthropic/claude-sonnet-5-5");
		assert.equal(summarize(tr).totalTokens, 18);
	}
});

test("opencode: read-only from its database, one session, tokens with reasoning as output", (t) => {
	const r = roots(t);
	const db = new DatabaseSync(r.opencodeDb);
	db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
	db.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_1", "/w", 1000);
	const msg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
	const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
	msg.run("u1", "ses_1", 1000, JSON.stringify({ role: "user" }));
	part.run("p1", "u1", "ses_1", 1000, JSON.stringify({ type: "text", text: "search the docs" }));
	msg.run(
		"a1",
		"ses_1",
		1500,
		JSON.stringify({
			role: "assistant",
			providerID: "opencode",
			modelID: "glm-5.3-flash-free",
			time: { completed: 4000 },
			tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 11, write: 0 } },
		}),
	);
	part.run("p2", "a1", "ses_1", 1600, JSON.stringify({ type: "text", text: "Found it." }));
	part.run(
		"p3",
		"a1",
		"ses_1",
		1700,
		JSON.stringify({
			type: "tool",
			tool: "webfetch",
			callID: "w1",
			state: { status: "completed", input: { url: "x" }, time: { end: 1800 } },
		}),
	);
	db.close();
	const tr = readTranscript({ harness: "opencode", sessionId: "ses_1" }, r);
	assert.equal(tr.messages.length, 2);
	const a = tr.messages[1];
	assert.equal(a?.text, "Found it.");
	assert.equal(a?.durationMs, 3000);
	assert.deepEqual(a?.usage, { input: 7, output: 5, cacheRead: 11, cacheWrite: 0 });
	assert.equal(a?.model, "opencode/glm-5.3-flash-free");
	assert.equal(a?.tools[0]?.ok, true);
	assert.throws(() => readTranscript({ harness: "opencode", sessionId: "nope" }, r), /not in/);
});

test("unknown harnesses and missing files say why", (t) => {
	const r = roots(t);
	assert.throws(() => readTranscript({ harness: "aider", sessionId: "x" }, r), /no transcript reader/);
	assert.throws(() => readTranscript({ harness: "claude", sessionId: "x" }, r), /no transcript on disk/);
});
