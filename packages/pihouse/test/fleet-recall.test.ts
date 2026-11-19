import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { createMemoryRepository } from "../src/fleet-memory-repo.ts";
import { createFleetRecall, matchingRelations } from "../src/fleet-recall.ts";

import type { RecallEvaluation } from "../src/fleet-recall-eval.ts";

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

function evaluation(t: TestContext) {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-manual-trial-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const rows: FleetJob[] = [];
	const live = { list: () => rows, get: (id: string) => rows.find((x) => x.id === id) };
	const recall = createFleetRecall(path, live);
	const command = (text: string, chatId = "owner") => recall.reply("p", chatId, text) ?? "";
	const state = () => JSON.parse(git(path, "show", "refs/heads/projects/p:memory.json"));
	function addThreads(start: number, end: number) {
		for (let i = start; i < end; i++) {
			const query = `batchedquery${i}`;
			for (const [prefix, title, text] of [
				["target", query, "other"],
				["distractor", "other", query],
			]) {
				rows.push({
					id: prefix + i,
					title,
					agent: "codex",
					project: "p",
					status: "completed",
					updatedAt: 1,
					messages: [{ role: "assistant", text }],
				});
			}
			command(`memory feedback ${query}`, `target${i}`);
		}
	}
	return { path, live, rows, recall, command, state, addThreads };
}

test("feedback never changes the active profile and each manual promotion pins one scored trial", (t) => {
	const { command, state, recall, addThreads, rows } = evaluation(t);
	addThreads(0, 6);
	assert.equal(recall.profile("p"), "balanced");
	assert.equal(state().trials.length, 0);
	assert.match(command("memory feedback batchedquery0", "target0"), /already/);
	assert.match(command("memory feedback batchedquery0", "target1"), /already has a source/);
	assert.match(command("memory tune"), /memory promote /);
	const trial = state().trials[0];
	assert.equal(trial.outcome, "eligible");
	assert.equal(trial.incumbent, "balanced");
	assert.equal(trial.candidate, "title");
	assert.deepEqual(trial.training, { total: 4, incumbent: 0, candidate: 4 });
	assert.deepEqual(trial.holdout, { total: 2, incumbent: 0, candidate: 2 });
	assert.deepEqual(trial.holdoutThreads, ["target2", "target5"]);
	assert.equal(recall.profile("p"), "balanced");
	assert.match(command("memory tune"), /two fresh holdout/);
	assert.match(command("memory feedback another question", "target2"), /already been exposed/);
	assert.equal(state().trials.length, 1);
	assert.match(command("memory promote"), /exact ID/);
	assert.match(command("memory promote wrong"), /exact ID/);
	assert.match(recall.reply("other", "owner", `memory promote ${trial.id}`) ?? "", /exact ID/);
	// A private control message can be stored between review and approval.
	rows.push({
		...rows[0],
		id: "owner",
		title: "memory tune",
		messages: [
			{ role: "user", text: "memory tune" },
			{ role: "assistant", kind: "memory", text: "Trial response." },
		],
	});
	assert.match(command(`memory promote ${trial.id}`), /Promoted title/);
	assert.match(command(`memory promote ${trial.id}`), /Already promoted/);
	assert.equal(recall.profile("p"), "title");
	addThreads(6, 12);
	assert.equal(state().trials.length, 1);
	assert.match(command("memory tune"), /retained/);
	const retained = state().trials[1];
	assert.equal(retained.incumbent, "title");
	assert.deepEqual(retained.holdoutThreads, ["target8", "target11"]);
	assert.equal(retained.holdout.total, 2);
	assert.equal(retained.holdout.incumbent, 2);
	assert.match(command(`memory promote ${retained.id}`), /ineligible/);
	assert.match(command(`memory promote ${trial.id}`), /exact ID/);
	assert.match(command("memory revert"), /Restored balanced/);
	assert.match(command("memory tune"), /two fresh holdout/);
	assert.equal(recall.profile("p"), "balanced");
});

test("new feedback and changed competing evidence separately invalidate pinned approval", (t) => {
	const { command, state, recall, addThreads, rows, live, path } = evaluation(t);
	addThreads(0, 6);
	command("memory tune");
	const first = state().trials[0];
	addThreads(6, 7);
	assert.match(command(`memory promote ${first.id}`), /changed/);
	addThreads(7, 12);
	command("memory tune");
	const second = state().trials[1];
	assert.match(command(`memory promote ${first.id}`), /exact ID/);
	rows.push({ ...rows[0], id: "later", title: "New competing evidence", updatedAt: 50 });
	const reopened = createFleetRecall(path, live);
	assert.match(reopened.reply("p", "owner", `memory promote ${second.id}`) ?? "", /changed/);
	assert.match(reopened.reply("p", "owner", "memory tune") ?? "", /two fresh holdout/);
	assert.equal(recall.profile("p"), "balanced");
});

test("legacy holdouts stay quarantined and repeated labels in one thread never meet the independence gate", (t) => {
	const { path, live, command, recall, state, addThreads } = evaluation(t);
	addThreads(0, 6);
	const repo = createMemoryRepository(path, live);
	repo.updateState<RecallEvaluation>(
		"p",
		() => {
			throw Error("fixture missing");
		},
		(s) => {
			s.trials.push({
				previous: "balanced",
				next: "title",
				outcome: "promoted",
				examples: 6,
				at: 1,
				train: 4,
				heldout: 2,
			});
			s.profile = "title";
			for (const e of s.examples) delete e.protocol;
			return "";
		},
	);
	assert.match(command("memory tune"), /0 fresh holdout threads/);
	assert.match(command("memory feedback new label", "target2"), /exposed/);
	assert.match(command("memory promote title"), /exact ID/);
	assert.equal(recall.profile("p"), "title");
	addThreads(6, 9);
	for (let i = 0; i < 5; i++) command(`memory feedback fresh label number ${i}`, "target8");
	assert.match(command("memory tune"), /1 fresh holdout thread/);
	assert.equal(state().trials.length, 1);
	addThreads(9, 12);
	command("memory tune");
	assert.deepEqual(state().trials.at(-1).holdoutThreads, ["target8", "target11"]);
	assert.equal(state().trials.at(-1).holdout.total, 7);
	assert.match(command("memory revert"), /Restored balanced/);
});

test("full feedback, fact and relation registers disclose the limit while retaining all previous records", (t) => {
	const { path, live, state, command, addThreads } = evaluation(t);
	addThreads(0, 1);
	const repo = createMemoryRepository(path, live);
	const existing = state();
	existing.examples = Array.from({ length: 96 }, (_, i) => ({
		chatId: "target0",
		query: `question ${i}`,
		holdout: false,
	}));
	existing.facts = Array.from({ length: 512 }, (_, i) => ({
		key: `key ${i}`,
		value: "v",
		chatId: "target0",
		version: 1,
	}));
	existing.relations = Array.from({ length: 1024 }, (_, i) => ({
		subject: "s",
		predicate: "p",
		object: String(i),
		chatId: "target0",
		version: 1,
	}));
	repo.updateState(
		"p",
		() => existing,
		(s) => {
			Object.assign(s, existing);
			return "";
		},
	);
	const head = git(path, "rev-parse", "refs/heads/projects/p");
	assert.match(command("memory feedback one more distinct question", "target0"), /capacity reached \(96 examples\)/);
	assert.match(command("memory save overflow = x"), /capacity reached/);
	assert.match(command("memory link s | p | overflow"), /capacity reached/);
	assert.equal(git(path, "rev-parse", "refs/heads/projects/p"), head);
	assert.deepEqual(state(), existing);
	assert.match(command("memory save key 0 = replacement"), /v2/);
	assert.equal(state().facts.length, 512);
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

test("restored memory abstains on missing attachment evidence and cites current facts and exact artifact names", (t) => {
	const { recall, rows, path } = evaluation(t);
	const archived: FleetJob = {
		id: "source",
		title: "Release evidence",
		project: "p",
		agent: "pi",
		status: "completed",
		updatedAt: 1,
		messages: [{ role: "assistant", text: "Shipping checklist attached." }],
		artifacts: [{ id: "checksum-id", name: "release-checksums.txt", type: "text", size: 64 }],
	};
	recall.capture(archived);
	rows.push({
		...archived,
		project: "other",
		id: "private-file",
		title: "Private checksum",
		messages: [{ role: "assistant", text: "a1b2c3d4" }],
	});
	recall.reply("p", "first", "memory save release branch = apricot");
	recall.reply("p", "second", "memory save release branch = plum");
	const restored = createFleetRecall(path, { list: () => [], get: () => undefined });
	const fact = restored.reply("p", "reader", "memory release branch") ?? "";
	assert.match(fact, /release branch = plum \(v2\)\n\/#chat=second/);
	assert.doesNotMatch(fact, /apricot/);
	assert.doesNotMatch(restored.context("p", "release branch"), /apricot/);
	const file = restored.reply("p", "reader", "memory release-checksums.txt") ?? "";
	assert.match(file, /release-checksums\.txt/);
	assert.match(file, /#chat=source&artifact=checksum-id/);
	for (const unsupported of ["a1b2c3d4", "unobservedchecksum"]) {
		assert.match(restored.reply("p", "reader", `memory ${unsupported}`) ?? "", /no matching/i);
		assert.equal(restored.context("p", unsupported), "");
	}
});
