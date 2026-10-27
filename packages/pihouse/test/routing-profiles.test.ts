// The routing profile file: strict parsing of <pihouseHome>/routing-profiles.json on temporary files. No model, provider
// or network is touched; a profile only names what the user authorized.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import { MAX_AGE_MS, observeAccounts } from "../src/account-usage.ts";
import type { Observation, Profile } from "../src/workflow/routing.ts";
import {
	type Choice,
	checkpointPause,
	chooseConfiguredRoute,
	chooseRoute,
	type LoadedProfiles,
	loadRoutingProfiles,
	type ModelRegistry,
	type PauseNotice,
	parseRoutingProfiles,
	readCheckpoint,
	routingProfilesPath,
} from "../src/workflow/routing-profiles.ts";

const candidate = {
	harness: "pihouse",
	model: "openai-codex/gpt-6-luna",
	account: "openai",
	billing: "subscription",
	capabilities: ["code"],
};
const profile = {
	id: "coding",
	purpose: "code",
	requiredCapabilities: ["code"],
	allowedBilling: ["subscription"],
	candidates: [candidate],
};
const file = (profiles: unknown[], version: unknown = 1) => ({ version, profiles });

function tempFile(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-profiles-"));
	const path = join(dir, "routing-profiles.json");
	writeFileSync(path, text);
	return path;
}

test("the profile file lives under the pihouse home", () => {
	assert.equal(routingProfilesPath("/home/x/.pihouse"), "/home/x/.pihouse/routing-profiles.json");
});

test("a valid file splits each exact provider/model ID and keeps the authorized billing", () => {
	const parsed = parseRoutingProfiles(file([profile]));
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.deepEqual(parsed.profiles, [
		{
			id: "coding",
			purpose: "code",
			requiredCapabilities: ["code"],
			allowedBilling: ["subscription"],
			candidates: [
				{
					harness: "pihouse",
					provider: "openai-codex",
					model: "gpt-6-luna",
					account: "openai",
					billing: "subscription",
					capabilities: ["code"],
				},
			],
		},
	]);
});

test("no file means no routing authority, and a file is hashed for the records", () => {
	assert.deepEqual(loadRoutingProfiles(join(tmpdir(), "pihouse-no-such-dir", "routing-profiles.json")), {
		status: "absent",
	});
	const text = JSON.stringify(file([profile]));
	const loaded = loadRoutingProfiles(tempFile(text));
	assert.equal(loaded.status, "loaded");
	if (loaded.status === "loaded") {
		assert.equal(loaded.hash, createHash("sha256").update(text).digest("hex"));
		assert.equal(loaded.profiles[0].id, "coding");
	}
});

test("an unreadable or non-JSON file is invalid, never a silent fallback", () => {
	const result = loadRoutingProfiles(tempFile("{ not json"));
	assert.equal(result.status, "invalid");
});

test("malformed or ambiguous files are rejected with a reason", () => {
	const cases: [string, unknown][] = [
		["wrong version", file([profile], 2)],
		["missing profiles", { version: 1 }],
		[
			"unknown key (an inferred equivalence)",
			file([{ ...profile, candidates: [{ ...candidate, equivalentTo: "x" }] }]),
		],
		["duplicate profile id", file([profile, { ...profile, purpose: "other" }])],
		["duplicate candidate", file([{ ...profile, candidates: [candidate, { ...candidate }] }])],
		["model without a provider", file([{ ...profile, candidates: [{ ...candidate, model: "gpt-6-luna" }] }])],
		["model with spaces", file([{ ...profile, candidates: [{ ...candidate, model: "openai-codex/gpt 6" }] }])],
		["empty provider", file([{ ...profile, candidates: [{ ...candidate, model: "/gpt-6-luna" }] }])],
		["unknown billing", file([{ ...profile, candidates: [{ ...candidate, billing: "paid" }] }])],
		["api billing not authorized", file([{ ...profile, candidates: [{ ...candidate, billing: "api" }] }])],
		["no candidates", file([{ ...profile, candidates: [] }])],
		["capabilities not an array", file([{ ...profile, candidates: [{ ...candidate, capabilities: "code" }] }])],
		["capabilities missing", file([{ ...profile, candidates: [{ ...candidate, capabilities: undefined }] }])],
		["empty account", file([{ ...profile, candidates: [{ ...candidate, account: "" }] }])],
		["empty harness", file([{ ...profile, candidates: [{ ...candidate, harness: " " }] }])],
	];
	for (const [name, data] of cases) {
		const result = parseRoutingProfiles(data);
		assert.equal(result.status, "invalid", name);
	}
});

test("api billing is usable only when the profile explicitly allows it", () => {
	const api = { ...candidate, billing: "api" };
	const parsed = parseRoutingProfiles(
		file([{ ...profile, allowedBilling: ["subscription", "api"], candidates: [api] }]),
	);
	assert.equal(parsed.status, "valid");
	if (parsed.status === "valid") assert.equal(parsed.profiles[0].candidates[0].billing, "api");
});

test("a capability list may be empty: it claims none, so any required capability is missing", () => {
	const parsed = parseRoutingProfiles(file([{ ...profile, candidates: [{ ...candidate, capabilities: [] }] }]));
	assert.equal(parsed.status, "valid");
});

// A fake of pi's model registry: the models it knows and which of them have credentials. Lookups are recorded so a
// test can show the policy asked for the exact provider and ID only.
function fakeRegistry(models: { provider: string; id: string; authed: boolean }[]) {
	const lookups: string[] = [];
	const registry: ModelRegistry = {
		find(provider, modelId) {
			lookups.push(`${provider}/${modelId}`);
			const hit = models.find((m) => m.provider === provider && m.id === modelId);
			return hit && { provider: hit.provider, id: hit.id };
		},
		hasConfiguredAuth(model) {
			return models.some((m) => m.provider === model.provider && m.id === model.id && m.authed);
		},
	};
	return { registry, lookups };
}

// Problem: chooseRoute() is written against a small ModelRegistry interface, not pi's class, so a pi upgrade that
// renamed find() or hasConfiguredAuth() would only fail at run time inside an extension.
// Example: pi 1.3.0 has find(provider, modelId): Model<Api> | undefined and hasConfiguredAuth(model: Model<Api>).
// Solution: this assignment is checked by `npm run check`; it fails to compile if pi's registry no longer fits.
// chooseRoute() only passes back the object find() returned, so pi always receives its own Model.
export function piRegistryFits(registry: PiModelRegistry): ModelRegistry {
	return registry;
}

// The file's own shape, parsed the way loadRoutingProfiles() parses it.
function parsedProfiles(...raw: unknown[]): Profile[] {
	const parsed = parseRoutingProfiles({ version: 1, profiles: raw });
	if (parsed.status !== "valid") throw new Error(parsed.reason);
	return parsed.profiles;
}

const NOW = Date.parse("2026-10-27T10:00:00Z");
const fresh = (account: string, state: Observation["state"]): Observation => ({
	provider: account,
	account,
	state,
	observedAt: NOW - 1_000,
	source: "fake",
});
const loadedWith = (profiles: Profile[]): LoadedProfiles => ({ status: "loaded", profiles, hash: "h1" });
const FIXED = "openai-codex/gpt-6-terra";
const lunaCandidate = {
	harness: "pihouse",
	model: "openai-codex/gpt-6-luna",
	account: "openai",
	billing: "subscription",
	capabilities: ["code"],
};
const otherCandidate = { ...lunaCandidate, model: "openai-codex/gpt-6-other" };
const codingRaw = { id: "coding", purpose: "code", requiredCapabilities: ["code"], allowedBilling: ["subscription"] };

test("no routing authority keeps the fixed model and touches no registry", () => {
	const { registry, lookups } = fakeRegistry([]);
	const args = { registry, profileId: "coding", fixed: FIXED, observations: [], now: NOW, maxAgeMs: 60_000 };
	assert.deepEqual(chooseRoute({ ...args, loaded: { status: "absent" } }), {
		status: "fixed",
		model: FIXED,
		reason: "no routing profiles file",
	});
	const invalid = chooseRoute({ ...args, loaded: { status: "invalid", reason: "not JSON" } });
	assert.equal(invalid.status, "fixed");
	const unasked = chooseRoute({
		...args,
		profileId: undefined,
		loaded: loadedWith(parsedProfiles({ ...codingRaw, candidates: [lunaCandidate] })),
	});
	assert.equal(unasked.status, "fixed");
	const missing = chooseRoute({
		...args,
		profileId: "review",
		loaded: loadedWith(parsedProfiles({ ...codingRaw, candidates: [lunaCandidate] })),
	});
	assert.equal(missing.status, "fixed");
	assert.deepEqual(lookups, []);
});

test("an authorized candidate must exist exactly and carry credentials before it is chosen", () => {
	const coding = parsedProfiles({ ...codingRaw, candidates: [lunaCandidate, otherCandidate] });
	// The registry knows gpt-6-luna without credentials, and only a look-alike of gpt-6-other.
	const { registry, lookups } = fakeRegistry([
		{ provider: "openai-codex", id: "gpt-6-luna", authed: false },
		{ provider: "openai-codex", id: "gpt-6-other-v2", authed: true },
	]);
	const choice = chooseRoute({
		loaded: loadedWith(coding),
		profileId: "coding",
		registry,
		fixed: FIXED,
		observations: [fresh("openai", "available")],
		now: NOW,
		maxAgeMs: 60_000,
	});
	assert.deepEqual(lookups, ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-other"]);
	assert.equal(choice.status, "routed");
	if (choice.status === "routed" && choice.result.status === "paused") {
		assert.equal(choice.profileHash, "h1");
		assert.deepEqual(
			choice.result.reasons.map((r) => r.reason),
			["credentials-unavailable", "model-unavailable"],
		);
	} else {
		assert.fail("expected a paused routing result");
	}
});

test("an available authorized candidate is selected with its observation and the profile hash", () => {
	const { registry } = fakeRegistry([{ provider: "openai-codex", id: "gpt-6-luna", authed: true }]);
	const choice = chooseRoute({
		loaded: loadedWith(parsedProfiles({ ...codingRaw, candidates: [lunaCandidate] })),
		profileId: "coding",
		registry,
		fixed: FIXED,
		observations: [fresh("openai", "available")],
		now: NOW,
		maxAgeMs: 60_000,
	});
	if (choice.status !== "routed" || choice.result.status !== "selected") assert.fail("expected a selected candidate");
	assert.equal(choice.result.candidate.model, "gpt-6-luna");
	assert.equal(choice.result.observation.account, "openai");
	assert.equal(choice.profileHash, "h1");
});

test("a credential flag the file adds is an unknown key, so the file is invalid", () => {
	const data = { version: 1, profiles: [{ ...codingRaw, candidates: [{ ...lunaCandidate, credentials: true }] }] };
	assert.equal(parseRoutingProfiles(data).status, "invalid");
});

// The paused checkpoint: a private file under the pihouse home, written atomically and verified by hash.
const PAUSED: Extract<Choice, { status: "routed" }> = {
	status: "routed",
	profile: "coding",
	profileHash: "h1",
	result: {
		status: "paused",
		profile: "coding",
		reasons: [
			{
				candidate: {
					harness: "pihouse",
					provider: "openai-codex",
					model: "gpt-6-luna",
					account: "openai",
					billing: "subscription",
					capabilities: ["code"],
				},
				reason: "exhausted",
			},
		],
	},
};

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "pihouse-home-"));
}

test("an exhausted profile persists a private, hash-checked checkpoint and injects one notice", () => {
	const home = tempHome();
	const notices: PauseNotice[] = [];
	const outcome = checkpointPause({ home, taskId: "task-7", choice: PAUSED, now: NOW, notify: (n) => notices.push(n) });
	assert.equal(outcome.status, "checkpointed");
	if (outcome.status !== "checkpointed") return;
	assert.equal(statSync(outcome.path).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(outcome.path)).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(dirname(outcome.path)), [`${outcome.id}.json`]);
	const read = readCheckpoint(outcome.path);
	assert.equal(read.status, "valid");
	if (read.status === "valid") {
		assert.equal(read.checkpoint.body.taskId, "task-7");
		assert.equal(read.checkpoint.body.profileHash, "h1");
		assert.equal(read.checkpoint.hash, outcome.hash);
	}
	assert.equal(notices.length, 1);
	assert.deepEqual(notices[0], {
		kind: "routing-paused",
		checkpointId: outcome.id,
		hash: outcome.hash,
		taskId: "task-7",
		profile: "coding",
		reasons: ["openai-codex/gpt-6-luna on openai: exhausted"],
	});
	assert.equal(JSON.stringify(notices[0]).includes(home), false, "the notice never carries the private path");
});

test("a tampered checkpoint is reported invalid rather than resumed", () => {
	const home = tempHome();
	const outcome = checkpointPause({ home, taskId: "task-7", choice: PAUSED, now: NOW, notify: () => {} });
	if (outcome.status !== "checkpointed") assert.fail("expected a checkpoint");
	writeFileSync(outcome.path, readFileSync(outcome.path, "utf8").replace("task-7", "task-8"));
	assert.equal(readCheckpoint(outcome.path).status, "invalid");
});

test("a selected or fixed choice pauses nothing and writes nothing", () => {
	const home = tempHome();
	const notices: PauseNotice[] = [];
	const fixed: Choice = { status: "fixed", model: FIXED, reason: "no routing profiles file" };
	assert.deepEqual(checkpointPause({ home, taskId: "t", choice: fixed, now: NOW, notify: (n) => notices.push(n) }), {
		status: "not-paused",
	});
	assert.deepEqual(readdirSync(home), []);
	assert.equal(notices.length, 0);
});

// End to end on fake sources: a Claude rate-limit file, response headers and a fake usage endpoint (HTTP answers are
// injected by the test). No provider or model is ever called.
function claudeFull(now: number): string {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-claude-"));
	const path = join(dir, "s1.json");
	writeFileSync(path, JSON.stringify({ used_percentage: 100, resets_at: now / 1000 + 7200 }));
	utimesSync(path, now / 1000, now / 1000);
	return dir;
}

async function fakeUsage(status: number): Promise<{ url: string; hits: () => number; close: () => void }> {
	let hits = 0;
	const server: Server = createServer((_req, res) => {
		hits++;
		res.statusCode = status;
		res.end("{}");
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/usage`;
	return { url, hits: () => hits, close: () => server.close() };
}

const claudeProfile = (...candidates: unknown[]) => ({
	...codingRaw,
	candidates,
});
const sonnet = {
	harness: "pihouse",
	model: "anthropic/claude-sonnet-5-5",
	account: "claude",
	billing: "subscription",
	capabilities: ["code"],
};

test("an exhausted account pauses with a checkpoint; the authorized alternative is chosen when it has room", async () => {
	const claudeDir = claudeFull(NOW);
	const headers = { openai: { at: NOW, windows: [{ label: "5h", percent: 10, resetsAt: NOW + 3_600_000 }] } };
	const { registry } = fakeRegistry([
		{ provider: "anthropic", id: "claude-sonnet-5-5", authed: true },
		{ provider: "openai-codex", id: "gpt-6-luna", authed: true },
	]);
	const sources = { now: NOW, claudeDir, headers, providers: ["anthropic", "openai-codex"] };
	const observations = (await observeAccounts(sources)).flatMap((o) => (o.observation ? [o.observation] : []));
	const luna = {
		harness: "pihouse",
		model: "openai-codex/gpt-6-luna",
		account: "openai",
		billing: "subscription",
		capabilities: ["code"],
	};

	const both = chooseRoute({
		loaded: loadedWith(parsedProfiles(claudeProfile(sonnet, luna))),
		profileId: "coding",
		registry,
		fixed: FIXED,
		observations,
		now: NOW,
		maxAgeMs: MAX_AGE_MS,
	});
	assert.equal(
		both.status === "routed" && both.result.status === "selected" && both.result.candidate.model,
		"gpt-6-luna",
	);

	const onlyClaude = chooseRoute({
		loaded: loadedWith(parsedProfiles(claudeProfile(sonnet))),
		profileId: "coding",
		registry,
		fixed: FIXED,
		observations,
		now: NOW,
		maxAgeMs: MAX_AGE_MS,
	});
	const home = tempHome();
	const notices: PauseNotice[] = [];
	const outcome = checkpointPause({
		home,
		taskId: "task-9",
		choice: onlyClaude,
		now: NOW,
		notify: (n) => notices.push(n),
	});
	assert.equal(outcome.status, "checkpointed");
	assert.deepEqual(notices[0]?.reasons, ["anthropic/claude-sonnet-5-5 on claude: exhausted"]);
});

test("a rate-limited usage endpoint is a rate pause, not exhaustion, and writes the same checkpoint kind", async () => {
	const usage = await fakeUsage(429);
	try {
		const { registry } = fakeRegistry([{ provider: "openai-codex", id: "gpt-6-luna", authed: true }]);
		const luna = {
			harness: "pihouse",
			model: "openai-codex/gpt-6-luna",
			account: "openai",
			billing: "subscription",
			capabilities: ["code"],
		};
		const observations = (
			await observeAccounts({
				now: NOW,
				providers: ["openai-codex"],
				headers: {},
				claudeDir: claudeFull(NOW),
				openaiToken: async () => "fake-token",
				openaiUrl: usage.url,
				poll: new Map(),
			})
		).flatMap((o) => (o.observation ? [o.observation] : []));
		const choice = chooseRoute({
			loaded: loadedWith(parsedProfiles(claudeProfile(luna))),
			profileId: "coding",
			registry,
			fixed: FIXED,
			observations,
			now: NOW,
			maxAgeMs: MAX_AGE_MS,
		});
		assert.equal(choice.status, "routed");
		if (choice.status === "routed" && choice.result.status === "paused") {
			assert.equal(choice.result.reasons[0]?.reason, "rate");
		} else {
			assert.fail("expected a paused result");
		}
		assert.equal(usage.hits(), 1);
	} finally {
		usage.close();
	}
});

test("the configured entry reads routing-profiles.json from PIHOUSE_HOME and routes with it", () => {
	const home = mkdtempSync(join(tmpdir(), "pihouse-home-"));
	const env = { PIHOUSE_HOME: home, HOME: "/nonexistent-home" };
	const { registry } = fakeRegistry([{ provider: "openai-codex", id: "gpt-6-luna", authed: true }]);
	const args = {
		env,
		registry,
		profileId: "coding",
		fixed: FIXED,
		observations: [fresh("openai", "available")],
		now: NOW,
		maxAgeMs: 60_000,
	};
	assert.deepEqual(chooseConfiguredRoute(args), { status: "fixed", model: FIXED, reason: "no routing profiles file" });
	const text = JSON.stringify(file([{ ...codingRaw, candidates: [lunaCandidate] }]));
	writeFileSync(join(home, "routing-profiles.json"), text);
	const choice = chooseConfiguredRoute(args);
	if (choice.status !== "routed" || choice.result.status !== "selected") assert.fail("expected a selected candidate");
	assert.equal(choice.profileHash, createHash("sha256").update(text).digest("hex"));
	assert.equal(choice.result.candidate.model, "gpt-6-luna");
});
