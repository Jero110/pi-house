import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupReviewed } from "../src/workflow/cleanup.ts";
import { markReviewed, recordCompact } from "../src/workflow/run-stages.ts";
import { type OperationalStore, openOperationalStore } from "../src/workflow/storage.ts";

const RUN = "run-1";
const REV = "run-1.r1";
const FILES = ["planner.jsonl", "worker.jsonl"];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Fixture {
	dir: string;
	root: string;
	transcripts: string;
	runDir: string;
	compact: string;
	store: OperationalStore;
}

function fixture(options: { review?: boolean; compactedBy?: "review" | "ask" } = {}): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "review-cleanup-"));
	const root = join(dir, "memory");
	const runDir = join(root, "conversations", RUN);
	const transcripts = join(runDir, "transcripts");
	mkdirSync(transcripts, { recursive: true });
	for (const name of FILES) writeFileSync(join(transcripts, name), `conversation ${name}\n`);
	writeFileSync(join(runDir, "run.json"), "{}\n");
	writeFileSync(join(runDir, "report.md"), "report\n");
	mkdirSync(join(root, "workflow", "compact"), { recursive: true });
	mkdirSync(join(root, "workflow", "reviews"), { recursive: true });
	const compact = join(root, "workflow", "compact", `${REV}.md`);
	writeFileSync(compact, "compact text\n");
	writeFileSync(join(root, "workflow", "reviews", "review-1.md"), "review text\n");
	const store = openOperationalStore(join(root, "memory.sqlite"), { legacy: true, fts: false });
	const now = "2026-01-01T00:00:00Z";
	store.db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?)").run(RUN, now);
	store.db
		.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)")
		.run(REV, RUN, "fp-1", now);
	recordCompact(store.db, {
		revisionId: REV,
		compactPath: `workflow/compact/${REV}.md`,
		compactHash: sha("compact text\n"),
		compactFingerprint: "fp-1",
		compactedBy: options.compactedBy ?? "review",
		compactedAt: now,
	});
	if (options.review !== false) markReviewed(store.db, [REV], "review-1");
	return { dir, root, transcripts, runDir, compact, store };
}

const done = (f: Fixture) => {
	f.store.close();
	rmSync(f.dir, { recursive: true, force: true });
};
const listed = (f: Fixture) => (existsSync(f.transcripts) ? readdirSync(f.transcripts).sort() : []);
const run = (f: Fixture, overrides: Partial<Parameters<typeof cleanupReviewed>[1]> = {}) =>
	cleanupReviewed(f.store.db, {
		root: f.root,
		revisionId: REV,
		currentFingerprint: "fp-1",
		quiescent: true,
		...overrides,
	});
const receipt = (f: Fixture) =>
	f.store.db.prepare("SELECT state, payload FROM cleanup_manifests WHERE id = ?").get(REV);

test("a reviewed, quiescent revision with a matching compact deletes only the owned copies", () => {
	const f = fixture();
	try {
		const result = run(f);
		assert.deepEqual(result, { status: "cleaned", id: REV, deleted: 2 });
		assert.deepEqual(listed(f), []);
		assert.equal(receipt(f)?.state, "cleaned");
		for (const keep of [join(f.runDir, "run.json"), join(f.runDir, "report.md"), f.compact])
			assert.ok(existsSync(keep), keep);
		assert.ok(existsSync(join(f.root, "workflow", "reviews", "review-1.md")));
	} finally {
		done(f);
	}
});

test("a revision compacted by ask and not reviewed is never deleted", () => {
	const f = fixture({ review: false, compactedBy: "ask" });
	try {
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), FILES);
		assert.equal(receipt(f), undefined, "no receipt without a review");
	} finally {
		done(f);
	}
});

test("a revision with no compact at all is never deleted", () => {
	const f = fixture();
	try {
		f.store.db.prepare("DELETE FROM run_stages").run();
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

for (const [name, tamper] of [
	["edited", (f: Fixture) => writeFileSync(f.compact, "edited\n")],
	["removed", (f: Fixture) => unlinkSync(f.compact)],
] as const) {
	test(`a reviewed revision whose compact file was ${name} is never deleted`, () => {
		const f = fixture();
		try {
			tamper(f);
			assert.equal(run(f).status, "blocked");
			assert.deepEqual(listed(f), FILES);
		} finally {
			done(f);
		}
	});
}

test("a compact recorded with a different hash is never deleted", () => {
	const f = fixture();
	try {
		f.store.db.prepare("UPDATE run_stages SET compact_hash = ?").run(sha("something else"));
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a changed evidence fingerprint blocks deletion and is reported", () => {
	const f = fixture();
	try {
		const result = run(f, { currentFingerprint: "fp-2" });
		assert.equal(result.status, "blocked");
		assert.match(result.status === "blocked" ? result.reason : "", /evidence changed/);
		assert.deepEqual(listed(f), FILES);
		// Captured again: the stored revision no longer matches the compact either.
		f.store.db.prepare("UPDATE revisions SET source_hash = 'fp-2' WHERE id = ?").run(REV);
		assert.equal(run(f, { currentFingerprint: "fp-2" }).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("an active run is never cleaned", () => {
	const f = fixture();
	try {
		assert.equal(run(f, { quiescent: false }).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a symlinked transcripts directory is refused with no deletion", () => {
	const f = fixture();
	try {
		const elsewhere = join(f.dir, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "planner.jsonl"), "keep\n");
		rmSync(f.transcripts, { recursive: true });
		symlinkSync(elsewhere, f.transcripts);
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(readdirSync(elsewhere), ["planner.jsonl"]);
	} finally {
		done(f);
	}
});

test("a symlinked file inside transcripts is refused with no deletion", () => {
	const f = fixture();
	try {
		const target = join(f.dir, "native-session.jsonl");
		writeFileSync(target, "native\n");
		unlinkSync(join(f.transcripts, "worker.jsonl"));
		symlinkSync(target, join(f.transcripts, "worker.jsonl"));
		assert.equal(run(f).status, "blocked");
		assert.ok(existsSync(join(f.transcripts, "planner.jsonl")));
		assert.ok(existsSync(target));
	} finally {
		done(f);
	}
});

test("a nested directory inside transcripts is refused", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.transcripts, "sub"));
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), [...FILES, "sub"].sort());
	} finally {
		done(f);
	}
});

test("an unsafe run id is refused", () => {
	const f = fixture();
	try {
		f.store.db.prepare("INSERT INTO runs(id, created_at) VALUES ('../x', '2026-01-01T00:00:00Z')").run();
		f.store.db.prepare("UPDATE revisions SET run_id = '../x' WHERE id = ?").run(REV);
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a file changed after the receipt is refused", () => {
	const f = fixture();
	try {
		// First attempt is interrupted by a changed fingerprint after the receipt would be written: simulate by
		// receipting through an active-run refusal-free path, then stop before deleting.
		const first = run(f, { beforeDelete: () => false });
		assert.equal(first.status, "blocked");
		assert.notEqual(receipt(f)?.state, "cleaned");
		assert.equal(JSON.parse(String(receipt(f)?.payload)).files.length, 2, "receipt is persisted before any deletion");
		writeFileSync(join(f.transcripts, "worker.jsonl"), "changed after receipt\n");
		const second = run(f);
		assert.equal(second.status, "blocked");
		assert.deepEqual(listed(f), FILES, "nothing deleted, not even the unchanged file");
	} finally {
		done(f);
	}
});

test("a file added after the receipt is never deleted", () => {
	const f = fixture();
	try {
		run(f, { beforeDelete: () => false });
		writeFileSync(join(f.transcripts, "late.jsonl"), "late\n");
		assert.equal(run(f).status, "cleaned");
		assert.deepEqual(listed(f), ["late.jsonl"]);
	} finally {
		done(f);
	}
});

test("an interrupted cleanup resumes from its receipt without deleting anything else", () => {
	const f = fixture();
	try {
		// Crash after the first unlink: planner.jsonl gone, receipt still 'committed'.
		let deleted = 0;
		assert.throws(() =>
			run(f, {
				beforeDelete: () => {
					if (deleted++ === 1) throw new Error("crash");
					return true;
				},
			}),
		);
		assert.deepEqual(listed(f), ["worker.jsonl"]);
		assert.notEqual(receipt(f)?.state, "cleaned");
		const resumed = run(f);
		assert.deepEqual(resumed, { status: "cleaned", id: REV, deleted: 1 });
		assert.deepEqual(listed(f), []);
		assert.deepEqual(run(f), { status: "cleaned", id: REV, deleted: 0 });
		for (const keep of [join(f.runDir, "run.json"), join(f.runDir, "report.md"), f.compact])
			assert.ok(existsSync(keep), keep);
	} finally {
		done(f);
	}
});

test("a tampered receipt naming paths outside the folder deletes nothing", () => {
	const f = fixture();
	try {
		run(f, { beforeDelete: () => false });
		const outside = join(f.dir, "outside.txt");
		writeFileSync(outside, "keep\n");
		const payload = JSON.parse(String(receipt(f)?.payload));
		payload.files = [{ name: "../../outside.txt", sha256: sha("keep\n") }];
		f.store.db.prepare("UPDATE cleanup_manifests SET payload = ? WHERE id = ?").run(JSON.stringify(payload), REV);
		assert.equal(run(f).status, "blocked");
		assert.ok(existsSync(outside));
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});

test("a finished compact job named compact-<revision> does not authorize deletion", () => {
	const f = fixture({ review: false, compactedBy: "ask" });
	try {
		f.store.db
			.prepare("INSERT INTO jobs(id, revision_id, state, payload) VALUES (?, ?, 'generated', ?)")
			.run(`compact-${REV}`, REV, JSON.stringify({ fingerprint: "fp-1", attempts: 0, artifactPath: f.compact }));
		assert.equal(run(f).status, "blocked");
		assert.deepEqual(listed(f), FILES);
	} finally {
		done(f);
	}
});
