// `pih [pi args...]`: pi with pihouse's config dir and extensions, opened as an agent-link root so the results
// of the agents it launches reach it by themselves.
//
// Two modes:
// - Root (the user typed `pih`): register with the agent-link hub as harness "pihouse". The hub answers with the
//   command for the pihouse profile (this CLI again, plus agent-link's pi extension and its identity env), which
//   runs here in the user's terminal.
// - Agent (AGENT_LINK_AGENT is set: the hub started this run, as a root's command or a worker's pane): run pi.
// Without a hub (PIHOUSE_NO_LINK=1, or the hub cannot start), pihouse still runs as plain pi with its extensions.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { type RootOptions, runRoot } from "agent-link";
import { type PaneCommand, READ_DIRS_ENV, readDirsFromEnv } from "agent-link-core";
import { cmuxHookExtension } from "./cmux-hooks.ts";
import { EXTENSIONS, PI_CLI, type PihousePaths, pihousePaths, SKILLS_DIR, THEME } from "./paths.ts";
import { ensureAgentDir, writePihouseProfile } from "./setup.ts";

export interface LaunchOptions {
	argv: readonly string[];
	env?: NodeJS.ProcessEnv;
	home?: string;
	cwd?: string;
	err?: (line: string) => void;
	/** Runs a command in this terminal; tests pass a fake. */
	run?: (cmd: PaneCommand) => Promise<number>;
	/** Registers as an agent-link root; tests pass a fake or a runRoot bound to a test hub. */
	root?: (opts: RootOptions) => Promise<number>;
}

/**
 * READ_DIRS_ENV with pihouse's skills folder added: briefs name skills by absolute path, so every worker pihouse
 * opens, in any harness, may read them without a permission prompt.
 */
export function withSkillsDir(env: NodeJS.ProcessEnv): string {
	const dirs = readDirsFromEnv(env);
	return (dirs.includes(SKILLS_DIR) ? dirs : [...dirs, SKILLS_DIR]).join(":");
}

/** The pi command line for one pihouse run. */
export function piCommand(
	paths: PihousePaths,
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): PaneCommand {
	return {
		argv: [
			process.execPath,
			PI_CLI,
			"--theme",
			THEME,
			...[...EXTENSIONS, ...cmuxHookExtension(env)].flatMap((e) => ["-e", e]),
			...argv,
		],
		// pihouse pins pi and updates it with its own install, so pi's "run pi update" notice would be wrong advice.
		env: {
			...env,
			PI_CODING_AGENT_DIR: paths.agentDir,
			PIHOUSE_HOME: paths.home,
			PI_SKIP_VERSION_CHECK: "1",
			[READ_DIRS_ENV]: withSkillsDir(env),
		} as Record<string, string>,
		cwd,
	};
}

export async function runPihouse(opts: LaunchOptions): Promise<number> {
	const env = opts.env ?? process.env;
	const err = opts.err ?? ((l: string) => process.stderr.write(`${l}\n`));
	const cwd = opts.cwd ?? process.cwd();
	const run = opts.run ?? runInTerminal;
	const paths = pihousePaths(env, opts.home);
	const setup = ensureAgentDir(paths);
	if (setup.wrote)
		err(`pih: set up ${paths.agentDir}${setup.copied.length ? ` (login copied from ${paths.piAgentDir})` : ""}`);

	if (env.AGENT_LINK_AGENT || env.PIHOUSE_NO_LINK === "1") return run(piCommand(paths, opts.argv, env, cwd));

	writePihouseProfile(env);
	let started = false;
	const notes: string[] = [];
	const code = await (opts.root ?? runRoot)({
		argv: ["pihouse", ...opts.argv],
		env: { ...env, PI_CODING_AGENT_DIR: paths.agentDir, PIHOUSE_HOME: paths.home, [READ_DIRS_ENV]: withSkillsDir(env) },
		cwd,
		err: (l) => notes.push(l),
		run: (cmd) => {
			started = true;
			return run(cmd);
		},
	});
	if (started) return code;
	// The hub could not take pihouse as a root; run without agent-link rather than not at all.
	for (const n of notes) err(n);
	err("pih: running without agent-link (spawning other agents is off). `agent-link status` shows the hub.");
	return run(piCommand(paths, opts.argv, env, cwd));
}

/**
 * Runs a command with this terminal's stdio and resolves with its exit code (128 + n for a signal).
 * Ctrl-C reaches the whole foreground group; pi handles it, so this process ignores it while pi runs.
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
			process.stderr.write(`pih: could not run ${file}: ${e.message}\n`);
			done(127);
		});
		child.once("exit", (code, signal) => done(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
	});
}
