import assert from "node:assert/strict";
import test from "node:test";
import { createTitleController } from "../src/extensions/title.ts";

test("a registered root receives a semantic title, but a worker keeps its identity", async () => {
	let name: string | undefined;
	const controller = createTitleController({
		depth: 0,
		session: () => "root",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: async () => "Improving pi-house",
		now: () => 100_000,
	});
	controller.input("plz improove the pi house experience");
	await controller.settled();
	assert.equal(name, "Improving pi-house");
	const worker = createTitleController({
		depth: 1,
		session: () => "worker",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: async () => "Wrong",
		now: () => 100_000,
	});
	worker.input("another task");
	await worker.settled();
	assert.equal(name, "Improving pi-house");
});

test("a stale response cannot replace a manual name or newer input", async () => {
	let name: string | undefined;
	let resolve: (title: string) => void = () => {};
	const controller = createTitleController({
		depth: 0,
		session: () => "root",
		current: () => name,
		owned: () => true,
		set: (value) => {
			name = value;
		},
		generate: () =>
			new Promise((r) => {
				resolve = r;
			}),
		now: () => 100_000,
	});
	controller.input("first request");
	const pending = controller.settled();
	name = "My manual name";
	controller.input("newer request");
	resolve("Old topic");
	await pending;
	assert.equal(name, "My manual name");
});

test("jobs are rate limited and provenance protects inherited or manually renamed sessions", async () => {
	let name: string | undefined = "Inherited";
	let owns = false;
	let calls = 0;
	let clock = 100_000;
	const controller = createTitleController({
		depth: 0,
		session: () => "fork",
		current: () => name,
		owned: () => owns,
		set: (value) => {
			name = value;
		},
		generate: async () => {
			calls++;
			return "Semantic title";
		},
		now: () => clock,
	});
	controller.input("request");
	await controller.settled();
	assert.equal(calls, 0);
	owns = true;
	controller.input("request");
	await controller.settled();
	controller.input("another topic");
	clock += 1000;
	await controller.settled();
	assert.equal(calls, 1);
});
