import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evidenceFingerprint, persistEvidence, revisionIdFor } from "../src/workflow/evidence-store.ts";
import { openMemory } from "../src/workflow/memory.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
import {
	markReviewed,
	pendingForReview,
	recordCompact,
	stageOf,
	uncompactedForProject,
} from "../src/workflow/run-stages.ts";
import { searchMemory, syncSearchIndex } from "../src/workflow/search.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");

function evidence(project: string, tag: string): WorkflowEvidence {
	return {
		lineage: `lineage-${tag}`,
		lineageStatus: "root-id",
		forkProvenance: "unknown",
		destructiveEligibility: "deferred",
		title: tag,
		project,
		plan: "docs/plans/p.md",
		participants: [
			{
				id: "planner",
				parent: null,
				role: "planner",
				harness: "pihouse",
				model: "m",
				taskId: null,
				taskTitle: null,
				assignedSkills: [],
				loadedSkills: [],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				activeMs: 1,
				messages: 1,
				missing: null,
				summary: null,
			},
		],
		metrics: { newTokens: 2, cacheRead: 0, activeMs: 1, wallMs: 1, agents: 1, messages: 1 },
		cursor: {},
	};
}

interface Fixture {
	root: string;
	store: OperationalStore;
	capture(runId: string, revision: number, project: string, tag?: string): { id: string; fingerprint: string };
	writeCompact(id: string, text: string): { path: string; hash: string };
	close(this: Fixture): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pihouse-stages-"));
	openMemory(root);
	const store = openOperationalStore(join(root, "memory.sqlite"), { legacy: true });
	return {
		root,
		store,
		capture(runId, revision, project, tag = `${runId}-${revision}`) {
			const ev = evidence(project, tag);
			const fingerprint = evidenceFingerprint(ev);
			const id = persistEvidence(store.db, {
				runId,
				revision,
				fingerprint,
				evidence: ev,
				capturedAt: `2026-11-05T10:0${revision}:00Z`,
			});
			return { id, fingerprint };
		},
		writeCompact(id, text) {
			const path = `workflow/compact/${id}.md`;
			mkdirSync(join(root, "workflow", "compact"), { recursive: true });
			writeFileSync(join(root, path), text);
			return { path, hash: sha(text) };
		},
		close() {
			try {
				this.store.close();
			} catch {
				// A test closed it to let the search code open its own connection.
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function compact(f: Fixture, revision: { id: string; fingerprint: string }, by: "review" | "ask" = "review") {
	const file = f.writeCompact(revision.id, `# Compact ${revision.id}\n\nunicornfact for ${revision.id}\n`);
	recordCompact(f.store.db, {
		revisionId: revision.id,
		compactPath: file.path,
		compactHash: file.hash,
		compactFingerprint: revision.fingerprint,
		compactedBy: by,
		compactedAt: "2026-11-05T12:00:00Z",
	});
	return file;
}

test("the schema change is additive and idempotent: run_stages exists after reopening", () => {
	const f = fixture();
	try {
		f.store.close();
		const again = openOperationalStore(join(f.root, "memory.sqlite"), { legacy: true });
		const again2 = openOperationalStore(join(f.root, "memory.sqlite"), { legacy: true });
		assert.equal(again2.version, 3);
		const columns = again.db.prepare("PRAGMA table_info(run_stages)").all() as { name: string }[];
		assert.deepEqual(
			columns.map((c) => c.name),
			[
				"revision_id",
				"compact_path",
				"compact_hash",
				"compact_fingerprint",
				"compacted_by",
				"compacted_at",
				"review_id",
				"reviewed_at",
			],
		);
		assert.equal(again.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 3").get()?.n, 1);
		again.close();
		again2.close();
		f.store = openOperationalStore(join(f.root, "memory.sqlite"), { legacy: true });
	} finally {
		f.close();
	}
});

test("a captured revision with no row is captured; recordCompact makes it compacted; markReviewed makes it reviewed", () => {
	const f = fixture();
	try {
		const r = f.capture("run-a", 1, "/p/app");
		assert.equal(stageOf(f.store.db, r.id), "captured");
		compact(f, r);
		assert.equal(stageOf(f.store.db, r.id), "compacted");
		markReviewed(f.store.db, [r.id], "review-20261105T143000Z");
		assert.equal(stageOf(f.store.db, r.id), "reviewed");
		const row = f.store.db.prepare("SELECT review_id, reviewed_at FROM run_stages WHERE revision_id = ?").get(r.id);
		assert.equal(row?.review_id, "review-20261105T143000Z");
		assert.ok(typeof row?.reviewed_at === "string" && row.reviewed_at.length > 0);
	} finally {
		f.close();
	}
});

test("recordCompact never overwrites a reviewed row, and replaces a compacted one", () => {
	const f = fixture();
	try {
		const r = f.capture("run-a", 1, "/p/app");
		compact(f, r, "ask");
		compact(f, r, "review");
		const row = f.store.db.prepare("SELECT compacted_by FROM run_stages WHERE revision_id = ?").get(r.id);
		assert.equal(row?.compacted_by, "review", "a compacted row is replaced");
		markReviewed(f.store.db, [r.id], "review-1");
		assert.throws(() => compact(f, r), /reviewed/);
		assert.equal(stageOf(f.store.db, r.id), "reviewed");
	} finally {
		f.close();
	}
});

test("markReviewed refuses a revision without a row and changes nothing", () => {
	const f = fixture();
	try {
		const a = f.capture("run-a", 1, "/p/app");
		const b = f.capture("run-b", 1, "/p/app");
		compact(f, a);
		assert.throws(() => markReviewed(f.store.db, [a.id, b.id], "review-1"), /run_stages|compact/i);
		assert.equal(stageOf(f.store.db, a.id), "compacted", "the whole call rolled back");
	} finally {
		f.close();
	}
});

test("pendingForReview returns the newest revision of each run that is not reviewed, scoped by project", () => {
	const f = fixture();
	try {
		const a1 = f.capture("run-a", 1, "/p/app");
		const a2 = f.capture("run-a", 2, "/p/app");
		const b1 = f.capture("run-b", 1, "/p/other");
		const c1 = f.capture("run-c", 1, "/p/app");
		compact(f, c1);
		markReviewed(f.store.db, [c1.id], "review-1");
		const all = pendingForReview(f.store.db).map((p) => p.revisionId);
		assert.deepEqual(all.sort(), [a2.id, b1.id].sort(), "older revisions and reviewed runs are not pending");
		assert.ok(!all.includes(a1.id));
		assert.deepEqual(
			pendingForReview(f.store.db, "/p/app").map((p) => p.revisionId),
			[a2.id],
		);
		assert.deepEqual(
			pendingForReview(f.store.db, "/p/other").map((p) => p.revisionId),
			[b1.id],
		);
		const first = pendingForReview(f.store.db, "/p/app")[0];
		assert.equal(first.runId, "run-a");
		assert.equal(first.project, "/p/app");
		assert.equal(first.fingerprint, a2.fingerprint);
	} finally {
		f.close();
	}
});

test("a run captured again after being reviewed is pending again as its new revision", () => {
	const f = fixture();
	try {
		const r1 = f.capture("run-a", 1, "/p/app");
		compact(f, r1);
		markReviewed(f.store.db, [r1.id], "review-1");
		assert.deepEqual(pendingForReview(f.store.db), []);
		const r2 = f.capture("run-a", 2, "/p/app");
		assert.deepEqual(
			pendingForReview(f.store.db).map((p) => p.revisionId),
			[r2.id],
		);
		assert.equal(r2.id, revisionIdFor("run-a", 2));
	} finally {
		f.close();
	}
});

test("pendingForReview leaves out runs the caller reports as active", () => {
	const f = fixture();
	try {
		const a = f.capture("run-a", 1, "/p/app");
		const b = f.capture("run-b", 1, "/p/app");
		const pending = pendingForReview(f.store.db, undefined, { isActive: (runId) => runId === "run-a" });
		assert.deepEqual(
			pending.map((p) => p.revisionId),
			[b.id],
		);
		assert.ok(a.id);
	} finally {
		f.close();
	}
});

test("uncompactedForProject lists pending revisions of the project with no valid compact", () => {
	const f = fixture();
	try {
		const a = f.capture("run-a", 1, "/p/app");
		const b = f.capture("run-b", 1, "/p/app");
		const c = f.capture("run-c", 1, "/p/other");
		const file = compact(f, a);
		assert.deepEqual(
			uncompactedForProject(f.store.db, "/p/app", { root: f.root }).map((p) => p.revisionId),
			[b.id],
		);
		assert.deepEqual(
			uncompactedForProject(f.store.db, "/p/other", { root: f.root }).map((p) => p.revisionId),
			[c.id],
		);
		// A compact edited on disk is stale: the revision is uncompacted again.
		writeFileSync(join(f.root, file.path), "edited by hand");
		assert.deepEqual(
			uncompactedForProject(f.store.db, "/p/app", { root: f.root })
				.map((p) => p.revisionId)
				.sort(),
			[a.id, b.id].sort(),
		);
		// A compact made from other evidence is stale too.
		const b2 = f.capture("run-b", 2, "/p/app");
		const fileB = f.writeCompact(b2.id, "# compact b2");
		recordCompact(f.store.db, {
			revisionId: b2.id,
			compactPath: fileB.path,
			compactHash: fileB.hash,
			compactFingerprint: "0".repeat(64),
			compactedBy: "ask",
			compactedAt: "2026-11-05T12:00:00Z",
		});
		assert.ok(
			uncompactedForProject(f.store.db, "/p/app", { root: f.root })
				.map((p) => p.revisionId)
				.includes(b2.id),
		);
	} finally {
		f.close();
	}
});

test("a compact is findable by search, a compact edited after indexing is refused and the last index survives", () => {
	const f = fixture();
	try {
		const r = f.capture("run-a", 1, "/p/app");
		const file = compact(f, r);
		f.store.close();
		const scope = { project: "app", trusts: ["derived"] };
		assert.equal(syncSearchIndex(f.root).indexed, 1);
		const hits = searchMemory(f.root, "unicornfact", scope);
		assert.deepEqual(
			hits.map((h) => [h.id, h.kind]),
			[[`compact:${r.id}`, "compact"]],
		);
		writeFileSync(join(f.root, file.path), "# tampered\n\nfalsehood\n");
		assert.throws(() => syncSearchIndex(f.root), /hash mismatch/);
		const after = searchMemory(f.root, "unicornfact", scope, 6, { sync: false });
		assert.equal(after.length, 1, "the previous index survives the refusal");
		f.store = openOperationalStore(join(f.root, "memory.sqlite"), { legacy: true });
	} finally {
		f.close();
	}
});

test("a review file is indexed as kind review and refused when its hash differs from the committed one", () => {
	const f = fixture();
	try {
		const rel = "workflow/reviews/review-20261105T143000Z.md";
		const text = "# Review\n\nnarwhalpattern repeated\n";
		writeFileSync(join(f.root, rel), text);
		const entry = {
			id: "review:review-20261105T143000Z",
			kind: "review",
			project: "/p/app",
			projectSlug: "app",
			title: "Review",
			summary: "narwhal",
			status: "active",
			path: rel,
			createdAt: "2026-11-05T14:30:00Z",
			lastUsedAt: "2026-11-05T14:30:00Z",
		};
		f.store.db
			.prepare("INSERT INTO index_entries(id, seq, payload) VALUES (?, 0, ?)")
			.run(entry.id, JSON.stringify(entry));
		f.store.db
			.prepare("INSERT INTO artifact_commits(id, path, hash, state, created_at) VALUES (?, ?, ?, 'committed', ?)")
			.run("review-1", join(f.root, rel), sha(text), "2026-11-05T14:30:00Z");
		f.store.close();
		const scope = { project: "app", trusts: ["derived"] };
		syncSearchIndex(f.root);
		assert.deepEqual(
			searchMemory(f.root, "narwhalpattern", scope).map((h) => h.kind),
			["review"],
		);
		writeFileSync(join(f.root, rel), "# Review\n\nedited\n");
		assert.throws(() => syncSearchIndex(f.root), /hash mismatch/);
		assert.equal(searchMemory(f.root, "narwhalpattern", scope, 6, { sync: false }).length, 1);
		f.store = openOperationalStore(join(f.root, "memory.sqlite"), { legacy: true });
	} finally {
		f.close();
	}
});
