#!/usr/bin/env node
// pihouse: the pihouse agent. `pih setup --backend cmux|tmux` is what install.sh runs once the code is in place.
import { homedir } from "node:os";
import { runPihouse } from "./launcher.ts";
import { PIHOUSE_VERSION, pihousePaths } from "./paths.ts";
import { setup, teardown } from "./setup.ts";

export const USAGE = `usage: pih [pi options] [message]       start pihouse (all pi options work)
       pih setup --backend cmux|tmux [--claude-bridge] [--books-env-file <path>] [--no-books]
                                        register pihouse's MCP servers (cmux, books) and profile (install.sh runs this);
                                        --claude-bridge also adds the Claude models on your Claude Code login;
                                        --books-env-file sets BOOKS_ENV_FILE for the books server (a path, never secrets);
                                        --no-books leaves the books server out
       pih uninstall                   undo setup's registrations (keeps ~/.pihouse)
       pih --version`;

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
	if (cmd === "uninstall") {
		teardown({ paths: pihousePaths(env, home), home, env, out });
		return 0;
	}
	return runPihouse({ argv, env, home, err });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
