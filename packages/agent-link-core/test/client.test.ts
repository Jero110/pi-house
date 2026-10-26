import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHubClient, ensureHub, identityFromEnv, stopHub } from "../src/client.ts";
import { hubPaths } from "../src/paths.ts";
import { tempHome, waitFor } from "./fakes/hub.ts";

const FAKE_DAEMON = join(import.meta.dirname, "fakes/daemon.ts");

test("identityFromEnv reads the four AGENT_LINK_* variables; without them there is no identity", () => {
	assert.deepEqual(
		identityFromEnv({ AGENT_LINK_AGENT: "w", AGENT_LINK_HUB: "/h.sock", AGENT_LINK_TOKEN: "t", AGENT_LINK_DEPTH: "2" }),
		{ agent: "w", hub: "/h.sock", token: "t", depth: 2 },
	);
	assert.equal(identityFromEnv({ AGENT_LINK_AGENT: "w" }), undefined);
	assert.equal(
		identityFromEnv({ AGENT_LINK_AGENT: "w", AGENT_LINK_HUB: "/h", AGENT_LINK_TOKEN: "t", AGENT_LINK_DEPTH: "x" })
			?.depth,
		0,
	);
});

test("ensureHub starts the daemon detached when the socket does not answer, then reuses it; stopHub ends it", async () => {
	const home = tempHome();
	try {
		const addr = await ensureHub({ home, entry: FAKE_DAEMON });
		const paths = hubPaths(home);
		assert.equal(addr.socket, paths.socket);
		assert.equal(addr.token, readFileSync(paths.token, "utf8").trim());
		const pid = readFileSync(paths.pid, "utf8").trim();
		assert.notEqual(Number(pid), process.pid, "a process of its own");

		const again = await ensureHub({ home, entry: FAKE_DAEMON });
		assert.deepEqual(again, addr);
		assert.equal(readFileSync(paths.pid, "utf8").trim(), pid, "no second daemon");

		const client = createHubClient(addr);
		const root = await client.register({ harness: "codex", cwd: home, pull: true });
		assert.ok("name" in root);
		const w = await client.spawn({ from: root.name, harness: "pi", task: "say hi", backend: "tmux" });
		assert.deepEqual(w, { name: "pi" });
		let messages: string[] = [];
		const end = Date.now() + 3000;
		while (!messages.length && Date.now() < end) {
			messages = (await client.inbox(root.name)).messages.map((m) => m.text);
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.deepEqual(messages, [
			"[agent-link] pi (pi · claude-bridge/claude-haiku-5-5) finished:\n\npi handled: say hi",
		]);

		assert.equal(await stopHub(home), true);
		assert.equal(existsSync(paths.socket), false);
		assert.equal(existsSync(paths.pid), false);
		await assert.rejects(client.status("x"), /not reachable/);
	} finally {
		await stopHub(home);
		rmSync(home, { recursive: true, force: true });
	}
});

test("ensureHub fails within its timeout when the daemon does not come up, and points at its log", async () => {
	const home = tempHome();
	try {
		const entry = join(home, "broken.mjs");
		writeFileSync(entry, "console.error('broken daemon'); process.exit(3);\n");
		await assert.rejects(ensureHub({ home, entry, timeoutMs: 300 }), /did not start within 300 ms; see .*hub\.log/);
		await waitFor(
			() =>
				existsSync(hubPaths(home).daemonLog) &&
				readFileSync(hubPaths(home).daemonLog, "utf8").includes("broken daemon"),
			"log",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
