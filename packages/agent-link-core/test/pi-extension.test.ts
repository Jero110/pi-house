import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createAgentLinkExtension, MESSAGE_TYPE } from "../src/pi-extension/index.ts";
import { FakePi, LineClient, tempSocketPath, tick } from "./fixtures/pi/fake-pi.ts";

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

async function started(t: TestContext, env: Record<string, string> = {}) {
	const path = tempSocketPath();
	const pi = new FakePi();
	createAgentLinkExtension({ AGENT_LINK_PI_SOCKET: path, ...env })(pi.api);
	await pi.emit("session_start", { reason: "startup" });
	await tick();
	const client = await LineClient.open(path);
	t.after(async () => {
		client.close();
		await pi.emit("session_shutdown");
	});
	await client.waitFor((l) => l.type === "state");
	return { path, pi, client };
}

test("without AGENT_LINK_PI_SOCKET the extension registers nothing", () => {
	const pi = new FakePi();
	createAgentLinkExtension({})(pi.api);
	assert.equal(pi.handlers.size, 0);
	assert.equal(pi.mcp.length, 0);
});

test("registers the agent-link MCP server from AGENT_LINK_PI_MCP, with direct exposure", () => {
	const pi = new FakePi();
	const mcp = JSON.stringify({ command: "/usr/bin/xl", args: ["mcp", "--x"] });
	createAgentLinkExtension({ AGENT_LINK_PI_SOCKET: tempSocketPath(), AGENT_LINK_PI_MCP: mcp })(pi.api);
	assert.deepEqual(pi.mcp, [
		{ name: "agent-link", config: { command: "/usr/bin/xl", args: ["mcp", "--x"], exposure: "direct" } },
	]);
});

test("the socket is 0600, says idle on connect, and is removed on session_shutdown", async (t) => {
	const { path, pi, client } = await started(t);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(client.lines[0], { type: "state", state: "idle" });
	await pi.emit("session_shutdown");
	assert.equal(existsSync(path), false);
	client.close();
});

test("/reload keeps the socket and its client: the next instance takes them over, and only a quit closes", async (t) => {
	const { path, pi, client } = await started(t);
	await pi.emit("session_shutdown", { reason: "reload" });
	assert.ok(existsSync(path), "the socket stays across a reload");
	const next = new FakePi();
	createAgentLinkExtension({ AGENT_LINK_PI_SOCKET: path })(next.api);
	const before = client.lines.length;
	await next.emit("session_start", { reason: "reload" });
	await client.waitFor(() => client.lines.slice(before).some((l) => l.type === "state"));
	client.send({ type: "prompt", id: "r1", text: "after reload" });
	await tick();
	assert.equal(pi.sent.length, 0, "the old instance gets nothing");
	assert.equal(next.sent.length, 1);
	await next.emit("session_shutdown", { reason: "quit" });
	assert.equal(existsSync(path), false);
	client.close();
});

test("a socket folder that is gone (agent closed by the hub) does not crash pi", async () => {
	const path = join(tempSocketPath(), "..", "gone", "pi.sock");
	const pi = new FakePi();
	createAgentLinkExtension({ AGENT_LINK_PI_SOCKET: path })(pi.api);
	await pi.emit("session_start", { reason: "reload" });
	await tick();
	await tick();
	await pi.emit("session_shutdown", { reason: "quit" });
});

test("a prompt while idle steers with triggerTurn, and the turn end carries its id and last text", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "prompt", id: "m1", text: "[agent-link] from boss: reply with READY" });
	await tick();
	assert.deepEqual(pi.sent, [
		{
			message: { customType: MESSAGE_TYPE, content: "[agent-link] from boss: reply with READY", display: true },
			options: { triggerTurn: true, deliverAs: "steer" },
		},
	]);
	await pi.emit("agent_start");
	await client.waitFor((l) => l.type === "state" && l.state === "busy");
	await pi.emit("message_end", { message: assistant("READY") });
	await client.waitFor((l) => l.type === "agent_message" && l.text === "READY");
	await pi.emit("agent_end", { messages: [assistant("READY")] });
	await pi.emit("agent_settled", { aborted: false });
	const end = await client.waitFor((l) => l.type === "turn_end");
	assert.deepEqual(end, { type: "turn_end", id: "m1", stopReason: "end_turn", text: "READY" });
	// idle is reported before the turn end, so the adapter is idle when prompt() resolves.
	const order = client.lines.map((l) => (l.type === "state" ? l.state : l.type));
	assert.deepEqual(order.slice(-2), ["idle", "turn_end"]);
	client.close();
	await pi.emit("session_shutdown");
});

test("a turn typed in the pane ends with id null", async (t) => {
	const { pi, client } = await started(t);
	await pi.emit("agent_start");
	await pi.emit("message_end", { message: assistant("typed answer") });
	await pi.emit("agent_settled", { aborted: false });
	const end = await client.waitFor((l) => l.type === "turn_end");
	assert.deepEqual(end, { type: "turn_end", id: null, stopReason: "end_turn", text: "typed answer" });
	client.close();
	await pi.emit("session_shutdown");
});

test("a prompt that races a running turn is a followUp, and that turn's end answers it", async (t) => {
	const { pi, client } = await started(t);
	await pi.emit("agent_start");
	client.send({ type: "prompt", id: "m2", text: "second" });
	await tick();
	assert.deepEqual(pi.sent[0]?.options, { deliverAs: "followUp" });
	await pi.emit("message_end", { message: assistant("both done") });
	await pi.emit("agent_settled", { aborted: false });
	const end = await client.waitFor((l) => l.type === "turn_end");
	assert.equal(end.id, "m2");
	client.close();
	await pi.emit("session_shutdown");
});

test("cancel aborts the running turn and the turn ends cancelled; a length stop is max_tokens", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "cancel" });
	await tick();
	assert.equal(pi.aborts, 0, "nothing to abort while idle");
	client.send({ type: "prompt", id: "m3", text: "sleep" });
	await pi.emit("agent_start");
	client.send({ type: "cancel" });
	await tick();
	assert.equal(pi.aborts, 1);
	await pi.emit("agent_settled", { aborted: true });
	const end = await client.waitFor((l) => l.type === "turn_end");
	assert.equal(end.stopReason, "cancelled");

	client.lines = [];
	await pi.emit("agent_start");
	await pi.emit("message_end", { message: assistant("cut", "length") });
	await pi.emit("agent_settled", { aborted: false });
	assert.equal((await client.waitFor((l) => l.type === "turn_end")).stopReason, "max_tokens");
	client.close();
	await pi.emit("session_shutdown");
});

test("guard: a worker's risky bash call is blocked without asking", async (t) => {
	const { pi, client } = await started(t, { AGENT_LINK_DEPTH: "1" });
	const r = await pi.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf /tmp/x" } });
	assert.deepEqual(r, { block: true, reason: 'agent-link guard: "rm -rf" is blocked for workers' });
	assert.equal(pi.confirms.length, 0);
	assert.equal(
		client.lines.some((l) => l.type === "tool_call"),
		false,
	);
	client.close();
	await pi.emit("session_shutdown");
});

test("guard: the root is asked in the pane, reported as asking, and a no blocks the call", async (t) => {
	const { pi, client } = await started(t, { AGENT_LINK_DEPTH: "0" });
	await pi.emit("agent_start");
	pi.confirmAnswer = false;
	const r = await pi.emit("tool_call", {
		toolName: "bash",
		toolCallId: "t2",
		input: { command: "git push origin main" },
	});
	assert.deepEqual(r, { block: true, reason: 'agent-link guard: the user declined "git push"' });
	assert.match(pi.confirms[0] ?? "", /git push origin main/);
	const asking = await client.waitFor((l) => l.type === "state" && l.state === "asking");
	assert.equal(asking.detail, "git push origin main");
	const states = client.lines.filter((l) => l.type === "state").map((l) => l.state);
	assert.deepEqual(states.slice(-2), ["asking", "busy"]);

	pi.confirmAnswer = true;
	const ok = await pi.emit("tool_call", { toolName: "bash", toolCallId: "t3", input: { command: "git push" } });
	assert.equal(ok, undefined);
	await client.waitFor((l) => l.type === "tool_call" && l.title === "bash: git push");
	client.close();
	await pi.emit("session_shutdown");
});

test("guard: without a UI the root's risky call is blocked; normal calls pass and are reported", async (t) => {
	const { pi, client } = await started(t);
	pi.hasUI = false;
	const r = await pi.emit("tool_call", { toolName: "bash", toolCallId: "t4", input: { command: "sudo ls" } });
	assert.equal((r as { block: boolean }).block, true);
	assert.equal(
		await pi.emit("tool_call", { toolName: "read", toolCallId: "t5", input: { path: "/a/b.ts" } }),
		undefined,
	);
	await client.waitFor((l) => l.type === "tool_call" && l.title === "read: /a/b.ts");
	client.close();
	await pi.emit("session_shutdown");
});

test("a pi dialog (ui_prompt) is reported as asking until it ends", async (t) => {
	const { pi, client } = await started(t);
	await pi.emit("agent_start");
	await pi.emit("ui_prompt_start", { kind: "select", title: "Pick one" });
	await client.waitFor((l) => l.state === "asking" && l.detail === "Pick one");
	await pi.emit("ui_prompt_end", { kind: "select" });
	await tick();
	assert.equal(client.lines.at(-1)?.state, "busy");
	client.close();
	await pi.emit("session_shutdown");
});

test("set_model while idle: the model is resolved, its auth checked, pi switched, and the effective model answered", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "set_model", id: "c1", model: "anthropic/claude-sonnet-5-5" });
	const res = await client.waitFor((l) => l.type === "model_result" && l.id === "c1");
	assert.deepEqual(res, { type: "model_result", id: "c1", status: "applied", model: "anthropic/claude-sonnet-5-5" });
	assert.deepEqual(pi.setModels, ["anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(pi.sent, [], "a model switch never starts a turn");
	client.close();
	await pi.emit("session_shutdown");
});

test("set_model with an unknown model, a model without credentials or a refusing pi errors and switches nothing", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "set_model", id: "u1", model: "anthropic/claude-nope" });
	client.send({ type: "set_model", id: "u2", model: "openai/gpt-5.5" });
	pi.setModelAnswer = false;
	client.send({ type: "set_model", id: "u3", model: "anthropic/claude-haiku-5-5" });
	const errors = await Promise.all(
		["u1", "u2", "u3"].map((id) => client.waitFor((l) => l.type === "model_result" && l.id === id)),
	);
	assert.match(String(errors[0]?.error), /unknown model anthropic\/claude-nope/);
	assert.match(String(errors[1]?.error), /no credentials for provider openai/);
	assert.match(String(errors[2]?.error), /pi refused anthropic\/claude-haiku-5-5/);
	assert.equal(
		errors.some((e) => "status" in e),
		false,
	);
	assert.deepEqual(pi.setModels, []);
	client.close();
	await pi.emit("session_shutdown");
});

test("set_model while a turn runs answers pending, and the switch happens before the turn's idle and end", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "prompt", id: "m1", text: "work" });
	await pi.emit("agent_start");
	client.send({ type: "set_model", id: "b1", model: "anthropic/claude-sonnet-5-5" });
	const res = await client.waitFor((l) => l.type === "model_result" && l.id === "b1");
	assert.deepEqual(res, { type: "model_result", id: "b1", status: "pending", model: "anthropic/claude-sonnet-5-5" });
	await tick();
	assert.deepEqual(pi.setModels, [], "not while the turn runs");

	// An unknown model is refused at once even while busy: pending is only for a switch that can happen.
	client.send({ type: "set_model", id: "b2", model: "anthropic/claude-nope" });
	assert.match(String((await client.waitFor((l) => l.id === "b2")).error), /unknown model/);

	await pi.emit("message_end", { message: assistant("done") });
	await pi.emit("agent_settled", { aborted: false });
	assert.deepEqual(pi.setModels, ["anthropic/claude-sonnet-5-5"]);
	await client.waitFor((l) => l.type === "turn_end");
	const order = client.lines.map((l) => (l.type === "state" ? l.state : l.type));
	assert.deepEqual(
		order.slice(-3),
		["model", "idle", "turn_end"],
		"the model is in place before the hub may prompt again",
	);
	assert.deepEqual(client.lines.at(-3), { type: "model", model: "anthropic/claude-sonnet-5-5" });
	client.close();
	await pi.emit("session_shutdown");
});

test("a pending switch whose auth is gone at the boundary reports model_error and keeps the model", async (t) => {
	const { pi, client } = await started(t);
	await pi.emit("agent_start");
	client.send({ type: "set_model", id: "e1", model: "anthropic/claude-sonnet-5-5" });
	await client.waitFor((l) => l.type === "model_result" && l.status === "pending");
	pi.authed.clear();
	await pi.emit("agent_settled", { aborted: false });
	const err = await client.waitFor((l) => l.type === "model_error");
	assert.equal(err.model, "anthropic/claude-sonnet-5-5");
	assert.match(String(err.error), /no credentials for provider anthropic/);
	assert.deepEqual(pi.setModels, []);
	assert.equal((await client.waitFor((l) => l.type === "turn_end")).type, "turn_end", "the turn still ends");
	client.close();
	await pi.emit("session_shutdown");
});

test("set_model after a prompt arrived but before its turn started is pending, never overlapping the turn", async (t) => {
	const { pi, client } = await started(t);
	client.send({ type: "prompt", id: "m9", text: "go" });
	await tick();
	client.send({ type: "set_model", id: "r1", model: "anthropic/claude-sonnet-5-5" });
	assert.equal((await client.waitFor((l) => l.id === "r1")).status, "pending");
	await pi.emit("agent_start");
	await pi.emit("agent_settled", { aborted: false });
	await client.waitFor((l) => l.type === "model");
	assert.deepEqual(pi.setModels, ["anthropic/claude-sonnet-5-5"]);
	client.close();
	await pi.emit("session_shutdown");
});

test("a prompt that arrives while a switch runs waits for it", async (t) => {
	const { pi, client } = await started(t);
	let release = () => {};
	pi.setModelGate = new Promise<void>((r) => {
		release = r;
	});
	client.send({ type: "set_model", id: "g1", model: "anthropic/claude-sonnet-5-5" });
	await tick();
	client.send({ type: "prompt", id: "g2", text: "next" });
	await tick();
	assert.deepEqual(pi.sent, [], "the turn waits for the switch");
	release();
	await client.waitFor((l) => l.type === "model_result" && l.id === "g1");
	await tick();
	assert.equal(pi.sent.length, 1);
	client.close();
	await pi.emit("session_shutdown");
});
