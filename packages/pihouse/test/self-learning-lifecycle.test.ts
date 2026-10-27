import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HubClient, SessionRecord } from "agent-link-core";
import { askContext, proposalCommand } from "../src/extensions/workflow.ts";
import { captureRun } from "../src/workflow/capture.ts";
import { DIGEST_SECTIONS } from "../src/workflow/digest-contract.ts";
import { digestCommand, type LearningDeps, selfLearningCommand } from "../src/workflow/learning-commands.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { getProposal, rollbackProposal } from "../src/workflow/proposals.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

interface ChildRecord {
	name: string;
	cwd: string;
	task: string;
	model?: string;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "connected-learning-lifecycle-"));
	const memory = join(root, "memory");
	const journal = join(root, "journal");
	mkdirSync(journal);
	migrateLegacyStore(memory);
	return { root, memory, journal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function nativeMessage(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text },
	});
}

function captureSyntheticRun(
	f: ReturnType<typeof fixture>,
	id: string,
	time: number,
): { root: SessionRecord; source: string } {
	const source = join(f.root, `${id}.jsonl`);
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: `session-${id}`, cwd: f.root })}\n${nativeMessage(`${id}-1`, `${id} original evidence`)}\n`,
	);
	const root: SessionRecord = {
		id,
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: id,
		harness: "pihouse",
		model: null,
		cwd: f.root,
		state: "exited",
		depth: 0,
		sessionId: `session-${id}`,
		transcript: source,
		startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, time)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, time)).toISOString(),
	};
	const store = openMemory(f.memory);
	assert.equal(
		captureRun([root], root, store, { by: "planner", now: new Date(Date.UTC(2026, 0, 1, 0, 2, time)) }),
		"written",
	);
	return { root, source };
}

function digestText(task: string): string {
	const revision = /for revision ([^\s.]+(?:\.r[0-9]+)?)\./.exec(task)?.[1] ?? "";
	const runId = revision.replace(/\.r[0-9]+$/, "");
	const input = /Input: ([^\n]+)/.exec(task)?.[1] ?? "";
	const pkg = JSON.parse(readFileSync(join(input, "run.json"), "utf8")) as { project: string };
	return JSON.stringify({
		schemaVersion: 1,
		runId,
		project: pkg.project,
		revision,
		sections: Object.fromEntries(DIGEST_SECTIONS.map((section) => [section, `synthetic ${section}`])),
	});
}

function manifestRevisions(task: string): string[] {
	const input = /Input: ([^\n]+)/.exec(task)?.[1] ?? "";
	const manifest = JSON.parse(readFileSync(input, "utf8")) as { items?: Array<{ revision: string }> };
	return manifest.items?.map((item) => item.revision) ?? [];
}

function groupArtifact(revisions: string[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		groups: [
			{
				id: "repeat",
				claim: "Keep test-first changes",
				scope: { kind: "global" },
				supporters: revisions,
				opposers: [],
				priorProposals: [],
			},
		],
	});
}

function reviewArtifact(revisions: string[]): string {
	return [
		"Synthetic review: repeated test-first practice is supported by independent runs.",
		"```json",
		JSON.stringify({
			schemaVersion: 1,
			proposals: [
				{
					kind: "memory",
					scope: "global",
					target: "memory:preference/test-first",
					before: "existing preference",
					after: "Run focused tests before committing.",
					supporting: revisions,
					opposing: [],
					conditions: ["when changing code"],
					uncertainty: "synthetic evidence",
					validation: "verify the focused test suite",
				},
			],
		}),
		"```",
	].join("\n");
}

function fakeHub(
	f: ReturnType<typeof fixture>,
	behavior: (task: string) => string,
	finish: (task: string) => string = () => "stop",
) {
	const spawns: ChildRecord[] = [];
	const client = {
		register: async () => ({ name: "coordinator", identity: { agent: "coordinator", hub: "", token: "", depth: 0 } }),
		spawn: async (body: { task: string; name: string; cwd: string; model?: string }) => {
			spawns.push({ name: body.name, cwd: body.cwd, task: body.task, model: body.model });
			const output = /Output: ([^\n]+)/.exec(body.task)?.[1];
			assert.ok(output, "production command supplies an isolated worker output path");
			writeFileSync(output, behavior(body.task));
			const transcript = join(f.journal, `${body.name}.jsonl`);
			writeFileSync(
				transcript,
				`${JSON.stringify({ message: { role: "assistant", stopReason: finish(body.task), content: [{ type: "text", text: "status only" }] } })}\n`,
			);
			writeFileSync(
				join(f.journal, `${body.name}.json`),
				JSON.stringify({
					id: `20260101T000000Z-${body.name}`,
					name: body.name,
					parent: "coordinator",
					parentName: "coordinator",
					root: "coordinator",
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
	return { client: client as unknown as HubClient, spawns };
}

function learningDeps(
	f: ReturnType<typeof fixture>,
	client: HubClient,
	fingerprint: (runId: string) => string | undefined,
): LearningDeps {
	return {
		memory: f.memory,
		journalDir: f.journal,
		env: { AGENT_LINK_AGENT: "coordinator", AGENT_LINK_HUB: "/fake/hub.sock", AGENT_LINK_TOKEN: "fake-token" },
		cwd: f.root,
		backend: "tmux",
		modelAvailable: () => true,
		progress: () => {},
		client,
		ports: {
			operationalState: () => ({ states: ["stopped"], deliveries: 0, handoff: false, livenessKnown: true }),
			currentFingerprint: (revision) => fingerprint(revision.replace(/\.r[0-9]+$/, "")),
		},
		pollMs: 20,
		timeoutMs: 5_000,
	};
}

function packageFingerprint(f: ReturnType<typeof fixture>, runId: string): string {
	return (JSON.parse(readFileSync(join(f.memory, "runs", runId, "run.json"), "utf8")) as { fingerprint: string })
		.fingerprint;
}

function transcriptCopy(f: ReturnType<typeof fixture>, runId: string): string {
	const dir = join(f.memory, "runs", runId, "transcripts");
	return readdirSync(dir)
		.map((name) => readFileSync(join(dir, name), "utf8"))
		.join("\n");
}

test("public digestCommand retries pending cleanup without calling a digest worker", async () => {
	const f = fixture();
	try {
		const run = join(f.memory, "runs", "run-pending");
		mkdirSync(join(run, "transcripts"), { recursive: true });
		writeFileSync(
			join(run, "run.json"),
			JSON.stringify({ id: "run-pending", fingerprint: "source", project: "fixture", agents: [{ id: "a" }] }),
		);
		writeFileSync(join(run, "transcripts", "a.jsonl"), "captured evidence");
		const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		try {
			store.db.exec(
				"INSERT INTO runs(id,created_at) VALUES ('run-pending','now'); INSERT INTO revisions(id,run_id,source_hash,created_at) VALUES ('run-pending.r1','run-pending','source','now'); INSERT INTO metrics(id,revision_id,kind,value) VALUES ('metric','run-pending.r1','run.metrics','{}'); INSERT INTO metrics(id,revision_id,kind,value) VALUES ('lineage','run-pending.r1','run.lineage','{}'); INSERT INTO participants(id,revision_id,role,payload) VALUES ('participant','run-pending.r1','planner','{}')",
			);
			const digestPath = join(f.memory, "digests", "run-pending", "digest.md");
			mkdirSync(join(f.memory, "digests", "run-pending"), { recursive: true });
			writeFileSync(digestPath, "durable but invalid receipt digest");
			store.db
				.prepare("INSERT INTO cleanup_manifests(id,payload,state) VALUES ('run-pending.r1',?,'cleanup-failed')")
				.run(
					JSON.stringify({
						runId: "run-pending",
						revision: "run-pending.r1",
						digestPath,
						digestHash: "not-the-file-hash",
						files: [{ name: "a.jsonl", hash: "irrelevant" }],
						attempts: 1,
					}),
				);
			store.db
				.prepare(
					"INSERT INTO jobs(id,revision_id,state,payload) VALUES ('digest-run-pending.r1','run-pending.r1','cleanup-failed',?)",
				)
				.run(JSON.stringify({ fingerprint: "source", attempts: 1, artifactPath: digestPath }));
			const hub = fakeHub(f, () => {
				throw new Error("pending cleanup must not spawn a digest or review child");
			});
			const outcome = await digestCommand(learningDeps(f, hub.client, () => "source"));
			assert.match(outcome.text, /0 generated, 0 cleaned, 1 cleanup pending, 0 failed, 0 deferred, 0 not started/);
			assert.equal(hub.spawns.length, 0, "public retry does not regenerate or start a review worker");
			assert.equal(
				store.db.prepare("SELECT state FROM cleanup_manifests WHERE id='run-pending.r1'").get()?.state,
				"cleanup-failed",
			);
			assert.ok(existsSync(join(run, "transcripts", "a.jsonl")));
		} finally {
			store.close();
		}
	} finally {
		f.cleanup();
	}
});

test("connected lifecycle captures, retries one failed digest, reviews and applies evidence, asks after cleanup, then captures only reopened delta", async () => {
	const f = fixture();
	try {
		const first = captureSyntheticRun(f, "run-a", 1);
		const second = captureSyntheticRun(f, "run-b", 2);
		const third = captureSyntheticRun(f, "run-c", 3);
		for (const { root } of [first, second, third]) {
			assert.ok(
				existsSync(join(f.memory, "runs", root.id, "report.md")),
				"capture writes the synthetic computed report",
			);
		}
		const fingerprints = new Map([first, second, third].map(({ root }) => [root.id, packageFingerprint(f, root.id)]));
		let failFirstRunOnce = true;
		const hub = fakeHub(f, (task) => {
			if (/job digest-/.test(task)) {
				const revision = /for revision ([^\s.]+(?:\.r[0-9]+)?)\./.exec(task)?.[1] ?? "";
				if (revision.startsWith("run-a.") && failFirstRunOnce) {
					failFirstRunOnce = false;
					return "not a valid digest";
				}
				return digestText(task);
			}
			if (/job scan-/.test(task)) return groupArtifact(manifestRevisions(task));
			if (/job review-/.test(task)) return reviewArtifact(manifestRevisions(task));
			return "unexpected job";
		});
		const deps = learningDeps(f, hub.client, (runId) => fingerprints.get(runId));

		const firstOutcome = await selfLearningCommand(deps);
		assert.match(firstOutcome.text, /1 generated, 1 cleaned, 0 cleanup pending, 1 failed/);
		assert.match(firstOutcome.text, /Proposals: 1 created, 0 merged/);
		assert.doesNotMatch(firstOutcome.text, /synthetic objective/);
		assert.ok(existsSync(join(f.memory, "digests", "run-b", "digest-run-b.r1.md")));
		assert.equal(existsSync(join(f.memory, "runs", "run-b", "transcripts")), false);
		assert.equal(
			existsSync(join(f.memory, "runs", "run-a", "transcripts")),
			true,
			"failed digest retains captured evidence",
		);

		const retryOutcome = await selfLearningCommand(deps);
		assert.match(retryOutcome.text, /2 generated, 2 cleaned, 0 cleanup pending, 0 failed/);
		assert.equal(existsSync(join(f.memory, "runs", "run-a", "transcripts")), false);
		assert.equal(existsSync(join(f.memory, "runs", "run-c", "transcripts")), false);
		assert.equal(
			hub.spawns.filter((child) => /job digest-/.test(child.task)).length,
			4,
			"the failure is retried once and each successful run is digested once",
		);
		assert.match(retryOutcome.text, /Proposals: 0 created, 1 merged/);
		assert.doesNotMatch(retryOutcome.text, /synthetic objective|Synthetic review:/);

		const store = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		let proposalId = "";
		try {
			const row = store.db
				.prepare("SELECT id, payload FROM proposals")
				.all()
				.find(
					(item) => (JSON.parse(String(item.payload)) as { target?: string }).target === "memory:preference/test-first",
				);
			assert.ok(row);
			proposalId = String(row.id);
			const proposal = getProposal(store.db, proposalId);
			assert.equal(proposal.state, "open");
			assert.equal(proposal.evidence.length, 3, "independent run evidence merges into the same proposal");
		} finally {
			store.close();
		}

		const target = join(f.memory, "approved-records", "preference", "test-first.md");
		mkdirSync(join(f.memory, "approved-records", "preference"), { recursive: true });
		writeFileSync(target, "existing preference");
		// Approval itself uses the public command so it applies against a real temporary target and records its receipt.
		const approved = await proposalCommand("approve", [proposalId], { memory: f.memory, repoRoot: f.root });
		assert.equal(approved.level, "info");
		assert.match(approved.text, /Applied .*Receipt recorded/);
		assert.equal(readFileSync(target, "utf8"), "Run focused tests before committing.");
		const appliedStore = openOperationalStore(join(f.memory, "memory.sqlite"), { fts: false, legacy: true });
		try {
			assert.equal(getProposal(appliedStore.db, proposalId).state, "applied");
			assert.ok(
				appliedStore.db.prepare("SELECT 1 FROM receipts WHERE proposal_id=? AND kind='application'").get(proposalId),
			);
			writeFileSync(target, "user edited after application");
			await assert.rejects(
				rollbackProposal(appliedStore.db, proposalId, {
					read: async () => readFileSync(target, "utf8"),
					compareAndSwap: async (expected, replacement) => {
						if (readFileSync(target, "utf8") !== expected) return false;
						writeFileSync(target, replacement);
						return true;
					},
					validate: async () => true,
				}),
				/rollback|changed/i,
			);
			assert.equal(readFileSync(target, "utf8"), "user edited after application");
		} finally {
			appliedStore.close();
		}

		const asked = await askContext(
			"Why did the synthetic run change?",
			{ PIHOUSE_HOME: f.root },
			{ memoryDir: f.memory, cwd: f.root },
		);
		assert.match(asked, /retained|run|digest/i);
		assert.doesNotMatch(asked, /original evidence|transcripts\/.*jsonl/);

		appendFileSync(first.source, `${nativeMessage("run-a-2", "new appended delta only")}\n`);
		const reopening = openMemory(f.memory);
		assert.equal(captureRun([first.root], first.root, reopening, { by: "planner" }), "written");
		const reopened = JSON.parse(readFileSync(join(f.memory, "runs", "run-a", "run.json"), "utf8")) as {
			revision: number;
		};
		assert.equal(reopened.revision, 2);
		assert.match(transcriptCopy(f, "run-a"), /new appended delta only/);
		assert.doesNotMatch(transcriptCopy(f, "run-a"), /run-a original evidence/);
	} finally {
		f.cleanup();
	}
});
