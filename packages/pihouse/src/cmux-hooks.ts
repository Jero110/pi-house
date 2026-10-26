// cmux's hook for pi, loaded into pihouse the way cmux loads it into plain pi.
//
// cmux's own `pi` wrapper writes the output of `cmux hooks pi extension-source` to a file and starts pi with
// `-e <file>`: that extension reports the session, the tools it runs, and "answer done" notifications to the cmux
// pane, so the pane shows what the agent is doing. pihouse starts pi by its own path, so it never goes through that
// wrapper, and a pihouse pane stayed silent. This does the same two steps for pihouse, only inside cmux.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "agent-link";

/** The line cmux puts in every extension it generates; the wrapper checks it too. */
export const CMUX_HOOK_MARKER = "cmux-pi-session-extension-marker";

/**
 * The extension file for this cmux pane, or none: outside cmux, with the hooks switched off (CMUX_PI_HOOKS_DISABLED=1),
 * or when the cmux CLI cannot produce it, pihouse runs as it did. The file lives where cmux's wrapper keeps its own copy
 * (<tmp>/cmux-pi-extensions/<surface>/cmux-session.ts), so both share it.
 */
export function cmuxHookExtension(env: NodeJS.ProcessEnv): string[] {
	const surface = env.CMUX_SURFACE_ID;
	if (!surface || env.CMUX_PI_HOOKS_DISABLED === "1") return [];
	const cli =
		env.CMUX_BUNDLED_CLI_PATH && existsSync(env.CMUX_BUNDLED_CLI_PATH) ? env.CMUX_BUNDLED_CLI_PATH : which("cmux", env);
	if (!cli) return [];
	try {
		const source = spawnSync(cli, ["hooks", "pi", "extension-source"], { env, encoding: "utf8", timeout: 5000 });
		if (source.status !== 0 || !source.stdout.includes(CMUX_HOOK_MARKER)) return [];
		const dir = join(env.TMPDIR || tmpdir(), "cmux-pi-extensions", surface);
		const file = join(dir, "cmux-session.ts");
		if (!existsSync(file) || readFileSync(file, "utf8") !== source.stdout) {
			mkdirSync(dir, { recursive: true });
			const tmp = join(dir, `.cmux-session.ts.${process.pid}`);
			writeFileSync(tmp, source.stdout, { mode: 0o600 });
			renameSync(tmp, file);
			chmodSync(file, 0o600);
		}
		return [file];
	} catch {
		return [];
	}
}
