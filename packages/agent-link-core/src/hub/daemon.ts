// The hub as a detached daemon: started by ensureHub() (src/client.ts) with `node <entry>`, it writes its
// pid, serves until SIGTERM or SIGINT, then closes every agent and removes its socket.
//
// Problem: adapters live in src/adapters and the pane backends in agent-link-cmux and agent-link-tmux, which
// depend on this package, so this file cannot import them without a cycle.
// Example: `node src/hub/daemon.ts` has no cmux backend to open a pane with.
// Solution: runDaemon() takes adapters and backends; the composing package (agent-link) has its own entry
// that imports them all and calls runDaemon(), and ensureHub({ entry }) starts that entry. Run as is, this
// file starts a hub with no adapters and no backends: roots can register and talk, spawn says what is missing.
import { rmSync, writeFileSync } from "node:fs";
import { agentLinkHome, hubPaths } from "../paths.ts";
import { type RunningHub, type StartHubOptions, startHub } from "./server.ts";

export type DaemonOptions = Omit<StartHubOptions, "home"> & { home?: string };

export async function runDaemon(opts: DaemonOptions): Promise<RunningHub> {
	const home = opts.home ?? agentLinkHome();
	const running = await startHub({ ...opts, home });
	const { pid } = hubPaths(home);
	writeFileSync(pid, `${process.pid}\n`, { mode: 0o600 });
	const stop = async () => {
		await running.close();
		rmSync(pid, { force: true });
		process.exit(0);
	};
	process.once("SIGTERM", () => void stop());
	process.once("SIGINT", () => void stop());
	process.stdout.write(`agent-link hub ${process.pid} listening on ${running.socket}\n`);
	return running;
}

if (import.meta.main) {
	await runDaemon({ adapters: {}, backends: {} });
}
