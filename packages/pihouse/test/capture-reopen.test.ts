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
import type { SessionRecord } from "agent-link-core";
import { captureRun, captureRunOutcome } from "../src/workflow/capture.ts";
import { commitDigest, runCleanup } from "../src/workflow/cleanup.ts";
import { type MemoryStore, openMemory } from "../src/workflow/memory.ts";
import { ACTIVE_MARKER } from "../src/workflow/migration.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

// Fake native pi JSONL sources only. A cleaned run is produced by the real digest commit and cleanup code, so the
// reopened revision is checked against the same receipts production writes.

const SECTIONS = [
	"objective",
	"participants",
	"decisions",
	"failures",
	"validations",
	"artifacts",
	"limitations",
	"candidates",
];
const RUN = "root-reopen";
const SESSION = "native-reopen";

function message(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text },
	});
}

function header(cwd: string, extra: Record<string, string> = {}): string {
	return JSON.stringify({ type: "session", id: SESSION, cwd, ...extra });
}

interface Fixture {
	home: string;
	memoryDir: string;
	source: string;
	root: SessionRecord;
	store: MemoryStore;
}

function setup(home: string, extraHeader: Record<string, string> = {}): Fixture {
	const source = join(home, "native.jsonl");
	writeFileSync(source, `${header(home, extraHeader)}\n${message("m1", "first-note")}\n`);
	const root: SessionRecord = {
		id: RUN,
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: RUN,
		harness: "pihouse",
		model: null,
		cwd: home,
		state: "exited",
		depth: 0,
		sessionId: SESSION,
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
	const memoryDir = join(home, "memory");
	mkdirSync(memoryDir, { recursive: true });
	// Activation is written after the store opens, as in evidence.test.ts: an active marker without its database throws.
	const store = openMemory(memoryDir);
	writeFileSync(join(memoryDir, ACTIVE_MARKER), JSON.stringify({ active: true }));
	return { home, memoryDir, source, root, store };
}

/** Commits a digest for the newest revision and cleans its captured copies through the production functions. */
function cleanNewestRevision(fixture: Fixture): void {
	const operational = openOperationalStore(join(fixture.memoryDir, "memory.sqlite"), { fts: false, legacy: true });
	try {
		const row = operational.db
			.prepare("SELECT id, source_hash FROM revisions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.get(RUN);
		const revision = String(row?.id);
		const fingerprint = String(row?.source_hash);
		const runDir = join(fixture.memoryDir, "runs", RUN);
		const pkg = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { project: string; cursor: unknown };
		const committed = commitDigest(operational.db, {
			ownedRoot: fixture.memoryDir,
			digestRoot: join(fixture.memoryDir, "digests"),
			identity: { runId: RUN, project: pkg.project, revision },
			digest: {
				text: JSON.stringify({
					schemaVersion: 1,
					runId: RUN,
					project: pkg.project,
					revision,
					sections: Object.fromEntries(SECTIONS.map((key) => [key, `${key} text`])),
				}),
				finish: "stop",
			},
			currentFingerprint: fingerprint,
			expectedFiles: readdirSync(join(runDir, "transcripts")).sort(),
			cursors: pkg.cursor,
		});
		assert.equal(committed.status, "committed");
		assert.equal(
			runCleanup(operational.db, { ownedRoot: fixture.memoryDir, id: revision, currentFingerprint: fingerprint })
				.status,
			"cleaned",
		);
	} finally {
		operational.close();
	}
}

function revisionCount(memoryDir: string): number {
	const operational = openOperationalStore(join(memoryDir, "memory.sqlite"), { fts: false, legacy: true });
	try {
		return Number(operational.db.prepare("SELECT count(*) AS n FROM revisions WHERE run_id = ?").get(RUN)?.n);
	} finally {
		operational.close();
	}
}

function capturedText(memoryDir: string): string {
	const dir = join(memoryDir, "runs", RUN, "transcripts");
	return readdirSync(dir)
		.map((name) => readFileSync(join(dir, name), "utf8"))
		.join("\n");
}

test("a cleaned run that gained lines is reopened as one new revision holding only the appended delta", () => {
	const home = mkdtempSync(join(tmpdir(), "capture-reopen-delta-"));
	try {
		const fixture = setup(home);
		const { store } = fixture;
		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "written");
		cleanNewestRevision(fixture);
		assert.equal(existsSync(join(fixture.memoryDir, "runs", RUN, "transcripts")), false);

		appendFileSync(fixture.source, `${message("m2", "second-note")}\n`);
		const outcome = captureRunOutcome([fixture.root], fixture.root, store, { by: "planner" });
		assert.equal(outcome.status, "written");
		assert.equal(revisionCount(fixture.memoryDir), 2);
		const pkg = JSON.parse(readFileSync(join(fixture.memoryDir, "runs", RUN, "run.json"), "utf8")) as {
			revision: number;
		};
		assert.equal(pkg.revision, 2);
		const text = capturedText(fixture.memoryDir);
		assert.ok(text.includes("second-note"));
		assert.ok(!text.includes("first-note"));
		assert.equal(store.readIndex().find((entry) => entry.id === `run:${RUN}`)?.status, "pending");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a cleaned run with no new evidence is discarded without a new revision", () => {
	const home = mkdtempSync(join(tmpdir(), "capture-reopen-same-"));
	try {
		const fixture = setup(home);
		const { store } = fixture;
		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "written");
		cleanNewestRevision(fixture);
		const before = readFileSync(join(fixture.memoryDir, "runs", RUN, "run.json"), "utf8");

		assert.equal(captureRunOutcome([fixture.root], fixture.root, store, { by: "planner" }).status, "discarded");
		assert.equal(revisionCount(fixture.memoryDir), 1);
		assert.equal(readFileSync(join(fixture.memoryDir, "runs", RUN, "run.json"), "utf8"), before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a truncated native source defers the reopened run with a reason and writes nothing", () => {
	const home = mkdtempSync(join(tmpdir(), "capture-reopen-truncated-"));
	try {
		const fixture = setup(home);
		const { store } = fixture;
		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "written");
		cleanNewestRevision(fixture);
		writeFileSync(fixture.source, `${header(home)}\n`);

		const outcome = captureRunOutcome([fixture.root], fixture.root, store, { by: "planner" });
		assert.equal(outcome.status, "deferred");
		assert.match(outcome.status === "deferred" ? outcome.reason : "", /truncated|rotated|changed|prefix/);
		assert.equal(revisionCount(fixture.memoryDir), 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a cleaned fork whose parent lineage is not retained defers the reopened run", () => {
	const home = mkdtempSync(join(tmpdir(), "capture-reopen-fork-"));
	try {
		const fixture = setup(home, { parentSession: "missing-parent" });
		const { store } = fixture;
		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "written");
		cleanNewestRevision(fixture);
		appendFileSync(fixture.source, `${message("m2", "second-note")}\n`);

		const outcome = captureRunOutcome([fixture.root], fixture.root, store, { by: "planner" });
		assert.equal(outcome.status, "deferred");
		assert.match(outcome.status === "deferred" ? outcome.reason : "", /fork/);
		assert.equal(revisionCount(fixture.memoryDir), 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a legacy processed run without a cleanup receipt stays processed", () => {
	const home = mkdtempSync(join(tmpdir(), "capture-reopen-legacy-"));
	try {
		const fixture = setup(home);
		const { store } = fixture;
		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "written");
		store.markProcessed([RUN], "batch-legacy");
		appendFileSync(fixture.source, `${message("m2", "second-note")}\n`);

		assert.equal(captureRun([fixture.root], fixture.root, store, { by: "planner" }), "processed");
		assert.equal(revisionCount(fixture.memoryDir), 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
