// The checks that run before `/workflow review` or the compact tool start anything, and the worker they use, against a
// temp vault and a fake hub client. No model, no network, no real hub: a fake client records every spawn.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	compactProjectCommand,
	LEARNING_MODEL_ENV,
	type LearningDeps,
	learningModel,
	reviewCommand,
} from "../src/workflow/learning-commands.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { stageOf } from "../src/workflow/run-stages.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const IDENTITY = { AGENT_LINK_AGENT: "coordinator-1", AGENT_LINK_HUB: "/nonexistent/hub.sock", AGENT_LINK_TOKEN: "t" };

interface Spawned {
	name: string;
	task: string;
	cwd: string;
	read?: string[];
	model?: string;
}

/** A fake hub client that records each spawn and leaves the child's output file unwritten, as a child that failed. */
function fakeHub() {
	const spawns: Spawned[] = [];
	const client = {
		register: async () => ({
			name: "coordinator-1",
			identity: { agent: "coordinator-1", hub: "", token: "", depth: 0 },
		}),
		spawn: async (body: { task: string; name: string; cwd: string; read?: string[]; model?: string }) => {
			spawns.push({ name: body.name, task: body.task, cwd: body.cwd, read: body.read, model: body.model });
			return { name: body.name };
		},
		cancel: async () => ({ ok: true }),
		event: async () => ({ ok: true }),
	};
	return { client, spawns };
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "learning-commands-"));
	const memory = join(root, "memory");
	const journal = join(root, "journal");
	mkdirSync(journal);
	migrateLegacyStore(memory);
	return { root, memory, journal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Fixture = ReturnType<typeof fixture>;

/** One captured run of /work/app with a conversation copy, as a capture leaves it. */
function addRun(f: Fixture, runId: string): void {
	const run = join(f.memory, "conversations", runId);
	mkdirSync(join(run, "transcripts"), { recursive: true });
	writeFileSync(
		join(run, "run.json"),
		JSON.stringify({ id: runId, fingerprint: "h", project: "/work/app", agents: [] }),
	);
	writeFileSync(join(run, "transcripts", "a.jsonl"), "RAW CONVERSATION\n");
	writeFileSync(
		join(run, "transcripts", "a.json"),
		JSON.stringify({
			harness: "claude",
			sessionId: "a",
			source: "/raw/a.jsonl",
			model: "claude-sonnet-5-5",
			messages: [{ index: 0, at: 1, role: "user", origin: "human", text: "add login", tools: [], skills: [] }],
		}),
	);
	const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		const revision = `${runId}.r1`;
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, '2026-01-01T00:00:00Z')").run(runId);
		store.db
			.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, 'h', '2026-01-01T00:00:00Z')")
			.run(revision, runId);
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES (?, ?, 'run.lineage', ?)")
			.run(`l-${runId}`, revision, JSON.stringify({ lineage: runId, project: "/work/app" }));
		store.db.prepare("INSERT INTO participants(id, revision_id, role, payload) VALUES (?, ?, 'planner', ?)").run(
			`p-${runId}`,
			revision,
			JSON.stringify({
				id: "a",
				parent: null,
				role: "planner",
				harness: "claude",
				model: "claude-sonnet-5-5",
				taskId: null,
				taskTitle: null,
				assignedSkills: [],
				loadedSkills: [],
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
				activeMs: 1,
				messages: 1,
				missing: null,
				summary: null,
			}),
		);
	} finally {
		store.close();
	}
}

function deps(f: Fixture, extra: Partial<LearningDeps> = {}): LearningDeps {
	return {
		memory: f.memory,
		journalDir: f.journal,
		env: { ...IDENTITY },
		cwd: f.root,
		backend: "tmux",
		modelAvailable: () => true,
		progress: () => {},
		isActive: () => false,
		currentFingerprint: () => "h",
		pollMs: 20,
		timeoutMs: 300,
		...extra,
	};
}

const stageNow = (f: Fixture, revision: string) => {
	const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		return stageOf(store.db, revision);
	} finally {
		store.close();
	}
};

test("the learning model is the documented setting, default the Claude bridge Sonnet, and nothing else", () => {
	assert.equal(LEARNING_MODEL_ENV, "PIHOUSE_LEARNING_MODEL");
	assert.equal(learningModel({}), "claude-bridge/claude-sonnet-5-5");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "openai/gpt-x" }), "openai/gpt-x");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "  " }), "claude-bridge/claude-sonnet-5-5");
});

test("review and the compact tool without an agent-link identity start nothing", async () => {
	const f = fixture();
	try {
		addRun(f, "run-one");
		const hub = fakeHub();
		const options = deps(f, { env: {}, client: hub.client as never, confirm: () => true });
		const review = await reviewCommand(options);
		assert.equal(review.level, "warning");
		assert.match(review.text, /need the agent-link hub.*Nothing was started/);
		const compact = await compactProjectCommand(options, "/work/app");
		assert.match(compact.text, /need the agent-link hub.*Nothing was started/);
		assert.equal(hub.spawns.length, 0);
		assert.equal(
			existsSync(join(f.memory, "workflow", "reviews")) ? readdirSync(join(f.memory, "workflow", "reviews")).length : 0,
			0,
		);
	} finally {
		f.cleanup();
	}
});

test("a model that does not resolve with configured auth, or no pane backend, starts nothing", async () => {
	const f = fixture();
	try {
		addRun(f, "run-one");
		const hub = fakeHub();
		const asked: string[] = [];
		const noModel = await reviewCommand(
			deps(f, {
				client: hub.client as never,
				confirm: () => true,
				modelAvailable: (model) => {
					asked.push(model);
					return false;
				},
			}),
		);
		assert.deepEqual(asked, ["claude-bridge/claude-sonnet-5-5"], "the default model is the one checked");
		assert.match(noModel.text, /claude-bridge\/claude-sonnet-5-5 is not available with configured auth/);
		assert.match(noModel.text, /PIHOUSE_LEARNING_MODEL/);
		const noBackend = await reviewCommand(
			deps(f, { client: hub.client as never, backend: undefined, confirm: () => true }),
		);
		assert.match(noBackend.text, /No pane backend.*Nothing was started/);
		assert.equal(hub.spawns.length, 0);
	} finally {
		f.cleanup();
	}
});

test("a declined review reaches the hub with nothing: no child, no stage, the conversation kept", async () => {
	const f = fixture();
	try {
		addRun(f, "run-one");
		const hub = fakeHub();
		const outcome = await reviewCommand(deps(f, { client: hub.client as never, confirm: () => false }));
		assert.match(outcome.text, /1 saved run waiting.*Review cancelled.*Nothing was started/);
		assert.equal(hub.spawns.length, 0);
		assert.equal(stageNow(f, "run-one.r1"), "captured");
		assert.ok(existsSync(join(f.memory, "conversations", "run-one", "transcripts", "a.jsonl")));
	} finally {
		f.cleanup();
	}
});

test("a confirmed review starts the compact child on the configured model, in the vault, and a failed child changes nothing", async () => {
	const f = fixture();
	try {
		addRun(f, "run-one");
		const hub = fakeHub();
		const outcome = await reviewCommand(
			deps(f, {
				client: hub.client as never,
				confirm: () => true,
				env: { ...IDENTITY, [LEARNING_MODEL_ENV]: "claude-bridge/other" },
			}),
		);
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /stopped at the compact step/);
		assert.equal(hub.spawns.length > 0, true);
		for (const spawn of hub.spawns) {
			assert.equal(spawn.model, "claude-bridge/other");
			assert.equal(spawn.cwd, f.memory, "children start in the vault, not in the project");
			assert.ok(!spawn.task.includes("RAW CONVERSATION"));
		}
		assert.equal(stageNow(f, "run-one.r1"), "captured");
		assert.ok(existsSync(join(f.memory, "conversations", "run-one", "transcripts", "a.jsonl")), "nothing was deleted");
	} finally {
		f.cleanup();
	}
});
