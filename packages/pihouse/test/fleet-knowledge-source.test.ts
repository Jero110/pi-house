import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readKnowledgeSource } from "../src/fleet-knowledge-source.ts";

function repository(t: { after(cleanup: () => void): void }) {
	const repo = mkdtempSync(join(tmpdir(), "fleet-knowledge-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));

	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "core.hooksPath", "/dev/null");
	const commit = () => {
		git("commit", "-qm", "Fixture");
		return git("rev-parse", "HEAD");
	};

	return { repo, git, commit };
}

test("reads the exact committed path and revision despite staged changes", (t) => {
	const { repo, git, commit } = repository(t);
	const path = join(repo, "FORMATO.md");
	writeFileSync(path, "# Formato\nContenido válido.\n");
	writeFileSync(join(repo, "README.md"), "Other source");
	git("add", ".");
	const revision = commit();
	writeFileSync(path, "Staged");
	git("add", "FORMATO.md");
	writeFileSync(path, "Working copy");

	assert.deepEqual(readKnowledgeSource(repo), {
		path: "FORMATO.md",
		revision,
		text: "# Formato\nContenido válido.\n",
	});
});

test("rejects an untracked source and does not discover a parent repository", (t) => {
	const { repo, git, commit } = repository(t);
	writeFileSync(join(repo, "README.md"), "Other source");
	git("add", "README.md");
	commit();
	const source = join(repo, "FORMATO.md");
	writeFileSync(source, "Untracked");
	assert.throws(() => readKnowledgeSource(repo), /FORMATO\.md/);

	git("add", "FORMATO.md");
	commit();
	const child = join(repo, "child");
	mkdirSync(child);
	assert.throws(() => readKnowledgeSource(child), /Knowledge source/);
});

test("rejects a committed symlink", (t) => {
	const { repo, git, commit } = repository(t);
	symlinkSync("README.md", join(repo, "FORMATO.md"));
	git("add", "FORMATO.md");
	commit();

	assert.throws(() => readKnowledgeSource(repo), /regular file/);
});

test("rejects a committed submodule entry", (t) => {
	const { git, commit, repo } = repository(t);
	git("commit", "--allow-empty", "-qm", "Submodule revision");
	git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},FORMATO.md`);
	commit();

	assert.throws(() => readKnowledgeSource(repo), /regular file/);
});

test("rejects a source larger than 32 KiB", (t) => {
	const { repo, git, commit } = repository(t);
	writeFileSync(join(repo, "FORMATO.md"), "A".repeat(32 * 1024 + 1));
	git("add", "FORMATO.md");
	commit();

	assert.throws(() => readKnowledgeSource(repo), /32 KiB/);
});
