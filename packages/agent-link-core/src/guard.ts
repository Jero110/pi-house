// Guard by depth, for Bash commands and for reading secret files. The main session (depth 0) asks before anything on
// the list. Workers (AGENT_LINK_DEPTH >= 1) are never asked anything, so nothing stops the executor to wait for an
// answer: they get a hard block on what cannot be undone, and what a commit recovers (git reset --hard, git clean -f)
// passes for them. Everything else passes too, git push and curl | sh included: a bad push is undone with a revert.

export type GuardVerdict = { action: "allow" } | { action: "ask" | "block"; reason: string };

/** "hard": workers are blocked. "main": only the main session asks; workers run it. */
type Level = "hard" | "main";

const RISKY: ReadonlyArray<readonly [RegExp, string, Level]> = [
	[
		/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|(--recursive|-r)\s+(--force|-f)|(--force|-f)\s+(--recursive|-r))\b/,
		"rm -rf",
		"hard",
	],
	[/(^|[;&|]\s*)sudo\b/, "sudo", "hard"],
	[/\bgit\s+reset\s+--hard\b/, "git reset --hard", "main"],
	[/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean -f", "main"],
	[/\bterraform\s+destroy\b/, "terraform destroy", "hard"],
	[/\bmkfs(\.\w+)?\b/, "mkfs", "hard"],
	[/\bdd\b[^|;&]*\bof=\/dev\//, "dd to a device", "hard"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb", "hard"],
	// Databases: what drops or empties data. SQL is matched in any case, whatever client runs it.
	[/\bdrop\s+(database|schema|table)\b/i, "DROP DATABASE/SCHEMA/TABLE", "hard"],
	[/\btruncate\s+(table\s+)?\w/i, "TRUNCATE", "hard"],
	[/\bdropdb\b/, "dropdb", "hard"],
	[/\b(flushall|flushdb)\b/i, "FLUSHALL/FLUSHDB", "hard"],
	// Problem: a command that names the project's .env hands its secrets to the model. Example: `cat .env`,
	// `source .env.local`, `grep KEY ./config/.env.production`. Solution: any command with a .env file as a word is
	// listed. `.env.example`, `.envrc` and `process.env` are not secrets and pass. This is a text match, not a sandbox.
	[/(^|[\s"'=<:/])\.env(?![\w-])(?!\.(?:example|sample|template|dist)\b)/, ".env file", "hard"],
];

function verdict(label: string, level: Level, depth: number): GuardVerdict {
	if (depth >= 1) {
		if (level === "hard") return { action: "block", reason: `agent-link guard: "${label}" is blocked for workers` };
		return { action: "allow" };
	}
	return { action: "ask", reason: label };
}

export function checkCommand(command: string, depth: number): GuardVerdict {
	for (const [pattern, label, level] of RISKY) {
		if (pattern.test(command)) return verdict(label, level, depth);
	}
	return { action: "allow" };
}

/** A .env file or one of its variants (.env.local, .env.production); templates such as .env.example are fine. */
const SECRET_FILE = /(^|[\\/])\.env(\.[\w.-]+)?$/;
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/;

/** The guard for a read tool (Claude Read, opencode read, pi read): the same .env rule as for Bash. */
export function checkRead(path: string, depth: number): GuardVerdict {
	if (SECRET_FILE.test(path) && !TEMPLATE_FILE.test(path)) return verdict(".env file", "hard", depth);
	return { action: "allow" };
}

export function depthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const depth = Number.parseInt(env.AGENT_LINK_DEPTH ?? "0", 10);
	return Number.isFinite(depth) && depth > 0 ? depth : 0;
}
