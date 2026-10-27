import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import brand from "../src/extensions/brand.ts";
import { createTitleController } from "../src/extensions/title.ts";

test("brand uses a bounded isolated model decision after the ordinary turn", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const entries: { type: string; id: string; customType?: string; data?: unknown; name?: string }[] = [];
	let name: string | undefined;
	let request: unknown;
	const sessionManager = { getSessionId: () => "root", getEntries: () => entries, getBranch: () => entries };
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		getSessionName: () => name,
		setSessionName: (value: string) => {
			name = value;
			entries.push({ type: "session_info", id: String(entries.length), name });
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", id: String(entries.length), customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: "/work",
		sessionManager,
		ui: { setTitle: () => {} },
		modelRegistry: {
			find: () => ({ id: "gpt-6-luna", provider: "openai-codex" }),
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, context: unknown) => {
				request = context;
				return {
					result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Improving pi-house" }] }),
				};
			},
		},
	} as never;
	const depth = process.env.AGENT_LINK_DEPTH;
	process.env.AGENT_LINK_DEPTH = "0";
	brand(pi);
	if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
	else process.env.AGENT_LINK_DEPTH = depth;
	handlers.get("input")?.({ text: "plz improove the pi house experience", source: "interactive" } as never, ctx);
	handlers.get("agent_end")?.({} as never, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(name, "Improving pi-house");
	assert.ok(request);
});

test("a selector rename written by another session manager wins over a pending title", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-title-"));
	const depth = process.env.AGENT_LINK_DEPTH;
	process.env.AGENT_LINK_DEPTH = "0";
	try {
		const manager = SessionManager.create(dir, dir);
		const handlers = new Map<string, (event: never, ctx: never) => unknown>();
		let finish: (value: unknown) => void = () => {};
		const pi = {
			on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
			getSessionName: () => manager.getSessionName(),
			setSessionName: (name: string) => manager.appendSessionInfo(name),
			appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			cwd: dir,
			ui: { setTitle: () => {} },
			sessionManager: manager,
			modelRegistry: {
				find: () => ({}),
				hasConfiguredAuth: () => true,
				streamSimple: () => ({
					result: () =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				}),
			},
		} as never;
		brand(pi);
		handlers.get("input")?.({ text: "original task", source: "interactive" } as never, ctx);
		manager.appendMessage({ role: "user", content: "original task", timestamp: Date.now() });
		handlers.get("agent_end")?.({} as never, ctx);
		const path = manager.getSessionFile();
		assert.ok(path);
		SessionManager.open(path).appendSessionInfo("Selector name");
		finish({ stopReason: "stop", content: [{ type: "text", text: "Old result" }] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(SessionManager.open(path).getSessionName(), "Selector name");
	} finally {
		if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
		else process.env.AGENT_LINK_DEPTH = depth;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resume reconstructs automatic ownership from the active branch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-resume-title-"));
	const depth = process.env.AGENT_LINK_DEPTH;
	process.env.AGENT_LINK_DEPTH = "0";
	try {
		const original = SessionManager.create(dir, dir);
		const id = original.appendSessionInfo("Earlier topic");
		original.appendCustomEntry("pihouse.auto-title", { session: original.getSessionId(), nameEntry: id });
		original.appendMessage({ role: "user", content: "earlier topic", timestamp: Date.now() });
		const path = original.getSessionFile();
		assert.ok(path);
		const manager = SessionManager.open(path);
		const handlers = new Map<string, (event: never, ctx: never) => unknown>();
		const pi = {
			on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
			getSessionName: () => manager.getSessionName(),
			setSessionName: (name: string) => manager.appendSessionInfo(name),
			appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: false,
			cwd: dir,
			sessionManager: manager,
			modelRegistry: {
				find: () => ({}),
				hasConfiguredAuth: () => true,
				streamSimple: () => ({
					result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "New topic" }] }),
				}),
			},
		} as never;
		brand(pi);
		handlers.get("session_start")?.({ reason: "resume" } as never, ctx);
		handlers.get("input")?.({ text: "a different topic", source: "interactive" } as never, ctx);
		handlers.get("agent_end")?.({} as never, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.getSessionName(), "New topic");
	} finally {
		if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
		else process.env.AGENT_LINK_DEPTH = depth;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("semantic title generation can be opted out without a provider call", async () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const entries: { type: string; id: string; name?: string; customType?: string; data?: unknown }[] = [];
	let name: string | undefined;
	let calls = 0;
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		getSessionName: () => name,
		setSessionName: (value: string) => {
			name = value;
			entries.push({ type: "session_info", id: String(entries.length), name });
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", id: String(entries.length), customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: "/work",
		ui: { setTitle: () => {} },
		sessionManager: { getSessionId: () => "root", getEntries: () => entries, getBranch: () => entries },
		modelRegistry: {
			find: () => {
				calls++;
				return undefined;
			},
		},
	} as never;
	const depth = process.env.AGENT_LINK_DEPTH;
	const optout = process.env.PIHOUSE_AUTO_TITLE;
	process.env.AGENT_LINK_DEPTH = "0";
	process.env.PIHOUSE_AUTO_TITLE = "0";
	try {
		brand(pi);
		handlers.get("input")?.({ text: "improve this project", source: "interactive" } as never, ctx);
		handlers.get("agent_end")?.({} as never, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 0);
		assert.equal(name, "improve this project");
	} finally {
		if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
		else process.env.AGENT_LINK_DEPTH = depth;
		if (optout === undefined) delete process.env.PIHOUSE_AUTO_TITLE;
		else process.env.PIHOUSE_AUTO_TITLE = optout;
	}
});

test("worker lifecycle leaves its hub-assigned tab identity alone", () => {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	let writes = 0;
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		getSessionName: () => undefined,
		setSessionName: () => {
			writes++;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: "/work",
		ui: {
			setTitle: () => {
				writes++;
			},
		},
	} as never;
	const depth = process.env.AGENT_LINK_DEPTH;
	process.env.AGENT_LINK_DEPTH = "1";
	brand(pi);
	if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
	else process.env.AGENT_LINK_DEPTH = depth;
	handlers.get("agent_start")?.({} as never, ctx);
	handlers.get("input")?.({ text: "work on this task", source: "interactive" } as never, ctx);
	handlers.get("agent_end")?.({} as never, ctx);
	assert.equal(writes, 0);
});

test("brand preserves manual names and does not inherit automatic ownership across a fork", async () => {
	for (const session of ["original", "fork"]) {
		const handlers = new Map<string, (event: never, ctx: never) => unknown>();
		const entries = [
			{ type: "session_info", id: "name", name: "My name" },
			{
				type: "custom",
				id: "marker",
				customType: "pihouse.auto-title",
				data: { session: "original", nameEntry: session === "fork" ? "name" : "old-name" },
			},
		];
		let name = "My name";
		let calls = 0;
		const pi = {
			on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
			getSessionName: () => name,
			setSessionName: (value: string) => {
				name = value;
			},
			appendEntry: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			cwd: "/work",
			ui: { setTitle: () => {} },
			sessionManager: { getSessionId: () => session, getEntries: () => entries, getBranch: () => entries },
			modelRegistry: {
				find: () => {
					calls++;
					return undefined;
				},
			},
		} as never;
		const depth = process.env.AGENT_LINK_DEPTH;
		process.env.AGENT_LINK_DEPTH = "0";
		brand(pi);
		if (depth === undefined) delete process.env.AGENT_LINK_DEPTH;
		else process.env.AGENT_LINK_DEPTH = depth;
		handlers.get("input")?.({ text: "new request", source: "interactive" } as never, ctx);
		handlers.get("agent_end")?.({} as never, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(name, "My name");
		assert.equal(calls, 0);
	}
});

test("a registered root receives a semantic title, but a worker keeps its identity", async () => {
	let name: string | undefined;
	const controller = createTitleController({
		depth: 0,
		session: () => "root",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: async () => "Improving pi-house",
		now: () => 100_000,
	});
	controller.input("plz improove the pi house experience");
	await controller.settled();
	assert.equal(name, "Improving pi-house");
	const worker = createTitleController({
		depth: 1,
		session: () => "worker",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: async () => "Wrong",
		now: () => 100_000,
	});
	worker.input("another task");
	await worker.settled();
	assert.equal(name, "Improving pi-house");
});

test("a stale response cannot replace a manual name or newer input", async () => {
	let name: string | undefined;
	let resolve: (title: string) => void = () => {};
	const controller = createTitleController({
		depth: 0,
		session: () => "root",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: () =>
			new Promise((r) => {
				resolve = r;
			}),
		now: () => 100_000,
	});
	controller.input("first request");
	const pending = controller.settled();
	name = "My manual name";
	controller.input("newer request");
	resolve("Old topic");
	await pending;
	assert.equal(name, "My manual name");
});

test("an unchanged revision does not trigger another model call after the rate limit", async () => {
	let clock = 0;
	let calls = 0;
	let name: string | undefined;
	const controller = createTitleController({
		depth: 0,
		session: () => "root",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: async () => {
			calls++;
			return "One title";
		},
		now: () => clock,
	});
	controller.input("first topic");
	await controller.settled();
	clock = 120_000;
	await controller.settled();
	assert.equal(calls, 1);
});

test("jobs are rate limited and provenance protects inherited or manually renamed sessions", async () => {
	let name: string | undefined = "Inherited";
	let owns = false;
	let calls = 0;
	let clock = 100_000;
	const controller = createTitleController({
		depth: 0,
		session: () => "fork",
		current: () => name,
		owned: () => owns,
		set: (value) => {
			name = value;
		},
		generate: async () => {
			calls++;
			return "Semantic title";
		},
		now: () => clock,
	});
	controller.input("request");
	await controller.settled();
	assert.equal(calls, 0);
	owns = true;
	controller.input("request");
	await controller.settled();
	controller.input("another topic");
	clock += 1000;
	await controller.settled();
	assert.equal(calls, 1);
});
