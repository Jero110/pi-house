import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a named session uses atomic create-or-attach in the project directory and propagates the tmux exit code", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pih session ")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "args");
	writeFileSync(join(dir, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$TMUX_LOG"\nexit 23\n', { mode: 0o755 });
	const env = { ...process.env, HOME: dir, PATH: dir, TMUX: "", TMUX_LOG: log };
	const result = spawnSync(process.execPath, [cli, "--tmux-session", "my-project"], { cwd: dir, env });
	assert.equal(result.status, 23, result.stderr.toString());
	assert.deepEqual(readFileSync(log, "utf8").trimEnd().split("\n"), [
		dir,
		"new-session",
		"-A",
		"-s",
		"pih-my-project",
		process.execPath,
		cli,
	]);
});

test("invalid names, extra arguments and nesting are rejected before tmux starts", async () => {
	const env = { PATH: "" };
	for (const args of [[], ["a:b"], ["a.b"], ["a\nb"], ["a", "b"]]) {
		assert.equal(await main(["--tmux-session", ...args], env), 2);
	}
	assert.equal(await main(["--tmux-session", "project_1"], { ...env, TMUX: "socket,1,0" }), 2);
});

test("remote mode selects the SSH host and opens the requested project through the host's shell", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pih remote ")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const project = "a team's $project";
	mkdirSync(join(dir, project));
	const log = join(dir, "result");
	writeFileSync(
		join(dir, "ssh"),
		[
			"#!/bin/sh",
			'test "$1" = "-t" && test "$2" = "-a" && test "$3" = "--" && test "$4" = "dev@mini-m6" || exit 91',
			'test "$#" -eq 5 || exit 92',
			'exec /bin/sh -c "$5"',
		].join("\n"),
		{ mode: 0o755 },
	);
	writeFileSync(join(dir, "pih"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$RESULT"\nexit 19\n', { mode: 0o755 });
	const shell = join(dir, "login-shell");
	writeFileSync(shell, '#!/bin/sh\ntest "$1" = "-lic" || exit 93\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
	const env = { HOME: dir, PATH: dir, SHELL: shell, RESULT: log };
	const result = spawnSync(process.execPath, [cli, "--remote", "dev@mini-m6", "docs", project], { env });
	assert.equal(result.status, 19, result.stderr.toString());
	assert.deepEqual(readFileSync(log, "utf8").trimEnd().split("\n"), [join(dir, project), "--tmux-session", "docs"]);
});

test("remote mode rejects SSH options and missing session names", async () => {
	for (const args of [["-oProxyCommand=oops", "task"], ["dev@-host", "task"], ["mini"], ["mini", "a:b"]]) {
		assert.equal(await main(["--remote", ...args], { PATH: "" }), 2);
	}
});
