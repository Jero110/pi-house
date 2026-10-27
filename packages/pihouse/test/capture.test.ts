import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal, readJournal, type SessionRecord } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import { workflowSessionName } from "../src/extensions/workflow.ts";
import { pihousePaths } from "../src/paths.ts";
import {
	addFlag,
	captureRun,
	isFlagged,
	lastFlagged,
	localRecord,
	ownRoot,
	readFlags,
	recordReview,
	sweepFlagged,
	TITLE_MAX,
} from "../src/workflow/capture.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { isExecutor } from "../src/workflow/run.ts";

const SECRET = "SECRET-TRANSCRIPT-TEXT-".repeat(8);

interface Fixture {
	home: string;
	roots: TranscriptRoots;
	journal: Journal;
	dir: string;
	store: ReturnType<typeof openMemory>;
}

function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "pihouse-capture-"));
	const roots: TranscriptRoots = {
		claude: join(home, "claude"),
		codex: join(home, "codex"),
		opencodeDb: join(home, "oc.db"),
		pi: join(home, "pi"),
		pihouse: join(home, "pihouse"),
	};
	const dir = join(home, "journal");
	return {
		home,
		roots,
		journal: new Journal(dir),
		dir,
		store: openMemory(pihousePaths({ PIHOUSE_HOME: home }, home).memory),
	};
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, s)).toISOString();

/** A pihouse session file with one request and one answer. */
function session(f: Fixture, id: string, request: string): void {
	mkdirSync(join(f.roots.pihouse, "--w--"), { recursive: true });
	writeFileSync(
		join(f.roots.pihouse, "--w--", `x_${id}.jsonl`),
		[
			{ type: "session", id, cwd: "/w", timestamp: at(0) },
			{ type: "message", id: `${id}u`, timestamp: at(1), message: { role: "user", content: request } },
			{
				type: "message",
				id: `${id}a`,
				timestamp: at(11),
				message: {
					role: "assistant",
					model: "m",
					content: [{ type: "text", text: "done" }],
					usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 5 },
				},
			},
		]
			.map((o) => JSON.stringify(o))
			.join("\n"),
	);
}

function agent(
	f: Fixture,
	id: string,
	name: string,
	parent: SessionRecord | null,
	extra: Partial<SessionRecord> = {},
): SessionRecord {
	const rec: SessionRecord = {
		id,
		name,
		parent: parent?.id ?? null,
		parentName: parent?.name ?? null,
		root: parent?.root ?? id,
		harness: "pihouse",
		model: null,
		cwd: "/w",
		state: "exited",
		depth: parent ? parent.depth + 1 : 0,
		sessionId: `s-${id}`,
		startedAt: at(Number(extra.depth ?? 0)),
		updatedAt: at(1),
		...extra,
	};
	f.journal.create(rec);
	session(f, `s-${id}`, id === "a" ? SECRET : `request of ${id}`);
	return rec;
}

/** planner -> workflow-executor -> w1 -> w1a, and w2: three levels below the root. */
function tree(f: Fixture): void {
	const a = agent(f, "a", "pihouse", null);
	const b = agent(f, "b", "workflow-executor", a, {
		startedAt: at(2),
		task: "Read /repo/skills/build/executor/SKILL.md.\nRun the plan /w/docs/plans/todo.md end to end.",
	});
	const c = agent(f, "c", "t1", b, {
		startedAt: at(3),
		task: "Task T1 of /w/docs/plans/todo.md: add the list\nSkills: tdd",
	});
	agent(f, "d", "t1-sub", c, { startedAt: at(4) });
	agent(f, "e", "t2", b, { startedAt: at(5), task: "Task T2 of /w/docs/plans/todo.md: search" });
}

test("a three-level tree is one package with every transcript copied, and no model runs", () => {
	const f = fixture();
	tree(f);
	const records = readJournal(f.dir);
	const root = records.find((r) => r.id === "a");
	assert.ok(root);
	assert.equal(captureRun(records, root, f.store, { by: "executor", roots: f.roots }), "written");

	const runDir = join(f.store.dir, "runs", "a");
	const pkg = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
	assert.equal(pkg.schema, 1);
	assert.equal(pkg.flaggedBy, "executor");
	assert.equal(pkg.plan, "docs/plans/todo.md");
	assert.equal(pkg.title, "todo");
	assert.deepEqual(
		pkg.agents.map((a: { id: string; parent: string | null; role: string }) => [a.id, a.parent, a.role]),
		[
			["a", null, "planner"],
			["b", "a", "executor"],
			["c", "b", "worker"],
			["d", "c", "worker"],
			["e", "b", "worker"],
		],
	);
	assert.equal(pkg.metrics.agents, 5);
	assert.equal(pkg.metrics.newTokens, 5 * 35);
	assert.equal(pkg.metrics.cacheRead, 500);
	assert.equal(pkg.metrics.messages, 10); // a request and an answer per agent
	assert.deepEqual(
		readdirSync(join(runDir, "transcripts")).sort(),
		[
			...["a", "b", "c", "d", "e"].flatMap((id) => [`s-${id}`].map(() => `${id}.json`)),
			...["a", "b", "c", "d", "e"].map((id) => `${id}.jsonl`),
		].sort(),
	);
	assert.equal(
		readFileSync(join(runDir, "transcripts", "d.jsonl"), "utf8"),
		readFileSync(join(f.roots.pihouse, "--w--", "x_s-d.jsonl"), "utf8"),
		"the raw file is copied as it is",
	);
	assert.ok(existsSync(join(runDir, "report.md")));
	assert.equal(f.store.pendingCount(), 1);
});

test("run.json holds no transcript text and its title is at most 80 chars", () => {
	const f = fixture();
	const root = agent(f, "a", "pihouse", null);
	assert.ok(SECRET.length > TITLE_MAX);
	captureRun([root], root, f.store, { by: "save", roots: f.roots });
	const text = readFileSync(join(f.store.dir, "runs", "a", "run.json"), "utf8");
	const pkg = JSON.parse(text);
	assert.ok(pkg.title.length <= TITLE_MAX, `title is ${pkg.title.length} chars`);
	assert.equal(pkg.title, "pihouse", "titles do not persist conversational requests");
	assert.ok(!text.includes(SECRET), "the whole request is not in run.json");
	assert.ok(!text.includes('"done"'), "no answer text either");
	const withReason = captureRun([root], root, f.store, { by: "save", reason: "x".repeat(300), roots: f.roots });
	assert.equal(withReason, "written");
	assert.ok(JSON.parse(readFileSync(join(f.store.dir, "runs", "a", "run.json"), "utf8")).title.length <= TITLE_MAX);
});

test("an unflagged run is ignored by the sweep, --last and the pending list", () => {
	const f = fixture();
	const plain = agent(f, "p", "pihouse", null);
	agent(f, "q", "helper", plain, { startedAt: at(2) });
	const flagged = agent(f, "x", "pihouse", null, { startedAt: at(20) });
	agent(f, "y", "workflow-executor", flagged, { startedAt: at(21) });
	const unflaggedNewer = agent(f, "z", "pihouse", null, { startedAt: at(40) });
	agent(f, "zz", "helper", unflaggedNewer, { startedAt: at(41) });
	const records = readJournal(f.dir);

	assert.equal(isFlagged(records, plain, readFlags(f.store.dir)), undefined);
	assert.equal(isFlagged(records, flagged, readFlags(f.store.dir))?.by, "executor");
	assert.deepEqual(sweepFlagged(records, f.store, { roots: f.roots }), ["x"]);
	assert.deepEqual(
		f.store.pending().map((e) => e.id),
		["run:x"],
	);
	const last = lastFlagged(records, f.store);
	assert.ok(last && "root" in last && last.root.id === "x", "--last skips the newer unflagged run");
	assert.deepEqual(
		sweepFlagged(records, f.store, { roots: f.roots }),
		[],
		"already captured runs are not captured again",
	);
});

test("a flag by name, by executor in the tree and by flags.json", () => {
	const f = fixture();
	const named = agent(f, "n", "workflow-planner", null);
	const saved = agent(f, "s", "pihouse", null, { startedAt: at(9) });
	const records = [named, saved];
	const flags = readFlags(f.store.dir);
	assert.equal(isFlagged(records, named, flags)?.by, "planner");
	assert.equal(isFlagged(records, saved, flags), undefined);
	addFlag(f.store.dir, "s", { by: "save", reason: "good run" });
	addFlag(f.store.dir, "s", { by: "planner" });
	const after = readFlags(f.store.dir);
	assert.deepEqual(isFlagged(records, saved, after), { by: "save", reason: "good run" });
	assert.ok(isExecutor({ ...saved, name: "workflow-executor" }));
	assert.ok(isExecutor({ ...saved, name: "executor-2" }));
	assert.ok(isExecutor({ ...saved, task: "/skill:executor docs/plans/x.md" }));
	const handoff = "Read /w/skills/build/executor/SKILL.md (absolute path) and follow it.\nPlan: docs/plans/x.md";
	assert.ok(isExecutor({ ...saved, task: handoff }));
	const child = agent(f, "e", "worker", saved, { task: handoff });
	assert.equal(isFlagged([saved, child], saved, flags)?.by, "executor");
});

test("a worker that only lists the executor skill among the files it edits is not an executor", () => {
	const f = fixture();
	const worker = agent(f, "c", "capture", null);
	const brief = "Build the capture step.\n\nFiles:\n- skills/build/executor/SKILL.md\n- packages/pihouse/src/x.ts\n";
	assert.ok(!isExecutor({ ...worker, task: brief }));
	assert.ok(!isExecutor({ ...worker, task: `${brief}Edit the executor skill to mention it.` }));
});

test("save on a plain chat with no workers and no hub captures it with its reason", () => {
	const f = fixture();
	session(f, "chat-1", "How do I rename a branch?");
	const root = localRecord("chat-1", "/w", join(f.roots.pihouse, "--w--", "x_chat-1.jsonl"));
	assert.equal(root.id, "local-chat-1");
	assert.equal(ownRoot([], { sessionId: "chat-1" }), undefined, "no journal record: the caller makes a local one");
	addFlag(f.store.dir, root.id, { by: "save", reason: "I liked how this went" });
	assert.equal(captureRun([root], root, f.store, { by: "save", reason: "I liked how this went" }), "written");
	const pkg = JSON.parse(readFileSync(join(f.store.dir, "runs", "local-chat-1", "run.json"), "utf8"));
	assert.equal(pkg.reason, "I liked how this went");
	assert.equal(pkg.title, "I liked how this went");
	assert.equal(pkg.agents.length, 1);
	assert.equal(pkg.agents[0].role, "root");
	assert.ok(existsSync(join(f.store.dir, "runs", "local-chat-1", "transcripts", "local-chat-1.json")));
	const last = lastFlagged([], f.store);
	assert.deepEqual(last, { stored: "local-chat-1" });
});

test("a missing transcript is recorded, not fatal; a processed run is not captured again; a review is kept", () => {
	const f = fixture();
	const root = agent(f, "a", "pihouse", null);
	const lost = agent(f, "l", "workflow-executor", root, { startedAt: at(2), sessionId: "nope" });
	const records = [root, lost];
	captureRun(records, root, f.store, { by: "executor", roots: f.roots });
	const pkg = JSON.parse(readFileSync(join(f.store.dir, "runs", "a", "run.json"), "utf8"));
	const gone = pkg.agents.find((a: { id: string }) => a.id === "l");
	assert.match(gone.missing, /no transcript on disk/);
	assert.equal(gone.transcript, "");
	assert.ok(recordReview(f.store, "a", "/r.md"));
	captureRun(records, root, f.store, { by: "executor", roots: f.roots });
	assert.equal(JSON.parse(readFileSync(join(f.store.dir, "runs", "a", "run.json"), "utf8")).review, "/r.md");
	f.store.markProcessed(["a"], "b1");
	assert.equal(captureRun(records, root, f.store, { by: "executor", roots: f.roots }), "processed");
	assert.equal(recordReview(f.store, "nope", "/r.md"), false);
});

test("sessions that start the planner or the executor get a readable workflow name", () => {
	assert.deepEqual(workflowSessionName("/skill:planner build a todo app with search"), {
		name: "workflow-planner · build a todo app with search",
		by: "planner",
	});
	assert.equal(workflowSessionName("/skill:planner")?.name, "workflow-planner · session");
	assert.deepEqual(workflowSessionName("Read /r/skills/build/executor/SKILL.md.\nRun the plan /w/docs/plans/todo.md"), {
		name: "workflow-executor · todo",
		by: "executor",
	});
	assert.equal(workflowSessionName("fix the bug in the parser"), undefined);
});
