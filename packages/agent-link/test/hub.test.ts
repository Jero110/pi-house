import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHubClient, DEFAULT_HUB_ENTRY, stableNode, startHub } from "agent-link-core";
import { tempHome } from "../../agent-link-core/test/fakes/hub.ts";
import { ADAPTERS } from "../src/adapters.ts";
import { hubOptions } from "../src/hub.ts";

test("ensureHub's default entry is this package's composed hub", () => {
	assert.equal(DEFAULT_HUB_ENTRY, join(import.meta.dirname, "../src/hub.ts"));
});

test("the composed hub: every adapter on main, both backends, node MCP commands, the user's own profiles", async () => {
	const home = tempHome();
	try {
		mkdirSync(join(home, "profiles"));
		writeFileSync(
			join(home, "profiles", "aider.json"),
			JSON.stringify({
				harness: "aider",
				adapter: "paste",
				label: "Aider",
				defaultModel: null,
				dialogs: [],
				command: ["aider"],
			}),
		);
		const opts = hubOptions(home);
		assert.deepEqual(Object.keys(ADAPTERS), ["claude", "codex", "opencode", "paste", "pi"]);
		assert.deepEqual(Object.keys(opts.backends).sort(), ["cmux", "tmux"]);
		assert.equal(opts.mcp?.cmux?.command, stableNode());
		assert.match(opts.mcp?.cmux?.args[0] ?? "", /packages\/agent-link-cmux\/src\/mcp\.ts$/);
		assert.deepEqual([...(opts.profiles?.keys() ?? [])].sort(), ["aider", "claude", "codex", "opencode", "pi"]);

		const running = await startHub(opts);
		try {
			const client = createHubClient({ socket: running.socket, token: running.token });
			const root = await client.register({ harness: "claude", cwd: home, pull: true });
			assert.ok("name" in root);
			// The user's own profile reaches the paste adapter and then the cmux backend, which needs the caller's
			// surface. A paste launch runs nothing on this machine, unlike claude's (pretrust, claude mcp get).
			const res = await client.spawn({ from: root.name, harness: "aider", task: "t", backend: "cmux" });
			assert.deepEqual(res, {
				error: "could not start aider: cmux backend: place.surface (the caller's surface) is required",
			});
		} finally {
			await running.close();
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
