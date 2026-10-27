import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extensions/context-upgrade.ts";
import { assess, type Profile } from "../src/workflow/context-upgrade.ts";

const profile: Profile = {
	id: "coding",
	provider: "p",
	source: "small",
	target: "large",
	account: "subscription",
	billing: "subscription",
	threshold: 0.8,
	headroom: 100,
};
const source = { provider: "p", id: "small", api: "api", input: ["text"], contextWindow: 1000 };
const target = { provider: "p", id: "large", api: "api", input: ["text"], contextWindow: 2000 };
const usage = { tokens: 850, contextWindow: 1000 };

test("profile, usage, compatibility, availability and headroom all gate a pending upgrade", () => {
	const base = { profile, source, target, usage, available: true, attempted: false };
	assert.equal(assess(base).status, "pending");
	assert.equal(assess({ ...base, profile: undefined }).status, "disabled");
	for (const change of [
		{ usage: { ...usage, tokens: null } },
		{ usage: { ...usage, tokens: 200 } },
		{ target: { ...target, contextWindow: 1000 } },
		{ target: { ...target, api: "other" } },
		{ target: { ...target, input: [] } },
		{ available: false },
		{ attempted: true },
		{ profile: { ...profile, headroom: 1200 } },
		{ source: { ...source, id: "other" } },
	])
		assert.notEqual(assess({ ...base, ...change }).status, "pending");
});

test("monitoring is opt-in and manual apply rechecks idle and model after waiting", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
	const entries: { customType: string; data: unknown }[] = [];
	let flag: string | undefined = JSON.stringify(profile);
	let switches = 0;
	extension({
		on: (n: string, f: (event: unknown, ctx: unknown) => unknown) => handlers.set(n, f),
		registerFlag() {},
		getFlag: () => flag,
		registerCommand: (_n: string, o: { handler: typeof command }) => {
			command = o.handler;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		setModel: async () => {
			switches++;
			return true;
		},
	} as unknown as ExtensionAPI);
	let current = source;
	let idle = false;
	const notices: string[] = [];
	const ctx = {
		get model() {
			return current;
		},
		modelRegistry: { find: () => target, getAvailable: () => [target] },
		getContextUsage: () => usage,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		waitForIdle: async () => {
			idle = true;
			current = { ...source, id: "other" };
		},
		sessionManager: { getSessionId: () => "session", getEntries: () => entries.map((e) => ({ type: "custom", ...e })) },
		hasUI: true,
		ui: { notify: (s: string) => notices.push(s) },
	};
	flag = undefined;
	await handlers.get("turn_end")?.({}, ctx);
	assert.equal(entries.length, 0);
	flag = JSON.stringify(profile);
	await handlers.get("turn_end")?.({}, ctx);
	assert.equal(switches, 0);
	assert.equal(entries[0]?.customType, "context-upgrade");
	assert.match(notices[0] ?? "", /pending/i);
	await command("apply", ctx);
	assert.equal(switches, 0);
	assert.match(notices.at(-1) ?? "", /paused/i);
});

test("manual apply switches once and records the actual native result", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
	const entries: { customType: string; data: unknown }[] = [];
	let current = source;
	let calls = 0;
	extension({
		on: (n: string, f: (event: unknown, ctx: unknown) => unknown) => handlers.set(n, f),
		registerFlag() {},
		getFlag: () => JSON.stringify(profile),
		registerCommand: (_n: string, o: { handler: typeof command }) => {
			command = o.handler;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		setModel: async () => {
			calls++;
			current = target;
			return true;
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		get model() {
			return current;
		},
		modelRegistry: { find: () => target, getAvailable: () => [target] },
		getContextUsage: () => usage,
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		sessionManager: { getSessionId: () => "session", getEntries: () => entries.map((e) => ({ type: "custom", ...e })) },
		hasUI: true,
		ui: { notify() {} },
	};
	await handlers.get("turn_end")?.({}, ctx);
	await command("apply", ctx);
	assert.equal(calls, 1);
	assert.ok(entries.some((entry) => (entry.data as { status?: string }).status === "switched"));
	await command("apply", ctx);
	assert.equal(calls, 1);
});
