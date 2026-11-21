import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { FLEET_RETRIEVAL_REVISION, searchFleetMemory } from "../src/fleet-memory.ts";
import { createMemoryRepository } from "../src/fleet-memory-repo.ts";

const empty = { list: () => [], get: () => undefined };
const first: FleetJob = {
	id: "chat-1",
	project: "study",
	title: "Canary rollout",
	agent: "codex",
	status: "completed",
	updatedAt: 10,
	messages: [
		{ role: "user", text: "Which operators approved the snapshot?", at: 5 },
		{
			role: "assistant",
			text: "Panamá and Αθήνα approved snapshot_restore. Original <markup> retained.",
			at: 10,
			actor: "Studio · Codex",
		},
	],
	artifacts: [{ name: "evidence.txt", id: "file-1", type: "text", size: 18 }],
};
function temp(t: TestContext) {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-search-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("indexed and direct retrieval agree on scoped, exact, originally spelled source passages", (t) => {
	const path = temp(t),
		repo = createMemoryRepository(path, empty);
	t.after(() => repo.close());
	const other = {
		...first,
		id: "other",
		project: "else",
		messages: [{ role: "user" as const, text: "only_private_secret" }],
	};
	repo.capture(first);
	repo.capture(other);
	const raw = { list: () => [first, other], get: (id: string) => [first, other].find((job) => job.id === id) };
	const archive = repo.source("study");
	for (const query of [
		"panama",
		"αθηνα",
		"snapshot_restore",
		"evidence.txt",
		"studio",
		"only_private_secret",
		"AND OR *",
	]) {
		for (const profile of ["balanced", "title", "evidence"] as const)
			assert.deepEqual(
				searchFleetMemory(archive, "study", query, profile),
				searchFleetMemory(raw, "study", query, profile),
			);
	}
	assert.equal(searchFleetMemory(archive, "study", "evidence.txt").hits[0]?.artifactId, "file-1");
	assert.equal(archive.get("other"), undefined);
});

test("Git ref replacement and removal drop stale postings, and a corrupt derivative rebuilds from Git", (t) => {
	const path = temp(t),
		repo = createMemoryRepository(path, empty);
	t.after(() => repo.close());
	const git = (...args: string[]) => execFileSync("git", ["--git-dir", path, ...args], { encoding: "utf8" }).trim();
	repo.capture(first);
	const scope = first.project;
	assert.ok(searchFleetMemory(repo.source(scope), scope, "panama").hits.length);
	repo.capture({
		...first,
		updatedAt: 20,
		messages: [{ role: "assistant", text: "Replacement authority is Lima.", at: 20 }],
	});
	assert.equal(searchFleetMemory(repo.source(scope), scope, "panama").hits.length, 0);
	assert.ok(searchFleetMemory(repo.source(scope), scope, "lima").hits.length);
	const ref = `refs/heads/threads/study/${createHash("sha256").update(first.id).digest("hex")}`,
		head = git("rev-parse", ref);
	git("update-ref", "-d", ref, head);
	assert.deepEqual(repo.source(scope).list(), []);
	git("update-ref", ref, head);
	repo.close();
	writeFileSync(join(path, `${FLEET_RETRIEVAL_REVISION}.sqlite`), "invalid cache");
	const rebuilt = repo.source(scope);
	assert.match(searchFleetMemory(rebuilt, scope, "lima").hits[0]?.excerpt ?? "", /Lima/);
});

test("unsaved live content wins once and administrative-only writes leave eligibility and digest unchanged", (t) => {
	const path = temp(t);
	const rows: FleetJob[] = [];
	const repo = createMemoryRepository(path, { list: () => rows, get: (id) => rows.find((j) => j.id === id) });
	t.after(() => repo.close());
	repo.capture(first);
	const hash = repo.source(first.project).evidenceDigest?.(first.project);
	const admin: FleetJob = {
		...first,
		updatedAt: 15,
		messages: [
			...first.messages,
			{ role: "user", kind: undefined, text: "memory feedback privatekeyword", at: 14 },
			{ role: "assistant", kind: "memory", text: "privatekeyword", at: 15 },
		],
	};
	repo.capture(admin);
	repo.capture({
		...first,
		id: "admin-only",
		title: "memory status",
		messages: [
			{ role: "user", text: "memory status" },
			{ role: "assistant", kind: "memory", text: "privatekeyword" },
		],
		artifacts: [],
	});
	assert.equal(repo.source(first.project).evidenceDigest?.(first.project), hash);
	assert.equal(searchFleetMemory(repo.source(first.project), first.project, "privatekeyword").hits.length, 0);
	rows.push({
		...first,
		updatedAt: 30,
		status: "running",
		messages: [{ role: "user", text: "A new observation from Mumbai.", at: 30 }],
	});
	const source = repo.source(first.project);
	assert.equal(searchFleetMemory(source, first.project, "Panama").hits.length, 0);
	assert.equal(searchFleetMemory(source, first.project, "Mumbai").hits.length, 1);
	assert.notEqual(source.evidenceDigest?.(first.project), hash);
});
