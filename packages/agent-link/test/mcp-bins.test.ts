import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { pullRoot, testHub, waitFor } from "../../agent-link-core/test/fakes/hub.ts";
import { mcpCommand } from "../src/commands.ts";

/** Starts a backend's MCP entry as the harness would, sends initialize and tools/list, returns the answers. */
async function handshake(backend: "cmux" | "tmux", env: NodeJS.ProcessEnv): Promise<Array<Record<string, unknown>>> {
	const { command, args } = mcpCommand(backend);
	const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (c: string) => {
		buf += c;
	});
	const send = (id: number, method: string, params = {}) =>
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	send(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1" } });
	send(2, "tools/list");
	await waitFor(() => buf.split("\n").filter(Boolean).length >= 2, "two answers", 5000);
	child.stdin.end();
	await new Promise((r) => child.once("exit", r));
	return buf
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>)
		.sort((a, b) => Number(a.id) - Number(b.id));
}

test("agent-link-cmux and agent-link-tmux run as processes and serve the seven tools to a spawned agent", async () => {
	const t = await testHub();
	try {
		const root = await pullRoot(t.client);
		const res = await t.client.spawn({ from: root, harness: "pi", task: "t", name: "w", backend: "cmux" });
		assert.ok("name" in res);
		const env = { ...process.env, ...t.kit.byName("w")?.spec?.env };
		for (const backend of ["cmux", "tmux"] as const) {
			const [init, list] = await handshake(backend, env);
			assert.ok(init && list);
			const instructions = String((init.result as { instructions?: string }).instructions);
			assert.match(instructions, /^agent-link: this session is "w"; it was opened by "codex"\./);
			const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((x) => x.name);
			assert.deepEqual(tools, ["spawn", "send", "permit", "reply", "status", "cancel", "inbox"]);
		}
	} finally {
		await t.stop();
	}
});
