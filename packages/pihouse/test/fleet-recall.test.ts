import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { createMemoryRepository } from "../src/fleet-memory-repo.ts";
import { createFleetRecall, matchingRelations } from "../src/fleet-recall.ts";

function git(path: string, ...args: string[]) {
	return execFileSync("git", ["--git-dir", path, ...args], { encoding: "utf8" }).trim();
}

test("owner-confirmed triples preserve Git history, direction, source and project isolation across retries and restores", (t) => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-triples-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const empty = { list: () => [], get: () => undefined };
	const repo = createMemoryRepository(path, empty);
	repo.updateState(
		"p",
		() => ({ profile: "balanced", examples: [], facts: [], trials: [], revision: 0, lastTrial: 0 }),
		(state) => {
			state.revision++;
			return "";
		},
	);
	const ref = "refs/heads/projects/p";
	const head = () => git(path, "rev-parse", ref);
	const recall = createFleetRecall(path, empty, "https://fleet.example");
	const legacy = head();
	assert.deepEqual(recall.relations("p"), []);
	for (const input of [
		"memory link missing | predicate",
		"memory link s | | o",
		"memory link 1 | 2 | 3 | 4",
		"memory unlink one | two | three",
	])
		recall.reply("p", "source", input);
	assert.equal(head(), legacy);
	assert.match(recall.reply("p", "first source", "memory link Quasar | depends on | Mercury") ?? "", /v1/);
	const first = head();
	assert.match(recall.reply("p", "duplicate", "memory link quasar | DEPENDS  ON | mercury") ?? "", /v1/);
	assert.equal(head(), first);
	assert.equal(JSON.parse(git(path, "show", `${first}:memory.json`)).relations[0].chatId, "first source");
	recall.reply("p", "another", "memory link Quasar | orbits | Helios");
	recall.reply("p", "reverse", "memory link Mercury | depends on | Quasar");
	const restored = createFleetRecall(path, empty, "https://fleet.example");
	assert.equal(restored.relations("p").length, 3);
	assert.equal(matchingRelations(restored.relations("p"), "orbits Helios")[0].chatId, "another");
	assert.deepEqual(matchingRelations(restored.relations("p"), "unrelated"), []);
	assert.match(
		restored.reply("p", "search", "memory Mercury") ?? "",
		/Quasar \| depends on \| Mercury \(v1\)\nhttps:\/\/fleet\.example\/#chat=first%20source/,
	);
	assert.match(restored.context("p", "Mercury"), /"chatId":"first source"/);
	assert.equal(restored.context("other", "Mercury"), "");
	assert.doesNotMatch(restored.reply("other", "search", "memory Mercury") ?? "", /Quasar/);
	assert.match(restored.reply("p", "retired", "memory unlink QUASAR | depends on | Mercury") ?? "", /v2/);
	const retired = head();
	assert.equal(JSON.parse(git(path, "show", `${retired}:memory.json`)).relations[0].chatId, "retired");
	restored.reply("p", "retry", "memory unlink Quasar | depends on | Mercury");
	assert.equal(head(), retired);
	assert.equal(restored.relations("p").length, 2);
	assert.doesNotMatch(restored.context("p", "Mercury"), /retired|first source/);
	assert.match(restored.reply("p", "latest", "memory link Quasar | depends on | Mercury") ?? "", /v3/);
	assert.equal(restored.relations("p")[0].chatId, "latest");
	assert.equal(git(path, "rev-parse", `${ref}^`), retired);
});

test("project facts cite their source, supersede older versions and can be retired", (t) => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-memory-eval-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const store = { list: () => [], get: () => undefined };
	const recall = createFleetRecall(path, store, "https://fleet.example");
	assert.match(recall.reply("p", "one", "memory save launch date = Thursday") ?? "", /v1/);
	assert.match(recall.reply("p", "two", "memory save launch date = Friday") ?? "", /v2/);
	assert.match(recall.reply("p", "three", "memory launch") ?? "", /Friday.*\n.*#chat=two/);
	assert.doesNotMatch(recall.reply("p", "three", "memory launch") ?? "", /Thursday/);
	assert.deepEqual(recall.facts("other"), []);
	assert.match(recall.reply("p", "two", "memory forget launch date") ?? "", /retired/i);
	assert.deepEqual(recall.facts("p"), []);
});

test("feedback is scoped, deduplicated and evaluated against separate held-out questions before changing recall", (t) => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-memory-eval-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const rows: FleetJob[] = [];
	const store = { list: () => rows, get: (id: string) => rows.find((x) => x.id === id) };
	const recall = createFleetRecall(path, store);
	for (let i = 0; i < 8; i++) {
		const q = `batchedquery${i}`;
		for (const [s, title, answer] of [
			["target", q, "other"],
			["distractor", "other", q],
		]) {
			rows.push({
				id: s + i,
				title,
				agent: "codex",
				project: "p",
				status: "completed",
				updatedAt: 1,
				messages: [{ role: "assistant", text: answer }],
			});
		}
		recall.reply("p", `target${i}`, `memory feedback ${q}`);
	}
	assert.equal(recall.profile("p"), "title");
	const trials = () => JSON.parse(git(path, "show", "refs/heads/projects/p:memory.json")).trials;
	const promoted = trials()[0];
	assert.equal(promoted.incumbent, "balanced");
	assert.equal(promoted.candidate, "title");
	assert.equal(promoted.outcome, "promoted");
	assert.deepEqual(promoted.training, { total: 4, incumbent: 0, candidate: 4 });
	assert.deepEqual(promoted.holdout, { total: 2, incumbent: 0, candidate: 2 });
	assert.match(recall.reply("p", "target0", "memory tune") ?? "", /retained title/);
	const retained = trials().at(-1);
	assert.equal(retained.incumbent, "title");
	assert.notEqual(retained.candidate, retained.incumbent);
	assert.equal(retained.training.incumbent, retained.training.total);
	assert.equal(retained.holdout.incumbent, retained.holdout.total);
	assert.equal(retained.heldout, retained.holdout.incumbent);
	assert.ok(retained.holdout.candidate < retained.holdout.incumbent);
	assert.match(recall.reply("p", "target0", "memory status") ?? "", /8 examples/);
	recall.reply("p", "target0", "memory feedback batchedquery0");
	assert.match(recall.reply("p", "target0", "memory status") ?? "", /8 examples/);
	assert.equal(recall.profile("other"), "balanced");
	assert.match(recall.reply("p", "target0", "memory revert") ?? "", /balanced/);
	assert.equal(recall.profile("p"), "balanced");
	assert.match(recall.reply("p", "target0", "memory tune") ?? "", /new feedback/i);
});

test("restoring the repository alone preserves project evidence and facts without access to Slack or the jobs database", (t) => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-recall-restore-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const job: FleetJob = {
		id: "thread-a",
		title: "Launch review",
		agent: "codex",
		project: "alpha",
		status: "completed",
		updatedAt: 1,
		messages: [{ role: "assistant", actor: "Mini M4 · Planner", text: "Release evidence includes a canary." }],
	};
	const empty = { list: () => [], get: () => undefined };
	const first = createFleetRecall(path, empty);
	first.capture(job);
	first.reply("alpha", job.id, "memory save release day = Thursday");
	const restored = createFleetRecall(path, empty);
	assert.equal(restored.source("alpha").get(job.id)?.messages[0].actor, "Mini M4 · Planner");
	assert.equal(restored.facts("alpha")[0].value, "Thursday");
	assert.match(restored.reply("alpha", "lookup", "memory canary") ?? "", /Release evidence/);
	assert.equal(restored.source("beta").get(job.id), undefined);
});
