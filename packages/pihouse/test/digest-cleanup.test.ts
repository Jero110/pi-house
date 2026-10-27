import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	capturedAdmission,
	cleanedCursors,
	cleanupAdapter,
	commitDigest,
	runCleanup,
} from "../src/workflow/cleanup.ts";
import { DIGEST_SECTIONS } from "../src/workflow/digest-contract.ts";
import { dispatchCleanup, dispatchJobs, enqueueJob } from "../src/workflow/jobs.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";

const identity = { runId: "run-1", project: "demo", revision: "rev-1" };
const FILES = ["planner.jsonl", "worker.jsonl"];

function digestText(overrides: Record<string, unknown> = {}): string {
	const sections = Object.fromEntries(DIGEST_SECTIONS.map((key) => [key, `${key} text`]));
	return JSON.stringify({ schemaVersion: 1, ...identity, sections, ...overrides });
}

interface Fixture {
	dir: string;
	owned: string;
	digests: string;
	transcripts: string;
	store: OperationalStore;
	outside: string;
	fingerprint: string;
}

function fixture(options: { metrics?: boolean; lineage?: boolean } = {}): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "digest-cleanup-"));
	const owned = join(dir, "memory");
	const transcripts = join(owned, "runs", identity.runId, "transcripts");
	mkdirSync(transcripts, { recursive: true });
	for (const name of FILES) writeFileSync(join(transcripts, name), `conversation ${name}\n`);
	const outside = join(dir, "native-session.jsonl");
	writeFileSync(outside, "native harness session\n");
	const store = openOperationalStore(join(owned, "memory.sqlite"), { fts: false });
	const fingerprint = "source-hash-1";
	const now = "2026-01-01T00:00:00Z";
	store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(identity.runId, now);
	store.db
		.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
		.run(identity.revision, identity.runId, fingerprint, now);
	if (options.metrics !== false)
		store.db
			.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES (?, ?, ?, ?)")
			.run("m1", identity.revision, "tokens", JSON.stringify({ input: 10, output: 5 }));
	if (options.lineage !== false)
		store.db
			.prepare("INSERT INTO participants(id, revision_id, role, payload) VALUES (?, ?, ?, ?)")
			.run("p1", identity.revision, "planner", JSON.stringify({ parent: null }));
	return { dir, owned, digests: join(owned, "digests"), transcripts, store, outside, fingerprint };
}

function done(f: Fixture): void {
	f.store.close();
	rmSync(f.dir, { recursive: true, force: true });
}

function commit(f: Fixture, overrides: Partial<Parameters<typeof commitDigest>[1]> = {}) {
	return commitDigest(f.store.db, {
		ownedRoot: f.owned,
		digestRoot: f.digests,
		identity,
		digest: { text: digestText(), finish: "stop" },
		currentFingerprint: f.fingerprint,
		expectedFiles: FILES,
		...overrides,
	});
}

const listed = (f: Fixture) => (existsSync(f.transcripts) ? readdirSync(f.transcripts).sort() : []);
const manifestRow = (f: Fixture) =>
	f.store.db.prepare("SELECT state, payload FROM cleanup_manifests WHERE id = ?").get(identity.revision);

test("a verified digest commit records a receipt and cleanup deletes exactly the manifest files", () => {
	const f = fixture();
	try {
		const committed = commit(f);
		assert.equal(committed.status, "committed");
		assert.equal(manifestRow(f)?.state, "committed");
		assert.deepEqual(listed(f), FILES, "commit alone deletes nothing");
		const result = runCleanup(f.store.db, {
			ownedRoot: f.owned,
			id: identity.revision,
			currentFingerprint: f.fingerprint,
		});
		assert.equal(result.status, "cleaned");
		assert.deepEqual(listed(f), []);
		assert.ok(existsSync(f.outside));
		assert.equal(manifestRow(f)?.state, "cleaned");
		if (committed.status === "committed")
			assert.equal(createHash("sha256").update(readFileSync(committed.path)).digest("hex"), committed.hash);
	} finally {
		done(f);
	}
});

test("malformed, wrong-identity or cut-off digests never reach a receipt", () => {
	const f = fixture();
	try {
		for (const bad of [
			commit(f, { digest: { text: "{not json", finish: "stop" } }),
			commit(f, { digest: { text: digestText({ runId: "other" }), finish: "stop" } }),
			commit(f, { digest: { text: digestText(), finish: "length" } }),
		])
			assert.equal(bad.status, "blocked");
		assert.equal(manifestRow(f), undefined);
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("missing metrics or lineage block the receipt and invalid metrics block deletion", () => {
	for (const options of [{ metrics: false }, { lineage: false }]) {
		const f = fixture(options);
		try {
			assert.equal(commit(f).status, "blocked");
			assert.equal(manifestRow(f), undefined);
			assert.deepEqual(listed(f), FILES);
		} finally {
			done(f);
		}
	}
	const f = fixture();
	try {
		assert.equal(commit(f).status, "committed");
		f.store.db.prepare("UPDATE metrics SET value = 'not json' WHERE revision_id = ?").run(identity.revision);
		assert.equal(
			runCleanup(f.store.db, { ownedRoot: f.owned, id: identity.revision, currentFingerprint: f.fingerprint }).status,
			"blocked",
		);
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("source drift defers the receipt and blocks a committed cleanup", () => {
	const f = fixture();
	try {
		assert.equal(commit(f, { currentFingerprint: "drifted" }).status, "deferred");
		assert.equal(manifestRow(f), undefined);
		assert.equal(commit(f).status, "committed");
		const result = runCleanup(f.store.db, { ownedRoot: f.owned, id: identity.revision, currentFingerprint: "drifted" });
		assert.equal(result.status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("incomplete or unaccounted coverage prevents the manifest", () => {
	const f = fixture();
	try {
		assert.equal(commit(f, { expectedFiles: [...FILES, "missing.jsonl"] }).status, "blocked");
		writeFileSync(join(f.transcripts, "extra.jsonl"), "not captured by this revision\n");
		assert.equal(commit(f).status, "blocked");
		assert.equal(manifestRow(f), undefined);
		assert.equal(listed(f).length, 3);
	} finally {
		done(f);
	}
});

test("symlinked files, nested directories and escaping expected names are refused", () => {
	const f = fixture();
	try {
		rmSync(join(f.transcripts, "worker.jsonl"));
		symlinkSync(f.outside, join(f.transcripts, "worker.jsonl"));
		assert.equal(commit(f).status, "blocked");
		assert.equal(readFileSync(f.outside, "utf8"), "native harness session\n");
		assert.equal(commit(f, { expectedFiles: ["../../../../native-session.jsonl"] }).status, "blocked");
		assert.equal(commit(f, { expectedFiles: ["sub/file.jsonl"] }).status, "blocked");
		assert.equal(manifestRow(f), undefined);
	} finally {
		done(f);
	}
});

test("a transcripts directory that is a symlink out of the owned root is refused", () => {
	const f = fixture();
	try {
		const real = join(f.dir, "project-files");
		mkdirSync(real);
		for (const name of FILES) writeFileSync(join(real, name), "project data\n");
		rmSync(f.transcripts, { recursive: true });
		symlinkSync(real, f.transcripts);
		assert.equal(commit(f).status, "blocked");
		assert.deepEqual(readdirSync(real).sort(), FILES);
	} finally {
		done(f);
	}
});

test("a tampered manifest naming paths outside the capture dir deletes nothing", () => {
	const f = fixture();
	try {
		assert.equal(commit(f).status, "committed");
		const row = manifestRow(f);
		const payload = JSON.parse(String(row?.payload)) as { files: { name: string; sha256: string }[] };
		payload.files.push({ name: "../../../native-session.jsonl", sha256: "0" });
		f.store.db
			.prepare("UPDATE cleanup_manifests SET payload = ? WHERE id = ?")
			.run(JSON.stringify(payload), identity.revision);
		const result = runCleanup(f.store.db, {
			ownedRoot: f.owned,
			id: identity.revision,
			currentFingerprint: f.fingerprint,
		});
		assert.equal(result.status, "blocked");
		assert.ok(existsSync(f.outside));
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a copy changed after the manifest was hashed is kept", () => {
	const f = fixture();
	try {
		assert.equal(commit(f).status, "committed");
		writeFileSync(join(f.transcripts, "worker.jsonl"), "appended after the digest\n");
		assert.equal(
			runCleanup(f.store.db, { ownedRoot: f.owned, id: identity.revision, currentFingerprint: f.fingerprint }).status,
			"blocked",
		);
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a corrupted digest file blocks deletion", () => {
	const f = fixture();
	try {
		const committed = commit(f);
		assert.equal(committed.status, "committed");
		if (committed.status !== "committed") return;
		writeFileSync(committed.path, "tampered");
		assert.equal(
			runCleanup(f.store.db, { ownedRoot: f.owned, id: identity.revision, currentFingerprint: f.fingerprint }).status,
			"blocked",
		);
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a crash between receipt and delete, or mid-delete, recovers idempotently", () => {
	const f = fixture();
	try {
		assert.equal(commit(f).status, "committed");
		// Crash after the receipt: nothing deleted yet. Simulate a crash mid-delete: one file already gone.
		rmSync(join(f.transcripts, "planner.jsonl"));
		const input = { ownedRoot: f.owned, id: identity.revision, currentFingerprint: f.fingerprint };
		assert.equal(runCleanup(f.store.db, input).status, "cleaned");
		assert.deepEqual(listed(f), []);
		assert.equal(runCleanup(f.store.db, input).status, "cleaned");
		assert.equal(commit(f).status, "committed", "re-committing a cleaned revision is idempotent");
		assert.equal(manifestRow(f)?.state, "cleaned");
	} finally {
		done(f);
	}
});

test("a failed cleanup retries through the jobs port without another digest model call", async () => {
	const f = fixture();
	try {
		enqueueJob(f.store.db, "job-1", identity.revision, f.fingerprint);
		let modelCalls = 0;
		const options = { invocation: "manual-1", now: () => 0, leaseMs: 10, maxJobs: 1 };
		const digestPath = join(f.digests, "run-1", "digest-rev-1.md");
		const generated = await dispatchJobs(
			f.store.db,
			[
				{
					id: "job-1",
					revision: identity.revision,
					evidencePath: join(f.transcripts, FILES[0]),
					fingerprint: f.fingerprint,
				},
			],
			{
				...options,
				adapter: async () => {
					modelCalls++;
					const committed = commit(f);
					assert.equal(committed.status, "committed");
					return { status: "success", artifactPath: digestPath, fingerprint: f.fingerprint };
				},
			},
		);
		assert.deepEqual(generated, [{ id: "job-1", status: "generated", path: digestPath }]);
		let drift = "drifted";
		const adapter = cleanupAdapter(f.store.db, { ownedRoot: f.owned, currentFingerprint: () => drift });
		const first = await dispatchCleanup(f.store.db, "job-1", { ...options, adapter });
		assert.equal(first.status, "cleanup-failed");
		assert.deepEqual(listed(f), FILES);
		drift = f.fingerprint;
		const second = await dispatchCleanup(f.store.db, "job-1", { ...options, adapter });
		assert.equal(second.status, "cleaned");
		assert.deepEqual(listed(f), []);
		assert.equal(modelCalls, 1);
	} finally {
		done(f);
	}
});

test("a cleaned revision cannot silently return and a reopened run starts at the retained cursor", () => {
	const f = fixture();
	try {
		const cursors = {
			s1: {
				sourceKind: "jsonl",
				sourceId: "s1",
				byteOffset: 42,
				prefixFingerprint: "abc",
				recordCount: 3,
				forkedFrom: null,
			},
		};
		assert.equal(capturedAdmission(f.store.db, identity.runId, f.fingerprint), "admit");
		assert.equal(commit(f, { cursors }).status, "committed");
		assert.equal(capturedAdmission(f.store.db, identity.runId, f.fingerprint), "admit", "not cleaned yet");
		assert.deepEqual(cleanedCursors(f.store.db, identity.runId), undefined);
		runCleanup(f.store.db, { ownedRoot: f.owned, id: identity.revision, currentFingerprint: f.fingerprint });
		assert.equal(capturedAdmission(f.store.db, identity.runId, f.fingerprint), "discarded");
		assert.equal(capturedAdmission(f.store.db, identity.runId, "later-evidence"), "admit");
		assert.deepEqual(cleanedCursors(f.store.db, identity.runId), cursors);
	} finally {
		done(f);
	}
});
