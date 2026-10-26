import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PaneCommand } from "agent-link-core";
import { pullRoot, testHub, waitFor } from "../../agent-link-core/test/fakes/hub.ts";
import { OPEN_USAGE, runRoot } from "../src/open.ts";

test("open registers a root with an adapter, runs its command with the extra args, then reports the exit", async () => {
	const t = await testHub();
	try {
		const ran: PaneCommand[] = [];
		const errs: string[] = [];
		const code = await runRoot({
			argv: ["claude", "--resume", "abc"],
			env: { PATH: "/usr/bin:/bin", HOME: t.home, TMUX: "/tmp/t,1,0" },
			cwd: t.home,
			home: t.home,
			err: (l) => errs.push(l),
			run: async (cmd) => {
				ran.push(cmd);
				// While the harness runs, it is a root the hub drives through its adapter.
				const root = t.running.hub.registry.get("claude");
				assert.equal(root?.record.pull, false);
				assert.equal(root?.record.parent, null);
				return 4;
			},
		});
		assert.equal(code, 4, "xl exits with the harness's code");
		assert.deepEqual(errs, []);
		assert.deepEqual(ran[0]?.argv, ["fake-harness", "--name", "claude", "--resume", "abc"]);
		assert.equal(ran[0]?.env.AGENT_LINK_AGENT, "claude");
		assert.equal(ran[0]?.env.AGENT_LINK_DEPTH, "0");
		assert.equal(ran[0]?.env.PATH, "/usr/bin:/bin", "the terminal's env reaches the harness");
		assert.deepEqual(
			t.kit.byName("claude")?.spec?.mcp,
			{ command: "agent-link-tmux", args: ["mcp"] },
			"tmux outside cmux",
		);
		await waitFor(() => t.running.hub.registry.get("claude")?.record.state === "exited", "root closed on exit");
	} finally {
		await t.stop();
	}
});

test("open runs the harness in this terminal: a real child gets the identity and its exit code comes back", async () => {
	const t = await testHub();
	try {
		const out = join(t.home, "child.txt");
		t.kit.onCreate = (a) => {
			a.launch = async (spec) => ({
				argv: [
					process.execPath,
					"-e",
					`require("fs").writeFileSync(${JSON.stringify(out)}, process.env.AGENT_LINK_AGENT + " " + process.argv[1]); process.exit(3)`,
				],
				env: spec.env,
				cwd: spec.cwd,
			});
		};
		const root = await pullRoot(t.client);
		const code = await runRoot({
			argv: ["pi", "extra"],
			env: { ...process.env, CMUX_BUNDLED_CLI_PATH: "x" },
			home: t.home,
			cwd: t.home,
		});
		assert.equal(code, 3);
		assert.equal(readFileSync(out, "utf8"), "pi extra");
		await waitFor(() => t.running.hub.registry.get("pi")?.record.state === "exited", "closed");
		assert.notEqual(t.running.hub.registry.get(root)?.record.state, "exited", "other roots stay");
	} finally {
		await t.stop();
	}
});

test("open without a harness prints usage; one the hub cannot drive says why", async () => {
	const t = await testHub();
	try {
		const errs: string[] = [];
		assert.equal(await runRoot({ argv: [], home: t.home, err: (l) => errs.push(l) }), 2);
		assert.deepEqual(errs, [OPEN_USAGE]);
		errs.length = 0;
		assert.equal(await runRoot({ argv: ["nope"], home: t.home, err: (l) => errs.push(l), run: async () => 0 }), 1);
		assert.match(errs[0] ?? "", /^agent-link open: no adapter for "nope" in this hub/);
	} finally {
		await t.stop();
	}
});
