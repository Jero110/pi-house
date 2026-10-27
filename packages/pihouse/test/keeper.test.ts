// The digest engine of the retired keeper (digest.ts) against fake runs and a fake `complete`: the memory pipeline
// that the migration still reads. The keeper's extension and its commands are gone; their tests went with them.
// No model, no network, no real pi: every context a test builds is a temp dir.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("every digest input and every consolidation input stay under the limits with 1, 5 and 20 runs", async () => {
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
		while (await digestPending(digestDeps(f, model.complete)));
		assert.equal(f.store.pendingCount(), 0);
		for (const p of model.calls) {
			const limit = p.includes("Consolidate this batch") ? LIMITS.consolidationInput : LIMITS.digestInput;
			assert.ok(p.length <= limit, `${total} runs: a prompt of ${p.length} chars is over ${limit}`);
		}
		// One digest prompt per run plus one consolidation per batch of at most 10.
		assert.equal(model.calls.length, total + Math.ceil(total / BATCH_SIZE));
	}
});
