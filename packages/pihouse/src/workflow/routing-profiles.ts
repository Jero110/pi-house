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
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pihousePaths } from "../paths.ts";
import { type Candidate, type Failure, type Observation, type Profile, type RoutingResult, route } from "./routing.ts";

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

/** The model registry the host gives us: pi's own, injected so tests can fake it. Only its answers are trusted. */
export interface ModelRef {
	provider: string;
	id: string;
}
export interface ModelRegistry {
	find(provider: string, modelId: string): ModelRef | undefined;
	hasConfiguredAuth(model: ModelRef): boolean;
}

export interface ChooseInput {
	loaded: LoadedProfiles;
	/** The profile the caller asked for; without one there is no routing authority. */
	profileId?: string;
	registry: ModelRegistry;
	/** The model the session would use without routing ("provider/model"); kept whenever there is no authority. */
	fixed: string;
	observations: Observation[];
	failures?: Failure[];
	now: number;
	maxAgeMs: number;
	checkpoint?: string;
}

export type Choice =
	| { status: "fixed"; model: string; reason: string }
	| { status: "routed"; profile: string; profileHash: string; result: RoutingResult };

/**
 * Chooses a model: the fixed one unless an authorized profile was asked for and the file is valid.
 * Problem: a candidate in the file names a model that may not exist, or whose key was never configured here.
 * Example: "openai-codex/gpt-6-luna" is in the file, but the registry only has a look-alike "gpt-6-luna-v2".
 * Solution: each candidate is looked up by its exact provider and ID; its credentials come from the registry's own
 * answer, never from a flag in the file. Then route() decides from the resolved candidates and the observations.
 */
export function chooseRoute(input: ChooseInput): Choice {
	const { loaded } = input;
	if (loaded.status !== "loaded") {
		const reason =
			loaded.status === "absent" ? "no routing profiles file" : `routing profiles invalid: ${loaded.reason}`;
		return { status: "fixed", model: input.fixed, reason };
	}
	const profile = loaded.profiles.find((item) => item.id === input.profileId);
	if (!profile) return { status: "fixed", model: input.fixed, reason: "no authorized routing profile requested" };
	const resolved = profile.candidates.map((candidate) => {
		const found = input.registry.find(candidate.provider, candidate.model);
		const modelAvailable = !!found && found.provider === candidate.provider && found.id === candidate.model;
		const credentials = !!found && modelAvailable && input.registry.hasConfiguredAuth(found);
		return { candidate, modelAvailable, credentials };
	});
	const result = route({
		profile,
		resolved,
		observations: input.observations,
		failures: input.failures,
		now: input.now,
		maxAgeMs: input.maxAgeMs,
		checkpoint: input.checkpoint,
	});
	return { status: "routed", profile: profile.id, profileHash: loaded.hash, result };
}

export interface ConfiguredChooseInput extends Omit<ChooseInput, "loaded"> {
	/** Where PIHOUSE_HOME and HOME come from; the process environment by default. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The one entry a caller needs: reads <pihouseHome>/routing-profiles.json, then chooses as chooseRoute() does.
 * Problem: every caller that located and loaded the file itself could read a different home or skip the loader.
 * Example: a worker launched with PIHOUSE_HOME=/tmp/h must route with /tmp/h/routing-profiles.json, not ~/.pihouse.
 * Solution: the home comes from pihousePaths(), the same place every other pihouse file is found. The file is read
 * on every call, so an edit applies to the next decision; no extension or binding is registered here.
 */
export function chooseConfiguredRoute(input: ConfiguredChooseInput): Choice {
	const { env = process.env, ...rest } = input;
	return chooseRoute({ ...rest, loaded: loadRoutingProfiles(routingProfilesPath(pihousePaths(env).home)) });
}

/** What a paused decision leaves behind: the body and its hash, both in one private file. */
export interface CheckpointBody {
	id: string;
	taskId: string;
	profile: string;
	profileHash: string;
	pausedAt: string;
	reasons: { provider: string; model: string; account: string; reason: string }[];
}
export interface Checkpoint {
	version: typeof ROUTING_PROFILES_VERSION;
	hash: string;
	body: CheckpointBody;
}
/** Shown to the user and to the session: fixed phrases and ids only, never the path or any provider text. */
export interface PauseNotice {
	kind: "routing-paused";
	checkpointId: string;
	hash: string;
	taskId: string;
	profile: string;
	reasons: string[];
}
export type PauseOutcome =
	| { status: "not-paused" }
	| { status: "checkpointed"; id: string; hash: string; path: string };
export interface PauseInput {
	/** The pihouse home; the checkpoint goes under routing/paused/ in it. */
	home: string;
	taskId: string;
	choice: Choice;
	now: number;
	notify: (notice: PauseNotice) => void;
}

/**
 * Writes a paused decision to disk, then tells the session. Only an exhausted alternative list pauses; a selected or
 * fixed choice writes nothing.
 * Problem: a pause that lives only in memory is lost when the session restarts, and the user is not told why work stopped.
 * Example: the only authorized account is exhausted at 14:00. The task must resume from the same checkpoint later, not
 * start again on a model nobody authorized.
 * Solution: the checkpoint is written to a temporary file with mode 0600, flushed, renamed over the final name and
 * the directory flushed. Its body is hashed, so a changed file is reported invalid. The notice is injected only after
 * the write, and it carries ids and the reasons, not the path.
 */
export function checkpointPause(input: PauseInput): PauseOutcome {
	const { choice } = input;
	if (choice.status !== "routed" || choice.result.status !== "paused") return { status: "not-paused" };
	const pausedAt = new Date(input.now).toISOString();
	const reasons = choice.result.reasons.map(({ candidate, reason }) => ({
		provider: candidate.provider,
		model: candidate.model,
		account: candidate.account,
		reason,
	}));
	const id = createHash("sha256")
		.update(JSON.stringify([input.taskId, choice.profile, choice.profileHash, pausedAt]))
		.digest("hex")
		.slice(0, 16);
	const body: CheckpointBody = {
		id,
		taskId: input.taskId,
		profile: choice.profile,
		profileHash: choice.profileHash,
		pausedAt,
		reasons,
	};
	const hash = sha256(JSON.stringify(body));
	const path = join(input.home, PAUSED_DIR, `${id}.json`);
	writeDurably(path, JSON.stringify({ version: ROUTING_PROFILES_VERSION, hash, body }, null, "\t"));
	input.notify({
		kind: "routing-paused",
		checkpointId: id,
		hash,
		taskId: input.taskId,
		profile: choice.profile,
		reasons: reasons.map((r) => `${r.provider}/${r.model} on ${r.account}: ${r.reason}`),
	});
	return { status: "checkpointed", id, hash, path };
}

/** Reads a checkpoint back and checks its hash; a changed or foreign file is invalid, never resumed. */
export function readCheckpoint(
	path: string,
): { status: "valid"; checkpoint: Checkpoint } | { status: "invalid"; reason: string } {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { status: "invalid", reason: "unreadable" };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data))
		return { status: "invalid", reason: "malformed" };
	const record = data as Obj;
	if (record.version !== ROUTING_PROFILES_VERSION) return { status: "invalid", reason: "version" };
	if (
		typeof record.hash !== "string" ||
		record.body === undefined ||
		record.hash !== sha256(JSON.stringify(record.body))
	) {
		return { status: "invalid", reason: "hash mismatch" };
	}
	return { status: "valid", checkpoint: record as unknown as Checkpoint };
}

const PAUSED_DIR = join("routing", "paused");

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function writeDurably(path: string, text: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkSync(temp);
		throw error;
	}
	closeSync(fd);
	renameSync(temp, path);
	// The rename is only durable once the directory entry is flushed. Some platforms cannot open a directory for
	// this; there the rename is the best available guarantee.
	try {
		const dirFd = openSync(dir, "r");
		fsyncSync(dirFd);
		closeSync(dirFd);
	} catch {
		// best effort, see above
	}
}
