import { execFileSync } from "node:child_process";
import { serveFleetBackup } from "./fleet-backup.ts";
import { createFleetJobs } from "./fleet-jobs.ts";
import { startSlackSocket } from "./fleet-slack-socket.ts";
import { serveFleet } from "./fleet-tailnet.ts";
import { issuePairCode, readFleetConfig } from "./fleet-web.ts";

export async function fleetMain(args: readonly string[]): Promise<number> {
	const [action, file] = args;
	if (args.length !== 2 || (action !== "serve" && action !== "pair" && action !== "open")) {
		process.stderr.write("usage: pih fleet serve|pair|open <config.json>\n");
		return 2;
	}
	try {
		const c = readFleetConfig(file);
		if (action === "open") {
			if (process.platform !== "darwin") throw new Error("Automatic browser pairing requires macOS.");
			execFileSync("/usr/bin/open", [`${c.origin}/#pair=${issuePairCode(c.stateDir)}`], { stdio: "ignore" });
			return 0;
		}
		if (action === "pair") {
			process.stdout.write(`${issuePairCode(c.stateDir)}\n`);
			return 0;
		}
		const jobs = createFleetJobs({
			stateDir: c.stateDir,
			origin: c.origin,
			memoryRepo: c.memoryRepo,
			projects: c.projects,
			host: c.host,
			planner: c.planner,
			planners: c.planners,
			turnTimeoutMs: c.turnTimeoutMs,
		});
		const stop = new AbortController();
		const slack = c.slack
			? startSlackSocket(
					c.slack,
					{ stateDir: c.stateDir, origin: c.origin, host: c.host, signal: stop.signal },
					jobs,
				).catch((error: unknown) => {
					if (!stop.signal.aborted)
						process.stderr.write(
							`Slack integration unavailable: ${error instanceof Error ? error.message : "startup failed"}\n`,
						);
				})
			: undefined;
		try {
			const backup = await serveFleetBackup(c, jobs);
			try {
				await serveFleet(c, jobs);
			} finally {
				backup.close();
			}
		} finally {
			stop.abort();
			await (await slack)?.close();
			jobs.close();
		}
		return 0;
	} catch (error) {
		process.stderr.write(`pih fleet: ${error instanceof Error ? error.message : "Host could not start"}\n`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await fleetMain(process.argv.slice(2));
