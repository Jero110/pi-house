import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pihousePaths } from "../src/paths.ts";
import { memoryServer, setup, teardown } from "../src/setup.ts";
import { reconcileSearch } from "../src/workflow/search.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const NAME = "pihouse-memory";

interface Fake {
	home: string;
	project: string;
	env: NodeJS.ProcessEnv;
	calls: () => string[];
}

/** A temporary HOME with fake claude/pi/codex/opencode CLIs that only record how they were called. */
function fake(t: { after: (fn: () => void) => void }): Fake {
	const home = mkdtempSync(join(tmpdir(), "pihouse-reg-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const bin = join(home, "bin");
	mkdirSync(bin);
	for (const b of ["claude", "pi", "codex", "opencode"]) {
		writeFileSync(join(bin, b), `#!/bin/sh\necho "${b} $*" >> "$HOME/calls.log"\n`);
		chmodSync(join(bin, b), 0o755);
	}
	const project = join(home, "work", "alpha");
	mkdirSync(project, { recursive: true });
	const memory = join(home, ".pihouse", "memory");
	mkdirSync(memory, { recursive: true });
	const store = openOperationalStore(join(memory, "memory.sqlite"));
	const path = join(home, "note.md");
	writeFileSync(path, "SECRETBODY should never appear in a prompt");
	reconcileSearch(store, [
		{
			id: "note",
			path,
			kind: "digest",
			project,
			status: "active",
			trust: "derived",
			title: "Note",
			summary: "s",
			provenance: "run",
			date: "2026-01-01",
		},
	]);
	store.close();
	return {
		home,
		project,
		env: {
			HOME: home,
			PATH: `${bin}:/usr/bin:/bin`,
			AGENT_LINK_HOME: join(home, ".al"),
			CODEX_HOME: join(home, ".codex"),
		},
		calls: () =>
			existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").trim().split("\n") : [],
	};
}

/** Starts a registered MCP command like a harness does and returns its initialize and tools/list replies. */
function discover(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
	const input = ["initialize", "tools/list"].map((method, i) =>
		JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params: {} }),
	);
	const run = spawnSync(command, args, { input: `${input.join("\n")}\n`, env, cwd, encoding: "utf8", timeout: 20_000 });
	const [init, list] = run.stdout
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	return { init, tools: list.result.tools.map((x: { name: string }) => x.name).sort() as string[], stdout: run.stdout };
}

const TOOLS = ["memory_feedback", "memory_get", "memory_propose", "memory_search"];

test("setup registers the memory MCP with claude, pi, codex and opencode, and each path discovers the tools", (t) => {
	const f = fake(t);
	const paths = pihousePaths(f.env, f.home);
	for (const backend of ["tmux", "cmux"] as const) setup({ paths, backend, home: f.home, env: f.env, out: () => {} });
	const calls = f.calls();
	const add = calls.filter((c) => c.startsWith(`claude mcp add --scope user ${NAME} --`));
	assert.equal(add.length, 2);
	assert.equal(calls.filter((c) => c.startsWith(`pi mcp add ${NAME} --exposure direct`)).length, 2);

	const [node, entry] = (add[0] ?? "").split(" -- ")[1]?.split(" ") ?? [];
	assert.match(entry ?? "", /pihouse\/src\/memory-mcp\.ts$/);
	// The hub gives a worker AGENT_LINK_AGENT; the launch folder and PIHOUSE_HOME give the scope.
	const harnessEnv = { PATH: f.env.PATH, PIHOUSE_HOME: join(f.home, ".pihouse"), AGENT_LINK_AGENT: "w1" };
	const seen = discover(node ?? "", [entry ?? ""], harnessEnv, f.project);
	assert.deepEqual(seen.tools, TOOLS);

	// Codex filters the env of its servers: what the block lists is all the server gets.
	const toml = readFileSync(join(f.home, ".codex", "config.toml"), "utf8");
	assert.equal(toml.split(`[mcp_servers.${NAME}]`).length, 2);
	const vars = JSON.parse(
		/env_vars = (\[.*\])/.exec(toml.split(`[mcp_servers.${NAME}]`)[1] ?? "")?.[1] ?? "[]",
	) as string[];
	for (const v of ["AGENT_LINK_AGENT", "PIHOUSE_HOME", "PIHOUSE_MEMORY_PROJECT", "PIHOUSE_MEMORY_HOME"])
		assert.ok(vars.includes(v), v);
	assert.ok(!vars.includes("AGENT_LINK_TOKEN"));
	const filtered = Object.fromEntries(
		Object.entries({ ...harnessEnv, AGENT_LINK_TOKEN: "x" }).filter(([k]) => k === "PATH" || vars.includes(k)),
	);
	assert.deepEqual(discover(node ?? "", [entry ?? ""], filtered as NodeJS.ProcessEnv, f.project).tools, TOOLS);

	const oc = JSON.parse(readFileSync(join(f.home, ".config", "opencode", "opencode.json"), "utf8"));
	assert.deepEqual(oc.mcp[NAME].command, [node, entry]);

	// An ordinary session carries the schemas and the short rule, and none of the stored text.
	assert.ok(seen.init.result.instructions.length < 600);
	assert.doesNotMatch(seen.stdout, /SECRETBODY/);
	assert.ok(seen.stdout.length < 8000);

	const mcp = JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8"));
	assert.equal(mcp.mcpServers[NAME].exposure, "direct");
	assert.equal(mcp.mcpServers[NAME].args[0], entry);
});

test("without an agent identity the registered server offers no usable store", (t) => {
	const f = fake(t);
	const spec = memoryServer(pihousePaths(f.env, f.home));
	assert.equal(spec.name, NAME);
	assert.ok(!spec.envVars.includes("AGENT_LINK_TOKEN"));
});

test("setup twice keeps one entry and the user's own config; teardown removes only ours", (t) => {
	const f = fake(t);
	const paths = pihousePaths(f.env, f.home);
	mkdirSync(join(f.home, ".codex"), { recursive: true });
	const own = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
	writeFileSync(join(f.home, ".codex", "config.toml"), own);
	mkdirSync(paths.agentDir, { recursive: true });
	writeFileSync(join(paths.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "m" } } }));
	setup({ paths, backend: "tmux", home: f.home, env: f.env, out: () => {} });
	setup({ paths, backend: "tmux", home: f.home, env: f.env, out: () => {} });
	const toml = readFileSync(join(f.home, ".codex", "config.toml"), "utf8");
	assert.equal(toml.split(`[mcp_servers.${NAME}]`).length, 2);
	assert.ok(toml.includes("[mcp_servers.other]"));
	teardown({ paths, home: f.home, env: f.env, out: () => {} });
	assert.ok(!readFileSync(join(f.home, ".codex", "config.toml"), "utf8").includes(NAME));
	assert.ok(readFileSync(join(f.home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.other]"));
	const left = JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8")).mcpServers;
	assert.deepEqual(Object.keys(left), ["mine"]);
	assert.ok(f.calls().includes(`claude mcp remove --scope user ${NAME}`));
	assert.ok(!existsSync(join(paths.home, "install-memory.json")));
});
