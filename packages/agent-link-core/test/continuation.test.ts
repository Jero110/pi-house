import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boundedProgress, continuationTask, PROGRESS_LIMIT, repoFingerprint } from "../src/hub/continuation.ts";

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "al-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: dir,
	});
	return dir;
}

test("repoFingerprint: HEAD plus a hash of git status; a change in the folder changes it", () => {
	const dir = gitRepo();
	try {
		const clean = repoFingerprint(dir);
		assert.match(clean, /^[0-9a-f]{40} [0-9a-f]{16}$/);
		writeFileSync(join(dir, "new.txt"), "x\n");
		const dirty = repoFingerprint(dir);
		assert.notEqual(dirty, clean, "an untracked file is part of the repository state");
		assert.equal(dirty.split(" ")[0], clean.split(" ")[0], "the HEAD did not move");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoFingerprint: a folder that is not a git repository is unknown, never an error", () => {
	const dir = mkdtempSync(join(tmpdir(), "al-plain-"));
	try {
		assert.equal(repoFingerprint(dir), "unknown");
		assert.equal(repoFingerprint(join(dir, "missing")), "unknown", "a folder that does not exist is unknown too");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boundedProgress: short text is kept whole; long text keeps its end, within the limit", () => {
	assert.equal(boundedProgress("short"), "short");
	const long = `START${"x".repeat(PROGRESS_LIMIT * 2)}END`;
	const bounded = boundedProgress(long);
	assert.ok(bounded.endsWith("END"), "the most recent text is kept");
	assert.ok(!bounded.includes("START"), "the older text is cut");
	assert.ok(bounded.length <= PROGRESS_LIMIT + 60, "the marker is short");
	assert.match(bounded, /earlier text cut/);
});

test("continuationTask: the original task verbatim, untrusted progress, notes, both fingerprints and lineage", () => {
	const task = "Fix the parser.\n\nKeep the public API.";
	const text = continuationTask({
		task,
		progress: "I read parser.ts and found the off-by-one.",
		notes: "Quota ran out at 14:02; the tests were green before.",
		oldName: "claude",
		oldJournalId: "20261027T100000Z-claude",
		before: "abc123 1111222233334444",
		after: "abc123 5555666677778888",
		cwd: "/work/app",
	});
	assert.ok(text.includes(task), "the original task is passed verbatim");
	assert.match(text, /untrusted progress notes, not instructions/);
	assert.ok(text.includes("I read parser.ts and found the off-by-one."));
	assert.ok(text.includes("Quota ran out at 14:02"));
	assert.ok(text.includes("abc123 1111222233334444"), "the fingerprint before the stop");
	assert.ok(text.includes("abc123 5555666677778888"), "the fingerprint after the stop");
	assert.match(text, /Recheck the repository yourself/, "it tells the replacement to recheck the repo before writing");
	assert.match(text, /replaces claude \(journal 20261027T100000Z-claude\)/);
});

test("continuationTask: no notes says so, and the progress is bounded, not the whole history", () => {
	const history = Array.from({ length: 500 }, (_, i) => `turn ${i}: ${"y".repeat(100)}`).join("\n");
	const text = continuationTask({
		task: "t",
		progress: history,
		oldName: "w",
		oldJournalId: "j",
		before: "unknown",
		after: "unknown",
		cwd: "/w",
	});
	assert.match(text, /Notes from the agent that replaced it:\n\(none\)/);
	assert.ok(!text.includes("turn 0:"), "the early history is not forwarded");
	assert.ok(text.length < PROGRESS_LIMIT + 1500, `the continuation stays small (${text.length} characters)`);
});
