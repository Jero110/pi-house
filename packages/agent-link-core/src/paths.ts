// Where agent-link keeps its files: one home folder per machine (or per test), private to the user.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The agent-link home: AGENT_LINK_HOME, else ~/.agent-link. */
export function agentLinkHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.AGENT_LINK_HOME?.trim();
	return fromEnv ? resolve(fromEnv) : join(homedir(), ".agent-link");
}

export interface HubPaths {
	home: string;
	/** The hub's Unix socket (0600). */
	socket: string;
	/** The token every request carries in x-agent-link-token (0600). */
	token: string;
	/** The running daemon's pid, so a dev script or a test can stop it. */
	pid: string;
	/** What a detached daemon writes to stdout and stderr. */
	daemonLog: string;
	/** One private folder per agent: run/<name> (0700). */
	run: string;
	events: string;
	/** The session journal: one JSON file per agent, kept after the hub stops. */
	sessions: string;
}

export function hubPaths(home: string = agentLinkHome()): HubPaths {
	return {
		home,
		socket: join(home, "hub.sock"),
		token: join(home, "token"),
		pid: join(home, "hub.pid"),
		daemonLog: join(home, "hub.log"),
		run: join(home, "run"),
		events: join(home, "events.sqlite"),
		sessions: join(home, "sessions"),
	};
}

/**
 * The node to write into configs that outlive this process (MCP registrations, profiles).
 * Problem: process.execPath is the resolved binary. Example: Homebrew's /opt/homebrew/Cellar/node/26.11.1/bin/node,
 * gone after the next `brew upgrade node`, which breaks every registered MCP server. Solution: the first `node` on
 * PATH (Homebrew's /opt/homebrew/bin/node is a stable link), else this process's node.
 */
export function stableNode(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PIHOUSE_NODE) return env.PIHOUSE_NODE;
	for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
		const file = join(dir, "node");
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {}
	}
	return process.execPath;
}
