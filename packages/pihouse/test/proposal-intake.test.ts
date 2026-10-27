import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingestReview } from "../src/workflow/proposal-intake.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

const block = (refs: string[], reopen?: string) =>
	`Review output\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, proposals: [{ kind: "skill", scope: "project", target: "skill:sample", before: "old", after: "new", supporting: refs, opposing: [], conditions: [], uncertainty: "low", validation: "npm test", ...(reopen ? { reopen } : {}) }] })}\n\`\`\``;

test("intake deduplicates run lineage evidence, is idempotent and records failed malformed intake", () => {
	const dir = mkdtempSync(join(tmpdir(), "proposal-intake-"));
	const store = openOperationalStore(join(dir, "db.sqlite"), { fts: false });
	try {
		for (const [rev, run] of [
			["r1", "run1"],
			["r2", "run2"],
			["r3", "run3"],
		]) {
			store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(run, "now");
			store.db
				.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(rev, run, "h", "now");
		}
		const review = block(["r1", "r2", "r3"]);
		assert.deepEqual(ingestReview(store.db, "review1", review), {
			status: "ingested",
			created: 1,
			merged: 0,
			suppressed: 0,
		});
		assert.deepEqual(ingestReview(store.db, "review1", review), {
			status: "ingested",
			created: 1,
			merged: 0,
			suppressed: 0,
		});
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get()?.n, 1);
		assert.deepEqual(ingestReview(store.db, "broken", "no contract"), {
			status: "failed",
			reason: "Error: expected exactly one fenced JSON block",
		});
		assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'intake-failure'").get()?.n, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
