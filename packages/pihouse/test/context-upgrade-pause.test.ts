import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extensions/context-upgrade.ts";

test("pressure with unavailable target is visibly paused without a model switch", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: { data: unknown }[] = [];
	const notices: string[] = [];
	extension({
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
		registerFlag() {},
		getFlag: () =>
			JSON.stringify({
				id: "p",
				provider: "p",
				source: "s",
				target: "t",
				account: "a",
				billing: "subscription",
				threshold: 0.8,
				headroom: 10,
			}),
		registerCommand() {},
		appendEntry: (_type: string, data: unknown) => entries.push({ data }),
	} as unknown as ExtensionAPI);
	const source = { provider: "p", id: "s", api: "a", input: ["text"], contextWindow: 100 };
	const target = { ...source, id: "t", contextWindow: 200 };
	const ctx = {
		model: source,
		getContextUsage: () => ({ tokens: 90, contextWindow: 100 }),
		modelRegistry: { find: () => target, getAvailable: () => [] },
		sessionManager: { getSessionId: () => "s", getEntries: () => [] },
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text) },
	};
	await handlers.get("turn_end")?.({}, ctx);
	assert.equal((entries[0]?.data as { status?: string })?.status, "paused");
	assert.match(notices[0] ?? "", /paused.*available/i);
});
