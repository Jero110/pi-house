// Runs the cmux CLI. Every tool goes through one runner, so tests swap it for a fake CLI.
import { execFile } from "node:child_process";

export type CmuxRunner = (args: readonly string[]) => Promise<string>;

export function cmuxRunner(env: NodeJS.ProcessEnv = process.env, bin = env.CMUX_BIN || "cmux"): CmuxRunner {
	return (args) =>
		new Promise((resolve, reject) => {
			execFile(
				bin,
				[...args],
				// CMUX_QUIET hides notices about renamed commands, which would mix with JSON on stdout.
				{ env: { ...env, CMUX_QUIET: "1" }, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error) reject(new Error(`cmux ${args.join(" ")}: ${(stderr || error.message).trim()}`));
					else resolve(stdout);
				},
			);
		});
}

export async function cmuxJson<T>(run: CmuxRunner, args: readonly string[]): Promise<T> {
	const out = await run(["--json", ...args]);
	try {
		return JSON.parse(out) as T;
	} catch {
		throw new Error(`cmux ${args.join(" ")} did not answer JSON: ${out.slice(0, 200)}`);
	}
}

/** Adds `--flag value` for each set option. Booleans become "true" or "false", as cmux takes them. */
export function flags(opts: Record<string, string | number | boolean | undefined>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(opts)) {
		if (v === undefined || v === "") continue;
		out.push(`--${k}`, String(v));
	}
	return out;
}
