import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createPiAdapter, PI_EXTENSION_PATH } from "../src/adapters/pi.ts";
import { readLines } from "../src/pi-extension/protocol.ts";
import type { AdapterDeps, LaunchSpec, PaneBackend, Profile, SessionUpdate } from "../src/types.ts";
import { tick } from "./fixtures/pi/fake-pi.ts";

const profile: Profile = JSON.parse(readFileSync(new URL("../profiles/pi.json", import.meta.url), "utf8"));

function spec(model: string | null = null): LaunchSpec {
	return {
		name: "pi-1",
		parent: "boss",
		model,
		cwd: "/work",
		runDir: mkdtempSync(join(tmpdir(), "xl-pia-")),
		env: { AGENT_LINK_AGENT: "pi-1", AGENT_LINK_DEPTH: "1" },
		mcp: { command: "/bin/xl", args: ["mcp"] },
		profile,
	};
}

function deps(): AdapterDeps & { logs: string[] } {
	const logs: string[] = [];
	return { logs, log: (kind) => logs.push(kind), guard: () => ({ action: "allow" }), depth: 1 };
}

/** A fake of the extension's side of the socket: records lines, lets the test answer. */
/** Closes the fake when the test ends, passed or failed, so an assertion never leaves the process hanging. */
function fakeExtension(t: TestContext, path: string, initial: "idle" | "busy" = "idle"): FakeExtension {
	const ext = new FakeExtension(path, initial);
	t.after(() => ext.close());
	return ext;
}

class FakeExtension {
	server: Server;
	socket: Socket | undefined;
	received: Record<string, unknown>[] = [];
	constructor(path: string, initial: "idle" | "busy" = "idle") {
		this.server = createServer((s) => {
			this.socket = s;
			readLines(s, (v) => this.received.push(v));
			this.send({ type: "state", state: initial });
		});
		this.server.listen(path);
	}
	send(v: Record<string, unknown>) {
		this.socket?.write(`${JSON.stringify(v)}\n`);
	}
	close() {
		this.socket?.destroy();
		this.server.close();
	}
}

test("launch runs pi with the extension, the model, the identity env, the socket and the MCP server", async () => {
	const s = spec();
	const cmd = await createPiAdapter(deps()).launch(s);
	assert.deepEqual(cmd.argv, ["pi", "-e", PI_EXTENSION_PATH, "--model", "claude-bridge/claude-haiku-5-5"]);
	assert.ok(PI_EXTENSION_PATH.endsWith("/src/pi-extension/index.ts"));
	assert.equal(cmd.cwd, "/work");
	assert.equal(cmd.env.AGENT_LINK_AGENT, "pi-1");
	assert.equal(cmd.env.AGENT_LINK_PI_SOCKET, join(s.runDir, "pi.sock"));
	assert.deepEqual(JSON.parse(cmd.env.AGENT_LINK_PI_MCP ?? ""), { command: "/bin/xl", args: ["mcp"] });
	const given = await createPiAdapter(deps()).launch(spec("anthropic/claude-sonnet-5-5"));
	assert.deepEqual(given.argv.slice(-2), ["--model", "anthropic/claude-sonnet-5-5"]);
});

test("connect waits for the socket to appear and resolves once the extension reports its state", async (t) => {
	const s = spec();
	const adapter = createPiAdapter(deps());
	await adapter.launch(s);
	let ext: FakeExtension | undefined;
	setTimeout(() => {
		ext = fakeExtension(t, join(s.runDir, "pi.sock"));
	}, 300);
	const t0 = Date.now();
	await adapter.connect();
	assert.ok(Date.now() - t0 >= 250);
	assert.equal(adapter.idle(), true);
	await adapter.close();
	ext?.close();
});

test("connect fails fast when the pane is gone", async () => {
	const s = spec();
	const adapter = createPiAdapter(deps(), { connectTimeoutMs: 5000 });
	await adapter.launch(s);
	const dead = { alive: async () => false } as unknown as PaneBackend;
	await assert.rejects(adapter.connect({ backend: dead, ref: "surface:1" }), /pane closed/);
});

test("prompt resolves on the turn end with its id; updates stream; idle follows the extension", async (t) => {
	const s = spec();
	const d = deps();
	const adapter = createPiAdapter(d);
	await adapter.launch(s);
	const ext = fakeExtension(t, join(s.runDir, "pi.sock"));
	const updates: SessionUpdate[] = [];
	adapter.onUpdate((u) => updates.push(u));
	await adapter.connect();
	const p = adapter.prompt({ id: "m1", from: "boss", text: "reply with READY" });
	assert.equal(adapter.idle(), false, "not idle while a prompt is in flight");
	await tick();
	assert.deepEqual(ext.received, [{ type: "prompt", id: "m1", text: "reply with READY" }]);
	await assert.rejects(adapter.prompt({ id: "m2", from: "boss", text: "x" }), /already in flight/);
	ext.send({ type: "state", state: "busy" });
	ext.send({ type: "tool_call", title: "bash: ls" });
	ext.send({ type: "agent_message", text: "READY" });
	ext.send({ type: "state", state: "idle" });
	ext.send({ type: "turn_end", id: "m1", stopReason: "end_turn", text: "READY" });
	assert.deepEqual(await p, { stopReason: "end_turn", text: "READY" });
	assert.equal(adapter.idle(), true);
	assert.deepEqual(updates, [
		{ kind: "state", state: "idle" },
		{ kind: "state", state: "busy" },
		{ kind: "tool_call", title: "bash: ls" },
		{ kind: "agent_message", text: "READY" },
		{ kind: "state", state: "idle" },
	]);
	assert.ok(d.logs.includes("turn_end"));
	await adapter.close();
	ext.close();
});

test("a turn the user typed becomes a turn_end update; asking is not idle; cancel is forwarded", async (t) => {
	const s = spec();
	const adapter = createPiAdapter(deps());
	await adapter.launch(s);
	const ext = fakeExtension(t, join(s.runDir, "pi.sock"), "busy");
	const updates: SessionUpdate[] = [];
	adapter.onUpdate((u) => updates.push(u));
	await adapter.connect();
	assert.equal(adapter.idle(), false);
	ext.send({ type: "state", state: "asking", detail: "git push" });
	await tick();
	assert.equal(adapter.idle(), false);
	ext.send({ type: "state", state: "idle" });
	ext.send({ type: "turn_end", id: null, stopReason: "end_turn", text: "typed" });
	await tick();
	assert.deepEqual(updates.at(-1), { kind: "turn_end", stopReason: "end_turn", text: "typed" });
	assert.deepEqual(updates.at(-3), { kind: "state", state: "asking", detail: "git push" });
	await adapter.cancel();
	await tick();
	assert.deepEqual(ext.received.at(-1), { type: "cancel" });
	await adapter.close();
	ext.close();
});

test("pi exiting mid-turn resolves the prompt as error and reports exited", async (t) => {
	const s = spec();
	const adapter = createPiAdapter(deps());
	await adapter.launch(s);
	const ext = fakeExtension(t, join(s.runDir, "pi.sock"));
	const updates: SessionUpdate[] = [];
	adapter.onUpdate((u) => updates.push(u));
	await adapter.connect();
	const p = adapter.prompt({ id: "m1", from: "boss", text: "work" });
	await tick();
	ext.close();
	assert.equal((await p).stopReason, "error");
	assert.equal(updates.at(-1)?.kind, "exited");
	assert.equal(adapter.idle(), false);
});

test("close resolves a pending prompt as cancelled, reports no exit and is idempotent", async (t) => {
	const s = spec();
	const adapter = createPiAdapter(deps());
	await adapter.launch(s);
	const ext = fakeExtension(t, join(s.runDir, "pi.sock"));
	const updates: SessionUpdate[] = [];
	adapter.onUpdate((u) => updates.push(u));
	await adapter.connect();
	const p = adapter.prompt({ id: "m1", from: "boss", text: "work" });
	await adapter.close();
	await adapter.close();
	assert.deepEqual(await p, { stopReason: "cancelled", text: "" });
	await tick();
	assert.equal(
		updates.some((u) => u.kind === "exited"),
		false,
	);
	ext.close();
});
