import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAskContext } from "../src/workflow/ask-context.ts";

test("ask uses bounded current architecture and explicitly unknown metric claims without active evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "ask-"));
	try {
		mkdirSync(join(root, "docs"), { recursive: true });
		mkdirSync(join(root, "skills", "executor"), { recursive: true });
		writeFileSync(join(root, "docs", "architecture.md"), "Architecture is versioned here.");
		writeFileSync(join(root, "docs", "specs", "unused"), "unused");
	} catch {
		/* fixture files below are the only relevant inputs */
	}
	try {
		const repo = join(root, "repo");
		mkdirSync(join(repo, "docs", "specs", "self-learning"), { recursive: true });
		writeFileSync(join(repo, "docs", "architecture.md"), "Architecture facts.");
		writeFileSync(join(repo, "docs", "specs", "self-learning", "memory-access.md"), "Ask contract.");
		writeFileSync(join(repo, "docs", "specs", "self-learning", "run-evidence.md"), "Evidence contract.");
		const text = buildAskContext({
			memoryDir: join(root, "memory"),
			project: "project-a",
			question: "token retry skill",
			repoRoot: repo,
			skillsDir: join(root, "skills"),
			now: new Date("2026-01-31T00:00:00Z"),
		});
		assert.match(text, /Price: unknown; quality\/validation: unknown/);
		assert.match(text, /Conversational retry detail: unavailable/);
		assert.match(text, /Architecture facts/);
		assert.match(text, /\[2026-01-01T00:00:00.000Z, 2026-01-31T00:00:00.000Z\)/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
