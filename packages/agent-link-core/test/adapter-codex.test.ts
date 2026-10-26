import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { codexConfigArgs, createCodexAdapter } from "../src/adapters/codex.ts";
import { checkCommand } from "../src/guard.ts";
import type { AdapterDeps, AgentAdapter, LaunchSpec, PaneBackend, Profile, SessionUpdate } from "../src/types.ts";
import { type FakeAppServer, FakeServerProcess } from "./fixtures/codex/fake-app-server.ts";

const profile: Profile = JSON.parse(readFileSync(new URL("../profiles/codex.json", import.meta.url), "utf8"));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const THREAD = "thread-tui";

function spec(model: string | null = null): LaunchSpec {
	return {
		name: "codex-1",
		parent: "boss",
		model,
		cwd: "/work",
		runDir: mkdtempSync(join(tmpdir(), "xl-codex-")),
		env: { AGENT_LINK_AGENT: "codex-1", AGENT_LINK_DEPTH: "1" },
		mcp: { command: "/bin/xl", args: ["mcp", "--backend", "cmux"] },
		profile,
	};
}

function deps(depth = 1): AdapterDeps & { logs: { kind: string; data?: Record<string, unknown> }[] } {
	const logs: { kind: string; data?: Record<string, unknown> }[] = [];
	return { logs, log: (kind, data) => logs.push({ kind, data }), guard: checkCommand, depth };
}

interface Harness {
	adapter: AgentAdapter;
	proc: FakeServerProcess;
	server: FakeAppServer;
	updates: SessionUpdate[];
	d: ReturnType<typeof deps>;
}

/** Launches the adapter on a fake app-server; with `connected`, the TUI's thread is announced and adopted. */
async function harness(t: TestContext, opts: { depth?: number; installed?: string[]; connected?: boolean } = {}) {
	let proc: FakeServerProcess | undefined;
	const d = deps(opts.depth ?? 1);
	const adapter = createCodexAdapter(d, {
		spawnServer: (command, args, o) => {
			proc = new FakeServerProcess(command, args, o);
			return proc;
		},
		listMcpServers: async () => opts.installed ?? [],
		timeoutMs: 3000,
	});
	const updates: SessionUpdate[] = [];
	// The session update (thread id for the journal) is checked on its own; the rest of the stream is what the tests look at.
	const sessions: SessionUpdate[] = [];
	adapter.onUpdate((u) => (u.kind === "session" ? sessions : updates).push(u));
	const cmd = await adapter.launch(spec());
	if (!proc) throw new Error("spawnServer was not called");
	const p = proc;
	t.after(async () => {
		await adapter.close();
		p.server.close();
	});
	const h: Harness = { adapter, proc: p, server: p.server, updates, d };
	if (opts.connected !== false) {
		h.server.notify("thread/started", { thread: { id: THREAD } });
		await adapter.connect();
	}
	return { ...h, cmd };
}

const WORKER_SANDBOX = ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"];

test("config args: model, workspace-write for workers, and the agent-link MCP server unless installed", () => {
	const s = spec("gpt-6");
	assert.deepEqual(codexConfigArgs(s, false), [
		"-c",
		'model="gpt-6"',
		...WORKER_SANDBOX,
		"-c",
		'mcp_servers.agent-link.command="/bin/xl"',
		"-c",
		'mcp_servers.agent-link.args=["mcp","--backend","cmux"]',
		"-c",
		'mcp_servers.agent-link.env_vars=["AGENT_LINK_AGENT","AGENT_LINK_HUB","AGENT_LINK_TOKEN","AGENT_LINK_DEPTH","AGENT_LINK_HOME","AGENT_LINK_READ_DIRS","CMUX_WORKSPACE_ID","CMUX_SURFACE_ID","TMUX","TMUX_PANE"]',
		"-c",
		'mcp_servers.agent-link.default_tools_approval_mode="approve"',
	]);
	assert.deepEqual(codexConfigArgs(spec(), true), WORKER_SANDBOX);
	assert.deepEqual(codexConfigArgs({ ...spec(), parent: null }, true), [], "a root keeps the user's own sandbox");
});

test("launch starts one app-server on a free port with the identity env; the pane runs the TUI on it", async (t) => {
	const { proc, cmd } = await harness(t, { connected: false, installed: ["agent-link"] });
	assert.equal(proc.command, "codex");
	assert.equal(proc.args[0], "app-server");
	assert.equal(proc.args[1], "--listen");
	assert.match(proc.args[2] ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
	assert.deepEqual(proc.args.slice(3), WORKER_SANDBOX, "agent-link installed globally: only the worker sandbox");
	assert.equal(proc.cwd, "/work");
	assert.equal(proc.env.AGENT_LINK_AGENT, "codex-1");
	assert.deepEqual(cmd.argv, ["codex", "--remote", proc.args[2]]);
	assert.equal(cmd.cwd, "/work");
	assert.equal(cmd.env.AGENT_LINK_DEPTH, "1");
	assert.equal(proc.server.received[0]?.method, "initialize");
});

test("connect adopts the thread the TUI starts, without subscribing to a thread that has no turns", async (t) => {
	const { adapter, server } = await harness(t, { connected: false });
	const connecting = adapter.connect();
	await tick();
	assert.equal(adapter.idle(), false, "no thread yet");
	server.notify("thread/started", { thread: { id: THREAD } });
	await connecting;
	assert.equal(adapter.idle(), true);
	assert.equal(
		server.received.some((m) => m.method === "thread/resume"),
		false,
	);
});

test("the first turn subscribes with thread/resume, retrying while Codex has no rollout yet", async (t) => {
	const { adapter, server, d } = await harness(t);
	server.resumeFailures = 2;
	const p = adapter.prompt({ id: "m1", from: "boss", text: "hi" });
	await server.waitFor((m) => m.method === "turn/start");
	await server.waitFor((m) => m.method === "thread/resume" && "params" in m);
	await tick(400);
	assert.equal(server.received.filter((m) => m.method === "thread/resume").length, 3);
	assert.ok(d.logs.some((l) => l.kind === "codex_subscribed"));
	server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "completed" } });
	assert.equal((await p).stopReason, "end_turn");
	adapter.prompt({ id: "m2", from: "boss", text: "again" });
	await server.waitFor(
		(m) => m.method === "turn/start" && (m.params as { input: { text: string }[] }).input[0]?.text === "again",
	);
	await tick();
	assert.equal(server.received.filter((m) => m.method === "thread/resume").length, 3, "subscribed once");
});

test("a turn that ended before the subscription is reported from the resume answer, once", async (t) => {
	const { adapter, server } = await harness(t);
	server.resumeTurns = [
		{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "a", text: "fast READY" }] },
	];
	const p = adapter.prompt({ id: "m1", from: "boss", text: "hi" });
	assert.deepEqual(await p, { stopReason: "end_turn", text: "fast READY" });
	server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "completed" } });
	await tick();
	assert.equal(adapter.idle(), true);
});

test("a turn typed in the TUI before any prompt makes the adapter subscribe", async (t) => {
	const { server, updates } = await harness(t);
	server.notify("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } });
	await server.waitFor((m) => m.method === "thread/resume");
	await tick();
	server.notify("turn/completed", {
		threadId: THREAD,
		turn: { id: "typed", items: [{ type: "agentMessage", id: "a", text: "typed first" }], status: "completed" },
	});
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "turn_end", stopReason: "end_turn", text: "typed first" });
});

test("connect finds a thread started before it connected through thread/loaded/list", async (t) => {
	const { adapter, server } = await harness(t, { connected: false });
	server.loaded = ["thread-early"];
	await adapter.connect();
	adapter.prompt({ id: "m1", from: "boss", text: "x" });
	const start = await server.waitFor((m) => m.method === "turn/start");
	assert.equal((start.params as { threadId: string }).threadId, "thread-early");
});

test("connect fails when the pane closes before the TUI starts a thread", async (t) => {
	const { adapter } = await harness(t, { connected: false });
	const dead = { alive: async () => false } as unknown as PaneBackend;
	await assert.rejects(adapter.connect({ backend: dead, ref: "surface:1" }), /pane closed/);
});

test("prompt starts a turn and resolves on turn/completed with the last agent message", async (t) => {
	const { adapter, server, updates } = await harness(t);
	const p = adapter.prompt({ id: "m1", from: "boss", text: "Reply with READY" });
	const start = await server.waitFor((m) => m.method === "turn/start");
	assert.deepEqual(start.params, { threadId: THREAD, input: [{ type: "text", text: "Reply with READY" }] });
	assert.equal(adapter.idle(), false);
	const turn = "turn-1";
	server.notify("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } });
	server.notify("turn/started", { threadId: THREAD, turn: { id: turn, items: [], status: "inProgress" } });
	server.notify("item/started", {
		threadId: THREAD,
		turnId: turn,
		item: { type: "commandExecution", id: "i1", command: "/bin/zsh -lc 'sleep 1'" },
	});
	server.notify("item/completed", {
		threadId: THREAD,
		turnId: turn,
		item: { type: "agentMessage", id: "i2", text: "Running it." },
	});
	server.notify("item/completed", {
		threadId: THREAD,
		turnId: turn,
		item: { type: "agentMessage", id: "i3", text: "READY" },
	});
	server.notify("thread/status/changed", { threadId: THREAD, status: { type: "idle" } });
	server.notify("turn/completed", { threadId: THREAD, turn: { id: turn, items: [], status: "completed" } });
	assert.deepEqual(await p, { stopReason: "end_turn", text: "READY" });
	assert.equal(adapter.idle(), true);
	assert.deepEqual(updates, [
		{ kind: "state", state: "busy" },
		{ kind: "tool_call", title: "/bin/zsh -lc 'sleep 1'", status: "in_progress" },
		{ kind: "agent_message", text: "Running it." },
		{ kind: "agent_message", text: "READY" },
		{ kind: "state", state: "idle" },
	]);
});

test("events of other threads are ignored", async (t) => {
	const { adapter, server, updates } = await harness(t);
	server.notify("turn/started", { threadId: "sub-agent", turn: { id: "x", items: [], status: "inProgress" } });
	await tick();
	assert.equal(updates.length, 0);
	assert.equal(adapter.idle(), true);
});

test("cancel interrupts the running turn and the prompt resolves cancelled", async (t) => {
	const { adapter, server } = await harness(t);
	const p = adapter.prompt({ id: "m1", from: "boss", text: "sleep 10" });
	await server.waitFor((m) => m.method === "turn/start");
	server.notify("turn/started", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "inProgress" } });
	await tick();
	await adapter.cancel();
	const interrupt = await server.waitFor((m) => m.method === "turn/interrupt");
	assert.deepEqual(interrupt.params, { threadId: THREAD, turnId: "turn-1" });
	server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "interrupted" } });
	assert.deepEqual(await p, { stopReason: "cancelled", text: "" });
});

test("a failed turn resolves error with the turn's error message", async (t) => {
	const { adapter, server } = await harness(t);
	const p = adapter.prompt({ id: "m1", from: "boss", text: "x" });
	await server.waitFor((m) => m.method === "turn/start");
	server.notify("turn/completed", {
		threadId: THREAD,
		turn: { id: "turn-1", items: [], status: "failed", error: { message: "usage limit reached" } },
	});
	assert.deepEqual(await p, { stopReason: "error", text: "usage limit reached" });
});

test("a turn typed in the TUI becomes a turn_end update", async (t) => {
	const { adapter, server, updates } = await harness(t);
	server.notify("turn/started", { threadId: THREAD, turn: { id: "typed", items: [], status: "inProgress" } });
	await tick();
	assert.equal(adapter.idle(), false);
	server.notify("turn/completed", {
		threadId: THREAD,
		turn: { id: "typed", items: [{ type: "agentMessage", id: "a", text: "typed answer" }], status: "completed" },
	});
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "turn_end", stopReason: "end_turn", text: "typed answer" });
	assert.equal(adapter.idle(), true);
});

test("a prompt folded into a running turn (same turn id) resolves when that turn completes", async (t) => {
	const { adapter, server, updates } = await harness(t);
	server.turnId = "running";
	server.notify("turn/started", { threadId: THREAD, turn: { id: "running", items: [], status: "inProgress" } });
	const p = adapter.prompt({ id: "m1", from: "boss", text: "also this" });
	await server.waitFor((m) => m.method === "turn/start");
	await tick();
	server.notify("turn/completed", { threadId: THREAD, turn: { id: "running", items: [], status: "completed" } });
	assert.equal((await p).stopReason, "end_turn");
	assert.equal(
		updates.some((u) => u.kind === "turn_end"),
		false,
	);
});

test("approvals: the guard accepts the normal and declines a worker's risky command with the reason", async (t) => {
	const { server, d, updates } = await harness(t, { depth: 1 });
	const ok = server.request("item/commandExecution/requestApproval", {
		threadId: THREAD,
		turnId: "turn-1",
		itemId: "i1",
		startedAtMs: 1,
		command: "ls -la",
	});
	server.notify("thread/status/changed", {
		threadId: THREAD,
		status: { type: "active", activeFlags: ["waitingOnApproval"] },
	});
	const okReply = await server.waitFor((m) => m.id === ok && "result" in m);
	assert.deepEqual(okReply.result, { decision: "accept" });

	const bad = server.request("item/commandExecution/requestApproval", {
		threadId: THREAD,
		turnId: "turn-1",
		itemId: "i2",
		startedAtMs: 1,
		command: "git push origin main",
	});
	const badReply = await server.waitFor((m) => m.id === bad && "result" in m);
	assert.deepEqual(badReply.result, { decision: "decline" });
	const steer = await server.waitFor((m) => m.method === "turn/steer");
	const sp = steer.params as { threadId: string; expectedTurnId: string; input: { text: string }[] };
	assert.equal(sp.expectedTurnId, "turn-1");
	assert.match(sp.input[0]?.text ?? "", /"git push" is blocked for workers.*git push origin main/);
	assert.ok(d.logs.some((l) => l.kind === "codex_approval" && l.data?.verdict === "block"));
	assert.equal(
		updates.some((u) => u.kind === "state" && u.state === "asking"),
		false,
		"requests the guard answers never show as asking",
	);
});

test("approvals: for the root, ask leaves the request to the TUI and reports asking until it resolves", async (t) => {
	const { adapter, server, updates } = await harness(t, { depth: 0 });
	const p = adapter.prompt({ id: "m1", from: "boss", text: "push it" });
	await server.waitFor((m) => m.method === "turn/start");
	server.notify("turn/started", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "inProgress" } });
	const id = server.request("item/commandExecution/requestApproval", {
		threadId: THREAD,
		turnId: "turn-1",
		itemId: "i1",
		startedAtMs: 1,
		command: "git push",
	});
	server.notify("thread/status/changed", {
		threadId: THREAD,
		status: { type: "active", activeFlags: ["waitingOnApproval"] },
	});
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "state", state: "asking", detail: "git push" });
	assert.equal(
		server.received.some((m) => m.id === id),
		false,
		"the adapter does not answer",
	);
	server.notify("serverRequest/resolved", { threadId: THREAD, requestId: id });
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "state", state: "busy" });
	server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", items: [], status: "completed" } });
	await p;
});

test("approvals: a file change is accepted; other requests leave the agent asking", async (t) => {
	const { server, updates } = await harness(t);
	server.notify("item/started", {
		threadId: THREAD,
		turnId: "turn-1",
		item: { type: "fileChange", id: "f1", changes: [{ path: "/work/a.ts" }], status: "inProgress" },
	});
	const id = server.request("item/fileChange/requestApproval", {
		threadId: THREAD,
		turnId: "turn-1",
		itemId: "f1",
		startedAtMs: 1,
	});
	const reply = await server.waitFor((m) => m.id === id && "result" in m);
	assert.deepEqual(reply.result, { decision: "accept" });
	assert.deepEqual(updates.at(0), { kind: "tool_call", title: "edit /work/a.ts", status: "in_progress" });
	server.request("item/tool/requestUserInput", { threadId: THREAD, turnId: "turn-1", itemId: "q1", questions: [] });
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "state", state: "asking", detail: "item/tool/requestUserInput" });
});

test("the app-server exiting reports exited and fails the pending prompt", async (t) => {
	const { adapter, server, proc, updates } = await harness(t);
	const p = adapter.prompt({ id: "m1", from: "boss", text: "x" });
	await server.waitFor((m) => m.method === "turn/start");
	proc.exit(1);
	const r = await p;
	assert.equal(r.stopReason, "error");
	await tick();
	assert.equal(updates.at(-1)?.kind, "exited");
	assert.equal(adapter.idle(), false);
});

test("close kills the app-server, cancels a pending prompt and is idempotent", async (t) => {
	const { adapter, server, proc, updates } = await harness(t);
	const p = adapter.prompt({ id: "m1", from: "boss", text: "x" });
	await server.waitFor((m) => m.method === "turn/start");
	await adapter.close();
	await adapter.close();
	assert.deepEqual(await p, { stopReason: "cancelled", text: "" });
	assert.deepEqual(proc.signals, ["SIGTERM"]);
	await tick();
	assert.equal(
		updates.some((u) => u.kind === "exited"),
		false,
	);
});
