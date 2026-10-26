#!/usr/bin/env node
// agent-link: the daemon, the installer and a look at the running hub.
import { homedir } from "node:os";
import { agentLinkHome, type BackendName } from "agent-link-core";
import { runHub } from "./hub.ts";
import { install, uninstall } from "./install.ts";
import { runRoot } from "./open.ts";
import { sessions, transcript } from "./sessions.ts";
import { status, stop } from "./status.ts";

export const USAGE = `usage: agent-link <command>

  install [--backend cmux|tmux]   register the agent-link MCP server with claude, codex, opencode and pi,
                                  and write the agent-link skill (default backend: cmux inside cmux, else tmux)
  uninstall                       revert what install did
  status                          the running hub's agents, as trees
  stop                            stop the hub and close its agents
  hub                             run the hub daemon in the foreground (normally started on demand)
  open <harness> [args...]        open a harness here as a root whose results arrive by themselves
  sessions                        every agent the hub ever ran, from the journal (works without a hub)
  transcript <agent> [--search t] an agent's last messages, read from its transcript (name or session id)`;

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
	env: NodeJS.ProcessEnv;
	/** The user's home, for install and uninstall. */
	home: string;
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
	const [cmd, ...rest] = argv;
	const xlHome = agentLinkHome(io.env);
	try {
		switch (cmd) {
			case "install": {
				const i = rest.indexOf("--backend");
				const backend = i >= 0 ? rest[i + 1] : undefined;
				if (backend !== undefined && backend !== "cmux" && backend !== "tmux") {
					io.err("--backend must be cmux or tmux");
					return 2;
				}
				install({ home: io.home, env: io.env, backend: backend as BackendName | undefined, out: io.out });
				return 0;
			}
			case "uninstall":
				uninstall({ home: io.home, env: io.env, out: io.out });
				return 0;
			case "status":
				return await status(xlHome, io.out);
			case "stop":
				return await stop(xlHome, io.out);
			case "hub":
				await runHub(xlHome);
				// Serves until a signal; runDaemon exits the process then.
				return await new Promise<number>(() => {});
			case "sessions":
				return sessions(xlHome, io.out);
			case "transcript": {
				const key = rest.find((a) => !a.startsWith("--"));
				if (!key) {
					io.err("usage: agent-link transcript <agent> [--search <text>] [--limit <n>]");
					return 2;
				}
				const opt = (f: string) => {
					const i = rest.indexOf(f);
					return i >= 0 ? rest[i + 1] : undefined;
				};
				return transcript(xlHome, key, io.out, { search: opt("--search"), limit: Number(opt("--limit")) || undefined });
			}
			case "open":
				return await runRoot({ argv: rest, env: io.env, err: io.err });
			case undefined:
			case "help":
			case "--help":
			case "-h":
				io.out(USAGE);
				return cmd === undefined ? 2 : 0;
			default:
				io.err(`unknown command "${cmd}"\n\n${USAGE}`);
				return 2;
		}
	} catch (e) {
		io.err(`agent-link ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (l) => process.stdout.write(`${l}\n`),
		err: (l) => process.stderr.write(`${l}\n`),
		env: process.env,
		home: homedir(),
	});
}
