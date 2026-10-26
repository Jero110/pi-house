// The composed hub daemon: every adapter (src/adapters.ts) and both pane backends. ensureHub() in
// agent-link-core starts this file by default (it resolves "agent-link/hub"), and `agent-link hub` runs it in front.
import { join } from "node:path";
import { createCmuxBackend } from "agent-link-cmux";
import { agentLinkHome, type DaemonOptions, loadProfiles, PROFILES_DIR, runDaemon } from "agent-link-core";
import { createTmuxBackend } from "agent-link-tmux";
import { ADAPTERS } from "./adapters.ts";
import { mcpCommands } from "./commands.ts";

/** What the daemon runs with. Profiles: the shipped ones, then the user's own in <home>/profiles. */
export function hubOptions(home: string = agentLinkHome()): DaemonOptions & { home: string } {
	return {
		home,
		adapters: ADAPTERS,
		backends: { cmux: createCmuxBackend(), tmux: createTmuxBackend() },
		profiles: loadProfiles([PROFILES_DIR, join(home, "profiles")]),
		mcp: mcpCommands(),
	};
}

export function runHub(home?: string) {
	return runDaemon(hubOptions(home));
}

if (import.meta.main) await runHub();
