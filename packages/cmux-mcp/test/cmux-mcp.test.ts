import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Journal } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import type { CmuxRunner } from "../src/cmux.ts";
import { serveMcp, type Tool } from "../src/server.ts";
import { cmuxTools, INSTRUCTIONS } from "../src/tools.ts";

const WS = "WS-1";

/** A fake cmux: records each call and answers from a table keyed by the command's words. */
function fakeCmux(answers: Record<string, string | ((args: readonly string[]) => string)>) {
	const calls: string[][] = [];
	const run: CmuxRunner = async (args) => {
		calls.push([...args]);
		const key = args.filter((a) => !a.startsWith("--") || a === "--json").join(" ");
		for (const [k, v] of Object.entries(answers)) if (key.startsWith(k)) return typeof v === "string" ? v : v(args);
		return "OK";
	};
	return { run, calls };
}

function setup(t: { after: (fn: () => void) => void }, answers: Parameters<typeof fakeCmux>[0] = {}) {
	const home = mkdtempSync(join(tmpdir(), "cmux-mcp-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const roots: TranscriptRoots = {
		claude: join(home, "claude"),
		codex: join(home, "codex"),
		opencodeDb: join(home, "oc.db"),
		pi: join(home, "pi"),
		pihouse: join(home, "pihouse"),
	};
	const journalDir = join(home, "journal");
	const fake = fakeCmux(answers);
	const tools = cmuxTools({ run: fake.run, env: { CMUX_WORKSPACE_ID: WS }, journalDir, roots });
	const tool = (name: string): Tool => {
		const found = tools.find((x) => x.name === name);
		if (!found) throw new Error(`no tool ${name}`);
		return found;
	};
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await tool(name).run(args);
		const first = r.content[0];
		return { text: first?.type === "text" ? first.text : "", isError: r.isError === true, result: r };
	};
	return { home, roots, journalDir, fake, tools, call };
}

const cmuxSession = (over: Record<string, unknown>) => ({
	agent: "claude",
	session_id: "sid-1",
	surface_id: "SURF-1",
	workspace_id: WS,
	cwd: "/w",
	agent_lifecycle: "idle",
	stored_pid_exists: true,
	updated_at: "2026-10-23T10:00:00Z",
	...over,
});

test("the tool list is exactly the one the README documents", (t) => {
	const { tools } = setup(t);
	assert.deepEqual(tools.map((x) => x.name).sort(), [
		"browser",
		"close_surface",
		"close_workspace",
		"current_workspace",
		"focus_surface",
		"identify",
		"list_agent_sessions",
		"list_surfaces",
		"list_workspaces",
		"move_surface",
		"new_pane",
		"new_surface",
		"new_workspace",
		"read_agent_transcript",
		"rename_tab",
		"rename_workspace",
		"reorder_surface",
		"resize_pane",
		"select_workspace",
		"surface_health",
		"swap_pane",
		"tree",
	]);
});

test("list_agent_sessions joins cmux's records with the agent-link journal and keeps journal-only agents", async (t) => {
	const s = setup(t, {
		"--json sessions": JSON.stringify({
			sessions: [
				cmuxSession({}),
				cmuxSession({ agent: "codex", session_id: "th-2", workspace_id: "OTHER", surface_id: "SURF-9" }),
			],
		}),
	});
	const j = new Journal(s.journalDir);
	const base = { cwd: "/w", depth: 1, state: "working" as const, model: null };
	j.create({
		...base,
		id: "j1",
		name: "claude-2",
		parent: "j0",
		parentName: "pihouse",
		root: "j0",
		harness: "claude",
		task: "Task T2: write the parser\nmore",
		sessionId: "sid-1",
		startedAt: "2026-10-23T09:00:00.000Z",
	});
	j.create({
		...base,
		id: "j2",
		name: "pihouse-2",
		parent: "j0",
		parentName: "pihouse",
		root: "j0",
		harness: "pihouse",
		backend: "tmux",
		pane: "%4",
		place: { workspace: WS },
		sessionId: "ps-1",
		startedAt: "2026-10-23T09:30:00.000Z",
	});
	const here = await s.call("list_agent_sessions");
	assert.match(
		here.text,
		/claude "claude-2" · state idle · session sid-1 · surface SURF-1 · workspace WS-1 \(current\)/,
	);
	assert.match(here.text, /launched by pihouse/);
	assert.match(here.text, /task: Task T2: write the parser$/m);
	assert.match(here.text, /pihouse "pihouse-2" · state working · session ps-1/);
	assert.doesNotMatch(here.text, /th-2/, "another workspace is left out by default");
	const all = await s.call("list_agent_sessions", { workspace: "all", agent: "codex" });
	assert.match(all.text, /^1\. codex · state idle · session th-2/);
});

test("read_agent_transcript resolves a name, session id or surface and reads the transcript, never the screen", async (t) => {
	const s = setup(t, {
		"--json sessions": JSON.stringify({ sessions: [cmuxSession({ transcript_path: null })] }),
	});
	const dir = join(s.roots.claude, "-w");
	mkdirSync(dir, { recursive: true });
	const at = (sec: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, sec)).toISOString();
	writeFileSync(
		join(dir, "sid-1.jsonl"),
		[
			{ type: "user", sessionId: "sid-1", timestamp: at(0), message: { content: "please build the parser" } },
			{
				type: "assistant",
				timestamp: at(5),
				message: {
					id: "m1",
					model: "claude-sonnet-5-5",
					content: [{ type: "text", text: "The parser is done; tests pass." }],
				},
			},
		]
			.map((o) => JSON.stringify(o))
			.join("\n"),
	);
	new Journal(s.journalDir).create({
		id: "j1",
		name: "claude-2",
		parent: null,
		parentName: null,
		root: "j1",
		harness: "claude",
		model: null,
		cwd: "/w",
		state: "exited",
		depth: 0,
		sessionId: "sid-1",
		startedAt: at(0),
	});
	for (const key of ["claude-2", "sid-1", "SURF-1"]) {
		const r = await s.call("read_agent_transcript", { session: key });
		assert.equal(r.isError, false, r.text);
		assert.match(r.text, /^claude "claude-2" session sid-1/);
		assert.match(r.text, /--- #1 assistant 2026-10-23 10:00:05\nThe parser is done; tests pass\./);
	}
	const found = await s.call("read_agent_transcript", { session: "sid-1", search: "PARSER IS" });
	assert.match(found.text, /1 messages match "PARSER IS"/);
	assert.ok(!s.fake.calls.some((c) => c.includes("read-screen")), "transcripts only");
	const missing = await s.call("read_agent_transcript", { session: "nope" });
	assert.equal(missing.isError, true);
});

test("cmux commands get the flags the CLI takes", async (t) => {
	const s = setup(t);
	await s.call("move_surface", { surface: "surface:4", pane: "pane:2", index: 0, focus: true });
	await s.call("reorder_surface", { surface: "surface:4", before: "surface:3" });
	await s.call("resize_pane", { pane: "pane:2", direction: "R", amount: 10 });
	await s.call("swap_pane", { pane: "pane:1", target_pane: "pane:2" });
	await s.call("rename_tab", { surface: "surface:4", title: "logs" });
	await s.call("focus_surface", { surface: "surface:4" });
	await s.call("new_workspace", { name: "api", cwd: "/w" });
	await s.call("browser", { action: "goto", args: ["https://example.com"], surface: "surface:7" });
	assert.deepEqual(s.fake.calls, [
		["move-surface", "--surface", "surface:4", "--pane", "pane:2", "--index", "0", "--focus", "true"],
		["reorder-surface", "--surface", "surface:4", "--before", "surface:3"],
		["resize-pane", "--pane", "pane:2", "-R", "--amount", "10"],
		["swap-pane", "--pane", "pane:1", "--target-pane", "pane:2"],
		["rename-tab", "--surface", "surface:4", "logs"],
		["focus-panel", "--panel", "surface:4"],
		["new-workspace", "--name", "api", "--cwd", "/w", "--focus", "false"],
		["browser", "--surface", "surface:7", "goto", "https://example.com"],
	]);
	const bad = await s.call("resize_pane", { direction: "X" });
	assert.equal(bad.isError, true);
});

test("close_workspace shows the contents and needs confirm while agents run there", async (t) => {
	const s = setup(t, {
		"tree --json": JSON.stringify({ windows: [{ workspaces: [{ id: WS }] }] }),
		"--json tree": JSON.stringify({ windows: [{ workspaces: [{ id: WS }] }] }),
		tree: 'workspace workspace:2 "api"\n└── surface surface:4 [terminal]',
		"--json sessions": JSON.stringify({ sessions: [cmuxSession({ agent_lifecycle: "running" })] }),
	});
	const first = await s.call("close_workspace", { workspace: "workspace:2" });
	assert.match(first.text, /^Not closed\. Workspace workspace:2 holds:\nworkspace workspace:2 "api"/);
	assert.match(first.text, /- claude session sid-1 \(running\)/);
	assert.ok(!s.fake.calls.some((c) => c[0] === "close-workspace"));
	const second = await s.call("close_workspace", { workspace: "workspace:2", confirm: true });
	assert.match(second.text, /^Closed workspace workspace:2/);
	assert.ok(s.fake.calls.some((c) => c[0] === "close-workspace"));
});

test("the server speaks MCP over stdio: initialize with instructions, tools/list, tools/call", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines: Record<string, unknown>[] = [];
	output.on("data", (d: Buffer) => {
		for (const l of d.toString().split("\n")) if (l.trim()) lines.push(JSON.parse(l));
	});
	const tools: Tool[] = [
		{
			name: "echo",
			description: "echo",
			inputSchema: { type: "object", properties: {} },
			run: async (a) => ({ content: [{ type: "text", text: JSON.stringify(a) }] }),
		},
	];
	const done = serveMcp({ name: "cmux", version: "0", instructions: INSTRUCTIONS, tools, input, output });
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
	input.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } })}\n`,
	);
	input.end();
	await done;
	assert.equal(lines.length, 3);
	assert.match(JSON.stringify(lines[0]), /never the terminal screen/);
	assert.match(JSON.stringify(lines[1]), /"name":"echo"/);
	assert.match(JSON.stringify(lines[2]), /\{\\"x\\":1\}/);
});
