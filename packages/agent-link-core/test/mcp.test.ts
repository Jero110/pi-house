import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { clientHarness, placeFromEnv, runMcpServer } from "../src/mcp/server.ts";
import { PULL_REMINDER, toolDefs } from "../src/mcp/tools.ts";
import { pullRoot, testHub, waitFor } from "./fakes/hub.ts";

type Json = Record<string, unknown>;

/** An MCP server on in-memory pipes, and a way to call it. */
function mcp(opts: Omit<Parameters<typeof runMcpServer>[0], "input" | "output">) {
	const input = new PassThrough();
	const output = new PassThrough();
	const waiting = new Map<number, (r: Json) => void>();
	let buf = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buf += chunk;
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const msg = JSON.parse(buf.slice(0, i)) as Json;
			buf = buf.slice(i + 1);
			waiting.get(msg.id as number)?.(msg);
			i = buf.indexOf("\n");
		}
	});
	const done = runMcpServer({ ...opts, input, output });
	let id = 0;
	const rpc = (method: string, params: Json = {}) =>
		new Promise<Json>((resolve) => {
			const n = ++id;
			waiting.set(n, resolve);
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
		});
	const tool = async (name: string, args: Json = {}) => {
		const res = (await rpc("tools/call", { name, arguments: args })).result as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
	};
	return {
		rpc,
		tool,
		async end() {
			input.end();
			await done;
		},
	};
}

const init = (client: string) => ({ protocolVersion: "2025-06-18", clientInfo: { name: client, version: "1" } });

test("eight tools, each with anthropic/alwaysLoad, with the tested wording", () => {
	const tools = toolDefs({ harnesses: ["claude", "codex", "opencode", "pi"], pull: false });
	assert.deepEqual(
		tools.map((t) => t.name),
		["spawn", "send", "permit", "reply", "status", "cancel", "model", "inbox"],
	);
	const by = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
	assert.match(by("spawn"), /Returns at once with the worker's exact name/);
	assert.match(by("send"), /Returns at once/);
	assert.match(by("status"), /never call status to wait/);
	assert.match(by("model"), /Change the model of one of your own workers/);
	assert.match(by("model"), /context.*nears its limit/);
	assert.match(by("model"), /You decide which model; the tool never picks one/);
	assert.deepEqual(tools.find((t) => t.name === "model")?.inputSchema.required, ["to", "model"]);
	assert.deepEqual(tools[0]?.inputSchema.required, ["harness", "task"]);
	assert.deepEqual(tools[0]?.inputSchema.properties.harness?.enum, ["claude", "codex", "opencode", "pi"]);
	const pull = toolDefs({ harnesses: ["claude"], pull: true });
	assert.match(pull[0]?.description ?? "", /waits in the hub until you read it with inbox\(\)/);
});

test("client names map to roots; place comes from the cmux or tmux env", () => {
	assert.equal(clientHarness("claude-code"), "claude");
	assert.equal(clientHarness("codex-mcp-client"), "codex");
	assert.equal(clientHarness("opencode"), "opencode");
	assert.equal(clientHarness("pi"), "pi");
	assert.equal(clientHarness("pi-coding-agent"), "pi");
	assert.equal(clientHarness("Some Client"), "some-client");
	assert.deepEqual(placeFromEnv("cmux", { CMUX_WORKSPACE_ID: "w1", CMUX_SURFACE_ID: "s1" }), {
		workspace: "w1",
		surface: "s1",
	});
	assert.equal(placeFromEnv("cmux", { TMUX_PANE: "%3" }), undefined);
	assert.deepEqual(placeFromEnv("tmux", { TMUX_PANE: "%3" }), { tmuxPane: "%3" });
	assert.deepEqual(placeFromEnv("tmux", { TMUX_PANE: "%3", TMUX: "/private/tmp/tmux-501/work,8123,0" }), {
		tmuxPane: "%3",
		tmuxSocket: "/private/tmp/tmux-501/work",
	});
});

test("no identity: the server registers once as a pull root named after its client; answers remind of inbox()", async () => {
	const t = await testHub();
	const server = mcp({
		backend: "cmux",
		env: { CMUX_WORKSPACE_ID: "workspace:2", CMUX_SURFACE_ID: "surface:9" },
		home: t.home,
		cwd: t.home,
	});
	try {
		const init1 = (await server.rpc("initialize", init("claude-code"))).result as Json;
		assert.match(String(init1.instructions), /^You are "claude", a root agent of agent-link\./);
		assert.match(String(init1.instructions), /read them with inbox\(\)/);
		assert.match(String(init1.instructions), /never with SendMessage or ListAgents/);
		const list = (await server.rpc("tools/list")).result as { tools: Array<{ name: string; _meta: Json }> };
		assert.equal(list.tools.length, 8);
		assert.ok(list.tools.every((x) => x._meta["anthropic/alwaysLoad"] === true));

		const spawn = await server.tool("spawn", { harness: "pi", task: "count files", name: "counter" });
		assert.equal(spawn.isError, false);
		assert.match(spawn.text, /^spawned counter\. Its final answer waits in the hub for inbox\(\)\./);
		assert.ok(spawn.text.endsWith(PULL_REMINDER));
		assert.deepEqual(t.backend.opened()[0]?.place, { workspace: "workspace:2", surface: "surface:9" });
		await server.tool("status");
		assert.equal(
			[...t.running.hub.registry.agents.keys()].filter((n) => n.startsWith("claude")).length,
			1,
			"registered once",
		);

		const fake = await waitFor(() => t.kit.byName("counter"), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		fake.finish("42 files");
		await waitFor(() => t.running.hub.registry.get("counter")?.record.state === "done", "done");
		const status = await server.tool("status");
		assert.match(status.text, /^- counter · pi · claude-bridge\/claude-haiku-5-5 · done \(your worker\)/);
		assert.match(status.text, /Results wait for inbox\(\)/);
		const inbox = await server.tool("inbox");
		assert.equal(inbox.text, "[agent-link] counter (pi · claude-bridge/claude-haiku-5-5) finished:\n\n42 files");
		assert.match((await server.tool("inbox")).text, /^inbox empty/);
		const switched = await server.tool("model", { to: "counter", model: "anthropic/claude-sonnet-5-5" });
		assert.equal(switched.isError, false);
		assert.equal(switched.text, "counter now uses anthropic/claude-sonnet-5-5 (it was claude-bridge/claude-haiku-5-5)");
		assert.deepEqual(fake.modelRequests, ["anthropic/claude-sonnet-5-5"]);
		fake.setModelResult = { status: "pending", model: "anthropic/claude-opus-5-5" };
		const later = await server.tool("model", { to: "counter", model: "anthropic/claude-opus-5-5" });
		assert.equal(
			later.text,
			"counter is busy: it switches to anthropic/claude-opus-5-5 before its next turn. status shows the model once it did.",
		);
		const bad = await server.tool("model", { to: "counter", model: "opus" });
		assert.equal(bad.isError, true);
		assert.match(bad.text, /^model not changed: .*exact <provider>\/<id>/);
		const cancel = await server.tool("cancel", { name: "counter" });
		assert.equal(cancel.text, "cancelled counter and closed its pane");
		const reply = await server.tool("reply", { result: "x" });
		assert.equal(reply.isError, true);
	} finally {
		await server.end();
		await t.stop();
	}
});

test("with identity: instructions name the agent and its parent; send, reply and errors go through the hub", async () => {
	const t = await testHub();
	try {
		const root = await pullRoot(t.client);
		const res = await t.client.spawn({ from: root, harness: "codex", task: "t", name: "w", backend: "cmux" });
		assert.ok("name" in res);
		const fake = await waitFor(() => t.kit.byName("w"), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		const env = fake.spec?.env ?? {};
		const server = mcp({ backend: "cmux", env });
		try {
			const r = (await server.rpc("initialize", init("codex-mcp-client"))).result as Json;
			assert.match(String(r.instructions), /^agent-link: this session is "w"; it was opened by "codex"\./);
			assert.doesNotMatch(String(r.instructions), /SendMessage/);
			const list = (await server.rpc("tools/list")).result as { tools: Array<{ description: string }> };
			assert.match(list.tools[0]?.description ?? "", /arrives later as a new message after your turn ends/);

			assert.equal(
				(await server.tool("reply", { result: "final" })).text,
				"result set: your parent gets it when this turn ends. Finish the turn now.",
			);
			const ask = await server.tool("send", { to: "codex", message: "which branch?" });
			assert.equal(ask.text, "queued for codex: it gets the message on its next free turn");
			assert.ok(!ask.text.includes(PULL_REMINDER));
			const bad = await server.tool("send", { to: "nobody", message: "x" });
			assert.equal(bad.isError, true);
			assert.match(bad.text, /^not sent: unknown agent "nobody"\. You can message: codex \(your parent\)\./);
			const nope = await server.tool("spawn", { harness: "nope", task: "x" });
			assert.match(nope.text, /^not spawned: unknown harness "nope"/);
			assert.equal((await server.rpc("ping")).result !== undefined, true);
			const unknown = await server.rpc("nope/method");
			assert.deepEqual(unknown.error, { code: -32601, message: "unknown method nope/method" });
		} finally {
			await server.end();
		}
	} finally {
		await t.stop();
	}
});

test("a hub that is gone: tools answer with an error that says not to retry in a loop", async () => {
	const t = await testHub();
	const env = {
		AGENT_LINK_AGENT: "w",
		AGENT_LINK_HUB: `${t.home}/missing.sock`,
		AGENT_LINK_TOKEN: "t",
		AGENT_LINK_DEPTH: "1",
	};
	const server = mcp({ backend: "tmux", env });
	try {
		const r = (await server.rpc("initialize", init("opencode"))).result as Json;
		assert.match(String(r.instructions), /hub is not reachable/);
		const res = await server.tool("status");
		assert.equal(res.isError, true);
		assert.match(res.text, /^the agent-link hub is not reachable: .*Do not retry in a loop; tell the user\.$/);
	} finally {
		await server.end();
		await t.stop();
	}
});

test("spawn offers the user's own profiles from the agent-link home, like the hub does", async () => {
	const home = mkdtempSync(join(tmpdir(), "al-prof-"));
	mkdirSync(join(home, "profiles"));
	writeFileSync(
		join(home, "profiles", "pihouse.json"),
		JSON.stringify({
			harness: "pihouse",
			adapter: "pi",
			label: "pihouse",
			defaultModel: null,
			dialogs: [],
			command: ["pihouse"],
		}),
	);
	// A test hub on that home: initialize registers a pull root, and without a running hub it would start a real
	// hub daemon that outlives the test.
	const t = await testHub({ home });
	const server = mcp({ backend: "tmux", env: { AGENT_LINK_HOME: home }, home });
	try {
		await server.rpc("initialize", init("claude-code"));
		const { tools } = (await server.rpc("tools/list")).result as { tools: Array<{ name: string; inputSchema: Json }> };
		const spawn = tools.find((x) => x.name === "spawn");
		const props = spawn?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
		const harness = props?.harness;
		assert.deepEqual(harness?.enum, ["claude", "codex", "opencode", "pi", "pihouse"]);
	} finally {
		await server.end();
		await t.stop();
		rmSync(home, { recursive: true, force: true });
	}
});
