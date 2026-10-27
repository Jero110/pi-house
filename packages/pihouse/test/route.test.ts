// `pih route`: the one answer an executor gets for a routing profile. Temporary profile files, a fake registry and fake
// usage observations; no model, provider or network is touched. The real pi registry is only built, never asked for a
// model.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccountObservation } from "../src/account-usage.ts";
import { main } from "../src/cli.ts";
import { SKILLS_DIR } from "../src/paths.ts";
import { openPiRegistry, ROUTE_EXIT, type RouteRegistry, runRoute } from "../src/route.ts";
import type { Observation } from "../src/workflow/routing.ts";
import { ROUTING_PROFILES_FILE, readCheckpoint, readRoutingDecisions } from "../src/workflow/routing-profiles.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");

const codex = {
	harness: "pihouse",
	model: "openai-codex/gpt-6-luna",
	account: "openai",
	billing: "subscription",
	capabilities: ["code"],
};
const sonnet = {
	harness: "pihouse",
	model: "anthropic/claude-sonnet-5-5",
	account: "claude",
	billing: "subscription",
	capabilities: ["code"],
};
const build = {
	id: "build",
	purpose: "build",
	requiredCapabilities: ["code"],
	allowedBilling: ["subscription"],
	candidates: [codex, sonnet],
};

function observation(account: string, state: Observation["state"], ageSeconds = 30): Observation {
	return { provider: account, account, state, observedAt: NOW - ageSeconds * 1000, source: "usage endpoint" };
}

// A fake of pi's registry: the models it knows, which of them have credentials, and nothing else.
function fakeRegistry(models: { provider: string; id: string; authed: boolean }[]): RouteRegistry {
	return {
		find(provider, modelId) {
			const hit = models.find((m) => m.provider === provider && m.id === modelId);
			return hit && { provider: hit.provider, id: hit.id };
		},
		hasConfiguredAuth(model) {
			return models.some((m) => m.provider === model.provider && m.id === model.id && m.authed);
		},
		getAvailable() {
			return models.filter((m) => m.authed).map((m) => ({ provider: m.provider }));
		},
		async getApiKeyForProvider() {
			return undefined;
		},
	};
}

const BOTH_MODELS = [
	{ provider: "openai-codex", id: "gpt-6-luna", authed: true },
	{ provider: "anthropic", id: "claude-sonnet-5-5", authed: true },
];

interface RunInput {
	args: string[];
	/** The profiles file as text; undefined writes no file. */
	raw?: string;
	models?: { provider: string; id: string; authed: boolean }[];
	observations?: Observation[];
}

interface RunResult {
	code: number;
	out: string[];
	err: string[];
	home: string;
	cleanup: () => void;
}

/** One `pih route` run in a fresh pihouse home. The caller must call cleanup(). */
async function run(input: RunInput): Promise<RunResult> {
	const home = mkdtempSync(join(tmpdir(), "pih-route-"));
	if (input.raw !== undefined) writeFileSync(join(home, ROUTING_PROFILES_FILE), input.raw);
	const out: string[] = [];
	const err: string[] = [];
	const registry = fakeRegistry(input.models ?? BOTH_MODELS);
	const observed: AccountObservation[] = (input.observations ?? []).map((o) => ({
		account: o.account,
		observation: o,
	}));
	const code = await runRoute(input.args, {
		env: { PIHOUSE_HOME: home },
		home,
		now: NOW,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		openRegistry: async () => registry,
		observe: async () => observed,
	});
	return { code, out, err, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const profilesFile = (...profiles: unknown[]) => JSON.stringify({ version: 1, profiles });

test("route decisions persist agent, task, selected model, account and reason", async () => {
	const r = await run({
		args: ["build", "--agent", "w-2", "--task", "T1"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		const records = readFileSync(join(r.home, "routing", "decisions.jsonl"), "utf8")
			.trim()
			.split("\n");
		assert.equal(records.length, 1);
		assert.deepEqual(JSON.parse(records[0] ?? "{}"), {
			time: NOW,
			profile: "build",
			task: "T1",
			agent: "w-2",
			model: "openai-codex/gpt-6-luna",
			account: "openai",
			billing: "subscription",
			reason: "available (usage endpoint, observed 30s ago)",
			failure: null,
			checkpoint: null,
		});
	} finally {
		r.cleanup();
	}
});

test("a paused decision records no model, the checkpoint it wrote, the failure it answered and every reason", async () => {
	const r = await run({
		args: ["build", "--agent", "w-1", "--task", "T1", "--current", "openai-codex/gpt-6-luna", "--failure", "exhausted"],
		raw: profilesFile(build),
		observations: [observation("openai", "exhausted"), observation("claude", "exhausted")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		const checkpoint = r.out.find((l) => l.startsWith("checkpoint: "))?.slice("checkpoint: ".length);
		assert.deepEqual(readRoutingDecisions(r.home).decisions, [
			{
				time: NOW,
				profile: "build",
				task: "T1",
				agent: "w-1",
				model: null,
				account: null,
				billing: null,
				reason: "openai-codex/gpt-6-luna on openai: exhausted; anthropic/claude-sonnet-5-5 on claude: exhausted",
				failure: "exhausted",
				checkpoint,
			},
		]);
	} finally {
		r.cleanup();
	}
});

test("a profile the file does not name is recorded as nothing authorized, with the agent it was for", async () => {
	const r = await run({
		args: ["review", "--agent", "w-3"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.unauthorized);
		const [record] = readRoutingDecisions(r.home).decisions;
		assert.equal(record?.agent, "w-3");
		assert.equal(record?.model, null);
		assert.match(record?.reason ?? "", /profile "review" is not in the routing profiles file/);
	} finally {
		r.cleanup();
	}
});

test("decisions are appended, never rewritten: a replacement adds its own line with its account and failure", async () => {
	const home = mkdtempSync(join(tmpdir(), "pih-route-append-"));
	const route = (args: string[], observations: Observation[]) =>
		runRoute(args, {
			env: { PIHOUSE_HOME: home },
			home,
			now: NOW,
			out: () => {},
			err: () => {},
			openRegistry: async () => fakeRegistry(BOTH_MODELS),
			observe: async () => observations.map((o) => ({ account: o.account, observation: o })),
		});
	try {
		writeFileSync(join(home, ROUTING_PROFILES_FILE), profilesFile(build));
		assert.equal(await route(["build", "--agent", "w-1", "--task", "T1"], [observation("openai", "available")]), 0);
		assert.equal(
			await route(
				["build", "--agent", "w-2", "--task", "T1", "--current", "openai-codex/gpt-6-luna", "--failure", "exhausted"],
				[observation("openai", "exhausted"), observation("claude", "available")],
			),
			0,
		);
		const decisions = readRoutingDecisions(home);
		assert.equal(decisions.skipped, 0);
		assert.deepEqual(
			decisions.decisions.map((d) => [d.agent, d.model, d.account, d.failure]),
			[
				["w-1", "openai-codex/gpt-6-luna", "openai", null],
				["w-2", "anthropic/claude-sonnet-5-5", "claude", "exhausted"],
			],
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the routing journal is private: its folder is 0700 and its file 0600", async () => {
	const r = await run({
		args: ["build", "--agent", "w-1"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		assert.equal(statSync(join(r.home, "routing")).mode & 0o777, 0o700);
		assert.equal(statSync(join(r.home, "routing", "decisions.jsonl")).mode & 0o777, 0o600);
	} finally {
		r.cleanup();
	}
});

test("a journal that cannot be written prints nothing and exits 1, so no model is handed out unrecorded", async () => {
	const home = mkdtempSync(join(tmpdir(), "pih-route-blocked-"));
	const out: string[] = [];
	const err: string[] = [];
	try {
		writeFileSync(join(home, ROUTING_PROFILES_FILE), profilesFile(build));
		// The journal folder is a plain file, so the decision cannot be appended.
		writeFileSync(join(home, "routing"), "not a folder");
		const code = await runRoute(["build", "--agent", "w-1"], {
			env: { PIHOUSE_HOME: home },
			home,
			now: NOW,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			openRegistry: async () => fakeRegistry(BOTH_MODELS),
			observe: async () => [{ account: "openai", observation: observation("openai", "available") }],
		});
		assert.equal(code, ROUTE_EXIT.error);
		assert.deepEqual(out, []);
		assert.match(err[0] ?? "", /could not record the decision/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a fresh available first candidate is selected with its exact model, profile, account and reason", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.selected);
		assert.deepEqual(r.out.slice(0, 3), ["selected: openai-codex/gpt-6-luna", "profile: build", "account: openai"]);
		assert.match(r.out[3] ?? "", /^reason: available \(usage endpoint, observed 30s ago\)$/);
		assert.deepEqual(r.err, []);
		// A selection writes its decision to the journal, but never a pause checkpoint.
		assert.equal(existsSync(join(r.home, "routing", "paused")), false, "a selection writes no checkpoint");
	} finally {
		r.cleanup();
	}
});

test("an exhausted account falls through to the authorized alternative, and the reason says so", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		observations: [observation("openai", "exhausted"), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.selected);
		assert.equal(r.out[0], "selected: anthropic/claude-sonnet-5-5");
		assert.match(r.out[3] ?? "", /^reason: authorized alternative /);
	} finally {
		r.cleanup();
	}
});

test("every candidate exhausted pauses: a readable checkpoint is written and nothing is selected", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		observations: [observation("openai", "exhausted"), observation("claude", "exhausted")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		assert.equal(r.out[0], "paused: profile build has no authorized candidate that can run now");
		const path = r.out.find((l) => l.startsWith("checkpoint: "))?.slice("checkpoint: ".length) ?? "";
		assert.ok(path.startsWith(join(r.home, "routing", "paused")), "the checkpoint lives in the pihouse home");
		const stored = readCheckpoint(path);
		assert.equal(stored.status, "valid");
		if (stored.status === "valid") assert.equal(stored.checkpoint.body.profile, "build");
		assert.equal(
			r.out.some((l) => l.startsWith("selected:")),
			false,
		);
	} finally {
		r.cleanup();
	}
});

test("a network failure is not exhaustion: the route pauses and does not spend the alternative", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		observations: [observation("openai", "network"), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		assert.ok(r.out.includes("reason: openai-codex/gpt-6-luna on openai: network"));
		assert.equal(
			r.out.some((l) => l.includes("anthropic")),
			false,
		);
	} finally {
		r.cleanup();
	}
});

test("an account with no usage observation is unknown, which pauses rather than assuming capacity", async () => {
	const r = await run({ args: ["build"], raw: profilesFile(build), observations: [] });
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		assert.ok(r.out.includes("reason: openai-codex/gpt-6-luna on openai: unknown"));
	} finally {
		r.cleanup();
	}
});

test("a stale observation is not proof of room either", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		observations: [observation("openai", "available", 60 * 60), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		assert.ok(r.out.includes("reason: openai-codex/gpt-6-luna on openai: stale"));
	} finally {
		r.cleanup();
	}
});

test("--current with failure exhausted skips that model and selects the alternative", async () => {
	const r = await run({
		args: ["build", "--current", "openai-codex/gpt-6-luna", "--failure", "exhausted"],
		raw: profilesFile(build),
		// The usage still says available: the native limit error is the newer fact.
		observations: [observation("openai", "available"), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.selected);
		assert.equal(r.out[0], "selected: anthropic/claude-sonnet-5-5");
	} finally {
		r.cleanup();
	}
});

test("--current with failure auth pauses instead of moving on: a refused login is not a quota problem", async () => {
	const r = await run({
		args: ["build", "--current", "openai-codex/gpt-6-luna", "--failure", "auth"],
		raw: profilesFile(build),
		observations: [observation("openai", "available"), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.paused);
		assert.ok(r.out.includes("reason: openai-codex/gpt-6-luna on openai: auth"));
		assert.equal(
			r.out.some((l) => l.includes("anthropic")),
			false,
		);
	} finally {
		r.cleanup();
	}
});

test("a candidate whose model the registry does not know is skipped, never invented", async () => {
	const r = await run({
		args: ["build"],
		raw: profilesFile(build),
		models: [{ provider: "anthropic", id: "claude-sonnet-5-5", authed: true }],
		observations: [observation("openai", "available"), observation("claude", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.selected);
		assert.equal(r.out[0], "selected: anthropic/claude-sonnet-5-5");
		assert.match(r.out[3] ?? "", /^reason: authorized alternative /);
	} finally {
		r.cleanup();
	}
});

test("no routing profiles file: says so, chooses nothing, exits as unauthorized", async () => {
	const r = await run({ args: ["build"], observations: [observation("openai", "available")] });
	try {
		assert.equal(r.code, ROUTE_EXIT.unauthorized);
		assert.deepEqual(r.out, []);
		assert.match(r.err[0] ?? "", /no routing profiles file, so nothing is authorized/);
		assert.equal(existsSync(join(r.home, "routing")), false);
	} finally {
		r.cleanup();
	}
});

test("an invalid profiles file says so and chooses nothing, however fresh the usage", async () => {
	const r = await run({ args: ["build"], raw: "{ not json", observations: [observation("openai", "available")] });
	try {
		assert.equal(r.code, ROUTE_EXIT.unauthorized);
		assert.deepEqual(r.out, []);
		assert.match(r.err[0] ?? "", /routing profiles file is invalid \(not JSON\)/);
	} finally {
		r.cleanup();
	}
});

test("a profile the file does not name chooses nothing", async () => {
	const r = await run({
		args: ["review"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.unauthorized);
		assert.deepEqual(r.out, []);
		assert.match(r.err[0] ?? "", /profile "review" is not in the routing profiles file/);
	} finally {
		r.cleanup();
	}
});

test("usage mistakes exit 2 and name the problem; nothing is chosen", async () => {
	const cases: { args: string[]; reason: RegExp }[] = [
		{ args: [], reason: /a profile name is required/ },
		{ args: ["build", "extra"], reason: /one profile name only/ },
		{ args: ["build", "--current", "openai-codex/gpt-6-luna"], reason: /--current and --failure go together/ },
		{ args: ["build", "--failure", "exhausted"], reason: /--current and --failure go together/ },
		{
			args: ["build", "--current", "gpt-6-luna", "--failure", "exhausted"],
			reason: /--current expects provider\/model/,
		},
		{ args: ["build", "--current", "openai-codex/gpt-6-luna", "--failure", "bogus"], reason: /--failure expects/ },
		{ args: ["build", "--task"], reason: /--task needs a value/ },
		{ args: ["build", "--agent", "../w-1"], reason: /--agent expects letters/ },
		{ args: ["build", "--model", "x"], reason: /unknown option --model/ },
	];
	for (const c of cases) {
		const r = await run({ args: c.args, raw: profilesFile(build), observations: [observation("openai", "available")] });
		try {
			assert.equal(r.code, ROUTE_EXIT.usage, c.args.join(" "));
			assert.match(r.err[0] ?? "", c.reason);
			assert.deepEqual(r.out, []);
		} finally {
			r.cleanup();
		}
	}
});

test("--current that the profile never authorized is a usage mistake, not a route", async () => {
	const r = await run({
		args: ["build", "--current", "openai-codex/gpt-9", "--failure", "exhausted"],
		raw: profilesFile(build),
		observations: [observation("openai", "available")],
	});
	try {
		assert.equal(r.code, ROUTE_EXIT.usage);
		assert.match(r.err[0] ?? "", /is not a candidate of profile build/);
	} finally {
		r.cleanup();
	}
});

test("the pi registry opens from an agent dir with no network and knows no invented model", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pih-route-agent-"));
	try {
		const registry = await openPiRegistry(agentDir);
		assert.equal(registry.find("openai-codex", "no-such-model-for-pihouse"), undefined);
		assert.ok(Array.isArray(registry.getAvailable()));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("pih route is reachable from the CLI: with no profiles file it exits unauthorized and writes nothing", async () => {
	const home = mkdtempSync(join(tmpdir(), "pih-route-cli-"));
	try {
		const code = await main(["route", "build"], { PIHOUSE_HOME: home, HOME: home });
		assert.equal(code, ROUTE_EXIT.unauthorized);
		assert.equal(existsSync(join(home, "routing")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// The executor skill tells agents what to run and how to read the answer. These checks keep it in step with the CLI:
// every failure kind it names is accepted, and the exit codes it documents are the ones runRoute returns.
test("the planner and the executor name the routing contract the CLI implements", async () => {
	const planner = readFileSync(join(SKILLS_DIR, "pre-build/planner/SKILL.md"), "utf8");
	const executor = readFileSync(join(SKILLS_DIR, "build/executor/SKILL.md"), "utf8");
	assert.match(planner, /\*\*Routing profile:\*\* <name>/);
	assert.match(
		executor,
		/`pih route <name> --current <provider\/model of that worker> --failure <exhausted\|rate\|auth>`/,
	);
	assert.match(executor, /Exit `3` \(`paused`\)/);
	assert.match(executor, /Exit `4`/);
	assert.match(executor, /or `2` \(a usage mistake\)/);
	// The journal attributes a decision to its worker and task only when the executor passes both.
	assert.match(executor, /`pih route <name> --agent <agent name> --task <T-id>`/);
	assert.match(executor, /`--agent <the worker that will run the selected model> --task <T-id>`/);
	assert.deepEqual(ROUTE_EXIT, { selected: 0, error: 1, usage: 2, paused: 3, unauthorized: 4 });
	for (const kind of ["exhausted", "rate", "auth"]) {
		const r = await run({
			args: ["build", "--current", "openai-codex/gpt-6-luna", "--failure", kind],
			raw: profilesFile(build),
			observations: [observation("openai", "available"), observation("claude", "available")],
		});
		try {
			assert.notEqual(r.code, ROUTE_EXIT.usage, `--failure ${kind} is accepted`);
		} finally {
			r.cleanup();
		}
	}
});
