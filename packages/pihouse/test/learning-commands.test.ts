// /workflow digest and /workflow self-learning against temp stores, a temp journal and a fake hub. A fake child writes
// what the real one would: a digest or a stage artifact at the path the task names, and a transcript that says it
// stopped. No model, no network, no real hub: a fake client records every spawn.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { proposalCommand } from "../src/extensions/workflow.ts";
import { DIGEST_SECTIONS } from "../src/workflow/digest-contract.ts";
import {
	digestCommand,
	LEARNING_MODEL_ENV,
	type LearningDeps,
	learningModel,
	selfLearningCommand,
} from "../src/workflow/learning-commands.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const IDENTITY = { AGENT_LINK_AGENT: "coordinator-1", AGENT_LINK_HUB: "/nonexistent/hub.sock", AGENT_LINK_TOKEN: "t" };

interface Spawned {
	name: string;
	task: string;
	cwd: string;
	read?: string[];
	model?: string;
}

/**
 * A fake hub client: registers one coordinator, and each spawn writes what `answer` says for its task, as a finished
 * child would. The default answers every job with a valid digest.
 */
function fakeHub(journal: string, answer: (task: string) => string = validDigest) {
	const spawns: Spawned[] = [];
	const client = {
		register: async () => ({
			name: "coordinator-1",
			identity: { agent: "coordinator-1", hub: "", token: "", depth: 0 },
		}),
		spawn: async (body: { task: string; name: string; cwd: string; read?: string[]; model?: string }) => {
			spawns.push({ name: body.name, task: body.task, cwd: body.cwd, read: body.read, model: body.model });
			const output = body.task.match(/Output: ([^\n]+)/)?.[1];
			assert.ok(output, "the child is told where to write");
			writeFileSync(output, answer(body.task));
			const transcript = join(journal, `${body.name}.jsonl`);
			writeFileSync(
				transcript,
				`${JSON.stringify({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } })}\n`,
			);
			writeFileSync(
				join(journal, `${body.name}.json`),
				JSON.stringify({
					id: `20260101T000000Z-${body.name}`,
					name: body.name,
					parent: "coordinator-1",
					parentName: "coordinator-1",
					root: "coordinator-1",
					harness: "pihouse",
					model: body.model ?? null,
					cwd: body.cwd,
					task: body.task,
					state: "done",
					depth: 1,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					transcript,
				}),
			);
			return { name: body.name };
		},
		cancel: async () => ({ ok: true }),
		event: async () => ({ ok: true }),
	};
	return { client, spawns };
}

/** The digest a child writes for the revision the task names: schema, identity and every section, nonempty. */
function validDigest(task: string): string {
	const revision = /for revision ([^\s.]+(?:\.r[0-9]+)?)\./.exec(task)?.[1] ?? "";
	const sections = Object.fromEntries(DIGEST_SECTIONS.map((key) => [key, `synthetic ${key}`]));
	const runId = revision.replace(/\.r[0-9]+$/, "");
	return JSON.stringify({ schemaVersion: 1, runId, project: "fixture", revision, sections });
}

interface Fixture {
	root: string;
	memory: string;
	journal: string;
	cleanup: () => void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "learning-commands-"));
	const memory = join(root, "memory");
	const journal = join(root, "journal");
	mkdirSync(journal);
	migrateLegacyStore(memory);
	return { root, memory, journal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fully exited synthetic run: its package, one transcript copy and the operational rows a capture writes. */
function addExitedRun(f: Fixture, runId: string, lineage = `lineage-${runId}`): void {
	const run = join(f.memory, "runs", runId);
	mkdirSync(join(run, "transcripts"), { recursive: true });
	writeFileSync(
		join(run, "run.json"),
		JSON.stringify({ id: runId, fingerprint: "source-hash", project: "fixture", agents: [{ id: "a" }] }),
	);
	writeFileSync(join(run, "transcripts", "a.jsonl"), `${JSON.stringify({ synthetic: runId })}\n`);
	const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
	try {
		const at = `2026-01-01T00:00:0${runId.length % 10}Z`;
		const revision = `${runId}.r1`;
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(runId, at);
		store.db
			.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, 'source-hash', ?)")
			.run(revision, runId, at);
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES (?, ?, 'run', '{}')")
			.run(`m-${runId}`, revision);
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES (?, ?, 'run.lineage', ?)")
			.run(`l-${runId}`, revision, JSON.stringify({ lineage }));
		store.db
			.prepare("INSERT INTO participants(id, revision_id, role, payload) VALUES (?, ?, 'planner', '{}')")
			.run(`p-${runId}`, revision);
	} finally {
		store.close();
	}
}

/** Ports that call every run exited and its source unchanged, the state a finished synthetic run is in. */
const exitedPorts = {
	operationalState: () => ({ states: ["stopped"], deliveries: 0, handoff: false, livenessKnown: true }),
	currentFingerprint: () => "source-hash",
};

function deps(f: Fixture, extra: Partial<LearningDeps> = {}): LearningDeps {
	return {
		memory: f.memory,
		journalDir: f.journal,
		env: { ...IDENTITY },
		cwd: f.root,
		backend: "tmux",
		modelAvailable: () => true,
		progress: () => {},
		pollMs: 20,
		timeoutMs: 5_000,
		...extra,
	};
}

test("the learning model is the documented setting, default Luna, and nothing else", () => {
	assert.equal(LEARNING_MODEL_ENV, "PIHOUSE_LEARNING_MODEL");
	assert.equal(learningModel({}), "openai-codex/gpt-6-luna");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "openai/gpt-x" }), "openai/gpt-x");
	assert.equal(learningModel({ PIHOUSE_LEARNING_MODEL: "  " }), "openai-codex/gpt-6-luna");
});

test("digest without an agent-link identity says the hub is needed and starts nothing", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-one");
		const hub = fakeHub(f.journal);
		const outcome = await digestCommand(deps(f, { env: {}, client: hub.client as never }));
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /need the agent-link hub/);
		assert.match(outcome.text, /Nothing was started/);
		assert.equal(hub.spawns.length, 0);
		assert.equal(existsSync(join(f.memory, "digests")), false, "no digest is written");
	} finally {
		f.cleanup();
	}
});

test("digest with a model that does not resolve with configured auth starts nothing", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-one");
		const hub = fakeHub(f.journal);
		const asked: string[] = [];
		const outcome = await digestCommand(
			deps(f, {
				client: hub.client as never,
				modelAvailable: (model) => {
					asked.push(model);
					return false;
				},
				ports: exitedPorts,
			}),
		);
		assert.deepEqual(asked, ["openai-codex/gpt-6-luna"], "the default model is the one checked");
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /openai-codex\/gpt-6-luna is not available with configured auth/);
		assert.match(outcome.text, /PIHOUSE_LEARNING_MODEL/);
		assert.equal(hub.spawns.length, 0);
	} finally {
		f.cleanup();
	}
});

test("a fully exited run is digested once under digests/, its copies cleaned, and the session gets status only", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-one");
		const hub = fakeHub(f.journal);
		const progress: string[] = [];
		const outcome = await digestCommand(
			deps(f, { client: hub.client as never, ports: exitedPorts, progress: (text) => progress.push(text) }),
		);
		assert.equal(outcome.level, "info");
		assert.match(outcome.text, /Digest: 1 generated, 1 cleaned, 0 cleanup pending, 0 failed, 0 deferred/);
		const digestFile = join(f.memory, "digests", "run-one", "digest-run-one.r1.md");
		assert.ok(existsSync(digestFile), "the digest is committed under digests/<run>");
		assert.match(outcome.text, new RegExp(digestFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(outcome.text, /synthetic objective/, "no digest text reaches the session");
		assert.equal(existsSync(join(f.memory, "runs", "run-one", "transcripts", "a.jsonl")), false, "the copy is cleaned");
		assert.equal(hub.spawns.length, 1);
		assert.equal(hub.spawns[0].model, "openai-codex/gpt-6-luna", "the child runs the configured model");
		assert.ok(hub.spawns[0].read?.includes(join(f.memory, "runs", "run-one")), "the child reads only its run folder");
		assert.ok(
			progress.some((text) => /Digest 1 of 1/.test(text)),
			"progress is reported while it works",
		);
	} finally {
		f.cleanup();
	}
});

test("a live run is deferred with its reason and nothing is started for it", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-live");
		const hub = fakeHub(f.journal);
		const outcome = await digestCommand(
			deps(f, {
				client: hub.client as never,
				ports: {
					operationalState: () => ({ states: ["working"], deliveries: null, handoff: null, livenessKnown: true }),
					currentFingerprint: () => "source-hash",
				},
			}),
		);
		assert.equal(outcome.level, "info");
		assert.match(outcome.text, /0 generated/);
		assert.match(outcome.text, /1 deferred/);
		assert.match(outcome.text, /run is active or liveness\/delivery status is unknown/);
		assert.equal(hub.spawns.length, 0);
	} finally {
		f.cleanup();
	}
});

test("more eligible runs than one invocation takes: the rest are reported as not started", async () => {
	const f = fixture();
	try {
		for (const id of ["run-a", "run-b", "run-c"]) addExitedRun(f, id);
		const hub = fakeHub(f.journal);
		const outcome = await digestCommand(deps(f, { client: hub.client as never, ports: exitedPorts }));
		assert.equal(hub.spawns.length, 2, "two jobs per invocation");
		assert.match(outcome.text, /1 not started/);
		assert.match(outcome.text, /2 generated, 2 cleaned/);
	} finally {
		f.cleanup();
	}
});

test("the digest command writes its attempt only under digests/.attempts and reads the store through the injected ports", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-one");
		const hub = fakeHub(f.journal);
		await digestCommand(deps(f, { client: hub.client as never, ports: exitedPorts }));
		const task = hub.spawns[0]?.task ?? "";
		const output = task.match(/Output: ([^\n]+)/)?.[1] ?? "";
		assert.ok(output.startsWith(join(f.memory, "digests", ".attempts")), output);
		assert.equal(readFileSync(join(f.memory, "digests", "run-one", "digest-run-one.r1.md"), "utf8").length > 0, true);
		assert.equal(dirname(output), join(f.memory, "digests", ".attempts"));
	} finally {
		f.cleanup();
	}
});

/** The scan a child writes for two runs that repeat one suggestion: one group, two supporting revisions. */
const scanOf = (supporters: string[]) =>
	JSON.stringify({
		schemaVersion: 1,
		groups: [{ id: "tests-first", claim: "Run the tests before committing", scope: { kind: "global" }, supporters }],
	});

/** The review a child writes: its reasoning, then the one fenced block intake reads, with one proposal. */
const REVIEW_TEXT = [
	"Both runs ask for the tests to run before a commit.",
	"",
	"```json",
	JSON.stringify({
		schemaVersion: 1,
		proposals: [
			{
				kind: "memory",
				scope: "global",
				target: "memory:preference/tests-first",
				before: "no rule",
				after: "run the tests before committing",
				supporting: ["run-a.r1", "run-b.r1"],
				opposing: [],
				conditions: ["repeated in two independent runs"],
				uncertainty: "two runs only",
				validation: "read the review",
			},
		],
	}),
	"```",
].join("\n");

/** Answers each job by its stage: digest, scan or review. */
function answerByStage(task: string): string {
	if (/job scan-/.test(task)) return scanOf(["run-a.r1", "run-b.r1"]);
	if (/job review-/.test(task)) return REVIEW_TEXT;
	return validDigest(task);
}

test("self-learning digests the missing runs, then scans and reviews the batch in separate children, applying nothing", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-a", "lin-a");
		addExitedRun(f, "run-b", "lin-b");
		const hub = fakeHub(f.journal, answerByStage);
		const progress: string[] = [];
		const outcome = await selfLearningCommand(
			deps(f, { client: hub.client as never, ports: exitedPorts, progress: (text) => progress.push(text) }),
		);
		assert.equal(outcome.level, "info", outcome.text);

		const stages = hub.spawns.map((spawn) => /job (scan|review|digest)-/.exec(spawn.task)?.[1]);
		assert.deepEqual(stages, ["digest", "digest", "scan", "review"], "digests first, then one scan and one review");
		const [scan, review] = [hub.spawns[2], hub.spawns[3]];
		assert.match(scan?.task ?? "", /"groups"/, "the scan child gets the groups contract");
		assert.match(review?.task ?? "", /"proposals"/, "the review child gets its proposal contract");
		assert.doesNotMatch(scan?.task ?? "", /Also read:/, "the scan reads only the manifest");
		assert.match(review?.task ?? "", /Also read:/, "the review also reads the scan summary");
		for (const spawn of [scan, review]) {
			assert.ok(spawn?.read?.includes(join(f.memory, "batches")), "the batch folder is readable");
			assert.ok(spawn?.read?.includes(join(f.memory, "digests")), "the digests are readable");
			assert.ok(!spawn?.read?.includes(join(f.memory, "runs", "run-a")), "no raw run folder is readable");
		}

		assert.match(outcome.text, /Self-learning batch batch-\w+: reviewed 2 run\(s\)\./);
		assert.match(outcome.text, /Digest: 2 generated, 2 cleaned/);
		assert.match(outcome.text, /Groups: 1, contradicted: 0, against a rejected proposal: 0\./);
		assert.match(outcome.text, /Proposals: 1 created, 0 merged, 0 suppressed\./);
		assert.match(outcome.text, /\/workflow approve <id>/);
		assert.match(outcome.text, /Nothing is applied by this command/);
		assert.doesNotMatch(outcome.text, /synthetic objective/, "no digest text reaches the session");
		assert.ok(progress.some((text) => /^Scan of batch/.test(text)));

		const listed = await proposalCommand("proposals", [], { memory: f.memory, repoRoot: f.root });
		assert.match(listed.text, /memory:preference\/tests-first/);
		assert.match(listed.text, /\bopen\b/, "the proposal waits for approval");
	} finally {
		f.cleanup();
	}
});

test("a second self-learning invocation reviews nothing again: the batch members are not duplicated", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-a", "lin-a");
		addExitedRun(f, "run-b", "lin-b");
		const hub = fakeHub(f.journal, answerByStage);
		await selfLearningCommand(deps(f, { client: hub.client as never, ports: exitedPorts }));
		const started = hub.spawns.length;
		const again = await selfLearningCommand(deps(f, { client: hub.client as never, ports: exitedPorts }));
		assert.match(again.text, /nothing to review/);
		assert.equal(hub.spawns.length, started, "no child is started for work already reviewed");
	} finally {
		f.cleanup();
	}
});

test("a scan that writes no valid decision stops the command, says nothing was applied, and keeps the batch open", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-a", "lin-a");
		const hub = fakeHub(f.journal, (task) =>
			/job scan-/.test(task) ? "prose, not the groups JSON" : validDigest(task),
		);
		const outcome = await selfLearningCommand(deps(f, { client: hub.client as never, ports: exitedPorts }));
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /stopped at the scan/);
		assert.match(outcome.text, /Nothing was applied; batch batch-\w+ stays open/);
		assert.equal(hub.spawns.length, 2, "one digest and one scan; no review is started");
		const listed = await proposalCommand("proposals", [], { memory: f.memory, repoRoot: f.root });
		assert.equal(listed.text, "No proposals yet.");
	} finally {
		f.cleanup();
	}
});

test("self-learning without the hub starts nothing", async () => {
	const f = fixture();
	try {
		addExitedRun(f, "run-a", "lin-a");
		const hub = fakeHub(f.journal, answerByStage);
		const outcome = await selfLearningCommand(deps(f, { env: {}, client: hub.client as never, ports: exitedPorts }));
		assert.equal(outcome.level, "warning");
		assert.match(outcome.text, /need the agent-link hub/);
		assert.equal(hub.spawns.length, 0);
	} finally {
		f.cleanup();
	}
});
