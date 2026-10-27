import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitArtifact, recoverArtifactCommits } from "../src/workflow/documents.ts";
import { backupOperationalState, openOperationalStore } from "../src/workflow/storage.ts";

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

test("backup preserves SQLite operational rows and canonical artifact bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-backup-"));
	try {
		const source = join(dir, "memory");
		const store = openOperationalStore(join(source, "memory.sqlite"));
		store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run("durable-run", "now");
		const artifact = commitArtifact({
			root: join(source, "documents"),
			id: "digest-2",
			kind: "digest",
			content: "# Kept evidence\\n",
		});
		const target = join(dir, "backup");
		backupOperationalState(store.db, join(source, "documents"), target);
		const restored = openOperationalStore(join(target, "memory.sqlite"));
		assert.equal(restored.db.prepare("SELECT id FROM runs").get()?.id, "durable-run");
		assert.equal(readFileSync(join(target, "documents", "digest-digest-2.md"), "utf8"), "# Kept evidence\\n");
		assert.equal(artifact.hash.length, 64);
		restored.close();
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
