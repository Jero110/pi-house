import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHub, stopHub } from "agent-link-core";
import { pullRoot, spawned, tempHome, testHub, waitFor } from "../../agent-link-core/test/fakes/hub.ts";
import { type CliIo, main, USAGE } from "../src/cli.ts";

function io(env: NodeJS.ProcessEnv, home = "/nonexistent-home"): CliIo & { lines: string[]; errs: string[] } {
	const lines: string[] = [];
	const errs: string[] = [];
	return { lines, errs, env, home, out: (l) => lines.push(l), err: (l) => errs.push(l) };
}

test("agent-link status prints the running hub's agents as trees", async () => {
	const t = await testHub();
	try {
		const root = await pullRoot(t.client);
		await spawned(t, root, "pi", "lead");
		await waitFor(() => t.kit.byName("lead")?.inTurn, "lead");
		await t.client.spawn({ from: "lead", harness: "claude", task: "t", name: "sub", backend: "cmux" });
		await waitFor(() => t.kit.byName("sub")?.inTurn, "sub");
		const c = io({ AGENT_LINK_HOME: t.home });
		assert.equal(await main(["status"], c), 0);
		assert.deepEqual(c.lines, [
			`agent-link hub on ${join(t.home, "hub.sock")}: 3 agents, 3 not exited`,
			"codex · codex · working · pull (results wait for inbox)",
			"  └ lead · pi · claude-bridge/claude-haiku-5-5 · working · cmux pane:1 · 1 queued",
			"    └ sub · claude · claude-haiku-5-5 · working · cmux pane:2 · 1 queued",
		]);
	} finally {
		await t.stop();
	}
});

test("agent-link stop ends a detached daemon; status and stop then say no hub runs", async () => {
	const home = tempHome();
	try {
		await ensureHub({ home, entry: join(import.meta.dirname, "../../agent-link-core/test/fakes/daemon.ts") });
		const c = io({ AGENT_LINK_HOME: home });
		assert.equal(await main(["stop"], c), 0);
		assert.deepEqual(c.lines, ["stopped the agent-link hub; its agents were closed with it"]);
		c.lines.length = 0;
		assert.equal(await main(["status"], c), 1);
		assert.equal(await main(["stop"], c), 1);
		assert.deepEqual(c.lines, [
			`no agent-link hub running (${join(home, "hub.sock")} does not answer)`,
			"no agent-link hub running",
		]);
	} finally {
		await stopHub(home);
		rmSync(home, { recursive: true, force: true });
	}
});

test("agent-link with no command or an unknown one prints usage; --backend is checked", async () => {
	const c = io({});
	assert.equal(await main([], c), 2);
	assert.deepEqual(c.lines, [USAGE]);
	assert.equal(await main(["frobnicate"], c), 2);
	assert.match(c.errs[0] ?? "", /^unknown command "frobnicate"/);
	assert.equal(await main(["install", "--backend", "screen"], c), 2);
	assert.equal(c.errs[1], "--backend must be cmux or tmux");
});
