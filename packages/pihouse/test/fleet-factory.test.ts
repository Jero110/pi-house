import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createFleetJobs } from "../src/fleet-jobs.ts";

test("evaluates isolated cases without leaking expected answers, publishes exactly tested drafts and pins production runs", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-factory-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo"),
		state = join(root, "state");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"commit.gpgSign=false",
			"commit",
			"-qm",
			"initial",
			"--allow-empty",
		],
		{ cwd: repo },
	);
	const worker = join(root, "worker.mjs");
	writeFileSync(
		worker,
		`import fs from "node:fs";const p=fs.readFileSync(0,"utf8");if(p.includes("expected_marker"))console.log("answer leaked");else if(p.includes("color blue"))console.log("expected_marker");else console.log("other");`,
	);
	const config = { stateDir: state, projects: { demo: repo, other: repo } };
	const jobs = createFleetJobs(config, worker);
	t.after(() => jobs.close());
	const f = jobs.factory;
	const def = {
		name: "Color check",
		instructions: "Identify a color",
		agent: "codex" as const,
		cases: [{ input: "color blue", expected: "expected_marker" }],
	};
	const draft = f.save("demo", null, def);
	assert.equal(f.list("demo")[0].id, draft.id);
	assert.equal(f.get("other", draft.id), undefined);
	assert.throws(() => f.publish("demo", draft.id, 1), /pass|evaluat|test/i);
	assert.throws(() => f.run("demo", draft.id, 1, "color blue", "prod"), /publish/i);
	f.evaluate("demo", draft.id, 1, "test-1");
	f.evaluate("demo", draft.id, 1, "test-1");
	assert.equal(jobs.list().length, 1);
	for (let i = 0; i < 300 && f.get("demo", draft.id)?.evaluations[0]?.status === "running"; i++) await wait(20);
	const result = f.get("demo", draft.id);
	assert.equal(result?.evaluations[0].status, "passed");
	assert.equal(result?.evaluations[0].cases[0].actual, "expected_marker");
	f.publish("demo", draft.id, 1);
	const prod = f.run("demo", draft.id, 1, "color blue", "prod-1");
	assert.equal(f.run("demo", draft.id, 1, "color blue", "prod-1").chatId, prod.chatId);
	assert.throws(() => f.run("demo", draft.id, 1, "different", "prod-1"), /request|retry/i);
	const changed = f.save("demo", draft.id, {
		...def,
		baseRevision: 1,
		cases: [{ input: "wrong", expected: "expected_marker" }],
	});
	assert.equal(changed.head, 2);
	assert.throws(() => f.save("demo", draft.id, { ...def, baseRevision: 1 }), /stale|changed|revision/i);
	assert.throws(() => f.publish("demo", draft.id, 1), /revision|stale|head/i);
	f.evaluate("demo", draft.id, 2, "test-2");
	for (let i = 0; i < 300 && f.get("demo", draft.id)?.evaluations[0]?.status === "running"; i++) await wait(20);
	assert.equal(f.get("demo", draft.id)?.evaluations[0].status, "failed");
	assert.throws(() => f.publish("demo", draft.id, 2), /pass|failed|test/i);
	assert.equal(f.get("demo", draft.id)?.published, 1);
	jobs.close();
	const reopened = createFleetJobs(config, worker);
	t.after(() => reopened.close());
	assert.equal(reopened.factory.get("demo", draft.id)?.runs[0].chatId, prod.chatId);
	assert.equal(reopened.factory.get("demo", draft.id)?.revisions.length, 2);
});
