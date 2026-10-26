// The keeper: the digest engine against fake runs and a fake `complete`, and the extension against a fake pi.
// No model, no network, no real pi: every context a test builds is a temp dir.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	afterBoundary,
	BOUNDARY,
	isSummarizeWords,
	type KeeperDeps,
	keeperBootstrap,
	registerKeeper,
} from "../src/extensions/keeper.ts";
import type { Catalog } from "../src/workflow/catalog.ts";
import {
	applyProposal,
	BATCH_SIZE,
	type Complete,
	digestPending,
	mechanicalProposals,
	prune,
	readProposal,
} from "../src/workflow/digest.ts";
import { LIMITS, type MemoryStore, openMemory, type RunPackage } from "../src/workflow/memory.ts";

type AgentMessage = ContextEvent["messages"][number];
const DAY = 86_400_000;

/** A clock the test moves by hand; every read advances one second so ids and order stay distinct. */
function clock(start = Date.UTC(2026, 9, 1)) {
	let t = start;
	return {
		now: () => {
			t += 1000;
			return new Date(t);
		},
		jump: (ms: number) => {
			t += ms;
		},
	};
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-keeper-"));
	const c = clock();
	return { dir, c, store: openMemory(join(dir, "memory"), { now: c.now }) };
}

const catalog: Catalog = {
	groups: [],
	skills: [
		{ name: "executor", group: "build", author: "pihouse", source: "x", license: "MIT", summary: "" },
		{ name: "tdd", group: "build", author: "Addy", source: "x", license: "MIT", summary: "" },
		{ name: "debugging", group: "extras", author: "Addy", source: "x", license: "MIT", summary: "" },
		{ name: "grilling", group: "pre-build", author: "Matt", source: "x", license: "MIT", summary: "" },
	],
};

/** A captured run with one agent and `messages` messages of text; the transcript is the thing a digest reads. */
function addRun(
	store: MemoryStore,
	id: string,
	opts: { text?: string; messages?: number; skills?: string[]; transcript?: unknown } = {},
): void {
	const n = opts.messages ?? 2;
	const transcript = opts.transcript ?? {
		harness: "pihouse",
		sessionId: id,
		source: `/x/${id}.jsonl`,
		messages: Array.from({ length: n }, (_, i) => ({
			index: i,
			at: i,
			role: i % 2 === 0 ? "user" : "assistant",
			origin: "human",
			text: opts.text ?? `message ${i} of ${id}`,
			tools: i % 2 ? [{ name: "bash", ok: i % 4 !== 1 }] : [],
			skills: [],
		})),
	};
	const pkg: RunPackage = {
		schema: 1,
		id,
		project: "/p",
		projectSlug: "p",
		flaggedBy: "save",
		capturedAt: "2026-10-01T00:00:00.000Z",
		title: `run ${id}`,
		metrics: { newTokens: 0, cacheRead: 0, activeMs: 0, wallMs: 0, agents: 1, messages: n },
		agents: [
			{
				id: "a",
				name: "pihouse",
				parent: null,
				role: "root",
				harness: "pihouse",
				model: "m",
				assignedSkills: [],
				loadedSkills: opts.skills ?? [],
				usage: {},
				activeMs: 0,
				messages: n,
				transcript: "transcripts/a.json",
				raw: null,
				missing: null,
			},
		],
	};
	assert.equal(store.writeRun(pkg, [{ agentId: "a", normalized: transcript }], `# Report of ${id}\n`), "written");
}

/** A fake model: one digest per run, one consolidation per batch, every prompt recorded. */
function fakeModel(opts: { digest?: string; memory?: string; proposals?: unknown[] } = {}) {
	const calls: string[] = [];
	const state = { proposals: opts.proposals ?? [], memory: opts.memory ?? "# How the user works\n- tests first\n" };
	const complete: Complete = async (prompt) => {
		calls.push(prompt);
		if (prompt.includes("Consolidate this batch"))
			return `Here you go\n\`\`\`json\n${JSON.stringify({ memory: state.memory, summary: "Batch summary.", proposals: state.proposals })}\n\`\`\``;
		const id = /# Run (\S+?):/.exec(prompt)?.[1];
		return opts.digest ?? `summary: digest of ${id}\n\nWhat ran: ${id}. What worked: tests.`;
	};
	return { calls, state, complete };
}

const digestDeps = (f: ReturnType<typeof fixture>, complete: Complete) => ({
	store: f.store,
	complete,
	catalog,
	now: f.c.now,
});

test("a batch of 3 is digested once: 3 digests and 1 consolidation, then 0 pending", async () => {
	const f = fixture();
	for (const id of ["r1", "r2", "r3"]) addRun(f.store, id);
	assert.equal(f.store.pendingCount(), 3);
	const model = fakeModel();
	const r = await digestPending(digestDeps(f, model.complete));
	assert.ok(r);
	assert.equal(model.calls.length, 3 + 1);
	assert.deepEqual(r.runIds.sort(), ["r1", "r2", "r3"]);
	assert.equal(f.store.pendingCount(), 0);
	assert.equal(f.store.readDigest("r2")?.startsWith("summary: digest of r2"), true);
	assert.match(f.store.readWorkflowMemory(), /tests first/);
	// The raw copies were archived; the package stays in place for skill counts.
	assert.equal(existsSync(join(f.store.dir, "runs", "r1", "transcripts")), false);
	assert.equal(existsSync(join(f.store.dir, "archive", "raw", "r1", "transcripts", "a.json")), true);
	assert.equal(existsSync(join(f.store.dir, "runs", "r1", "run.json")), true);
	// Nothing is left to do: no second read.
	assert.equal(await digestPending(digestDeps(f, model.complete)), undefined);
	assert.equal(model.calls.length, 4);
});

test("a second batch reads only its own runs, never the transcripts of the first", async () => {
	const f = fixture();
	for (const id of ["a1", "a2"]) addRun(f.store, id, { text: "FIRST-BATCH-SECRET" });
	const first = fakeModel();
	await digestPending(digestDeps(f, first.complete));
	assert.ok(
		first.calls.some((p) => p.includes("FIRST-BATCH-SECRET")),
		"the first batch was read once",
	);

	addRun(f.store, "b1", { text: "second batch text" });
	const second = fakeModel();
	await digestPending(digestDeps(f, second.complete));
	assert.equal(second.calls.length, 2);
	assert.ok(second.calls.every((p) => !p.includes("FIRST-BATCH-SECRET")));
	assert.ok(second.calls[1]?.includes("digest of b1"), "the consolidation sees digests");
	assert.ok(second.calls[1]?.includes("tests first"), "and the memory the first batch wrote");
});

test("a batch is at most 10 runs and the summary says how many remain", async () => {
	const f = fixture();
	for (let i = 0; i < 12; i++) addRun(f.store, `r${i}`);
	const r = await digestPending(digestDeps(f, fakeModel().complete));
	assert.equal(r?.runIds.length, BATCH_SIZE);
	assert.equal(r?.remaining, 2);
	assert.match(r?.summary ?? "", /2 more runs are pending/);
	assert.equal(f.store.pendingCount(), 2);
});

test("a failed model call leaves the batch claimed and the next summarize resumes it without re-reading", async () => {
	const f = fixture();
	for (const id of ["r1", "r2", "r3"]) addRun(f.store, id);
	let n = 0;
	const flaky: Complete = async (prompt) => {
		if (!prompt.includes("Consolidate") && ++n === 2) throw new Error("model down");
		return fakeModel().complete(prompt);
	};
	await assert.rejects(digestPending(digestDeps(f, flaky)), /model down/);
	assert.equal(f.store.pendingCount(), 3, "nothing is processed");
	assert.equal(f.store.claimedBatches().length, 1);
	const model = fakeModel();
	const r = await digestPending(digestDeps(f, model.complete));
	assert.equal(r?.runIds.length, 3);
	assert.equal(model.calls.length, 2 + 1, "only the two runs without a digest, and the consolidation");
	assert.equal(f.store.pendingCount(), 0);
});

test("approve applies a memory rule and reject is remembered: the same proposal is dropped next time", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	const rule = { kind: "memory-rule", target: "(new)", change: "- prefers small commits", evidence: "r1 #3" };
	const noisy = { kind: "memory-rule", target: "(new)", change: "- hates emojis", evidence: "r1 #5" };
	const model = fakeModel({ proposals: [rule, noisy] });
	const r = await digestPending(digestDeps(f, model.complete));
	assert.equal(r?.proposals.length, 2);
	const [ruleId, noisyId] = r?.proposals.map((p) => p.id) ?? [];
	assert.ok(ruleId && noisyId);

	// Nothing is applied before the user decides.
	assert.doesNotMatch(f.store.readWorkflowMemory(), /small commits/);
	f.store.decide(ruleId, "approved");
	const p = readProposal(f.store, ruleId);
	assert.ok(p);
	assert.deepEqual(applyProposal(f.store, p), { applied: true, note: "workflow-memory.md updated" });
	assert.match(f.store.readWorkflowMemory(), /- prefers small commits/);
	assert.equal(readProposal(f.store, ruleId)?.status, "applied");

	f.store.decide(noisyId, "rejected", "too noisy");
	addRun(f.store, "r2");
	const again = await digestPending(digestDeps(f, model.complete));
	assert.deepEqual(
		again?.proposals.filter((x) => x.kind === "memory-rule"),
		[],
		"the rejected one is not made again",
	);
	assert.ok((again?.blocked ?? 0) >= 1);
	assert.doesNotMatch(f.store.readWorkflowMemory(), /hates emojis/);
});

test("applyProposal only applies approved proposals, and edits or drops an exact line", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	const model = fakeModel({
		memory: "# Memory\n- old rule\n- keep me\n",
		proposals: [{ kind: "memory-rule", target: "- old rule", change: "(drop)", evidence: "e" }],
	});
	const r = await digestPending(digestDeps(f, model.complete));
	const id = r?.proposals[0]?.id ?? "";
	const open = readProposal(f.store, id);
	assert.ok(open);
	assert.throws(() => applyProposal(f.store, open), /not approved/);
	f.store.decide(id, "approved");
	const ok = readProposal(f.store, id);
	assert.ok(ok);
	applyProposal(f.store, ok);
	assert.equal(f.store.readWorkflowMemory(), "# Memory\n- keep me\n");
});

test("a skill proposal is left to the model with an instruction; code does not edit skills", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	const model = fakeModel({ proposals: [{ kind: "edit-skill", target: "tdd", change: "Add a line", evidence: "e" }] });
	const r = await digestPending(digestDeps(f, model.complete));
	const id = r?.proposals[0]?.id ?? "";
	f.store.decide(id, "approved");
	const p = readProposal(f.store, id);
	assert.ok(p);
	const res = applyProposal(f.store, p);
	assert.equal(res.applied, false);
	assert.match("instruction" in res ? res.instruction : "", /Make the change in that skill's SKILL\.md/);
	assert.equal(readProposal(f.store, id)?.status, "approved", "marked applied only after the model did it");
});

test("remove-skill comes up for a skill none of the last 10 runs used, and not before 10 runs", async () => {
	const f = fixture();
	for (let i = 0; i < 9; i++) addRun(f.store, `r${i}`, { skills: ["debugging"] });
	const few = await digestPending(digestDeps(f, fakeModel().complete));
	assert.deepEqual(
		few?.proposals.filter((p) => p.kind === "remove-skill"),
		[],
		"9 runs are too few",
	);

	addRun(f.store, "r9", { skills: ["debugging"] });
	const ten = await digestPending(digestDeps(f, fakeModel().complete));
	const removals = ten?.proposals.filter((p) => p.kind === "remove-skill").map((p) => p.title);
	// tdd was never used. debugging was. executor and pre-build skills are not candidates.
	assert.deepEqual(removals, ["remove-skill: tdd"]);
});

test("remove-idea comes up for an idea nobody touched in the last 10 runs", async () => {
	const f = fixture();
	f.store.writeIdea({ id: "i1", title: "old idea", project: "/p", projectSlug: "p" }, "Try X");
	for (let i = 0; i < 10; i++) addRun(f.store, `r${i}`, { skills: ["tdd", "debugging"] });
	const r = await digestPending(digestDeps(f, fakeModel().complete));
	assert.deepEqual(
		r?.proposals.filter((p) => p.kind === "remove-idea").map((p) => p.title),
		["remove-idea: old idea"],
	);
});

test("pruning archives an entry unused for 90 days, and deletes nothing", () => {
	const f = fixture();
	const idea = f.store.writeIdea({ id: "i1", title: "old idea", project: "/p", projectSlug: "p" }, "Try X");
	f.c.jump(91 * DAY);
	f.store.writeIdea({ id: "i2", title: "new idea", project: "/p", projectSlug: "p" }, "Try Y");
	const r = prune({ store: f.store, catalog, now: f.c.now });
	assert.deepEqual(r.archived, [idea.id]);
	assert.equal(existsSync(join(f.store.dir, "archive", "ideas", "i1.md")), true, "moved, not deleted");
	assert.equal(existsSync(join(f.store.dir, "ideas", "i2.md")), true);
	assert.equal(f.store.readIndex().find((e) => e.id === idea.id)?.status, "archived");
	assert.deepEqual(r.proposed, [], "no delete proposal for it");
});

test("raw copies archived over 90 days ago get a delete-raw proposal that deletes only when approved", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	await digestPending(digestDeps(f, fakeModel().complete));
	const raw = join(f.store.dir, "archive", "raw", "r1");
	assert.equal(existsSync(raw), true);
	assert.deepEqual(mechanicalProposals(f.store, catalog, f.c.now()), [], "too early");

	f.c.jump(91 * DAY);
	const r = prune({ store: f.store, catalog, now: f.c.now });
	const del = r.proposed.find((p) => p.kind === "delete-raw");
	assert.ok(del);
	assert.equal(existsSync(raw), true, "proposed, not deleted");
	f.store.decide(del.id, "approved");
	const p = readProposal(f.store, del.id);
	assert.ok(p);
	applyProposal(f.store, p);
	assert.equal(existsSync(raw), false);
	assert.equal(
		existsSync(join(f.store.dir, "archive", "digests", "r1.md")),
		true,
		"the digest is archived, not deleted",
	);
	assert.equal(
		existsSync(join(f.store.dir, "archive", "runs", "r1", "run.json")),
		true,
		"the package is archived, not deleted",
	);
});

/** Files under a folder, with sizes. */
function bytesUnder(dir: string): number {
	let n = 0;
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, name.name);
		n += name.isDirectory() ? bytesUnder(p) : statSync(p).size;
	}
	return n;
}

test("the bootstrap, every digest input and every consolidation input stay under the limits with 1, 5 and 20 runs", async () => {
	// A 2 MB transcript: 4,000 messages of 500 chars.
	const big = {
		harness: "pihouse",
		sessionId: "big",
		source: "/x/big.jsonl",
		messages: Array.from({ length: 4000 }, (_, i) => ({
			index: i,
			at: i,
			role: i % 2 === 0 ? "user" : "assistant",
			origin: "human",
			text: `${i} ${"lorem ipsum ".repeat(60)}`,
			tools: [{ name: "bash", ok: true }],
			skills: [],
		})),
	};
	for (const total of [1, 5, 20]) {
		const f = fixture();
		for (let i = 0; i < total; i++) addRun(f.store, `r${i}`, { transcript: big });
		assert.ok(bytesUnder(join(f.store.dir, "runs")) >= total * 2_000_000, "the runs really are about 2 MB each");
		const model = fakeModel({
			digest: `summary: s\n${"d".repeat(1900)}`,
			memory: `# Memory\n${"- a rule of the user\n".repeat(380)}`.slice(0, LIMITS.workflowMemory),
		});
		while (await digestPending(digestDeps(f, model.complete))) {
			assert.ok(keeperBootstrap(f.store).length <= LIMITS.keeperBootstrap);
		}
		assert.equal(f.store.pendingCount(), 0);
		for (const p of model.calls) {
			const limit = p.includes("Consolidate this batch") ? LIMITS.consolidationInput : LIMITS.digestInput;
			assert.ok(p.length <= limit, `${total} runs: a prompt of ${p.length} chars is over ${limit}`);
		}
		const boot = keeperBootstrap(f.store);
		assert.ok(boot.length <= LIMITS.keeperBootstrap, `${total} runs: bootstrap ${boot.length}`);
		assert.match(boot, /0 runs pending/);
		// One digest prompt per run plus one consolidation per batch of at most 10.
		assert.equal(model.calls.length, total + Math.ceil(total / BATCH_SIZE));
	}
});

// ---- the extension, against a fake pi ----

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const sentUser: Array<{ text: string; options: unknown }> = [];
	const names: string[] = [];
	const pi = {
		on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, o.handler),
		sendUserMessage: async (text: string, options: unknown) => {
			sentUser.push({ text, options });
		},
		sendMessage: () => {},
		setSessionName: (n: string) => names.push(n),
	};
	const fire = (event: string, payload: unknown, ctx: unknown) => handlers.get(event)?.map((h) => h(payload, ctx));
	return { pi: pi as unknown as ExtensionAPI, handlers, commands, sentUser, names, fire };
}

function keeperOf(
	f: ReturnType<typeof fixture>,
	model: ReturnType<typeof fakeModel>,
	env: NodeJS.ProcessEnv = { PIHOUSE_KEEPER: "1" },
) {
	const fp = fakePi();
	const deps: KeeperDeps = {
		env,
		store: () => f.store,
		records: () => [],
		catalog: () => catalog,
		complete: () => model.complete,
		now: f.c.now,
	};
	registerKeeper(fp.pi, deps);
	const notes: string[] = [];
	const status: Record<string, string | undefined> = {};
	const sent: Array<{ customType: string; content: string; display: boolean }> = [];
	const ui = {
		notify: (m: string) => notes.push(m),
		setStatus: (k: string, v: string | undefined) => {
			status[k] = v;
		},
	};
	const rctx = {
		ui,
		model: {},
		modelRegistry: {},
		sendMessage: async (m: { customType: string; content: string; display: boolean }) => {
			sent.push(m);
		},
	};
	const ctx = {
		ui,
		model: {},
		modelRegistry: {},
		isIdle: () => true,
		waitForIdle: async () => {},
		newSession: async (o?: { withSession?: (c: unknown) => Promise<void> }) => {
			await o?.withSession?.(rctx);
			return { cancelled: false };
		},
	};
	return { ...fp, notes, status, sent, ctx };
}

test("the extension does nothing unless PIHOUSE_KEEPER=1", () => {
	const f = fixture();
	const k = keeperOf(f, fakeModel(), {});
	assert.equal(k.handlers.size, 0);
	assert.equal(k.commands.size, 0);
});

test("on start the keeper says how many runs are pending", () => {
	const f = fixture();
	for (const id of ["r1", "r2", "r3"]) addRun(f.store, id);
	const k = keeperOf(f, fakeModel());
	k.fire("session_start", { reason: "startup" }, k.ctx);
	assert.equal(k.status.keeper, "3 runs pending");
	assert.match(k.notes[0] ?? "", /3 runs pending/);
});

test("/keeper summarize digests in a fresh session, shows summary and proposals, then writes a boundary", async () => {
	const f = fixture();
	for (const id of ["r1", "r2", "r3"]) addRun(f.store, id);
	const model = fakeModel({ proposals: [{ kind: "memory-rule", target: "(new)", change: "- a rule", evidence: "e" }] });
	const k = keeperOf(f, model);
	await k.commands.get("keeper")?.("summarize", k.ctx);
	assert.equal(model.calls.length, 4);
	assert.equal(k.sent.length, 2);
	assert.equal(k.sent[0]?.display, true);
	assert.match(k.sent[0]?.content ?? "", /3 runs digested/);
	assert.match(k.sent[0]?.content ?? "", /memory-rule: - a rule/);
	assert.equal(k.sent[1]?.customType, BOUNDARY);
	assert.equal(k.sent[1]?.display, false);
	assert.equal(k.status.keeper, "0 runs pending");
});

test("/keeper approve and reject work by id prefix and the rejection sticks", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	const model = fakeModel({
		proposals: [
			{ kind: "memory-rule", target: "(new)", change: "- keep", evidence: "e" },
			{ kind: "memory-rule", target: "(new)", change: "- drop", evidence: "e" },
		],
	});
	const k = keeperOf(f, model);
	await k.commands.get("keeper")?.("summarize", k.ctx);
	const open = f.store.readIndex().filter((e) => e.kind === "proposal");
	assert.equal(open.length, 2);
	const [keep, drop] = open.map((e) => e.id.slice("proposal:".length));
	await k.commands.get("keeper")?.(`approve ${keep}`, k.ctx);
	await k.commands.get("keeper")?.(`reject ${drop} not for me`, k.ctx);
	assert.match(f.store.readWorkflowMemory(), /- keep/);
	assert.doesNotMatch(f.store.readWorkflowMemory(), /- drop/);
	assert.equal(readProposal(f.store, keep ?? "")?.status, "applied");
	assert.equal(readProposal(f.store, drop ?? "")?.status, "rejected");
	assert.equal(
		f.store.propose({ kind: "memory-rule", target: "(new)", change: "- DROP", evidence: "" }).result,
		"rejected-before",
	);
	await k.commands.get("keeper")?.("approve zzz", k.ctx);
	assert.match(k.notes.at(-1) ?? "", /no unique proposal/);
});

test("the context handler drops the messages before the last boundary", () => {
	const f = fixture();
	const k = keeperOf(f, fakeModel());
	const msg = (text: string, t: number): AgentMessage => ({ role: "user", content: text, timestamp: t });
	const boundary = (t: number): AgentMessage => ({
		role: "custom",
		customType: BOUNDARY,
		content: "Job done",
		display: false,
		timestamp: t,
	});
	const messages = [msg("old 1", 1), boundary(2), msg("middle", 3), boundary(4), msg("new 1", 5), msg("new 2", 6)];
	const out = k.fire("context", { messages }, k.ctx)?.[0] as { messages: AgentMessage[] };
	assert.deepEqual(
		out.messages.map((m) => (m.role === "user" ? m.content : "?")),
		["new 1", "new 2"],
	);
	// With no boundary yet, everything goes through.
	assert.equal(afterBoundary(messages.slice(0, 1)).length, 1);
	assert.equal(afterBoundary(messages.slice(0, 2)).length, 0, "a boundary last leaves nothing before it");
});

test("before each request the model gets the bootstrap, and it does not grow with the conversation", () => {
	const f = fixture();
	addRun(f.store, "r1");
	const k = keeperOf(f, fakeModel());
	const out = k.fire("before_agent_start", { systemPrompt: "BASE", messageType: "user", prompt: "hi" }, k.ctx)?.[0] as {
		systemPrompt: string;
	};
	assert.ok(out.systemPrompt.startsWith("BASE\n\n"));
	assert.match(out.systemPrompt, /1 run pending/);
	assert.ok(out.systemPrompt.length - 6 <= LIMITS.keeperBootstrap);
});

test('plain words ("summarize them", "digest") run the digest through the command; other text goes through', async () => {
	assert.equal(isSummarizeWords("summarize"), true);
	assert.equal(isSummarizeWords("Summarize them."), true);
	assert.equal(isSummarizeWords("digest"), true);
	assert.equal(isSummarizeWords("summarize the docs for me"), false);
	assert.equal(isSummarizeWords("what did you digest?"), false);

	const f = fixture();
	addRun(f.store, "r1");
	const k = keeperOf(f, fakeModel());
	const handled = k.fire("input", { text: "summarize them", source: "interactive" }, k.ctx)?.[0];
	assert.deepEqual(handled, { action: "handled" });
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(k.sentUser, [{ text: "/keeper summarize", options: { expandPromptTemplates: true } }]);
	// What the extension sent back is the command: it digests and rotates like the typed one.
	await k.commands.get("keeper")?.("summarize", k.ctx);
	assert.equal(f.store.pendingCount(), 0);

	assert.deepEqual(k.fire("input", { text: "what is pending?", source: "interactive" }, k.ctx)?.[0], {
		action: "continue",
	});
	assert.deepEqual(k.fire("input", { text: "summarize", source: "extension" }, k.ctx)?.[0], { action: "continue" });
	assert.equal(k.sentUser.length, 1);
});

test("/keeper with no argument shows the pending count and the open proposals; code only, no model", async () => {
	const f = fixture();
	addRun(f.store, "r1");
	const model = fakeModel();
	const k = keeperOf(f, model);
	await k.commands.get("keeper")?.("", k.ctx);
	assert.match(k.notes[0] ?? "", /1 run pending\nNo open proposals\./);
	assert.equal(model.calls.length, 0);
});
