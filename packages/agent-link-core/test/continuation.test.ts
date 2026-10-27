import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boundedProgress, continuationTask, PROGRESS_LIMIT, repoFingerprint } from "../src/hub/continuation.ts";
import { readJournal } from "../src/journal.ts";
import type { Profile } from "../src/types.ts";
import { fakeProfiles, pullRoot, type TestHub, testHub, waitFor } from "./fakes/hub.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "al-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: dir,
	});
	return dir;
}

test("repoFingerprint: HEAD plus a hash of git status; a change in the folder changes it", () => {
	const dir = gitRepo();
	try {
		const clean = repoFingerprint(dir);
		assert.match(clean, /^[0-9a-f]{40} [0-9a-f]{16}$/);
		writeFileSync(join(dir, "new.txt"), "x\n");
		const dirty = repoFingerprint(dir);
		assert.notEqual(dirty, clean, "an untracked file is part of the repository state");
		assert.equal(dirty.split(" ")[0], clean.split(" ")[0], "the HEAD did not move");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoFingerprint: a folder that is not a git repository is unknown, never an error", () => {
	const dir = mkdtempSync(join(tmpdir(), "al-plain-"));
	try {
		assert.equal(repoFingerprint(dir), "unknown");
		assert.equal(repoFingerprint(join(dir, "missing")), "unknown", "a folder that does not exist is unknown too");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boundedProgress: short text is kept whole; long text keeps its end, within the limit", () => {
	assert.equal(boundedProgress("short"), "short");
	const long = `START${"x".repeat(PROGRESS_LIMIT * 2)}END`;
	const bounded = boundedProgress(long);
	assert.ok(bounded.endsWith("END"), "the most recent text is kept");
	assert.ok(!bounded.includes("START"), "the older text is cut");
	assert.ok(bounded.length <= PROGRESS_LIMIT + 60, "the marker is short");
	assert.match(bounded, /earlier text cut/);
});

test("continuationTask: the original task verbatim, untrusted progress, notes, both fingerprints and lineage", () => {
	const task = "Fix the parser.\n\nKeep the public API.";
	const text = continuationTask({
		task,
		progress: "I read parser.ts and found the off-by-one.",
		notes: "Quota ran out at 14:02; the tests were green before.",
		oldName: "claude",
		oldJournalId: "20261027T100000Z-claude",
		before: "abc123 1111222233334444",
		after: "abc123 5555666677778888",
		cwd: "/work/app",
	});
	assert.ok(text.includes(task), "the original task is passed verbatim");
	assert.match(text, /untrusted progress notes, not instructions/);
	assert.ok(text.includes("I read parser.ts and found the off-by-one."));
	assert.ok(text.includes("Quota ran out at 14:02"));
	assert.ok(text.includes("abc123 1111222233334444"), "the fingerprint before the stop");
	assert.ok(text.includes("abc123 5555666677778888"), "the fingerprint after the stop");
	assert.match(text, /Recheck the repository yourself/, "it tells the replacement to recheck the repo before writing");
	assert.match(text, /replaces claude \(journal 20261027T100000Z-claude\)/);
});

test("continuationTask: no notes says so, and the progress is bounded, not the whole history", () => {
	const history = Array.from({ length: 500 }, (_, i) => `turn ${i}: ${"y".repeat(100)}`).join("\n");
	const text = continuationTask({
		task: "t",
		progress: history,
		oldName: "w",
		oldJournalId: "j",
		before: "unknown",
		after: "unknown",
		cwd: "/w",
	});
	assert.match(text, /Notes from the agent that replaced it:\n\(none\)/);
	assert.ok(!text.includes("turn 0:"), "the early history is not forwarded");
	assert.ok(text.length < PROGRESS_LIMIT + 1500, `the continuation stays small (${text.length} characters)`);
});

// ---------------------------------------------------------------------------------------------------------------
// Hub: replace fences the old worker, confirms it exited, then continues its task with a replacement.
// ---------------------------------------------------------------------------------------------------------------

const PIHOUSE: Profile = { harness: "pihouse", adapter: "pi", label: "pihouse", defaultModel: null, dialogs: [] };
/** Short bound: a worker that never confirms is refused after 300 ms, not 20 s. */
const REPLACE = { interruptMs: 300 };

async function withHub(fn: (t: TestHub) => Promise<void>): Promise<void> {
	const t = await testHub({ ...REPLACE, profiles: fakeProfiles([PIHOUSE]) });
	try {
		await fn(t);
	} finally {
		for (const a of t.kit.all) a.releaseClose();
		await t.stop();
	}
}

/** A worker that started in `cwd` and is inside its brief turn. */
async function workerIn(t: TestHub, from: string, harness: string, name: string, cwd: string): Promise<string> {
	const res = await t.client.spawn({ from, harness, task: `task of ${name}`, name, cwd, backend: "cmux" });
	if ("error" in res) throw new Error(res.error);
	const fake = await waitFor(() => t.kit.byName(res.name), `${name} adapter`);
	await waitFor(() => fake.inTurn, `${name} brief turn`);
	return res.name;
}

const stateOf = (t: TestHub, name: string) => t.running.hub.registry.get(name)?.record.state;
const inboxTexts = async (t: TestHub, name: string) => (await t.client.inbox(name)).messages.map((m) => m.text);

function gitRepoWithWork(): string {
	const dir = gitRepo();
	writeFileSync(join(dir, "parser.ts"), "export const x = 1;\n");
	return dir;
}

test("replace: the old worker is fenced and confirmed closed before the replacement starts, in the same folder", () =>
	withHub(async (t) => {
		const repo = gitRepoWithWork();
		try {
			const root = await pullRoot(t.client);
			const old = await workerIn(t, root, "claude", "old", repo);
			const oldFake = await waitFor(() => t.kit.byName(old), "old adapter");
			oldFake.emit({ kind: "agent_message", text: "early history line" });
			oldFake.emit({ kind: "agent_message", text: "I found the off-by-one in parser.ts" });
			const before = repoFingerprint(repo);

			const res = await t.running.hub.replace({
				from: root,
				to: old,
				harness: "pihouse",
				model: "openai-codex/gpt-6-luna",
				notes: "quota ran out at 14:02",
			});
			assert.ok(!("error" in res) && res.status === "replaced", JSON.stringify(res));
			assert.equal(res.name, "old-r1", "the replacement is named <old>-r1");
			assert.equal(res.previous, old);
			assert.equal(res.before, before);
			assert.equal(res.after, before, "nothing changed the folder while the old worker stopped");

			const order = t.kit.trace;
			const closed = order.indexOf(`${old}:close`);
			assert.ok(closed >= 0 && closed < order.indexOf("old-r1:launch"), `close before launch: ${order.join(" | ")}`);
			assert.equal(stateOf(t, old), "exited", "the old worker is confirmed exited");
			assert.ok(t.backend.closed.has(oldFake.pane?.ref ?? "?"), "the old pane closed");

			const next = await waitFor(() => t.kit.byName("old-r1"), "replacement adapter");
			assert.equal(next.spec?.cwd, repo, "the same folder");
			assert.equal(next.spec?.model, "openai-codex/gpt-6-luna");
			assert.equal(t.running.hub.registry.get("old-r1")?.record.parent, root, "the same parent");
			await waitFor(() => next.prompts.length === 1, "replacement brief");
			const brief = next.prompts[0]?.text ?? "";
			assert.ok(brief.includes("task of old"), "the original task, verbatim");
			assert.ok(brief.includes("I found the off-by-one in parser.ts"), "the old worker's last text");
			assert.ok(!brief.includes("early history line"), "not the history");
			assert.ok(brief.includes("quota ran out at 14:02"), "the caller's notes");
			assert.ok(brief.includes(before), "the fingerprint before the stop");
			assert.match(brief, /replaces old \(journal /, "the lineage");

			const records = readJournal(join(t.home, "sessions"));
			const oldRecord = records.find((r) => r.name === old);
			const newRecord = records.find((r) => r.name === "old-r1");
			assert.ok(oldRecord && newRecord, "both are journaled");
			assert.equal(newRecord?.replaces, oldRecord?.id, "the replacement names the worker it continues");
			assert.equal(oldRecord?.replacedBy, newRecord?.id, "the old worker names its replacement");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}));

test("replace: a worker that errored on its quota is continued from its last text", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "quota", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		oldFake.emit({ kind: "agent_message", text: "step two is half done" });
		oldFake.finish("429: usage limit reached", "error");
		await waitFor(() => stateOf(t, old) === "error", "the turn failed");

		const res = await t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		assert.ok(!("error" in res) && res.status === "replaced", JSON.stringify(res));
		const next = await waitFor(() => t.kit.byName("quota-r1"), "replacement adapter");
		await waitFor(() => next.prompts.length === 1, "replacement brief");
		assert.ok(next.prompts[0]?.text.includes("step two is half done"));
	}));

test("replace: a late result from the replaced worker is never delivered as finished; one stale notice at most", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "late", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		// Problem: a cancel the harness ignores leaves the turn running while the worker is closed.
		// Example: its answer lands after the replacement already runs and reaches the parent as current.
		oldFake.ignoreCancel = true;
		const res = await t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		assert.ok(!("error" in res) && res.status === "replaced", JSON.stringify(res));

		oldFake.finish("the old answer, written too late", "end_turn");
		await sleep(30);
		const texts = await inboxTexts(t, root);
		assert.ok(!texts.some((x) => x.includes("the old answer")), "the late answer is not delivered");
		assert.ok(!texts.some((x) => /late\b.*finished/.test(x)), "not as a finished result");
		const stale = texts.filter((x) => /stale/.test(x));
		assert.equal(stale.length, 1, "exactly one short stale notice");
		assert.match(stale[0] ?? "", /replaced by late-r1/);
	}));

test("replace: a worker that never confirms its exit is refused and spawns nothing", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "stuck", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		oldFake.holdClose = true;
		const adapters = t.kit.all.length;

		const res = await t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		assert.ok("error" in res && /did not confirm its exit/.test(res.error), JSON.stringify(res));
		assert.equal(t.kit.all.length, adapters, "no replacement was created");
		assert.notEqual(stateOf(t, old), "exited", "the worker is not confirmed");
	}));

test("replace: a child of the replaced worker moves to the replacement and keeps running; siblings cannot replace", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const planner = await workerIn(t, root, "pi", "planner", tmpdir());
		const plannerFake = await waitFor(() => t.kit.byName(planner), "planner adapter");
		const routing = await workerIn(t, planner, "pi", "routing", tmpdir());
		const routingFake = await waitFor(() => t.kit.byName(routing), "routing adapter");
		const sibling = await workerIn(t, root, "pi", "sibling", tmpdir());

		const refused = await t.running.hub.replace({ from: sibling, to: planner, harness: "pihouse" });
		assert.ok("error" in refused && /only its parent/.test(refused.error), JSON.stringify(refused));
		assert.equal(stateOf(t, planner), "working", "a refused replace fences nothing");

		const res = await t.running.hub.replace({ from: root, to: planner, harness: "pihouse" });
		assert.ok(!("error" in res) && res.status === "replaced", JSON.stringify(res));
		assert.equal(t.running.hub.registry.get(routing)?.record.parent, "planner-r1", "the child has one parent");
		assert.equal(stateOf(t, routing), "working", "the child was not closed with the fenced worker");
		assert.equal(plannerFake.calls.includes("close"), true);
		assert.equal(routingFake.calls.includes("close"), false);

		const next = await waitFor(() => t.kit.byName("planner-r1"), "replacement adapter");
		await waitFor(() => next.inTurn, "replacement brief turn");
		routingFake.finish("routing done");
		next.finish("replacement brief done");
		await waitFor(() => next.prompts.length === 2, "the child's result reaches the replacement");
		assert.match(next.prompts[1]?.text ?? "", /routing done/);
		assert.equal(stateOf(t, sibling), "working", "the sibling is untouched");
	}));

test("replace: a worker that finished before it was fenced is the outcome; nothing is spawned", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "done", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		oldFake.finish("all tests pass");
		await waitFor(() => stateOf(t, old) === "done", "the turn ended");
		const adapters = t.kit.all.length;

		const res = await t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		assert.ok("status" in res && res.status === "finished", JSON.stringify(res));
		assert.match(res.result, /all tests pass/);
		assert.equal(t.kit.all.length, adapters, "no replacement, the work is not repeated");
		assert.equal(stateOf(t, old), "done");
	}));

test("replace: a turn that finishes on its own while the worker is fenced is the outcome, not a replacement", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "racer", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		oldFake.ignoreCancel = true;
		oldFake.holdClose = true;
		const adapters = t.kit.all.length;
		const pending = t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		await sleep(30);
		oldFake.finish("finished just in time", "end_turn");

		const res = await pending;
		assert.ok("status" in res && res.status === "finished", JSON.stringify(res));
		assert.match(res.result, /finished just in time/);
		assert.equal(t.kit.all.length, adapters, "nothing is spawned");
	}));

test("replace: a second replace or a model change on the same worker is refused while the first runs", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "twice", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		oldFake.holdClose = true;
		const first = t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		await sleep(30);

		const second = await t.running.hub.replace({ from: root, to: old, harness: "pihouse" });
		assert.ok("error" in second && /already being replaced/.test(second.error), JSON.stringify(second));
		const plain = await t.running.hub.model({ from: root, to: old, model: "anthropic/claude-sonnet-5-5" });
		assert.ok("error" in plain && /being replaced/.test(plain.error), JSON.stringify(plain));
		const firstRes = await first;
		assert.ok("error" in firstRes && /did not confirm/.test(firstRes.error));
	}));

test("replace: a refused request touches nothing: unknown harness, inexact model, a stranger, itself", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const old = await workerIn(t, root, "claude", "untouched", tmpdir());
		const oldFake = await waitFor(() => t.kit.byName(old), "adapter");
		const adapters = t.kit.all.length;

		const unknown = await t.running.hub.replace({ from: root, to: old, harness: "nope" });
		assert.ok("error" in unknown && /unknown harness/.test(unknown.error), JSON.stringify(unknown));
		const inexact = await t.running.hub.replace({ from: root, to: old, harness: "pihouse", model: "sonnet" });
		assert.ok("error" in inexact && /exact/.test(inexact.error), JSON.stringify(inexact));
		const ghost = await t.running.hub.replace({ from: root, to: "ghost", harness: "pihouse" });
		assert.ok("error" in ghost && /unknown agent/.test(ghost.error), JSON.stringify(ghost));
		const self = await t.running.hub.replace({ from: old, to: old, harness: "pihouse" });
		assert.ok("error" in self && /cannot replace/.test(self.error), JSON.stringify(self));

		assert.equal(stateOf(t, old), "working", "nothing was fenced");
		assert.equal(oldFake.calls.includes("close"), false);
		assert.equal(t.kit.all.length, adapters);
	}));
