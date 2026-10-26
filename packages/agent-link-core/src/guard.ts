// Bash guard by depth: the main session (depth 0) asks before risky commands,
// workers (AGENT_LINK_DEPTH >= 1) get a hard block. Everything else passes.

export type GuardVerdict = { action: "allow" } | { action: "ask" | "block"; reason: string };

const RISKY: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|(--recursive|-r)\s+(--force|-f)|(--force|-f)\s+(--recursive|-r))\b/,
		"rm -rf",
	],
	[/(^|[;&|]\s*)sudo\b/, "sudo"],
	[/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, "pipe a download into a shell"],
	[/\bgit\s+push\b/, "git push"],
	[/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
	[/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean -f"],
	[/\bterraform\s+destroy\b/, "terraform destroy"],
	[/\bmkfs(\.\w+)?\b/, "mkfs"],
	[/\bdd\b[^|;&]*\bof=\/dev\//, "dd to a device"],
	[/\bchmod\s+(-R\s+)?777\b/, "chmod 777"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
];

export function checkCommand(command: string, depth: number): GuardVerdict {
	for (const [pattern, label] of RISKY) {
		if (pattern.test(command)) {
			return depth >= 1
				? { action: "block", reason: `agent-link guard: "${label}" is blocked for workers` }
				: { action: "ask", reason: label };
		}
	}
	return { action: "allow" };
}

export function depthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const depth = Number.parseInt(env.AGENT_LINK_DEPTH ?? "0", 10);
	return Number.isFinite(depth) && depth > 0 ? depth : 0;
}
