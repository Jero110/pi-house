// The launch script every pane backend runs instead of the pane command itself.
//
// Problem: a long command typed into a pane can stall the shell before it runs, and it shows the hub token on
// screen. Example: a worker started with `env AGENT_LINK_TOKEN=... claude --mcp-config '{"mcpServers":...}'` typed
// into a cmux pane left the token in the pane's scrollback and the user's shell history. Solution: the pane runs
// a short `/bin/sh <script>`; the script is private (0600, in a 0700 folder), deletes itself as soon as it
// starts, exports the env, changes to the cwd and execs the command, so the harness owns the pane process.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneCommand } from "./types.ts";

/** POSIX shell quoting: safe words stay as they are, anything else goes in single quotes. */
export function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}

export const DEFAULT_LAUNCH_DIR = join(tmpdir(), "agent-link-launch");

/** Writes the launch script for cmd and returns its absolute path. */
export function writeLaunchScript(cmd: PaneCommand, dir = DEFAULT_LAUNCH_DIR): string {
	if (cmd.argv.length === 0) throw new Error("launch script: empty argv");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir leaves the mode of a folder that already exists alone.
	chmodSync(dir, 0o700);
	const file = join(dir, `${randomBytes(8).toString("hex")}.sh`);
	const lines = [
		"#!/bin/sh",
		'rm -f -- "$0"',
		...Object.entries(cmd.env).map(([k, v]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`launch script: bad env name ${JSON.stringify(k)}`);
			return `export ${k}=${shellQuote(v)}`;
		}),
		`cd ${shellQuote(cmd.cwd)} || exit 1`,
		`exec ${shellCommand(cmd.argv)}`,
	];
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	return file;
}

/** The short command a pane runs: `/bin/sh <script>`. */
export function launchCommand(cmd: PaneCommand, dir?: string): string {
	return `/bin/sh ${shellQuote(writeLaunchScript(cmd, dir))}`;
}
