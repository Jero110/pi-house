import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpencodeAdapter, OPENCODE_GUARD_PLUGIN, opencodeConfig } from "../src/adapters/opencode.ts";
import * as plugin from "../src/adapters/opencode-guard.ts";
import type { AgentAdapter, LaunchSpec, PaneBackend, SessionUpdate } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
	for (const end = Date.now() + ms; !cond(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

const SID = "ses_fake1";

const spec = (): LaunchSpec => ({
	name: "oc1",
	parent: "root",
	model: null,
	cwd: "/tmp",
	runDir: "/tmp/xl-run-oc1",
	env: { AGENT_LINK_AGENT: "oc1", AGENT_LINK_DEPTH: "1" },
	mcp: { command: "/bin/xl", args: ["mcp"] },
	profile: {
		harness: "opencode",
		adapter: "opencode",
		label: "opencode",
		defaultModel: "opencode/glm-5.3-flash-free",
		dialogs: [],
	},
});

/** A fake opencode server: the routes the adapter uses, with the requests recorded and /event pushed by hand. */
async function fakeOpencode() {
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	const streams: ServerResponse[] = [];
	let messages: unknown[] = [];
	const onPrompt: Array<(text: string) => void> = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (d) => {
			raw += String(d);
		});
		req.on("end", () => {
			const path = req.url ?? "";
			const body = raw ? JSON.parse(raw) : undefined;
			requests.push({ method: req.method ?? "", path, body });
			const json = (v: unknown) => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(v));
			};
			if (path === "/event") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
				streams.push(res);
				return;
			}
			if (path === "/session" && req.method === "GET") return json([]);
			if (path === "/session" && req.method === "POST") return json({ id: SID, title: body.title });
			if (path === "/tui/select-session") return json(true);
			if (path === `/session/${SID}/message`) return json(messages);
			if (path === `/session/${SID}/prompt_async`) {
				res.statusCode = 204;
				res.end();
				for (const cb of onPrompt) cb(body.parts[0].text);
				return;
			}
			if (path === `/session/${SID}/abort`) return json(true);
			// Like opencode: the reply is taken, then *.replied goes out on /event.
			const permit = path.match(/^\/permission\/([^/]+)\/reply$/);
			if (permit && req.method === "POST") {
				json(true);
				send("permission.replied", { sessionID: SID, requestID: permit[1], reply: body.reply });
				return;
			}
			const question = path.match(/^\/question\/([^/]+)\/reply$/);
			if (question && req.method === "POST") {
				json(true);
				send("question.replied", { sessionID: SID, requestID: question[1], answers: body.answers });
				return;
			}
			res.statusCode = 404;
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const send = (type: string, properties: Record<string, unknown>) => {
		for (const s of streams) s.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
	};
	const status = (type: string) => send("session.status", { sessionID: SID, status: { type } });
	const idle = () => send("session.idle", { sessionID: SID });
	const reply = (text: string) => {
		messages = [...messages, { info: { role: "assistant" }, parts: [{ type: "step-start" }, { type: "text", text }] }];
	};
	const kill = async () => {
		for (const s of streams) s.destroy();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	};
	return { port, requests, onPrompt, send, status, idle, reply, kill, streams };
}

const opened: Array<{ adapter: AgentAdapter; oc: Awaited<ReturnType<typeof fakeOpencode>> }> = [];
afterEach(async () => {
	for (const { adapter, oc } of opened.splice(0)) {
		await adapter.close();
		await oc.kill().catch(() => {});
	}
});

async function started(opts: { pane?: { backend: PaneBackend; ref: string }; mcpInstalled?: boolean } = {}) {
	const oc = await fakeOpencode();
	const updates: SessionUpdate[] = [];
	const logs: string[] = [];
	const adapter = createOpencodeAdapter(
		{ log: (k) => logs.push(k), guard: () => ({ action: "allow" }), depth: 1 },
		{
			port: oc.port,
			mcpInstalled: async () => opts.mcpInstalled ?? false,
			selectDelays: [0, 20, 40],
			selectTimeoutMs: 1000,
			cancelGraceMs: 200,
		},
	);
	adapter.onUpdate((u) => updates.push(u));
	opened.push({ adapter, oc });
	const cmd = await adapter.launch(spec());
	await adapter.connect(opts.pane);
	await until(() => oc.streams.length === 1, "event stream");
	return { oc, adapter, updates, logs, cmd };
}

function fakePane(screens: string[]) {
	const reads: number[] = [];
	const backend: PaneBackend = {
		name: "cmux",
		open: async () => "surface:2",
		close: async () => {},
		read: async () => {
			reads.push(Date.now());
			return screens[Math.min(reads.length - 1, screens.length - 1)] ?? "";
		},
		keys: async () => {},
		paste: async () => {},
		alive: async () => true,
	};
	return { backend, ref: "surface:2", reads };
}

test("opencode launch: TUI with the server on the port, the model, the MCP and the guard in its config", async () => {
	const { cmd } = await started();
	const port = Number(cmd.argv[2]);
	assert.deepEqual(cmd.argv, ["opencode", "--port", String(port), "-m", "opencode/glm-5.3-flash-free"]);
	const config = JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT ?? "");
	assert.deepEqual(config.mcp["agent-link"], {
		type: "local",
		command: ["/bin/xl", "mcp"],
		environment: { AGENT_LINK_AGENT: "oc1", AGENT_LINK_DEPTH: "1" },
		enabled: true,
	});
	assert.deepEqual(config.plugin, [OPENCODE_GUARD_PLUGIN]);
	assert.ok(existsSync(fileURLToPath(OPENCODE_GUARD_PLUGIN)), "the plugin file opencode loads exists");
	assert.equal(cmd.env.AGENT_LINK_AGENT, "oc1");
});

test("opencode config allows the shared read folders outside cwd, and nothing else, up front", () => {
	assert.equal(opencodeConfig(spec(), true).permission, undefined);
	const config = opencodeConfig({ ...spec(), readDirs: ["/skills", "/refs"] }, true);
	assert.deepEqual(config.permission, { external_directory: { "/skills/**": "allow", "/refs/**": "allow" } });
});

test("opencode config leaves out the MCP when agent-link is installed globally, keeps the guard", () => {
	const config = opencodeConfig(spec(), true);
	assert.equal(config.mcp, undefined);
	assert.deepEqual(config.plugin, [OPENCODE_GUARD_PLUGIN]);
});

test("opencode connect creates a titled session and selects it in the TUI until the pane shows it", async () => {
	const pane = fakePane(["opencode loading", "opencode loading", "  agent-link\n  oc1  ctrl+p commands"]);
	const { oc, logs } = await started({ pane });
	const create = oc.requests.find((r) => r.method === "POST" && r.path === "/session");
	assert.deepEqual(create?.body, { title: "agent-link oc1" });
	const selects = oc.requests.filter((r) => r.path === "/tui/select-session");
	assert.equal(selects.length, 3, "selected until the title showed (wrapped across lines)");
	assert.deepEqual(selects[0]?.body, { sessionID: SID });
	assert.ok(logs.includes("tui_selected"));
});

test("opencode prompt sends prompt_async and resolves on session.idle with the last assistant text", async () => {
	const { oc, adapter, updates } = await started();
	oc.onPrompt.push(() => {
		oc.status("busy");
		oc.send("message.part.updated", {
			sessionID: SID,
			part: { type: "tool", sessionID: SID, tool: "bash", state: { status: "completed", title: "sleep 1" } },
		});
		oc.send("message.part.updated", {
			sessionID: SID,
			part: { type: "text", sessionID: SID, text: "READY", time: { start: 1, end: 2 } },
		});
		oc.reply("READY");
		oc.status("idle");
		oc.idle();
	});
	const res = await adapter.prompt({ id: "m1", from: "agent-link", text: "reply with READY" });
	assert.deepEqual(res, { stopReason: "end_turn", text: "READY" });
	const sent = oc.requests.find((r) => r.path === `/session/${SID}/prompt_async`);
	assert.deepEqual(sent?.body, {
		model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
		parts: [{ type: "text", text: "reply with READY" }],
	});
	assert.ok(updates.some((u) => u.kind === "tool_call" && u.title === "sleep 1" && u.status === "completed"));
	assert.ok(updates.some((u) => u.kind === "agent_message" && u.text === "READY"));
	assert.ok(!updates.some((u) => u.kind === "turn_end"));
	assert.equal(adapter.idle(), true);
});

test("opencode prompt ignores a session.idle that comes before busy, and other sessions' events", async () => {
	const { oc, adapter } = await started();
	let resolved = false;
	oc.onPrompt.push(() => {
		oc.idle();
		oc.send("session.status", { sessionID: "ses_other", status: { type: "busy" } });
		oc.send("session.idle", { sessionID: "ses_other" });
	});
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "x" }).then((r) => {
		resolved = true;
		return r;
	});
	await sleep(80);
	assert.equal(resolved, false);
	oc.status("busy");
	oc.reply("done");
	oc.idle();
	assert.deepEqual(await p, { stopReason: "end_turn", text: "done" });
});

test("opencode permission requests make the agent asking, the reply makes it busy again", async () => {
	const { oc, adapter, updates } = await started();
	oc.onPrompt.push(() => {
		oc.status("busy");
		oc.send("permission.asked", { id: "per1", sessionID: SID, permission: "bash", patterns: ["git push"] });
	});
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "push" });
	await until(() => updates.some((u) => u.kind === "state" && u.state === "asking"), "asking");
	assert.deepEqual(
		updates.find((u) => u.kind === "state" && u.state === "asking"),
		{
			kind: "state",
			state: "asking",
			detail: "bash: git push",
			ask: {
				kind: "permission",
				questions: [{ question: "bash: git push", options: ["Allow once", "Allow always", "Reject"] }],
			},
		},
	);
	assert.equal(adapter.idle(), false);
	oc.send("permission.replied", { sessionID: SID, requestID: "per1", reply: "once" });
	await until(() => updates.at(-1)?.kind === "state" && (updates.at(-1) as { state: string }).state === "busy", "busy");
	oc.reply("pushed");
	oc.idle();
	assert.deepEqual(await p, { stopReason: "end_turn", text: "pushed" });
});

test("opencode turn typed in the pane ends with a turn_end update", async () => {
	const { oc, adapter, updates } = await started();
	oc.status("busy");
	await until(() => adapter.idle() === false, "busy");
	oc.reply("typed answer");
	oc.idle();
	await until(() => updates.some((u) => u.kind === "turn_end"), "turn_end");
	assert.deepEqual(
		updates.find((u) => u.kind === "turn_end"),
		{ kind: "turn_end", stopReason: "end_turn", text: "typed answer" },
	);
	assert.equal(adapter.idle(), true);
});

test("opencode cancel aborts the session and the prompt resolves cancelled", async () => {
	const { oc, adapter } = await started();
	oc.onPrompt.push(() => oc.status("busy"));
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "sleep 30" });
	await until(() => adapter.idle() === false && oc.requests.some((r) => r.path.endsWith("prompt_async")), "busy");
	await sleep(20);
	await adapter.cancel();
	assert.ok(oc.requests.some((r) => r.method === "POST" && r.path === `/session/${SID}/abort`));
	oc.send("session.error", { sessionID: SID, error: { name: "MessageAbortedError", data: {} } });
	oc.idle();
	assert.equal((await p).stopReason, "cancelled");
});

test("opencode cancel resolves the prompt even when no idle follows the abort", async () => {
	const { oc, adapter } = await started();
	oc.onPrompt.push(() => oc.status("busy"));
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "sleep 30" });
	await until(() => adapter.idle() === false, "busy");
	await adapter.cancel();
	assert.equal((await p).stopReason, "cancelled");
});

test("opencode session.error ends the turn as an error with its message", async () => {
	const { oc, adapter } = await started();
	oc.onPrompt.push(() => {
		oc.status("busy");
		oc.send("session.error", { sessionID: SID, error: { name: "APIError", data: { message: "rate limited" } } });
		oc.idle();
	});
	assert.deepEqual(await adapter.prompt({ id: "m1", from: "agent-link", text: "x" }), {
		stopReason: "error",
		text: "rate limited",
	});
});

test("opencode server gone: exited, and a pending prompt resolves as an error", async () => {
	const { oc, adapter, updates } = await started();
	oc.onPrompt.push(() => oc.status("busy"));
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "x" });
	await until(() => updates.some((u) => u.kind === "state" && u.state === "busy"), "busy");
	await oc.kill();
	assert.equal((await p).stopReason, "error");
	assert.ok(updates.some((u) => u.kind === "exited"));
	assert.equal(adapter.idle(), false);
});

test("opencode connect fails when opencode dies while the TUI is being selected", async () => {
	const oc = await fakeOpencode();
	const adapter = createOpencodeAdapter(
		{ log: () => {}, guard: () => ({ action: "allow" }), depth: 1 },
		{ port: oc.port, mcpInstalled: async () => false, selectDelays: [0, 30], selectTimeoutMs: 5000 },
	);
	opened.push({ adapter, oc });
	await adapter.launch(spec());
	const started = Date.now();
	const connecting = adapter.connect(fakePane(["opencode loading"]));
	await until(() => oc.streams.length === 1, "event stream");
	await oc.kill();
	await assert.rejects(connecting, /exited while connecting/);
	assert.ok(Date.now() - started < 2000, "fails at once, not after the select timeout");
});

// The guard plugin, kept with its tests.

const saved = process.env.AGENT_LINK_DEPTH;
afterEach(() => {
	if (saved === undefined) delete process.env.AGENT_LINK_DEPTH;
	else process.env.AGENT_LINK_DEPTH = saved;
});

async function bash(command: string, tool = "bash"): Promise<void> {
	const hooks = await plugin.AgentLinkGuard();
	await hooks["tool.execute.before"]({ tool }, { args: { command } });
}

test("the opencode plugin module exports only the plugin, since opencode runs every export", () => {
	assert.deepEqual(Object.keys(plugin), ["AgentLinkGuard"]);
});

test("opencode workers get risky bash commands blocked with the guard's reason", async () => {
	process.env.AGENT_LINK_DEPTH = "1";
	await assert.rejects(bash("git push origin main"), {
		message: 'agent-link guard: "git push" is blocked for workers',
	});
	await assert.rejects(bash("cd x && rm -rf build"), /rm -rf/);
	await bash("git status");
	await bash("npm test");
});

test("opencode guard leaves other tools and non-workers untouched", async () => {
	process.env.AGENT_LINK_DEPTH = "1";
	await bash("git push", "read");
	delete process.env.AGENT_LINK_DEPTH;
	await bash("git push origin main");
	process.env.AGENT_LINK_DEPTH = "0";
	await bash("git push origin main");
});

test("permit answers an opencode permission through its API, never the pane; a busy status does not end the wait", async () => {
	const { oc, adapter, updates } = await started();
	oc.onPrompt.push(() => {
		oc.status("busy");
		oc.send("permission.asked", {
			id: "per7",
			sessionID: SID,
			permission: "external_directory",
			patterns: ["/proj/docs/plans/*"],
		});
		oc.status("busy");
	});
	const p = adapter.prompt({ id: "m1", from: "agent-link", text: "read the brief" });
	await until(() => updates.some((u) => u.kind === "state" && u.state === "asking"), "asking");
	assert.equal(updates.at(-1)?.kind === "state" && (updates.at(-1) as { state: string }).state, "asking");
	assert.deepEqual(await adapter.answer?.("9"), { error: "there is no option 9" });
	assert.deepEqual(await adapter.answer?.("always"), { answered: "Allow always" });
	assert.deepEqual(
		oc.requests.find((r) => r.path === "/permission/per7/reply"),
		{ method: "POST", path: "/permission/per7/reply", body: { reply: "always" } },
	);
	await until(() => updates.at(-1)?.kind === "state" && (updates.at(-1) as { state: string }).state === "busy", "busy");
	assert.deepEqual(await adapter.answer?.("1"), { error: "opencode is not waiting on a permission or question" });
	oc.reply("read it");
	oc.idle();
	assert.deepEqual(await p, { stopReason: "end_turn", text: "read it" });
});

test("permit answers an opencode question with several options picked, sending their labels", async () => {
	const { oc, adapter, updates } = await started();
	oc.status("busy");
	oc.send("question.asked", {
		id: "que1",
		sessionID: SID,
		questions: [
			{
				question: "¿Qué ciudades?",
				header: "Ciudades",
				multiple: true,
				options: [
					{ label: "Tokio", description: "2 días" },
					{ label: "Kioto", description: "1 día" },
					{ label: "Osaka", description: "" },
				],
			},
		],
	});
	await until(() => updates.some((u) => u.kind === "state" && u.state === "asking"), "asking");
	const asking = updates.find((u) => u.kind === "state" && u.state === "asking") as { ask?: unknown };
	assert.deepEqual(asking.ask, {
		kind: "question",
		questions: [{ question: "¿Qué ciudades?", options: ["Tokio — 2 días", "Kioto — 1 día", "Osaka"], multiple: true }],
	});
	assert.deepEqual(await adapter.answer?.("1, kioto"), { answered: "Tokio — 2 días, Kioto — 1 día" });
	assert.deepEqual(oc.requests.find((r) => r.path === "/question/que1/reply")?.body, { answers: [["Tokio", "Kioto"]] });
	await until(() => updates.at(-1)?.kind === "state" && (updates.at(-1) as { state: string }).state === "busy", "busy");
});
