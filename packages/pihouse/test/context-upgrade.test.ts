import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extensions/context-upgrade.ts";
import { EXTENSIONS } from "../src/paths.ts";
import { assess, type Profile, parseProfile } from "../src/workflow/context-upgrade.ts";

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

// Problem: a monitor that ships in every session must stay silent for a user who never opted in.
// Example: an ordinary session has no --context-upgrade-profile; a turn that reaches the context limit must not record
// a pending upgrade, notify, or ask the model anything.
// Solution: pihouse registers the extension in every session, and this test runs its handlers with a context whose
// model calls throw. Only the explicit profile flag turns monitoring on.
test("pihouse registers the context upgrade monitor in every session", () => {
	assert.ok(EXTENSIONS.some((e) => e.endsWith("extensions/context-upgrade.ts")));
});

test("an unconfigured session records nothing, notifies nothing and never calls the model", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: unknown[] = [];
	const notices: string[] = [];
	const registered: string[] = [];
	extension({
		on: (n: string, f: (event: unknown, ctx: unknown) => unknown) => handlers.set(n, f),
		registerFlag: (name: string) => registered.push(`flag:${name}`),
		getFlag: () => undefined,
		registerCommand: (name: string) => registered.push(`command:${name}`),
		appendEntry: (...args: unknown[]) => entries.push(args),
	} as unknown as ExtensionAPI);
	const modelCall = () => {
		throw new Error("an unconfigured session must not reach the model registry");
	};
	const ctx = {
		model: source,
		getContextUsage: () => usage,
		modelRegistry: { find: modelCall, getAvailable: modelCall },
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		hasUI: true,
		ui: { notify: (s: string) => notices.push(s) },
	};
	await handlers.get("turn_end")?.({}, ctx);
	await handlers.get("session_before_compact")?.({}, ctx);
	assert.deepEqual(entries, []);
	assert.deepEqual(notices, []);
	assert.deepEqual(registered, ["flag:context-upgrade-profile", "command:context-upgrade"]);
});

// The help text is what a user sees in pi's flag and command lists. Automatic switching is not implemented, and the
// text must say so, so nobody expects the monitor to switch models on its own.
test("the help text says the monitor only reports and that automatic switching is not implemented", () => {
	const descriptions: string[] = [];
	extension({
		on() {},
		registerFlag: (_name: string, options: { description?: string }) => descriptions.push(options.description ?? ""),
		getFlag: () => undefined,
		registerCommand: (_name: string, options: { description?: string }) => descriptions.push(options.description ?? ""),
		appendEntry() {},
	} as unknown as ExtensionAPI);
	assert.equal(descriptions.length, 2);
	for (const text of descriptions) assert.match(text, /no automatic switching/i);
	// The opt-in is spelled out: the flag name and an example, and nothing happens without it.
	assert.match(descriptions[0] ?? "", /pih --context-upgrade-profile '\{"id":"coding"/);
	assert.match(descriptions[0] ?? "", /Without it nothing is monitored/);
});

// The example in the help text is a real opt-in: it parses, so copying it turns monitoring on.
test("the example in the help text parses as a profile", () => {
	const flag = extensionFlagDescription();
	const json = /'(\{.*\})'/.exec(flag)?.[1];
	assert.ok(json, "the help shows the JSON in quotes");
	assert.ok(parseProfile(json), "the example is a valid profile");
});

function extensionFlagDescription(): string {
	let text = "";
	extension({
		on() {},
		registerFlag: (_name: string, options: { description?: string }) => {
			text = options.description ?? "";
		},
		getFlag: () => undefined,
		registerCommand() {},
		appendEntry() {},
	} as unknown as ExtensionAPI);
	return text;
}
