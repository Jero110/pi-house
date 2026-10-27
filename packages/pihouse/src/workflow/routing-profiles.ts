// The routing profiles file: the only place a fallback model can come from, read from <pihouseHome>/routing-profiles.json.
//
// Problem: a fallback that picks "the equivalent model" on another account, or a candidate that quietly bills an API
// key, would spend money the user never authorized.
// Example: a profile lists openai-codex/gpt-6-luna on account "openai" with billing "subscription". A candidate with
// billing "api" in a profile whose allowedBilling lacks "api" must make the whole file invalid, not be skipped.
// Solution: a strict, versioned schema. Unknown keys, duplicate IDs, malformed IDs and unlisted billing modes reject the
// file. Each model is named exactly as pi names it ("provider/model"); nothing is inferred from branding or a list.
// A missing file means no routing authority at all: the fixed model stays.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Profile } from "./routing.ts";

export const ROUTING_PROFILES_VERSION = 1;
export const ROUTING_PROFILES_FILE = "routing-profiles.json";

const MAX_PROFILES = 32;
const MAX_CANDIDATES = 16;
const MAX_CAPABILITIES = 16;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;
const BILLING = /^(subscription|api)$/;
const MODEL = /^([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export type ParseResult = { status: "valid"; profiles: Profile[] } | { status: "invalid"; reason: string };
export type LoadedProfiles =
	| { status: "absent" }
	| { status: "invalid"; reason: string }
	| { status: "loaded"; profiles: Profile[]; hash: string };

type Obj = Record<string, unknown>;

export function routingProfilesPath(home: string): string {
	return join(home, ROUTING_PROFILES_FILE);
}

/** Parses the decoded JSON. The first problem found is the reason; the whole file is then invalid. */
export function parseRoutingProfiles(data: unknown): ParseResult {
	try {
		return { status: "valid", profiles: readProfiles(data) };
	} catch (error) {
		return { status: "invalid", reason: error instanceof Error ? error.message : "invalid" };
	}
}

/** Reads the file. Absent means no routing authority; unreadable, non-JSON or invalid is reported, never ignored. */
export function loadRoutingProfiles(file: string): LoadedProfiles {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "absent" };
		return { status: "invalid", reason: "unreadable" };
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { status: "invalid", reason: "not JSON" };
	}
	const parsed = parseRoutingProfiles(data);
	if (parsed.status === "invalid") return parsed;
	return { status: "loaded", profiles: parsed.profiles, hash: createHash("sha256").update(text).digest("hex") };
}

function readProfiles(data: unknown): Profile[] {
	const root = object(data, "root", ["version", "profiles"]);
	if (root.version !== ROUTING_PROFILES_VERSION) throw new Error(`root.version: expected ${ROUTING_PROFILES_VERSION}`);
	const ids = new Set<string>();
	return list(root.profiles, "profiles", 1, MAX_PROFILES).map((raw, i) => {
		const profile = readProfile(raw, `profiles[${i}]`);
		if (ids.has(profile.id)) throw new Error(`profiles[${i}].id: duplicate profile id`);
		ids.add(profile.id);
		return profile;
	});
}

function readProfile(raw: unknown, path: string): Profile {
	const o = object(raw, path, ["id", "purpose", "requiredCapabilities", "allowedBilling", "candidates"]);
	const allowedBilling = uniqueTokens(o.allowedBilling, `${path}.allowedBilling`, 1, 2, BILLING);
	const seen = new Set<string>();
	const candidates = list(o.candidates, `${path}.candidates`, 1, MAX_CANDIDATES).map((c, i) => {
		const candidate = readCandidate(c, `${path}.candidates[${i}]`, allowedBilling);
		const key = JSON.stringify([candidate.harness, candidate.provider, candidate.model, candidate.account]);
		if (seen.has(key)) throw new Error(`${path}.candidates[${i}]: duplicate candidate`);
		seen.add(key);
		return candidate;
	});
	return {
		id: token(o.id, `${path}.id`, ID),
		purpose: token(o.purpose, `${path}.purpose`, ID),
		requiredCapabilities: uniqueTokens(
			o.requiredCapabilities,
			`${path}.requiredCapabilities`,
			0,
			MAX_CAPABILITIES,
			CAPABILITY,
		),
		allowedBilling,
		candidates,
	};
}

function readCandidate(raw: unknown, path: string, allowedBilling: readonly string[]): Candidate {
	const o = object(raw, path, ["harness", "model", "account", "billing", "capabilities"]);
	const [provider, model] = modelId(o.model, `${path}.model`);
	const billing = token(o.billing, `${path}.billing`, BILLING);
	// Problem: a candidate with billing "api" in a profile that never listed "api" would be skipped by the policy
	// without a word. Solution: the file itself is wrong, so it is rejected here.
	if (!allowedBilling.includes(billing)) throw new Error(`${path}.billing: not listed in allowedBilling`);
	return {
		harness: token(o.harness, `${path}.harness`, ID),
		provider,
		model,
		account: token(o.account, `${path}.account`, ACCOUNT),
		billing,
		// An empty list claims no capability: a profile that requires one then finds this candidate incompatible.
		capabilities: uniqueTokens(o.capabilities, `${path}.capabilities`, 0, MAX_CAPABILITIES, CAPABILITY),
	};
}

function object(raw: unknown, path: string, keys: readonly string[]): Obj {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path}: expected an object`);
	const extra = Object.keys(raw).find((key) => !keys.includes(key));
	if (extra !== undefined) throw new Error(`${path}.${extra}: unknown key`);
	return raw as Obj;
}

function list(raw: unknown, path: string, min: number, max: number): unknown[] {
	if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
		throw new Error(`${path}: expected ${min} to ${max} entries`);
	}
	return raw;
}

function token(raw: unknown, path: string, pattern: RegExp): string {
	if (typeof raw !== "string" || !pattern.test(raw)) throw new Error(`${path}: malformed`);
	return raw;
}

function uniqueTokens(raw: unknown, path: string, min: number, max: number, pattern: RegExp): string[] {
	const values = list(raw, path, min, max).map((item, i) => token(item, `${path}[${i}]`, pattern));
	if (new Set(values).size !== values.length) throw new Error(`${path}: duplicate entry`);
	return values;
}

function modelId(raw: unknown, path: string): [string, string] {
	const match = typeof raw === "string" ? MODEL.exec(raw) : null;
	if (!match) throw new Error(`${path}: expected provider/model`);
	return [match[1], match[2]];
}
