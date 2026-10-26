import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pihousePaths } from "../src/paths.ts";
import {
	LIMITS,
	type MemoryStore,
	openMemory,
	type Proposal,
	parseFrontmatter,
	type RunAgentEntry,
	type RunPackage,
} from "../src/workflow/memory.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-26T12:00:00Z");

function fixture(): { store: MemoryStore; dir: string; clock: { t: number } } {
	const home = mkdtempSync(join(tmpdir(), "pihouse-memory-"));
	const dir = pihousePaths({ PIHOUSE_HOME: home }, home).memory;
	const clock = { t: T0 };
	return { store: openMemory(dir, { now: () => new Date(clock.t) }), dir, clock };
}

function agent(id: string, skills: string[] = []): RunAgentEntry {
	return {
		id,
		name: id,
		parent: null,
		role: "root",
		harness: "pihouse",
		model: "m",
		assignedSkills: skills,
		loadedSkills: [],
		usage: {},
		activeMs: 1,
		messages: 2,
		transcript: `transcripts/${id}.json`,
		raw: `transcripts/${id}.jsonl`,
		missing: null,
	};
}

function run(id: string, skills: string[] = [], project = "/abs/pi-house"): RunPackage {
	return {
		schema: 1,
		id,
		project,
		projectSlug: "pi-house",
		flaggedBy: "save",
		reason: "liked it",
		capturedAt: new Date(T0).toISOString(),
		title: `Run ${id}`,
		metrics: { newTokens: 1, cacheRead: 0, activeMs: 1, wallMs: 1, agents: 1, messages: 2 },
		agents: [agent("a1", skills)],
	};
}

const transcripts = [{ agentId: "a1", normalized: { messages: ["SECRET TRANSCRIPT"] }, raw: '{"m":"SECRET"}\n' }];
const proposal: Proposal = {
	kind: "memory-rule",
	target: "workflow-memory.md",
	change: "Always  split tasks\nbefore coding",
	evidence: "runs 1 and 2",
};

test("paths: memory lives under the pihouse home", () => {
	assert.equal(pihousePaths({ PIHOUSE_HOME: "/x" }, "/h").memory, "/x/memory");
	assert.equal(pihousePaths({}, "/h").memory, "/h/.pihouse/memory");
});

test("writeRun writes the package, transcripts and a pending entry; recapturing a pending run replaces it", () => {
	const { store, dir } = fixture();
	assert.equal(store.writeRun(run("r1"), transcripts, "# report"), "written");
	for (const f of ["run.json", "report.md", "transcripts/a1.json", "transcripts/a1.jsonl"]) {
		assert.ok(existsSync(join(dir, "runs/r1", f)), f);
	}
	assert.equal(JSON.parse(readFileSync(join(dir, "runs/r1/run.json"), "utf8")).id, "r1");
	assert.equal(store.pendingCount(), 1);
	const again = { ...run("r1"), title: "Newer" };
	assert.equal(store.writeRun(again, [{ agentId: "a1", normalized: {} }]), "written");
	assert.equal(store.pendingCount(), 1);
	assert.equal(store.pending()[0].title, "Newer");
	assert.ok(!existsSync(join(dir, "runs/r1/transcripts/a1.jsonl")), "old files are replaced, not merged");
	assert.deepEqual(readdirSync(join(dir, "runs/r1/transcripts")), ["a1.json"]);
});

test("writeRun rejects an id that would leave the memory dir", () => {
	const { store } = fixture();
	assert.throws(() => store.writeRun(run("../evil"), []), /Unsafe/);
});

test("pending lists oldest first and a processed run never comes back, even when captured again", () => {
	const { store, clock } = fixture();
	store.writeRun(run("r1"), transcripts);
	clock.t += 1000;
	store.writeRun(run("r2"), transcripts);
	assert.deepEqual(
		store.pending().map((e) => e.id),
		["run:r1", "run:r2"],
	);
	store.markProcessed(["r1"], "b1");
	assert.deepEqual(
		store.pending().map((e) => e.id),
		["run:r2"],
	);
	assert.equal(store.writeRun(run("r1"), transcripts), "processed");
	assert.equal(store.pendingCount(), 1);
	assert.ok(store.readIndex().find((e) => e.id === "run:r1")?.status === "processed");
	store.markProcessed(["r2", "nope"], "b1");
	assert.equal(store.pendingCount(), 0);
});

test("digests are written, read back, capped and indexed", () => {
	const { store } = fixture();
	store.writeRun(run("r1"), transcripts);
	store.writeDigest("r1", "---\nsummary: split first\n---\n\nBody");
	assert.match(store.readDigest("r1") ?? "", /Body/);
	assert.equal(store.readDigest("zzz"), null);
	const entry = store.readIndex().find((e) => e.id === "digest:r1");
	assert.equal(entry?.summary, "split first");
	assert.equal(entry?.project, "/abs/pi-house");
	assert.throws(() => store.writeDigest("r1", "x".repeat(LIMITS.digest + 1)), RangeError);
});

test("claimBatch is idempotent and never claims a run twice; finishBatch writes the summary", () => {
	const { store, dir } = fixture();
	for (const id of ["r1", "r2", "r3"]) store.writeRun(run(id), transcripts);
	const b = store.claimBatch(["r1", "r2"]);
	assert.ok(b);
	assert.equal(store.claimBatch(["r2", "r1"])?.id, b.id);
	const second = store.claimBatch(["r1", "r2", "r3"]);
	assert.deepEqual(second?.runIds, ["r3"]);
	assert.equal(store.claimBatch(["r1", "r3"]), null);
	assert.equal(store.claimedBatches().length, 2);
	const done = store.finishBatch(b.id, "Two runs digested");
	assert.equal(done.state, "done");
	assert.equal(readFileSync(join(dir, `batches/${b.id}.md`), "utf8"), "Two runs digested");
	assert.equal(store.claimedBatches().length, 1);
	assert.ok(store.readIndex().some((e) => e.id === `batch:${b.id}`));
	store.markProcessed(b.runIds, b.id);
	assert.equal(store.claimBatch(b.runIds), null, "processed runs are not claimable");
});

test("consulted sources and ideas are written with frontmatter and indexed", () => {
	const { store, dir } = fixture();
	const meta = { id: "yt-1", title: "A talk", project: "/abs/p", projectSlug: "p", source: "https://youtu.be/x" };
	store.writeConsulted(meta, "full transcript text", "short summary");
	assert.equal(readFileSync(join(dir, "consulted/yt-1.txt"), "utf8"), "full transcript text");
	const md = parseFrontmatter(readFileSync(join(dir, "consulted/yt-1.md"), "utf8"));
	assert.equal(md.fields.source, "https://youtu.be/x");
	assert.match(md.body, /## Summary\n\nshort summary/);
	store.writeIdea({ id: "i1", title: "Idea", project: "/abs/p", projectSlug: "p" }, "Do the thing");
	assert.equal(parseFrontmatter(readFileSync(join(dir, "ideas/i1.md"), "utf8")).body.trim(), "Do the thing");
	assert.deepEqual(
		store.readIndex().map((e) => e.id),
		["consulted:yt-1", "idea:i1"],
	);
});

test("propose: fingerprint ignores case and spacing, duplicates are caught, a rejection is remembered", () => {
	const { store, dir } = fixture();
	const first = store.propose(proposal);
	assert.equal(first.result, "created");
	if (first.result !== "created") return;
	assert.equal(first.fingerprint.length, 64);
	const dup = store.propose({ ...proposal, change: "always split TASKS before   coding" });
	assert.equal(dup.result, "duplicate");
	assert.equal(dup.fingerprint, first.fingerprint);
	const fm = parseFrontmatter(readFileSync(join(dir, `proposals/${first.id}.md`), "utf8"));
	assert.equal(fm.fields.status, "open");
	assert.equal(fm.fields.kind, "memory-rule");
	assert.equal(fm.fields.fingerprint, first.fingerprint);
	assert.match(fm.body, /Always {2}split tasks\nbefore coding/);

	store.decide(first.id, "rejected", "not for me");
	assert.equal(parseFrontmatter(readFileSync(join(dir, `proposals/${first.id}.md`), "utf8")).fields.status, "rejected");
	assert.equal(store.propose(proposal).result, "rejected-before");
	assert.equal(store.propose({ ...proposal, change: "A different rule" }).result, "created");
});

test("a rejected proposal stays blocked after it is archived", () => {
	const { store } = fixture();
	const p = store.propose(proposal);
	if (p.result !== "created") throw new Error("expected created");
	store.decide(`proposal:${p.id}`, "rejected");
	store.archive(`proposal:${p.id}`);
	assert.equal(store.readIndex()[0].status, "archived");
	assert.equal(store.propose(proposal).result, "rejected-before");
});

test("approve then apply: status moves and an approved proposal is not proposed again", () => {
	const { store } = fixture();
	const p = store.propose(proposal);
	if (p.result !== "created") throw new Error("expected created");
	assert.equal(store.decide(p.id, "approved").status, "approved");
	assert.equal(store.propose(proposal).result, "duplicate");
	assert.equal(store.markApplied(p.id).status, "applied");
	assert.throws(() => store.decide("nope", "approved"), /No memory entry/);
});

test("workflow memory: empty at first, written, capped", () => {
	const { store } = fixture();
	assert.equal(store.readWorkflowMemory(), "");
	store.writeWorkflowMemory("- split tasks");
	assert.equal(store.readWorkflowMemory(), "- split tasks");
	assert.throws(() => store.writeWorkflowMemory("x".repeat(LIMITS.workflowMemory + 1)), RangeError);
	assert.equal(store.readWorkflowMemory(), "- split tasks");
});

test("indexSlice reads only the index, filters, orders newest first and never exceeds maxChars", () => {
	const { store, dir, clock } = fixture();
	for (let i = 1; i <= 5; i++) {
		clock.t += 1000;
		store.writeRun(run(`r${i}`, [], i % 2 ? "/abs/a" : "/abs/b"), transcripts);
	}
	// Problem: ask must not load transcripts. Example: a 2 MB transcript read for a one-line slice.
	// Solution: the test makes every transcript unreadable; a slice that opened one would throw.
	for (let i = 1; i <= 5; i++) {
		chmodSync(join(dir, `runs/r${i}/transcripts/a1.json`), 0o000);
		chmodSync(join(dir, `runs/r${i}/transcripts/a1.jsonl`), 0o000);
	}
	const all = store.indexSlice({ limit: 10, maxChars: 10_000 }).split("\n");
	assert.equal(all.length, 5);
	assert.ok(all[0].startsWith("run:r5 · run · pi-house · Run r5 · "));
	assert.equal(store.indexSlice({ limit: 2, maxChars: 10_000 }).split("\n").length, 2);
	assert.equal(store.indexSlice({ project: "/abs/a", limit: 10, maxChars: 10_000 }).split("\n").length, 3);
	assert.equal(store.indexSlice({ kinds: ["idea"], limit: 10, maxChars: 10_000 }), "");
	for (const max of [0, 10, 100, 130, 200]) {
		assert.ok(store.indexSlice({ limit: 10, maxChars: max }).length <= max, `max ${max}`);
	}
	for (let i = 1; i <= 5; i++) {
		chmodSync(join(dir, `runs/r${i}/transcripts/a1.json`), 0o600);
		chmodSync(join(dir, `runs/r${i}/transcripts/a1.jsonl`), 0o600);
	}
});

test("touch sets lastUsedAt and keeps an entry from going stale", () => {
	const { store, clock } = fixture();
	store.writeDigest("r1", "digest");
	store.writeDigest("r2", "digest");
	clock.t += 80 * DAY;
	store.touch(["digest:r1"]);
	clock.t += 20 * DAY;
	assert.deepEqual(store.archiveStale({ days: 90 }), ["digest:r2"]);
});

test("archiveStale archives an entry unused for 91 days, keeps it on disk and spares pending work", () => {
	const { store, dir, clock } = fixture();
	store.writeRun(run("r1"), transcripts);
	store.writeRun(run("r2"), transcripts);
	store.markProcessed(["r1"], "b1");
	store.writeConsulted({ id: "c1", title: "t", project: "", projectSlug: "" }, "text", "sum");
	store.propose(proposal);
	store.writeWorkflowMemory("rules");
	clock.t += 91 * DAY;
	const archived = store.archiveStale();
	assert.deepEqual(archived.sort(), ["consulted:c1", "run:r1"]);
	assert.ok(existsSync(join(dir, "archive/runs/r1/run.json")));
	assert.ok(existsSync(join(dir, "archive/runs/r1/transcripts/a1.json")));
	assert.ok(existsSync(join(dir, "archive/consulted/c1.md")));
	assert.ok(existsSync(join(dir, "archive/consulted/c1.txt")));
	assert.ok(!existsSync(join(dir, "runs/r1")));
	assert.equal(store.readIndex().find((e) => e.id === "run:r1")?.status, "archived");
	assert.equal(store.pendingCount(), 1, "pending runs are never archived by age");
	assert.equal(store.readIndex().find((e) => e.kind === "proposal")?.status, "open");
	assert.equal(store.readWorkflowMemory(), "rules");
	assert.equal(store.indexSlice({ limit: 10, maxChars: 10_000 }).includes("run:r1"), false);
});

test("archiveStale at 89 days archives nothing; superseded entries are archived at any age", () => {
	const { store, clock } = fixture();
	store.writeDigest("r1", "old digest");
	store.writeIdea({ id: "i1", title: "Idea", project: "", projectSlug: "" }, "idea");
	clock.t += 89 * DAY;
	assert.deepEqual(store.archiveStale(), []);
	const f = JSON.parse(readFileSync(join(store.dir, "index.json"), "utf8"));
	f.entries.find((e: { id: string }) => e.id === "idea:i1").supersededBy = "idea:i2";
	writeFileSync(join(store.dir, "index.json"), JSON.stringify(f));
	assert.deepEqual(store.archiveStale(), ["idea:i1"]);
});

test("deleteArchived deletes only archived entries", () => {
	const { store, dir } = fixture();
	store.writeRun(run("r1"), transcripts);
	store.writeRun(run("r2"), transcripts);
	store.archive("run:r1");
	assert.deepEqual(store.deleteArchived(["run:r1", "run:r2"]), ["run:r1"]);
	assert.ok(!existsSync(join(dir, "archive/runs/r1")));
	assert.ok(existsSync(join(dir, "runs/r2/run.json")));
	assert.deepEqual(
		store.readIndex().map((e) => e.id),
		["run:r2"],
	);
});

test("skillUse counts runs per skill over the last N processed runs", () => {
	const { store, clock } = fixture();
	for (const [id, skills] of [
		["r1", ["tdd", "plan"]],
		["r2", ["tdd"]],
		["r3", ["tdd", "debug"]],
	] as const) {
		clock.t += 1000;
		store.writeRun(run(id, [...skills]), transcripts);
		store.markProcessed([id], "b");
	}
	store.writeRun(run("r4", ["never"]), transcripts);
	assert.deepEqual(store.skillUse(10), { tdd: 3, plan: 1, debug: 1 });
	assert.deepEqual(store.skillUse(2), { tdd: 2, debug: 1 });
});

test("writes are atomic: no .tmp file is left behind", () => {
	const { store, dir } = fixture();
	store.writeRun(run("r1"), transcripts);
	store.writeWorkflowMemory("x");
	const names: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(d, e.name));
			else names.push(e.name);
		}
	};
	walk(dir);
	assert.ok(names.length > 0);
	assert.ok(names.every((n) => !n.endsWith(".tmp")));
});
