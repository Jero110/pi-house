import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchCommand, shellCommand, shellQuote, writeLaunchScript } from "../src/launch-script.ts";

test("quoting survives a real shell round trip", () => {
	const tricky = ["plain", "with space", "it's", '{"json": "yes"}', "$HOME `x` \\n", "ñ ✓", ""];
	const out = execFileSync("/bin/sh", ["-c", shellCommand(["printf", "%s\\n", ...tricky])], { encoding: "utf8" });
	assert.equal(out, `${tricky.join("\n")}\n`);
	assert.equal(shellQuote("simple-path/x.js"), "simple-path/x.js");
});

test("the launch script runs the command with env and cwd, then is gone; it is private while it exists", () => {
	const dir = mkdtempSync(join(tmpdir(), "xi-ls-"));
	const file = writeLaunchScript(
		{ argv: ["sh", "-c", 'printf "%s|%s" "$XI_X" "$(pwd -P)"'], env: { XI_X: "it's {json} $y" }, cwd: "/tmp" },
		dir,
	);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.match(readFileSync(file, "utf8"), /^#!\/bin\/sh\nrm -f -- "\$0"\n/);
	const out = execFileSync("/bin/sh", [file], { encoding: "utf8" });
	assert.equal(
		out,
		`it's {json} $y|${execFileSync("/bin/sh", ["-c", "cd /tmp && pwd -P"], { encoding: "utf8" }).trim()}`,
	);
	assert.equal(existsSync(file), false);
});

test("an existing launch folder with loose permissions is made private", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "xi-ls-")), "launch");
	mkdirSync(dir, { mode: 0o755 });
	chmodSync(dir, 0o755);
	const cmd = launchCommand({ argv: ["true"], env: {}, cwd: "/" }, dir);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.match(cmd, /^\/bin\/sh \S+\.sh$/);
});

test("bad env names and empty argv are refused instead of written into the script", () => {
	const dir = mkdtempSync(join(tmpdir(), "xi-ls-"));
	assert.throws(() => writeLaunchScript({ argv: ["true"], env: { "A;rm -rf /": "x" }, cwd: "/" }, dir), /bad env/);
	assert.throws(() => writeLaunchScript({ argv: [], env: {}, cwd: "/" }, dir), /empty argv/);
});

test("a cwd that does not exist stops the script before the command runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "xi-ls-"));
	const file = writeLaunchScript({ argv: ["echo", "ran"], env: {}, cwd: "/no/such/dir" }, dir);
	assert.throws(() => execFileSync("/bin/sh", [file], { encoding: "utf8", stdio: "pipe" }));
});
