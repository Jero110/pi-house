// Claude Code PreToolUse hook on Bash and Read: `node claude-hook.ts <depth>` reads the hook JSON on stdin and applies
// the agent-link guard. The adapter puts the agent's depth in the command, so the hook needs no env.
//
// Problem: a worker could run a catastrophic command (git reset --hard, rm -rf) with nobody watching.
// Example: a worker told to "publish the branch" runs `git reset --hard`.
// Solution: workers (depth >= 1) get a deny with the guard's reason, which is what the model sees; the main
// session (depth 0) gets "ask", so Claude shows its own permission prompt and the session goes `waiting`. A worker
// is never asked: what a commit recovers (git reset --hard) simply passes for it.
// The Read tool is judged too, so a worker cannot read the project's .env.
// Anything else prints nothing and Claude's own permission settings rule.
import { checkCommand, checkRead, type GuardVerdict } from "../guard.ts";

interface HookInput {
	tool_name?: string;
	tool_input?: { command?: unknown; file_path?: unknown };
}

/** The hook's stdout for one call: empty to let Claude decide, else a PreToolUse decision. */
export function hookOutput(input: HookInput, depth: number): string {
	const verdict: GuardVerdict =
		input.tool_name === "Read"
			? checkRead(String(input.tool_input?.file_path ?? ""), depth)
			: checkCommand(String(input.tool_input?.command ?? ""), depth);
	if (verdict.action === "allow") return "";
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: verdict.action === "block" ? "deny" : "ask",
			permissionDecisionReason: verdict.reason,
		},
	});
}

if (import.meta.main) {
	const parsed = Number.parseInt(process.argv[2] ?? "", 10);
	// No depth or a bad one: treat it as a worker, the safe side.
	const depth = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
	let raw = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (d: string) => {
		raw += d;
	});
	process.stdin.on("end", () => {
		let input: HookInput = {};
		try {
			input = raw ? (JSON.parse(raw) as HookInput) : {};
		} catch {
			// Unreadable input: no command to judge, so nothing to deny.
		}
		process.stdout.write(hookOutput(input, depth));
	});
}
