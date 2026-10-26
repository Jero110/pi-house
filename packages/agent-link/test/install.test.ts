import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stableNode } from "agent-link-core";
import { defaultBackend, mcpCommand } from "../src/commands.ts";
import { install, manifestPath, removeBlock, uninstall } from "../src/install.ts";
import { SKILL_MD } from "../src/skill.ts";

/** A temporary HOME with fake harness CLIs that only record how they were called. */
function fakeHome(bins: readonly string[] = ["claude", "pi", "codex", "opencode"]) {
	const home = mkdtempSync(join(tmpdir(), "xl-home-"));
	const bin = join(home, "bin");
	mkdirSync(bin);
	for (const b of bins) {
		const file = join(bin, b);
		writeFileSync(file, `#!/bin/sh\necho "${b} $*" >> "$HOME/calls.log"\n`);
		chmodSync(file, 0o755);
	}
	const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin` };
	const lines: string[] = [];
	return {
		home,
		env,
		lines,
		out: (l: string) => lines.push(l),
		calls: () =>
			existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").trim().split("\n") : [],
		read: (p: string) => readFileSync(join(home, p), "utf8"),
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

const command = { command: "/usr/local/bin/node", args: ["/repo/packages/agent-link-cmux/src/mcp.ts"] };

test("install registers agent-link with all four harnesses and writes the skill; uninstall reverts exactly that", () => {
	const h = fakeHome();
	try {
		// What the user had before: a Codex config, an opencode config with another server, Claude's folder.
		mkdirSync(join(h.home, ".codex"));
		const codexBefore = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
		writeFileSync(join(h.home, ".codex/config.toml"), codexBefore);
		mkdirSync(join(h.home, ".config/opencode"), { recursive: true });
		const ocBefore = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { other: { type: "local", command: ["o"] } } }, null, 2)}\n`;
		writeFileSync(join(h.home, ".config/opencode/opencode.json"), ocBefore);
		mkdirSync(join(h.home, ".claude"));
		writeFileSync(join(h.home, ".claude.json"), '{"projects":{}}\n');

		install({ home: h.home, env: h.env, backend: "cmux", command, out: h.out });

		const node = command.command;
		const mcp = command.args[0];
		assert.deepEqual(h.calls(), [
			"claude mcp remove --scope user agent-link",
			`claude mcp add --scope user agent-link -- ${node} ${mcp}`,
			`pi mcp add agent-link --exposure direct --description Launch and message other coding agents -- ${node} ${mcp}`,
		]);
		assert.equal(
			h.read(".codex/config.toml"),
			`${codexBefore}\n# agent-link: begin (written by an installer; its uninstall removes it)\n[mcp_servers.agent-link]\ncommand = "${node}"\nargs = ["${mcp}"]\nenv_vars = ["AGENT_LINK_AGENT","AGENT_LINK_HUB","AGENT_LINK_TOKEN","AGENT_LINK_DEPTH","AGENT_LINK_HOME","AGENT_LINK_READ_DIRS","CMUX_WORKSPACE_ID","CMUX_SURFACE_ID","TMUX","TMUX_PANE"]\ndefault_tools_approval_mode = "approve"\n# agent-link: end\n`,
		);
		const oc = JSON.parse(h.read(".config/opencode/opencode.json"));
		assert.deepEqual(oc.mcp["agent-link"], { type: "local", command: [node, mcp], enabled: true });
		assert.deepEqual(oc.mcp.other, { type: "local", command: ["o"] });
		assert.equal(h.read(".agents/skills/agent-link/SKILL.md"), SKILL_MD);
		assert.equal(h.read(".claude/skills/agent-link/SKILL.md"), SKILL_MD);
		assert.equal(existsSync(join(h.home, ".pi/agent/skills/agent-link")), false, "pi reads ~/.agents/skills");
		// Backups of the files as they were.
		assert.equal(h.read(".codex/config.toml.agent-link.bak"), codexBefore);
		assert.equal(h.read(".config/opencode/opencode.json.agent-link.bak"), ocBefore);
		assert.equal(h.read(".claude.json.agent-link.bak"), '{"projects":{}}\n');
		assert.ok(existsSync(manifestPath(h.home, h.env)));
		assert.deepEqual(h.lines.slice(0, 2), [
			`agent-link install: backend cmux, MCP server "agent-link" = ${node} ${mcp}`,
			"claude: added user MCP server agent-link (claude mcp add --scope user); backup ~/.claude.json.agent-link.bak",
		]);

		// Idempotent: a second install leaves one block, one key, and the first backups.
		writeFileSync(
			join(h.home, ".codex/config.toml"),
			`${h.read(".codex/config.toml")}\n[profiles.fast]\nmodel = "x"\n`,
		);
		install({ home: h.home, env: h.env, backend: "cmux", command, out: h.out });
		const toml = h.read(".codex/config.toml");
		assert.equal(toml.split("[mcp_servers.agent-link]").length, 2);
		assert.equal(h.read(".codex/config.toml.agent-link.bak"), codexBefore);

		h.lines.length = 0;
		assert.equal(uninstall({ home: h.home, env: h.env, out: h.out }), true);
		assert.equal(
			h.read(".codex/config.toml"),
			`${codexBefore}\n[profiles.fast]\nmodel = "x"\n`,
			"the user's later edit stays",
		);
		assert.equal(h.read(".config/opencode/opencode.json"), ocBefore);
		assert.equal(existsSync(join(h.home, ".agents/skills/agent-link")), false);
		assert.equal(existsSync(join(h.home, ".claude/skills/agent-link")), false);
		assert.deepEqual(h.calls().slice(-2), ["pi mcp remove agent-link", "claude mcp remove --scope user agent-link"]);
		assert.equal(existsSync(manifestPath(h.home, h.env)), false);
		assert.match(h.lines.at(-1) ?? "", /^backups from the first install kept: /);
		assert.equal(uninstall({ home: h.home, env: h.env, out: h.out }), false, "nothing left to revert");
	} finally {
		h.cleanup();
	}
});

test("files install created are removed again; harnesses not found are skipped and said so", () => {
	const h = fakeHome(["codex", "opencode"]);
	try {
		install({ home: h.home, env: h.env, backend: "tmux", command, out: h.out });
		assert.ok(h.lines.includes("claude: not found on PATH, skipped"));
		assert.ok(h.lines.includes("pi: not found on PATH, skipped"));
		assert.ok(existsSync(join(h.home, ".codex/config.toml")));
		assert.equal(JSON.parse(h.read(".config/opencode/opencode.json")).$schema, "https://opencode.ai/config.json");
		assert.equal(existsSync(join(h.home, ".claude/skills")), false, "no ~/.claude: no Claude skill");
		uninstall({ home: h.home, env: h.env, out: h.out });
		assert.equal(existsSync(join(h.home, ".codex/config.toml")), false);
		assert.equal(existsSync(join(h.home, ".config/opencode/opencode.json")), false);
	} finally {
		h.cleanup();
	}
});

test("a harness on PATH that does not run (cmux's pi shim with no pi) is skipped, and the install goes on", () => {
	const h = fakeHome(["claude", "codex"]);
	try {
		writeFileSync(
			join(h.home, "bin", "pi"),
			'#!/bin/sh\necho "Configured agent is unavailable. Install it or check the command configuration." >&2\nexit 1\n',
		);
		chmodSync(join(h.home, "bin", "pi"), 0o755);
		const m = install({ home: h.home, env: h.env, backend: "cmux", command, out: h.out });
		assert.ok(
			h.lines.some((l) =>
				/^pi: found at .* but it does not run \(Configured agent is unavailable\..*\), skipped$/.test(l),
			),
			h.lines.join("\n"),
		);
		assert.deepEqual(
			m.steps.map((s) => s.harness).filter((x) => x !== "agents"),
			["claude", "codex"],
		);
	} finally {
		h.cleanup();
	}
});

test("an opencode config with comments, or a Codex entry of the user's own, is left alone", () => {
	const h = fakeHome([]);
	try {
		mkdirSync(join(h.home, ".config/opencode"), { recursive: true });
		const jsonc = '{\n  // mine\n  "theme": "x"\n}\n';
		writeFileSync(join(h.home, ".config/opencode/opencode.jsonc"), jsonc);
		mkdirSync(join(h.home, ".codex"));
		const own = '[mcp_servers.agent-link]\ncommand = "custom"\n';
		writeFileSync(join(h.home, ".codex/config.toml"), own);
		install({ home: h.home, env: h.env, backend: "cmux", command, out: h.out });
		assert.equal(h.read(".config/opencode/opencode.jsonc"), jsonc);
		assert.equal(h.read(".codex/config.toml"), own);
		assert.ok(
			h.lines.some((l) => /^opencode: .*opencode\.jsonc is not plain JSON \(comments\?\), left as it is/.test(l)),
		);
		assert.ok(
			h.lines.some((l) => /^codex: .* already has its own \[mcp_servers\.agent-link\], left as it is$/.test(l)),
		);
	} finally {
		h.cleanup();
	}
});

test("removeBlock keeps what is around the block", () => {
	const b =
		"# agent-link: begin (written by an installer; its uninstall removes it)\n[mcp_servers.agent-link]\n# agent-link: end";
	assert.equal(removeBlock(`a = 1\n\n${b}\n`), "a = 1\n");
	assert.equal(removeBlock(`${b}\n`), "");
	assert.equal(removeBlock(`a = 1\n\n${b}\n[x]\ny = 2\n`), "a = 1\n[x]\ny = 2\n");
	assert.equal(removeBlock("no block\n"), "no block\n");
});

test("default backend: cmux inside cmux, else tmux; the MCP command is node and the backend's entry", () => {
	assert.equal(defaultBackend({ CMUX_SOCKET_CAPABILITY: "x" }), "cmux");
	assert.equal(defaultBackend({ CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/x" }), "cmux");
	assert.equal(defaultBackend({ TMUX: "/tmp/t,1,0" }), "tmux");
	assert.equal(defaultBackend({}), "tmux");
	const cmd = mcpCommand("tmux");
	assert.equal(cmd.command, stableNode());
	assert.match(cmd.args[0] ?? "", /packages\/agent-link-tmux\/src\/mcp\.ts$/);
	assert.ok(existsSync(cmd.args[0] ?? ""));
});
