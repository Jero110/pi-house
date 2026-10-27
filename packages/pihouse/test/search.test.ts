import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileSearch, searchDocuments } from "../src/workflow/search.ts";
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
