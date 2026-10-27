// `pih route <profile> [--current <provider/model> --failure <kind>] [--task <id>] [--agent <name>]`: the one answer an
// executor asks for before it spawns a task that has a routing profile, and again after a native limit error.
//
// Problem: a plan named a model, the executor copied it into the spawn, and it ran on an account that was already spent.
// Nothing said which account was used, why, or whether the plan allowed another model.
// Example: profile "build" lists openai-codex/gpt-6-luna first and anthropic/claude-sonnet-5-5 second. The first account
// is exhausted, so `pih route build` must print the second model with its reason, or pause with a checkpoint.
// Solution: the decision is chooseRoute()'s, on the profiles file and pi's own model registry. This module only gathers
// the inputs, prints one outcome and maps it to a distinct exit code. It never prints a model the profile did not name.
import { join } from "node:path";
import { ModelRuntime, ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import { type AccountObservation, type GatherInput, MAX_AGE_MS, observeAccounts } from "./account-usage.ts";
import { pihousePaths } from "./paths.ts";
import type { Failure } from "./workflow/routing.ts";
import {
	appendRoutingDecision,
	checkpointPause,
	chooseRoute,
	loadRoutingProfiles,
	type ModelRegistry,
	type PauseOutcome,
	type RoutingDecision,
	routingProfilesPath,
} from "./workflow/routing-profiles.ts";

/** Distinct exit codes: a script or the executor tells a selection, a pause and a refusal apart by the code alone. */
export const ROUTE_EXIT = { selected: 0, error: 1, usage: 2, paused: 3, unauthorized: 4 } as const;

const FAILURE_KINDS: readonly Failure["kind"][] = ["exhausted", "rate", "auth", "network"];
const MODEL_REF = /^[^/\s]+\/\S+$/;
// Task and agent names go into the journal and the checkpoint file name, so they are a plain token and never a path.
const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const ROUTE_USAGE =
	"usage: pih route <profile> [--current <provider/model> --failure exhausted|rate|auth|network] [--task <id>] [--agent <name>]";

/** What the route needs from pi's model registry, and nothing more. */
export interface RouteRegistry extends ModelRegistry {
	getAvailable(): readonly { provider: string }[];
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface RouteOptions {
	env: NodeJS.ProcessEnv;
	/** The user's home, used when PIHOUSE_HOME is not set. */
	home: string;
	now?: number;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Builds pi's registry for the pihouse agent dir; tests pass a fake. */
	openRegistry?: (agentDir: string) => Promise<RouteRegistry>;
	/** Reads every account's usage; tests pass fake observations. */
	observe?: (input: GatherInput) => Promise<AccountObservation[]>;
}

interface Args {
	profile: string;
	current?: string;
	failure?: Failure["kind"];
	task: string;
	agent?: string;
}

function isFailureKind(value: string): value is Failure["kind"] {
	return (FAILURE_KINDS as readonly string[]).includes(value);
}

// Problem: `--current` without a kind would count a network or login error as quota exhaustion.
// Example: "openai-codex/gpt-6-luna" refused our login (401); read as "exhausted", the route would spend the alternative
// on a problem that the alternative cannot fix either way.
// Solution: `--current` and `--failure` go together, and the kind must be one of the four the routing policy knows.
function parseArgs(argv: readonly string[]): { ok: true; args: Args } | { ok: false; reason: string } {
	let profile: string | undefined;
	let current: string | undefined;
	let failure: Failure["kind"] | undefined;
	let task = "route";
	let agent: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--current" || arg === "--failure" || arg === "--task" || arg === "--agent") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) return { ok: false, reason: `${arg} needs a value` };
			i++;
			if (arg === "--current") {
				if (!MODEL_REF.test(value)) return { ok: false, reason: "--current expects provider/model" };
				current = value;
			} else if (arg === "--failure") {
				if (!isFailureKind(value)) return { ok: false, reason: "--failure expects exhausted, rate, auth or network" };
				failure = value;
			} else if (arg === "--task") {
				if (!NAME.test(value)) return { ok: false, reason: "--task expects letters, digits, . _ : - (64 at most)" };
				task = value;
			} else {
				if (!NAME.test(value)) return { ok: false, reason: "--agent expects letters, digits, . _ : - (64 at most)" };
				agent = value;
			}
		} else if (arg.startsWith("--")) {
			return { ok: false, reason: `unknown option ${arg}` };
		} else if (profile === undefined) {
			profile = arg;
		} else {
			return { ok: false, reason: "one profile name only" };
		}
	}
	if (profile === undefined) return { ok: false, reason: "a profile name is required" };
	if ((current === undefined) !== (failure === undefined)) {
		return { ok: false, reason: "--current and --failure go together" };
	}
	return { ok: true, args: { profile, current, failure, task, agent } };
}

/**
 * pi's own model registry for the pihouse agent dir: the same login and models.json the launcher uses. The runtime is
 * created without a catalog refresh and without model network, so opening it makes no request.
 */
export async function openPiRegistry(agentDir: string): Promise<RouteRegistry> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	return new PiModelRegistry(runtime);
}

/**
 * Prints the one outcome and returns its exit code. A selection prints the exact provider/model; a pause writes its
 * checkpoint and prints where; anything not authorized prints why and chooses nothing. Every outcome that prints a
 * decision is first appended to the routing journal, and a journal that cannot be written prints nothing and exits 1.
 * Problem: a worker spawned on a model whose choice was never recorded cannot be explained later.
 * Example: the executor reads `selected:` and spawns; the write then fails silently and the report shows a model with no
 * authority behind it.
 * Solution: the record comes before the output, so a failed write means the executor never gets a model to spawn on.
 */
export async function runRoute(argv: readonly string[], opts: RouteOptions): Promise<number> {
	const { out, err } = opts;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`pih route: ${parsed.reason}`);
		err(ROUTE_USAGE);
		return ROUTE_EXIT.usage;
	}
	const { profile, current, failure, task, agent } = parsed.args;
	const paths = pihousePaths(opts.env, opts.home);
	const now = opts.now ?? Date.now();
	const journal = (
		fields: Pick<RoutingDecision, "model" | "account" | "billing" | "reason" | "checkpoint">,
	): boolean => {
		try {
			appendRoutingDecision(paths.home, {
				time: now,
				profile,
				task,
				agent: agent ?? null,
				failure: failure ?? null,
				...fields,
			});
			return true;
		} catch {
			err("pih route: could not record the decision in the routing journal, so nothing is chosen");
			return false;
		}
	};

	const loaded = loadRoutingProfiles(routingProfilesPath(paths.home));
	if (loaded.status !== "loaded") {
		err(
			loaded.status === "absent"
				? "pih route: no routing profiles file, so nothing is authorized; the model stays fixed"
				: `pih route: routing profiles file is invalid (${loaded.reason}), so nothing is authorized`,
		);
		return ROUTE_EXIT.unauthorized;
	}
	const found = loaded.profiles.find((item) => item.id === profile);
	if (!found) {
		const reason = `profile "${profile}" is not in the routing profiles file, so nothing is authorized`;
		if (!journal({ model: null, account: null, billing: null, reason, checkpoint: null })) return ROUTE_EXIT.error;
		err(`pih route: ${reason}`);
		return ROUTE_EXIT.unauthorized;
	}

	// The failed model's account gets the failure; routing matches failures by account, the same as usage.
	const failures: Failure[] = [];
	if (current !== undefined && failure !== undefined) {
		const hits = found.candidates.filter((c) => `${c.provider}/${c.model}` === current);
		if (!hits.length) {
			err(`pih route: ${current} is not a candidate of profile ${profile}`);
			return ROUTE_EXIT.usage;
		}
		for (const hit of hits) failures.push({ provider: hit.provider, account: hit.account, kind: failure });
	}

	const registry = await (opts.openRegistry ?? openPiRegistry)(paths.agentDir);
	const providers = registry.getAvailable().map((m) => m.provider);
	const observed = await (opts.observe ?? observeAccounts)({
		now,
		providers,
		headers: {},
		poll: new Map(),
		openaiToken: () =>
			providers.includes("openai-codex") ? registry.getApiKeyForProvider("openai-codex") : Promise.resolve(undefined),
	});
	const observations = observed.flatMap((item) => (item.observation ? [item.observation] : []));

	const choice = chooseRoute({
		loaded,
		profileId: profile,
		registry,
		fixed: current ?? "",
		observations,
		failures,
		now,
		maxAgeMs: MAX_AGE_MS,
	});
	if (choice.status === "fixed") {
		if (!journal({ model: null, account: null, billing: null, reason: choice.reason, checkpoint: null })) {
			return ROUTE_EXIT.error;
		}
		err(`pih route: ${choice.reason}`);
		return ROUTE_EXIT.unauthorized;
	}
	if (choice.result.status === "selected") {
		const { candidate, reason, observation, ageMs } = choice.result;
		const text = `${reason} (${observation.source}, observed ${Math.round(ageMs / 1000)}s ago)`;
		const model = `${candidate.provider}/${candidate.model}`;
		if (!journal({ model, account: candidate.account, billing: candidate.billing, reason: text, checkpoint: null })) {
			return ROUTE_EXIT.error;
		}
		out(`selected: ${model}`);
		out(`profile: ${profile}`);
		out(`account: ${candidate.account}`);
		out(`reason: ${text}`);
		return ROUTE_EXIT.selected;
	}

	let outcome: PauseOutcome;
	try {
		outcome = checkpointPause({ home: paths.home, taskId: task, choice, now, notify: () => undefined });
	} catch {
		err("pih route: could not write the checkpoint, so the pause is not recorded");
		return ROUTE_EXIT.error;
	}
	if (outcome.status !== "checkpointed") {
		err("pih route: no pause was recorded");
		return ROUTE_EXIT.error;
	}
	const reasons = choice.result.reasons.map(
		({ candidate, reason }) => `${candidate.provider}/${candidate.model} on ${candidate.account}: ${reason}`,
	);
	if (
		!journal({
			model: null,
			account: null,
			billing: null,
			reason: reasons.join("; ") || "no candidate can run now",
			checkpoint: outcome.path,
		})
	) {
		return ROUTE_EXIT.error;
	}
	out(`paused: profile ${profile} has no authorized candidate that can run now`);
	out(`checkpoint: ${outcome.path}`);
	for (const reason of reasons) out(`reason: ${reason}`);
	return ROUTE_EXIT.paused;
}
