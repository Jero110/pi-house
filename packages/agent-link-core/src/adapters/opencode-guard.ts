// opencode plugin: the agent-link bash guard for opencode workers.
//
// Problem: Claude workers block risky commands (git push, rm -rf...) through their PreToolUse hook, but an
// opencode worker ran whatever its own permission config allowed.
// Example: a worker asked to "publish the branch" runs `git push` and nothing stops it.
// Solution: the adapter lists this file under `plugin` in OPENCODE_CONFIG_CONTENT. opencode calls
// tool.execute.before for every tool call; throwing there cancels the call and the error text is
// what the model sees, exactly like the deny of Claude's PreToolUse hook.
//
// opencode runs every exported function of a plugin module as a plugin, so this module exports
// only the plugin. It runs inside opencode (Bun), which loads the .ts source.
import { checkCommand } from "../guard.ts";

/** The parts of opencode's hook arguments the guard reads (see opencode.ai/docs/plugins). */
interface ToolCall {
	tool: string;
}
interface ToolArgs {
	args?: { command?: unknown };
}

export async function AgentLinkGuard() {
	return {
		"tool.execute.before": async (input: ToolCall, output: ToolArgs): Promise<void> => {
			if (input.tool !== "bash") return;
			// The hub sets AGENT_LINK_DEPTH >= 1 on every worker (IDENTITY_ENV.depth). Depth 0 is the user's own
			// session: opencode's own permissions rule there.
			const depth = Number.parseInt(process.env.AGENT_LINK_DEPTH ?? "0", 10);
			if (!(depth >= 1)) return;
			const verdict = checkCommand(String(output.args?.command ?? ""), depth);
			if (verdict.action === "block") throw new Error(verdict.reason);
		},
	};
}
