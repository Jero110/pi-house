// How the agent-link MCP server starts, for each backend: node and the absolute path of the backend's entry.
//
// Problem: a bare `agent-link-cmux` works only where npm linked the bin onto PATH, and a harness or a pane may
// run with another PATH. Example: a Codex worker started from the hub daemon has the daemon's PATH, not the
// user's shell PATH. Solution: every registration uses this node and the resolved file, so it works wherever
// the repository is checked out, with no global install.
import { fileURLToPath } from "node:url";
import { type BackendName, stableNode } from "agent-link-core";

export interface McpCommand {
	command: string;
	args: string[];
}

export function mcpCommand(backend: BackendName): McpCommand {
	const entry =
		backend === "cmux" ? import.meta.resolve("agent-link-cmux/mcp") : import.meta.resolve("agent-link-tmux/mcp");
	return { command: stableNode(), args: [fileURLToPath(entry)] };
}

export function mcpCommands(): Record<BackendName, McpCommand> {
	return { cmux: mcpCommand("cmux"), tmux: mcpCommand("tmux") };
}

/**
 * The backend for this terminal: cmux when cmux runs it (CMUX_SOCKET_CAPABILITY or CMUX_BUNDLED_CLI_PATH,
 * which cmux sets in its terminals), else tmux.
 */
export function defaultBackend(env: NodeJS.ProcessEnv = process.env): BackendName {
	return env.CMUX_SOCKET_CAPABILITY || env.CMUX_BUNDLED_CLI_PATH ? "cmux" : "tmux";
}
