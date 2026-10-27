import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitArtifact, recoverArtifactCommits } from "../src/workflow/documents.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

test("operational schema migrates and retains state across reopen", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-storage-"));
	try {
		const dbPath = join(dir, "memory.sqlite");
		const first = openOperationalStore(dbPath);
		first.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run("run-1", "now");
		first.close();
		const second = openOperationalStore(dbPath);
		assert.equal(second.db.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1);
		assert.equal(second.version, 1);
		second.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("artifact commit uses private storage and recovers a durable file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-artifact-"));
	try {
		const store = openOperationalStore(join(dir, "memory.sqlite"));
		const committed = commitArtifact({
			root: join(dir, "memory"),
			id: "digest-1",
			kind: "digest",
			content: "# Evidence\n",
		});
		assert.equal(committed.hash.length, 64);
		assert.deepEqual(recoverArtifactCommits(store.db, join(dir, "memory")), ["digest-1"]);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FTS capability failure is diagnostic and leaves existing database bytes intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-ftS-"));
	try {
		const path = join(dir, "memory.sqlite");
		const store = openOperationalStore(path, { fts: false });
		assert.equal(store.fts.available, false);
		assert.match(store.fts.diagnostic ?? "", /FTS5/i);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
