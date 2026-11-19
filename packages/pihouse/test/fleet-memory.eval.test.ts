import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { fleetMemoryReply, fleetProjectGraph, searchFleetMemory } from "../src/fleet-memory.ts";

const web: FleetJob = {
	id: "web-1",
	project: "libro",
	title: "Backup decision",
	agent: "codex",
	status: "completed",
	updatedAt: 10,
	messages: [
		{ role: "user", text: "How should we preserve catalog records?" },
		{
			role: "assistant",
			actor: "Studio · Codex",
			text: "We chose encrypted snapshots for the catalog. Keep the restore manifest alongside each snapshot.",
		},
	],
	events: [{ type: "started", text: "Mini · Planner · Preparing a plan.", at: 5 }],
	artifacts: [{ id: "a1", name: "restore-manifest.txt", type: "text", size: 50 }],
};
const slack: FleetJob = {
	...web,
	id: "slack-2",
	title: "Nightly run",
	updatedAt: 20,
	messages: [{ role: "assistant", actor: "Mini · Planner", text: "La sincronización nocturna terminó a las 02:00." }],
	artifacts: [],
	events: [],
};
const secret: FleetJob = {
	...web,
	project: "other",
	id: "private",
	title: "Other project secret",
	messages: [{ role: "user", text: "narrow-secret-only" }],
};
function source(rows: FleetJob[]) {
	return { list: () => rows, get: (id: string) => rows.find((row) => row.id === id) };
}

test("project recall eval ranks grounded evidence, accepts accentless queries, and abstains", () => {
	const db = source([secret, slack, web]);
	assert.equal(searchFleetMemory(db, "libro", "encrypted snapshots").hits[0]?.chatId, "web-1");
	assert.match(searchFleetMemory(db, "libro", "sincronizacion").hits[0]?.excerpt ?? "", /sincronización/);
	assert.equal(searchFleetMemory(db, "libro", "restore-manifest.txt").hits[0]?.artifactId, "a1");
	assert.equal(searchFleetMemory(db, "libro", "studio").hits[0]?.source, "Recorded actor");
	for (const query of ["narrow-secret-only", "nonexistentphrase", "", "'()***"])
		assert.deepEqual(searchFleetMemory(db, "libro", query).hits, []);
});

test("explicit recall is shared across entry points and avoids citing earlier memory answers", () => {
	const shadow = {
		...web,
		id: "echo",
		title: "Prior thread",
		messages: [
			{ role: "user" as const, text: "/memory sesame" },
			{ role: "system" as const, text: "Project memory · libro\nsesame" },
		],
	};
	const db = source([shadow, slack, web]);
	assert.equal(fleetMemoryReply(db, "libro", "please fix the code"), undefined);
	assert.equal(fleetMemoryReply(db, "libro", "/memoryful abc"), undefined);
	assert.match(
		fleetMemoryReply(db, "libro", "/memory sincronización", "https://mini.example.ts.net") ?? "",
		/https:\/\/mini\.example\.ts\.net\/#chat=slack-2/,
	);
	assert.match(fleetMemoryReply(db, "libro", "/memory sesame") ?? "", /No matching/i);
	assert.match(fleetMemoryReply(db, "libro", "/memory") ?? "", /search terms/i);
});

test("graph eval restricts every edge to recorded project, chat, machine and artifact identities", () => {
	const db = source([secret, slack, web]);
	const graph = fleetProjectGraph(db, "libro", "Studio");
	assert.equal(graph.project, "libro");
	assert.deepEqual(
		graph.threads.map((thread) => thread.id),
		["slack-2", "web-1"],
	);
	assert.deepEqual(graph.threads[1]?.machines.sort(), ["Mini", "Studio"]);
	assert.deepEqual(graph.threads[1]?.artifacts, [{ id: "a1", name: "restore-manifest.txt" }]);
	assert.deepEqual(fleetProjectGraph(db, "missing", "Studio").threads, []);
});

test("calibration eval swaps title/evidence ranks without indexing feedback, keeps latest equal-strength source", () => {
	const titleOnly = { ...web, id: "title", title: "Osprey", messages: [] };
	const observed = {
		...web,
		id: "evidence",
		messages: [
			{ role: "assistant" as const, text: "Osprey first decision." },
			{ role: "assistant" as const, text: "Osprey revised decision." },
		],
	};
	const label = {
		...web,
		id: "label",
		title: "memory feedback osprey",
		messages: [
			{ role: "user" as const, text: "memory feedback osprey target title" },
			{ role: "assistant" as const, text: "Osprey gold label." },
		],
	};
	const db = source([label, observed, titleOnly]);
	assert.equal(searchFleetMemory(db, "libro", "osprey", "title").hits[0]?.chatId, "title");
	const ranked = searchFleetMemory(db, "libro", "osprey", "evidence").hits;
	assert.deepEqual(
		ranked.map((hit) => hit.chatId),
		["evidence", "title"],
	);
	assert.match(ranked[0].excerpt, /revised/);
	assert.match(fleetMemoryReply(db, "libro", "memory osprey", undefined, "evidence") ?? "", /revised/);
});

test("an imported chat keeps its recorded owner instead of acquiring the viewing host", () => {
	const imported = { ...web, sourceHost: "Archive mini", messages: [], events: [] };
	const graph = fleetProjectGraph({ list: () => [imported], get: () => imported }, "libro", "Coordinator");
	assert.deepEqual(graph.threads[0]?.machines, ["Archive mini"]);
});
