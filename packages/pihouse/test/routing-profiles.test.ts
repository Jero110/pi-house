// The routing profile file: strict parsing of <pihouseHome>/routing-profiles.json on temporary files. No model, provider
// or network is touched; a profile only names what the user authorized.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Observation, Profile } from "../src/workflow/routing.ts";
import {
	chooseRoute,
	type LoadedProfiles,
	loadRoutingProfiles,
	type ModelRegistry,
	parseRoutingProfiles,
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
