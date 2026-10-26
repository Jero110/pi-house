#!/usr/bin/env node
// xl <harness> [harness args...]: opens a harness in this terminal as an agent-link root with an adapter, so
// its workers' results reach it by themselves as new turns. It registers the root (POST /agents with
// adapter: true), runs the command the adapter returns with this terminal's stdio, and reports the exit.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createHubClient, ensureHub, type PaneCommand, placeFromEnv } from "agent-link-core";
import { defaultBackend } from "./commands.ts";

export interface RootOptions {
	/** The harness, then arguments passed on to it. */
	argv: readonly string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** agent-link home; default AGENT_LINK_HOME or ~/.agent-link. */
	home?: string;
	hubEntry?: string;
	/** Runs the harness and resolves with its exit code; default: a child with inherited stdio. */
	run?: (cmd: PaneCommand) => Promise<number>;
	err?: (line: string) => void;
	/** The process the hub watches for this root; default this one. */
	pid?: number;
}

export const OPEN_USAGE = "usage: agent-link open <harness> [harness args...]   e.g. agent-link open claude";

/** Returns the exit code for `agent-link open`: the harness's own, or 1 / 2 when it could not start. */
export async function runRoot(opts: RootOptions): Promise<number> {
	const env = opts.env ?? process.env;
	const err = opts.err ?? ((l: string) => process.stderr.write(`${l}\n`));
	const [harness, ...rest] = opts.argv;
	if (!harness || harness.startsWith("-")) {
		err(OPEN_USAGE);
		return 2;
	}
	let client: ReturnType<typeof createHubClient>;
	let registered: Awaited<ReturnType<ReturnType<typeof createHubClient>["register"]>>;
	try {
		client = createHubClient(await ensureHub({ home: opts.home, entry: opts.hubEntry, env }));
		registered = await client.register({
			harness,
			cwd: opts.cwd ?? process.cwd(),
			pull: false,
			adapter: true,
			pid: opts.pid ?? process.pid,
			backend: defaultBackend(env),
			place: placeFromEnv(defaultBackend(env), env),
		});
	} catch (e) {
		err(`agent-link open: the agent-link hub is not reachable: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
	if ("error" in registered) {
		err(`agent-link open: ${registered.error}`);
		return 1;
	}
	if (!registered.command) {
		err(`agent-link open: the hub returned no command for ${harness}`);
		return 1;
	}
	const cmd: PaneCommand = {
		...registered.command,
		argv: [...registered.command.argv, ...rest],
		env: { ...env, ...registered.command.env } as Record<string, string>,
	};
	const code = await (opts.run ?? runInTerminal)(cmd);
	await client
		.event({
			agent: registered.name,
			type: "exited",
			pid: opts.pid ?? process.pid,
			detail: `harness exited with code ${code}`,
		})
		.catch(() => {});
	return code;
}

/**
 * Runs the harness in this terminal and resolves with its exit code (128 + n for a signal).
 * Problem: Ctrl-C in the terminal reaches the whole foreground group, so the launcher got it too and died while the
 * harness, which handles Ctrl-C itself, went on as a root nobody watched. Solution: the launcher ignores SIGINT and
 * SIGQUIT while the harness runs, and passes SIGTERM and SIGHUP on to it.
 */
export function runInTerminal(cmd: PaneCommand): Promise<number> {
	return new Promise((resolve) => {
		const [file, ...args] = cmd.argv;
		if (!file) return resolve(2);
		const child = spawn(file, args, { stdio: "inherit", env: cmd.env, cwd: cmd.cwd });
		const ignore = () => {};
		const forward = (sig: NodeJS.Signals) => child.kill(sig);
		process.on("SIGINT", ignore);
		process.on("SIGQUIT", ignore);
		process.on("SIGTERM", forward);
		process.on("SIGHUP", forward);
		const done = (code: number) => {
			process.off("SIGINT", ignore);
			process.off("SIGQUIT", ignore);
			process.off("SIGTERM", forward);
			process.off("SIGHUP", forward);
			resolve(code);
		};
		child.once("error", (e) => {
			process.stderr.write(`agent-link open: could not run ${file}: ${e.message}\n`);
			done(127);
		});
		child.once("exit", (code, signal) => {
			const n = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
			done(n);
		});
	});
}

if (import.meta.main) process.exitCode = await runRoot({ argv: process.argv.slice(2) });
