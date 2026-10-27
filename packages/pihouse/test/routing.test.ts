import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Candidate, type Observation, type Profile, pollAccount, route } from "../src/workflow/routing.ts";

const terra: Candidate = {
	harness: "pihouse",
	provider: "provider",
	model: "terra",
	account: "a",
	billing: "subscription",
	capabilities: ["code"],
};
const luna: Candidate = {
	harness: "pihouse",
	provider: "provider",
	model: "luna",
	account: "b",
	billing: "subscription",
	capabilities: ["code"],
};
const profile: Profile = {
	id: "coding",
	purpose: "code",
	requiredCapabilities: ["code"],
	allowedBilling: ["subscription"],
	candidates: [terra, luna],
};
const available = (account: string, state: Observation["state"], observedAt = 100): Observation => ({
	provider: "provider",
	account,
	state,
	observedAt,
	source: "fake",
});
const resolved = [terra, luna].map((candidate) => ({ candidate, credentials: true, modelAvailable: true }));
const select = (observations: Observation[], extra = {}) =>
	route({ profile, resolved, observations, now: 110, maxAgeMs: 20, ...extra });

test("selects only an explicitly authorized resolved compatible candidate", () => {
	const result = select([available("a", "exhausted"), available("b", "available")]);
	assert.equal(result.status, "selected");
	if (result.status === "selected") {
		assert.equal(result.candidate.model, "luna");
		assert.equal(result.observation.source, "fake");
		assert.equal(result.ageMs, 10);
	}
	assert.equal(select([available("a", "available")], { resolved: [] }).status, "paused");
	assert.equal(
		select([available("a", "available")], { profile: { ...profile, allowedBilling: ["api"] } }).status,
		"paused",
	);
	assert.equal(
		select([available("a", "available")], { profile: { ...profile, requiredCapabilities: ["vision"] } }).status,
		"paused",
	);
});

test("unknown, stale, errors and exhausted do not imply available capacity", () => {
	for (const state of ["unknown", "exhausted", "auth", "network", "rate"] as const) {
		const result = select([available("a", state)]);
		assert.equal(result.status, "paused");
		if (result.status === "paused") assert.equal(result.reasons[0].reason, state);
	}
	const stale = select([available("a", "available", 1)]);
	assert.equal(stale.status, "paused");
	if (stale.status === "paused") assert.equal(stale.reasons[0].reason, "stale");
	const missing = select([]);
	if (missing.status === "paused") assert.equal(missing.reasons[0].reason, "unknown");
});

test("native failures stay distinct and an exhausted profile produces a checkpoint", () => {
	for (const failure of ["auth", "network", "rate", "exhausted"] as const) {
		const result = select([available("a", "available"), available("b", "exhausted")], {
			failures: [{ provider: "provider", account: "a", kind: failure }],
			checkpoint: "task-1",
		});
		assert.equal(result.status, "paused");
		if (result.status === "paused") {
			assert.equal(result.reasons[0].reason, failure);
			assert.equal(result.checkpoint, "task-1");
		}
	}
});

test("polling deduplicates in-flight account requests and applies bounded backoff", async () => {
	const state = new Map();
	let calls = 0;
	let finish: (observation: Observation) => void = () => {};
	const fetch = () => {
		calls++;
		return new Promise<Observation>((resolve) => {
			finish = resolve;
		});
	};
	const first = pollAccount(state, "provider", "a", 100, fetch);
	const second = pollAccount(state, "provider", "a", 100, fetch);
	await Promise.resolve();
	assert.equal(calls, 1);
	finish(available("a", "network"));
	assert.deepEqual(await first, await second);
	assert.equal((await pollAccount(state, "provider", "a", 101, fetch)).status, "backoff");
	assert.equal(calls, 1);
});

test("quota belongs to the account, so providers behind one login share its observation", () => {
	// Problem: a ChatGPT login serves openai-codex models; usage is read per account as "openai".
	// Example: candidate openai-codex/gpt-6-luna on account "openai" never matched its observation, so it was "unknown".
	const shared: Candidate = { ...terra, provider: "openai-codex", model: "gpt-6-luna", account: "openai" };
	const sharedProfile: Profile = { ...profile, candidates: [shared] };
	const result = route({
		profile: sharedProfile,
		resolved: [{ candidate: shared, credentials: true, modelAvailable: true }],
		observations: [{ provider: "openai", account: "openai", state: "available", observedAt: 100, source: "fake" }],
		now: 110,
		maxAgeMs: 20,
	});
	assert.equal(result.status, "selected");
});
