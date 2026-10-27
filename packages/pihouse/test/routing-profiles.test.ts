// The routing profile file: strict parsing of <pihouseHome>/routing-profiles.json on temporary files. No model, provider
// or network is touched; a profile only names what the user authorized.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRoutingProfiles, parseRoutingProfiles, routingProfilesPath } from "../src/workflow/routing-profiles.ts";

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
