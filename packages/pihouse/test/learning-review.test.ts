import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DIGEST_SECTIONS } from "../src/workflow/digest-contract.ts";
import {
	type AgentRequest,
	type AgentResponse,
	runSelfLearning,
	type SelfLearningOptions,
} from "../src/workflow/learning-review.ts";
import { createProposal, getProposal, rejectProposal } from "../src/workflow/proposals.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Fixture {
	dir: string;
	root: string;
	store: OperationalStore;
	lineages: Map<string, string>;
	calls: AgentRequest[];
	clock: { now: number };
}

function fixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "learning-review-"));
	const store = openOperationalStore(join(dir, "memory.sqlite"), { fts: false });
	return { dir, root: join(dir, "reviews-root"), store, lineages: new Map(), calls: [], clock: { now: 1000 } };
}

function done(f: Fixture): void {
	f.store.close();
	rmSync(f.dir, { recursive: true, force: true });
}

/** A retained digest: run, revision, committed receipt and the digest bytes on disk. */
function addDigest(f: Fixture, name: string, options: { lineage?: string; project?: string; pad?: number } = {}) {
	const runId = `run-${name}`;
	const revision = `rev-${name}`;
	const sections = Object.fromEntries(
		DIGEST_SECTIONS.map((key) => [key, `${key} of ${name}${"x".repeat(options.pad ?? 0)}`]),
	);
	const text = JSON.stringify({ schemaVersion: 1, runId, project: options.project ?? "demo", revision, sections });
	const digestPath = join(f.dir, "digests", `${name}.md`);
	mkdirSync(join(f.dir, "digests"), { recursive: true });
	writeFileSync(digestPath, text);
	const db = f.store.db;
	db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(runId, `2026-01-01T00:00:0${f.lineages.size}Z`);
	db.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)").run(
		revision,
		runId,
		"fp",
		`2026-01-01T00:00:0${f.lineages.size}Z`,
	);
	db.prepare("INSERT INTO cleanup_manifests(id, payload, state) VALUES (?, ?, 'cleaned')").run(
		revision,
		JSON.stringify({ runId, revision, digestPath, digestHash: sha(text), files: [], attempts: 0 }),
	);
	f.lineages.set(runId, options.lineage ?? `lineage-${name}`);
	return { runId, revision, digestPath, text };
}

type Decision = {
	schemaVersion: 1;
	groups: {
		id: string;
		claim: string;
		scope: { kind: "project"; project: string } | { kind: "global" };
		supporters: string[];
		opposers?: string[];
		priorProposals?: string[];
	}[];
};

function options(f: Fixture, extra: Partial<SelfLearningOptions> = {}, decision?: Decision): SelfLearningOptions {
	return {
		invocation: "inv-1",
		now: () => f.clock.now,
		leaseMs: 60_000,
		reviewRoot: f.root,
		lineageOf: (runId) => f.lineages.get(runId),
		missing: [],
		digestAdapter: async () => ({ status: "failure" }),
		agent: async (request: AgentRequest): Promise<AgentResponse> => {
			f.calls.push(request);
			mkdirSync(join(request.outputPath, ".."), { recursive: true });
			writeFileSync(
				request.outputPath,
				request.stage === "scan"
					? JSON.stringify(decision ?? { schemaVersion: 1, groups: [] })
					: 'Full reasoning.\n\n```json\n{"schemaVersion":1,"proposals":[]}\n```',
			);
			return { status: "success", artifactPath: request.outputPath };
		},
		...extra,
	};
}

const members = (f: Fixture, batchId: string) =>
	f.store.db
		.prepare("SELECT item_id FROM batch_members WHERE batch_id = ? ORDER BY item_id")
		.all(batchId)
		.map((row) => String(row.item_id));

test("one invocation scans then reviews pinned digests, records lineage support and never applies", async () => {
	const f = fixture();
	try {
		const a = addDigest(f, "a", { lineage: "L1" });
		const b = addDigest(f, "b", { lineage: "L1" });
		const c = addDigest(f, "c", { lineage: "L2" });
		const prior = createProposal(f.store.db, { id: "p1", target: "t", before: "x", after: "y", evidence: ["e"] });
		rejectProposal(f.store.db, "p1", "no");
		const decision: Decision = {
			schemaVersion: 1,
			groups: [
				{
					id: "g1",
					claim: "paraphrase",
					scope: { kind: "project", project: "demo" },
					supporters: [a.revision, b.revision, c.revision],
					opposers: [],
					priorProposals: ["p1"],
				},
			],
		};
		const result = await runSelfLearning(f.store.db, options(f, {}, decision));
		assert.equal(result.status, "reviewed");
		assert.deepEqual(
			f.calls.map((call) => call.stage),
			["scan", "review"],
		);
		for (const call of f.calls) assert.deepEqual(Object.keys(call).sort().includes("text"), false);
		const group = result.groups[0];
		assert.equal(group?.supportRuns, 3);
		assert.equal(group?.supportLineages, 2, "two runs of one lineage count once");
		assert.equal(group?.priorRejected, true);
		const manifest = JSON.parse(readFileSync(result.manifestPath ?? "", "utf8"));
		assert.deepEqual(
			manifest.items.map((item: { revision: string; digestHash: string }) => [item.revision, item.digestHash]),
			[a, b, c].map((d) => [d.revision, sha(d.text)]),
		);
		assert.equal(manifest.prior[0].id, "p1");
		assert.equal(manifest.prior[0].version, prior.version);
		assert.deepEqual(members(f, result.batchId ?? ""), [a.revision, b.revision, c.revision]);
		assert.equal(getProposal(f.store.db, "p1").state, "rejected");
		assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'application'").get()?.n, 0);
	} finally {
		done(f);
	}
});

test("missing digests are dispatched first; failed ones are excluded and never reviewed", async () => {
	const f = fixture();
	try {
		const a = addDigest(f, "a");
		f.store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('run-bad', 'x')").run();
		f.store.db
			.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES ('rev-bad','run-bad','fp','x')")
			.run();
		const { enqueueJob } = await import("../src/workflow/jobs.ts");
		enqueueJob(f.store.db, "rev-bad", "rev-bad", "fp");
		const result = await runSelfLearning(
			f.store.db,
			options(f, {
				missing: [{ id: "rev-bad", revision: "rev-bad", evidencePath: "/tmp/e", fingerprint: "fp" }],
			}),
		);
		assert.deepEqual(result.queue, { missing: 1, generated: 0, failed: 1 });
		assert.deepEqual(result.excluded, [{ id: "rev-bad", reason: "digest failed" }]);
		assert.equal(result.status, "reviewed");
		assert.deepEqual(members(f, result.batchId ?? ""), [a.revision]);
	} finally {
		done(f);
	}
});

test("limits: ten runs per batch and a character budget leave the rest unreviewed, then advance", async () => {
	const f = fixture();
	try {
		for (let i = 0; i < 12; i++) addDigest(f, String(i).padStart(2, "0"));
		const first = await runSelfLearning(f.store.db, options(f));
		assert.equal(members(f, first.batchId ?? "").length, 10);
		assert.equal(first.overflow.length, 2);
		assert.ok(first.overflow.every((entry) => entry.reason === "run limit"));
		const second = await runSelfLearning(f.store.db, options(f, { invocation: "inv-2" }));
		assert.equal(members(f, second.batchId ?? "").length, 2);
		assert.notEqual(second.batchId, first.batchId);
		const third = await runSelfLearning(f.store.db, options(f, { invocation: "inv-3" }));
		assert.equal(third.status, "nothing-to-review");
	} finally {
		done(f);
	}
	const g = fixture();
	try {
		addDigest(g, "a");
		addDigest(g, "b", { pad: 5000 });
		const result = await runSelfLearning(g.store.db, options(g, { maxInputChars: 3000 }));
		assert.deepEqual(
			result.overflow.map((entry) => [entry.revision, entry.reason]),
			[["rev-b", "character budget"]],
		);
		assert.deepEqual(members(g, result.batchId ?? ""), ["rev-a"]);
	} finally {
		done(g);
	}
});

test("a failed review keeps the batch open; the restart resumes it without duplicating or marking reviewed", async () => {
	const f = fixture();
	try {
		addDigest(f, "a");
		addDigest(f, "b");
		let fail = true;
		const agent: SelfLearningOptions["agent"] = async (request) => {
			if (request.stage === "review" && fail) return { status: "failure" };
			return options(f).agent(request);
		};
		const first = await runSelfLearning(f.store.db, options(f, { agent }));
		assert.equal(first.status, "review-failed");
		const open = f.store.db.prepare("SELECT state FROM batches WHERE id = ?").get(first.batchId ?? "");
		assert.equal(open?.state, "open");
		addDigest(f, "c");
		fail = false;
		const second = await runSelfLearning(f.store.db, options(f, { agent, invocation: "inv-2" }));
		assert.equal(second.status, "reviewed");
		assert.equal(second.batchId, first.batchId);
		assert.deepEqual(members(f, second.batchId ?? ""), ["rev-a", "rev-b"]);
		assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM batches").get()?.n, 1);
		assert.equal(f.calls.filter((call) => call.stage === "scan").length, 1, "scan is reused");
	} finally {
		done(f);
	}
});

test("a pinned digest that changed blocks the review instead of reviewing different bytes", async () => {
	const f = fixture();
	try {
		const a = addDigest(f, "a");
		await runSelfLearning(f.store.db, options(f, { agent: async () => ({ status: "failure" }) }));
		writeFileSync(a.digestPath, `${a.text} `);
		const result = await runSelfLearning(f.store.db, options(f, { invocation: "inv-2" }));
		assert.equal(result.status, "blocked");
		assert.equal(f.store.db.prepare("SELECT state FROM batches").get()?.state, "open");
	} finally {
		done(f);
	}
});

test("invalid scan decisions fail the scan; unknown lineage and old revisions are excluded", async () => {
	const f = fixture();
	try {
		const a = addDigest(f, "a");
		addDigest(f, "nolineage");
		f.lineages.delete("run-nolineage");
		const bad: Decision = {
			schemaVersion: 1,
			groups: [{ id: "g", claim: "c", scope: { kind: "global" }, supporters: ["rev-ghost"] }],
		};
		const result = await runSelfLearning(f.store.db, options(f, {}, bad));
		assert.equal(result.status, "scan-failed");
		assert.deepEqual(result.excluded, [{ id: "rev-nolineage", reason: "lineage unknown" }]);
		assert.equal(f.calls.filter((call) => call.stage === "review").length, 0);
		assert.deepEqual(members(f, result.batchId ?? ""), [a.revision]);
	} finally {
		done(f);
	}
});

test("contradictions are counted by lineage and shown in the result", async () => {
	const f = fixture();
	try {
		const a = addDigest(f, "a", { lineage: "L1" });
		const b = addDigest(f, "b", { lineage: "L2" });
		const d = addDigest(f, "d", { lineage: "L2", project: "other" });
		const decision: Decision = {
			schemaVersion: 1,
			groups: [
				{
					id: "g",
					claim: "c",
					scope: { kind: "global" },
					supporters: [a.revision],
					opposers: [b.revision, d.revision],
				},
			],
		};
		const result = await runSelfLearning(f.store.db, options(f, {}, decision));
		assert.equal(result.groups[0]?.opposeLineages, 1);
		assert.equal(result.groups[0]?.contradicted, true);
	} finally {
		done(f);
	}
});
