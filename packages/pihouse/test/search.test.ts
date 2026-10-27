import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openMemory, type RunPackage } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { reconcileSearch, searchDocuments, searchMemory, syncSearchIndex } from "../src/workflow/search.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

test("reconciles canonical documents and searches only authorized active trusted scope", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-search-"));
	const store = openOperationalStore(join(dir, "memory.sqlite"));
	try {
		const path = join(dir, "digest.md");
		writeFileSync(path, "A body containing the unique nebula evidence.");
		const doc = {
			id: "one",
			path,
			kind: "digest",
			project: "alpha",
			status: "active",
			trust: "derived",
			title: "Report",
			summary: "Summary",
			provenance: "run one",
			date: "2025-01-01",
		};
		reconcileSearch(store, [
			doc,
			{ ...doc, id: "other", project: "beta" },
			{ ...doc, id: "inactive", status: "rejected" },
			{ ...doc, id: "raw", kind: "transcript" },
			{ ...doc, id: "external", trust: "external" },
		]);
		const scope = { project: "alpha", trusts: ["derived"] };
		const hits = searchDocuments(store, "nebula", scope);
		assert.deepEqual(
			hits.map((hit) => hit.id),
			["one"],
		);
		assert.match(hits[0].extract, /nebula/);
		assert.equal(hits[0].provenance, "run one");
		assert.ok(hits[0].reason);
		assert.deepEqual(searchDocuments(store, '"broken', scope), []);
		assert.equal(searchDocuments(store, "Report", scope).length, 1);
		assert.equal(searchDocuments(store, "Summary", scope).length, 1);
		assert.equal(searchDocuments(store, '"unique nebula"', scope).length, 1);
		assert.equal(searchDocuments(store, '"nebula unique"', scope).length, 0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reconciliation preserves operational rows and surfaces missing or mismatched documents", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-rebuild-"));
	const store = openOperationalStore(join(dir, "memory.sqlite"));
	try {
		store.db.prepare("INSERT INTO jobs(id,state,payload) VALUES ('job','failed','attempts')").run();
		const path = join(dir, "doc.md");
		writeFileSync(path, "first word");
		const doc = {
			id: "one",
			path,
			kind: "digest",
			project: "alpha",
			status: "active",
			trust: "derived",
			title: "T",
			summary: "S",
			provenance: "P",
			date: "now",
		};
		reconcileSearch(store, [doc]);
		writeFileSync(path, "second word");
		reconcileSearch(store, [doc]);
		assert.equal(searchDocuments(store, "second", { project: "alpha", trusts: ["derived"] }).length, 1);
		assert.equal(store.db.prepare("SELECT payload FROM jobs WHERE id='job'").get()?.payload, "attempts");
		assert.throws(() => reconcileSearch(store, [{ ...doc, hash: "0".repeat(64) }]), /hash/i);
		rmSync(path);
		assert.throws(() => reconcileSearch(store, [doc]));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("search bounds output and propagates index failures", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-bounds-"));
	const store = openOperationalStore(join(dir, "memory.sqlite"));
	try {
		const path = join(dir, "doc.md");
		writeFileSync(path, `needle ${"x".repeat(5000)}`);
		const doc = {
			id: "one",
			path,
			kind: "digest",
			project: "alpha",
			status: "active",
			trust: "derived",
			title: "needle",
			summary: "",
			provenance: "p".repeat(2000),
			date: "now",
		};
		reconcileSearch(
			store,
			Array.from({ length: 10 }, (_, i) => ({ ...doc, id: `id-${i}` })),
		);
		const scope = { project: "alpha", trusts: ["derived"] };
		const hits = searchDocuments(store, "needle", scope, 999);
		assert.equal(hits.length, 6);
		assert.ok(hits.reduce((sum, hit) => sum + hit.extract.length, 0) <= 6000);
		assert.ok(hits.every((hit) => hit.provenance.length <= 512));
		store.db.exec("DROP TABLE search_fts");
		assert.throws(() => searchDocuments(store, "needle", scope));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

function run(id: string): RunPackage {
	return {
		schema: 1,
		id,
		project: "/abs/p",
		projectSlug: "p",
		flaggedBy: "save",
		capturedAt: "2026-10-26T12:00:00Z",
		title: `Run ${id}`,
		metrics: { newTokens: 1, cacheRead: 0, activeMs: 1, wallMs: 1, agents: 1, messages: 1 },
		agents: [],
	};
}

/** A migrated store with a digest, a consulted source, an idea, an approved and a pending proposal. */
function activated(): { dir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pihouse-sync-"));
	const dir = join(root, "memory");
	const mem = openMemory(dir);
	mem.writeRun(run("r1"), [{ agentId: "a1", normalized: { messages: ["TRANSCRIPTSECRET zebra"] } }]);
	mem.writeDigest("r1", "---\nsummary: digest summary\n---\n\nThe digest mentions quasar behaviour.");
	const meta = { title: "Src", project: "/abs/p", projectSlug: "p" };
	mem.writeConsulted({ ...meta, id: "src1" }, "external pulsar text", "consulted summary");
	mem.writeIdea({ ...meta, id: "idea1", title: "Idea" }, "idea about comet caching");
	const a = mem.propose({ kind: "memory-rule", target: "m", change: "approved nebula rule", evidence: "e" });
	mem.propose({ kind: "memory-rule", target: "m", change: "pending vortex rule", evidence: "e" });
	if (a.result === "created") mem.decide(a.id, "approved");
	migrateLegacyStore(dir);
	return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("syncSearchIndex builds the inventory from the activated store, excluding transcripts and unapproved records", () => {
	const { dir, cleanup } = activated();
	try {
		const result = syncSearchIndex(dir);
		assert.equal(result.mode, "full");
		const scope = { project: "p", trusts: ["derived", "external"], includeGlobal: true };
		const ids = (q: string) => searchMemory(dir, q, scope).map((h) => h.id);
		assert.deepEqual(ids("quasar"), ["digest:r1"]);
		assert.deepEqual(ids("pulsar"), ["consulted:src1"]);
		assert.deepEqual(ids("comet"), ["idea:idea1"]);
		assert.equal(ids("nebula").length, 1, "approved global proposal");
		assert.deepEqual(ids("vortex"), []);
		assert.deepEqual(ids("TRANSCRIPTSECRET"), []);
		assert.deepEqual(searchMemory(dir, "pulsar", { project: "p", trusts: ["derived"] }), []);
		assert.deepEqual(searchMemory(dir, "quasar", { project: "other", trusts: ["derived"] }), []);
	} finally {
		cleanup();
	}
});

test("syncSearchIndex reindexes only changed documents and drops removed ones", () => {
	const { dir, cleanup } = activated();
	try {
		syncSearchIndex(dir);
		const same = syncSearchIndex(dir);
		assert.deepEqual([same.mode, same.indexed, same.removed], ["incremental", 0, 0]);
		writeFileSync(join(dir, "digests/r1.md"), "---\nsummary: digest summary\n---\n\nNow about supernova.");
		const changed = syncSearchIndex(dir);
		assert.deepEqual([changed.indexed, changed.removed], [1, 0]);
		const scope = { project: "p", trusts: ["derived"] };
		assert.equal(searchMemory(dir, "quasar", scope).length, 0);
		assert.equal(searchMemory(dir, "supernova", scope).length, 1);
		rmSync(join(dir, "ideas/idea1.md"));
		assert.throws(() => syncSearchIndex(dir), /idea:idea1/);
		assert.equal(searchMemory(dir, "supernova", scope, 6, { sync: false }).length, 1, "last good index kept");
	} finally {
		cleanup();
	}
});

test("syncSearchIndex rebuilds a damaged search index and never touches operational tables", () => {
	const { dir, cleanup } = activated();
	try {
		syncSearchIndex(dir);
		const store = openOperationalStore(join(dir, "memory.sqlite"), { legacy: true });
		const before = store.db.prepare("SELECT count(*) AS n FROM index_entries").get()?.n;
		store.db.prepare("INSERT INTO jobs(id,state,payload) VALUES ('j','failed','x')").run();
		store.db.exec("DROP TABLE search_fts");
		store.close();
		const result = syncSearchIndex(dir);
		assert.equal(result.mode, "full");
		const after = openOperationalStore(join(dir, "memory.sqlite"), { legacy: true });
		assert.equal(after.db.prepare("SELECT count(*) AS n FROM index_entries").get()?.n, before);
		assert.equal(after.db.prepare("SELECT payload FROM jobs WHERE id='j'").get()?.payload, "x");
		after.close();
		assert.equal(searchMemory(dir, "quasar", { project: "p", trusts: ["derived"] }).length, 1);
		assert.equal(syncSearchIndex(dir, { full: true }).mode, "full");
	} finally {
		cleanup();
	}
});

test("syncSearchIndex refuses non-activated, missing and corrupt stores with a diagnosis", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-refuse-"));
	try {
		const legacyDir = join(root, "legacy");
		openMemory(legacyDir).writeIdea({ id: "i", title: "t", project: "p", projectSlug: "p" }, "body");
		assert.throws(() => syncSearchIndex(legacyDir), /not activated|migrate/i);
		assert.equal(
			openOperationalStore(join(legacyDir, "memory.sqlite"))
				.db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_fts'")
				.get(),
			undefined,
		);
		const { dir, cleanup } = activated();
		try {
			writeFileSync(join(dir, "memory.sqlite"), "not a database");
			assert.throws(() => syncSearchIndex(dir), /corrupt|not an activated/i);
			rmSync(join(dir, "memory.sqlite"));
			assert.throws(() => syncSearchIndex(dir), /missing|restore/i);
		} finally {
			cleanup();
		}
		mkdirSync(join(root, "empty"));
		assert.throws(() => syncSearchIndex(join(root, "empty")), /not activated|migrate/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncSearchIndex refuses index paths that leave memory or name a transcript", () => {
	const { dir, cleanup } = activated();
	try {
		const setPath = (path: string) => {
			const store = openOperationalStore(join(dir, "memory.sqlite"), { legacy: true });
			const row = store.db.prepare("SELECT payload FROM index_entries WHERE id = 'digest:r1'").get() as {
				payload: string;
			};
			store.db
				.prepare("UPDATE index_entries SET payload = ? WHERE id = 'digest:r1'")
				.run(JSON.stringify({ ...(JSON.parse(row.payload) as { path: string }), path }));
			store.close();
		};
		setPath("../../escaped.md");
		assert.throws(() => syncSearchIndex(dir), /outside the memory directory/);
		setPath("digests/transcripts/r1.md");
		assert.throws(() => syncSearchIndex(dir), /outside the memory directory/);
	} finally {
		cleanup();
	}
});

test("syncSearchIndex surfaces a body that no longer matches its committed hash", () => {
	const { dir, cleanup } = activated();
	try {
		const store = openOperationalStore(join(dir, "memory.sqlite"), { legacy: true });
		store.db
			.prepare("INSERT INTO artifact_commits(id,path,hash,state,created_at) VALUES ('c',?,?,'committed','now')")
			.run(join(dir, "digests/r1.md"), "0".repeat(64));
		store.close();
		assert.throws(() => syncSearchIndex(dir), /hash mismatch.*digest:r1/i);
	} finally {
		cleanup();
	}
});
