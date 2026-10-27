import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/workflow/report.ts";
import { buildRun } from "../src/workflow/run.ts";

test("a local session can render a partial code-only report without inventing usage", () => {
	const root = {
		id: "local",
		root: "local",
		parent: null,
		parentName: null,
		name: "ordinary chat",
		task: undefined,
		harness: "pihouse",
		model: "unknown",
		cwd: process.cwd(),
		state: "working" as const,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		depth: 0,
		sessionId: "local-session",
		transcript: undefined,
	};
	const report = renderReport(buildRun([root], root));
	assert.match(report, /PARTIAL/i);
	assert.match(report, /unknown|unavailable/i);
});

test("review is the model-triggering path; report rendering is plain code", async () => {
	const source = await import("node:fs/promises");
	const workflow = await source.readFile(new URL("../src/extensions/workflow.ts", import.meta.url), "utf8");
	assert.match(workflow, /triggerTurn:\s*true/);
	assert.equal(typeof renderReport, "function");
});
