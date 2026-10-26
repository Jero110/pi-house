import assert from "node:assert/strict";
import { test } from "node:test";
import { createPasteAdapter, fillCommand, newLines } from "../src/adapters/paste.ts";
import type { AdapterDeps, LaunchSpec, PaneBackend, PaneHandle, Profile, SessionUpdate } from "../src/types.ts";

const OPTS = { quietMs: 40, pollMs: 5, connectTimeoutMs: 2000, startTimeoutMs: 300 };

function deps(): AdapterDeps & { logged: string[] } {
	const logged: string[] = [];
	return { logged, log: (kind) => logged.push(kind), guard: () => ({ action: "allow" }), depth: 1 };
}

/** A pane whose screen the test writes; it records pastes and keys. */
function fakePane() {
	const pane = {
		screen: "",
		open: true,
		events: [] as string[],
		/** Called after enter: lets a test script what the "harness" does. */
		onEnter: (_text: string) => {},
		lastPaste: "",
	};
	const backend: PaneBackend = {
		name: "tmux",
		open: async () => "%1",
		close: async () => {
			pane.open = false;
		},
		read: async () => {
			if (!pane.open) throw new Error("gone");
			return pane.screen;
		},
		keys: async (_ref, keys) => {
			pane.events.push(...keys.map((k) => `key:${k}`));
			if (keys.includes("enter")) pane.onEnter(pane.lastPaste);
		},
		paste: async (_ref, text) => {
			pane.events.push(`paste:${text}`);
			pane.lastPaste = text;
			pane.screen += `> ${text}\n`;
		},
		alive: async () => pane.open,
	};
	const handle: PaneHandle = { backend, ref: "%1" };
	return { pane, handle };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile: Profile = {
	harness: "aider",
	adapter: "paste",
	label: "Aider",
	defaultModel: "gpt-x",
	dialogs: [],
	command: ["aider", "--model", "{model}", "--root={cwd}"],
};

const spec = (p: Profile, model: string | null): LaunchSpec => ({
	name: "aider",
	parent: "root",
	model,
	cwd: "/work",
	runDir: "/run/aider",
	env: { AGENT_LINK_AGENT: "aider" },
	mcp: { command: "node", args: [] },
	profile: p,
});

test("launch fills {model} and {cwd}, falling back to the profile's model", async () => {
	const a = createPasteAdapter(deps(), OPTS);
	assert.deepEqual(await a.launch(spec(profile, "m1")), {
		argv: ["aider", "--model", "m1", "--root=/work"],
		env: { AGENT_LINK_AGENT: "aider" },
		cwd: "/work",
	});
	assert.deepEqual((await a.launch(spec(profile, null))).argv[2], "gpt-x");
	await assert.rejects(a.launch(spec({ ...profile, command: undefined }, null)), /no command/);
	assert.throws(() => fillCommand(["x", "{model}"], { model: null, cwd: "/" }), /no model/);
});

test("connect waits until the screen stops changing", async () => {
	const { pane, handle } = fakePane();
	const a = createPasteAdapter(deps(), OPTS);
	let ticks = 0;
	const drawing = setInterval(() => {
		pane.screen = `loading ${ticks++}\n`;
	}, 5);
	let connected = false;
	const c = a.connect(handle).then(() => {
		connected = true;
	});
	await sleep(100);
	assert.equal(connected, false);
	clearInterval(drawing);
	await c;
	assert.ok(a.idle());
	await a.close();
});

test("prompt pastes, presses enter, and resolves with the new lines once the screen is quiet", async () => {
	const { pane, handle } = fakePane();
	pane.screen = "Welcome\n> \n";
	pane.onEnter = (text) => {
		setTimeout(() => {
			pane.screen += "thinking...\n";
		}, 10);
		setTimeout(() => {
			pane.screen = pane.screen.replace("thinking...\n", `you said: ${text.toUpperCase()}\n`);
		}, 30);
	};
	const d = deps();
	const a = createPasteAdapter(d, OPTS);
	const updates: SessionUpdate[] = [];
	a.onUpdate((u) => updates.push(u));
	await a.connect(handle);
	const started = Date.now();
	const r = await a.prompt({ id: "1", from: "root", text: "hello\nworld" });
	assert.ok(Date.now() - started >= 30 + OPTS.quietMs - 5);
	assert.deepEqual(pane.events, ["paste:hello\nworld", "key:enter"]);
	// The echoed prompt and the line already on screen are not part of the answer.
	assert.deepEqual(r, { stopReason: "end_turn", text: "you said: HELLO\nWORLD" });
	assert.deepEqual(
		updates.map((u) => (u.kind === "state" ? u.state : u.kind)),
		["busy", "idle"],
	);
	assert.ok(a.idle());
	assert.ok(d.logged.includes("paste_turn_end"));
	await a.close();
});

test("idle is false while a prompt is in flight and while the screen moves", async () => {
	const { pane, handle } = fakePane();
	pane.screen = "ready\n";
	const a = createPasteAdapter(deps(), OPTS);
	await a.connect(handle);
	pane.onEnter = () => {
		pane.screen += "working\n";
	};
	const p = a.prompt({ id: "1", from: "root", text: "go" });
	await sleep(1);
	assert.equal(a.idle(), false);
	await p;
	pane.screen += "the user typed something\n";
	await sleep(15);
	assert.equal(a.idle(), false);
	await sleep(OPTS.quietMs + 20);
	assert.equal(a.idle(), true);
	await a.close();
});

test("cancel sends escape and resolves the prompt as cancelled", async () => {
	const { pane, handle } = fakePane();
	pane.screen = "ready\n";
	const a = createPasteAdapter(deps(), OPTS);
	await a.connect(handle);
	let n = 0;
	const spinner = setInterval(() => {
		pane.screen = `ready\nspinning ${n++}\n`;
	}, 5);
	const p = a.prompt({ id: "1", from: "root", text: "long task" });
	await sleep(30);
	await a.cancel();
	clearInterval(spinner);
	const r = await p;
	assert.equal(r.stopReason, "cancelled");
	assert.deepEqual(pane.events.slice(-1), ["key:escape"]);
	await a.close();
});

test("a screen that never changes after enter ends the prompt with an error", async () => {
	const { pane, handle } = fakePane();
	pane.screen = "frozen\n";
	const backend: PaneBackend = { ...handle.backend, paste: async () => {} };
	const d = deps();
	const a = createPasteAdapter(d, OPTS);
	await a.connect({ backend, ref: "%1" });
	const r = await a.prompt({ id: "1", from: "root", text: "anyone?" });
	assert.equal(r.stopReason, "error");
	assert.ok(d.logged.includes("paste_no_change"));
	assert.equal(pane.screen, "frozen\n");
	await a.close();
});

test("a pane that closes mid-turn ends the prompt with an error and reports exited", async () => {
	const { pane, handle } = fakePane();
	pane.screen = "ready\n";
	const a = createPasteAdapter(deps(), OPTS);
	const updates: SessionUpdate[] = [];
	a.onUpdate((u) => updates.push(u));
	await a.connect(handle);
	pane.onEnter = () => {
		pane.open = false;
	};
	const r = await a.prompt({ id: "1", from: "root", text: "bye" });
	assert.equal(r.stopReason, "error");
	assert.ok(updates.some((u) => u.kind === "exited"));
	assert.equal(a.idle(), false);
	await a.close();
});

test("connect fails at once when the pane closes during startup", async () => {
	const { pane, handle } = fakePane();
	pane.open = false;
	const started = Date.now();
	await assert.rejects(createPasteAdapter(deps(), OPTS).connect(handle), /pane closed/);
	assert.ok(Date.now() - started < OPTS.connectTimeoutMs);
});

test("connect needs a pane", async () => {
	await assert.rejects(createPasteAdapter(deps(), OPTS).connect(), /needs a pane/);
});

test("newLines keeps order, counts repeated lines and drops the prompt's own lines", () => {
	const before = "a\n}\nprompt\n";
	const after = "a\n}\nprompt\n> fix it\nnew 1\n}\nnew 2\n\n";
	assert.equal(newLines(before, after, "fix it"), "new 1\n}\nnew 2");
	assert.equal(newLines(before, after), "> fix it\nnew 1\n}\nnew 2");
	const shell = "sh$ for i in 1 2; do echo $i; done\n1\n2\nsh$ ok\n";
	assert.equal(newLines("", shell, "for i in 1 2; do echo $i; done\nok"), "1\n2\nsh$ ok");
});
