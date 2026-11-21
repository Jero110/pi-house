#!/usr/bin/env node
// pihouse: the pihouse agent. `pih setup --backend cmux|tmux` is what install.sh runs once the code is in place.
import { homedir } from "node:os";
import { shellQuote } from "agent-link-core";
import { fleetMain } from "./fleet.ts";
import { runInTerminal, runPihouse } from "./launcher.ts";
import { PIHOUSE_VERSION, pihousePaths } from "./paths.ts";
import { runRoute } from "./route.ts";
import { setup, teardown } from "./setup.ts";

export const KEEPER_RETIRED =
	"pih keeper was retired. Use /workflow proposals, /workflow approve <id> and /workflow reject <id> [reason] in a pihouse session; /workflow review looks back at saved runs.";

export const USAGE = `usage: pih [pi options] [message]       start pihouse (all pi options work)
       pih fleet serve|pair|open <config.json>  serve the private chat UI, issue a code or open it on this Mac
       pih --tmux-session <name>        start or reattach to a named pihouse session on this host
       pih --remote <[user@]host> <name> [project-dir]
                                        start or reattach on an SSH host (relative paths use its home)
       pih setup --backend cmux|tmux [--claude-bridge] [--books-env-file <path>] [--no-books]
                                        register pihouse's MCP servers (cmux, books) and profile (install.sh runs this);
                                        --claude-bridge also adds the Claude models on your Claude Code login;
                                        --books-env-file sets BOOKS_ENV_FILE for the books server (a path, never secrets);
                                        --no-books leaves the books server out
       pih uninstall                   undo setup's registrations (keeps ~/.pihouse)
       pih route <profile> [--current <provider/model> --failure <kind>] [--task <id>] [--agent <name>]
                                        the exact model an authorized routing profile allows now: 0 selected,
                                        3 paused (checkpoint written), 4 nothing authorized, 2 usage;
                                        --agent names the worker a decision is recorded for
       pih --version`;

function validSession(name: string | undefined): name is string {
	return !!name && !/[^A-Za-z0-9_-]/.test(name);
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const out = (l: string) => process.stdout.write(`${l}\n`);
	const err = (l: string) => process.stderr.write(`${l}\n`);
	const home = env.HOME || homedir();
	const [cmd, ...rest] = argv;
	if (cmd === "--version" || cmd === "-v") {
		out(`pih ${PIHOUSE_VERSION}`);
		return 0;
	}
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		out(USAGE);
		return 0;
	}
	if (cmd === "fleet") return fleetMain(rest);
	if (cmd === "--remote") {
		const [host, name, project = "."] = rest;
		if (
			!host ||
			!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
			!validSession(name) ||
			!project ||
			rest.length > 3
		) {
			err("usage: pih --remote <[user@]host> <name> [project-dir]");
			return 2;
		}
		const relative = project === "~" ? "." : project.replace(/^~\//, "");
		const directory = project.startsWith("/") ? shellQuote(project) : `"$HOME"/${shellQuote(relative)}`;
		// macOS installers often add pih and Node to .zshrc. Load the host's interactive login environment.
		const script = `cd -- ${directory} && exec pih --tmux-session ${shellQuote(name)}`;
		return runInTerminal({
			argv: ["ssh", "-t", "-a", "--", host, `exec "$SHELL" -lic ${shellQuote(script)}`],
			env: env as Record<string, string>,
			cwd: process.cwd(),
		});
	}
	if (cmd === "--tmux-session") {
		const [name] = rest;
		if (rest.length !== 1 || !validSession(name)) {
			err("pih: --tmux-session takes one name using letters, digits, hyphens or underscores");
			return 2;
		}
		if (env.TMUX) {
			err("pih: detach from tmux before opening a named session");
			return 2;
		}
		// Two reconnecting clients can race. Let the tmux server create or attach in one request.
		return runInTerminal({
			argv: ["tmux", "new-session", "-A", "-s", `pih-${name}`, process.execPath, import.meta.filename],
			env: env as Record<string, string>,
			cwd: process.cwd(),
		});
	}
	if (cmd === "setup") {
		const i = rest.indexOf("--backend");
		const backend = i >= 0 ? rest[i + 1] : undefined;
		if (backend !== "cmux" && backend !== "tmux") {
			err("pih setup: --backend must be cmux or tmux");
			return 2;
		}
		const e = rest.indexOf("--books-env-file");
		const booksEnvFile = e >= 0 ? rest[e + 1] : undefined;
		if (e >= 0 && !booksEnvFile) {
			err("pih setup: --books-env-file needs a path");
			return 2;
		}
		setup({
			paths: pihousePaths(env, home),
			backend,
			home,
			env,
			out,
			claudeBridge: rest.includes("--claude-bridge"),
			noBooks: rest.includes("--no-books"),
			booksEnvFile,
		});
		return 0;
	}
	// Problem: `pih keeper` would start a root that no longer exists, so it would look like it worked. Solution: refuse it
	// and name the replacements; nothing starts.
	if (cmd === "keeper") {
		err(KEEPER_RETIRED);
		return 2;
	}
	// Problem: an executor needs one exact model per spawn, and a plain `pih` would start a whole session for it.
	// Solution: `route` answers on stdout with exit codes that say selected, paused or unauthorized, then exits.
	if (cmd === "route") return runRoute(rest, { env, home, out, err });
	if (cmd === "uninstall") {
		teardown({ paths: pihousePaths(env, home), home, env, out });
		return 0;
	}
	return runPihouse({ argv, env, home, err });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
