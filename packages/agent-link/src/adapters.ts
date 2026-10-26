// Every adapter the hub runs, by the name profiles give in "adapter". Adding a harness's adapter is one line.
import {
	type AdapterFactory,
	claudeAdapter,
	createCodexAdapter,
	createPiAdapter,
	opencodeAdapter,
	pasteAdapter,
} from "agent-link-core";

export const ADAPTERS: Record<string, AdapterFactory> = {
	claude: claudeAdapter,
	codex: (deps) => createCodexAdapter(deps),
	opencode: opencodeAdapter,
	paste: pasteAdapter,
	pi: (deps) => createPiAdapter(deps),
};
