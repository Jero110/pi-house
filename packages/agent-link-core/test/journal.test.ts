import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSessions, Journal, journalId, readJournal, treeOf } from "../src/journal.ts";
import { hubPaths } from "../src/paths.ts";
import { echoResponder } from "./fakes/adapter.ts";
import { pullRoot, testHub, waitFor } from "./fakes/hub.ts";

test("journal ids are sortable and carry the name", () => {
	assert.equal(journalId("claude-2", new Date("2026-10-23T10:15:00.123Z")), "20261023T101500Z-claude-2");
});

test("a journal writes, updates, finds and walks records, newest first", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "al-journal-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const j = new Journal(dir);
	const base = { parentName: null, harness: "pihouse", model: null, cwd: "/w", state: "starting" as const, depth: 0 };
	j.create({ ...base, id: "a", name: "pihouse", parent: null, root: "a", startedAt: "2026-10-23T10:00:00.000Z" });
	j.create({
		...base,
		id: "b",
		name: "claude",
		parent: "a",
		parentName: "pihouse",
		root: "a",
		harness: "claude",
		depth: 1,
		task: "build it",
		startedAt: "2026-10-23T10:01:00.000Z",
	});
	j.update("b", { sessionId: "sid-1", transcript: "/t/sid-1.jsonl", state: "working", model: undefined });

	const records = readJournal(dir);
	assert.deepEqual(
		records.map((r) => r.id),
		["b", "a"],
	);
	assert.equal(records[0]?.transcript, "/t/sid-1.jsonl");
	assert.equal(records[0]?.model, null, "undefined in a patch keeps the old value");
	assert.deepEqual(
		findSessions(records, "sid-1").map((r) => r.id),
		["b"],
	);
	assert.deepEqual(
		findSessions(records, "claude").map((r) => r.id),
		["b"],
	);
	assert.deepEqual(
		treeOf(records, "a").map((r) => r.name),
		["pihouse", "claude"],
	);
});

test("the hub journals every agent with its task, pane and session, and the files outlive the hub", async () => {
	const t = await testHub({ respond: echoResponder });
	const root = await pullRoot(t.client, "pihouse");
	const spawned = await t.client.spawn({ from: root, harness: "claude", task: "write the tests", backend: "cmux" });
	assert.ok("name" in spawned);
	const fake = await waitFor(() => t.kit.byName(spawned.name), "adapter");
	fake.emit({ kind: "session", sessionId: "sid-9", transcript: "/t/sid-9.jsonl" });
	const dir = hubPaths(t.home).sessions;
	await waitFor(() => readJournal(dir).find((r) => r.sessionId === "sid-9"), "the session in the journal");
	await t.stop({ keepHome: true });

	const records = readJournal(dir);
	const worker = records.find((r) => r.name === spawned.name);
	const parent = records.find((r) => r.name === root);
	assert.ok(worker && parent);
	assert.equal(worker.parent, parent.id);
	assert.equal(worker.root, parent.id);
	assert.equal(worker.task, "write the tests");
	assert.equal(worker.backend, "cmux");
	assert.ok(worker.pane, "the pane the hub opened");
	assert.equal(worker.transcript, "/t/sid-9.jsonl");
	assert.equal(worker.state, "exited", "the hub closing ends the agent and the journal says so");
	assert.ok(worker.endedAt);
	rmSync(t.home, { recursive: true, force: true });
});
