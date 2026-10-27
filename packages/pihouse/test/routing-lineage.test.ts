// Routing lineage end to end, with fakes only: a profile with two candidates on different accounts, a worker that
// fails on the first account, and its replacement on the second. The route decisions, a synthetic agent-link journal,
// the live report and the captured evidence must show both decisions with their accounts and reasons, and exactly one
// worker may still be writing. No hub, provider, quota or home directory is touched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "agent-link-core";
import type { AccountObservation } from "../src/account-usage.ts";
import { ROUTE_EXIT, type RouteRegistry, runRoute } from "../src/route.ts";
import { captureRun } from "../src/workflow/capture.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { renderEvidenceReport, renderReport } from "../src/workflow/report.ts";
import type { Observation } from "../src/workflow/routing.ts";
import {
	appendRoutingDecision,
	ROUTING_PROFILES_FILE,
	readRoutingDecisions,
} from "../src/workflow/routing-profiles.ts";
import { buildRun } from "../src/workflow/run.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const profiles = {
	version: 1,
	profiles: [
		{
			id: "build",
			purpose: "build",
			requiredCapabilities: ["code"],
			allowedBilling: ["subscription"],
			candidates: [
				{
					harness: "pihouse",
					model: "openai-codex/gpt-6-luna",
					account: "openai",
					billing: "subscription",
					capabilities: ["code"],
				},
				{
					harness: "pihouse",
					model: "anthropic/claude-sonnet-5-5",
					account: "claude",
					billing: "subscription",
					capabilities: ["code"],
				},
			],
		},
	],
};

const registry: RouteRegistry = {
	find(provider, id) {
		return [
			{ provider: "openai-codex", id: "gpt-6-luna" },
			{ provider: "anthropic", id: "claude-sonnet-5-5" },
		].find((m) => m.provider === provider && m.id === id);
	},
	hasConfiguredAuth() {
		return true;
	},
	getAvailable() {
		return [{ provider: "openai-codex" }, { provider: "anthropic" }];
	},
	async getApiKeyForProvider() {
		return undefined;
	},
};

const observation = (account: string, state: Observation["state"], now: number): Observation => ({
	provider: account,
	account,
	state,
	observedAt: now - 5_000,
	source: "usage endpoint",
});

/** One `pih route` call in the shared home, with the account observations it is given. */
async function route(home: string, args: string[], now: number, observed: Observation[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runRoute(args, {
		env: { PIHOUSE_HOME: home },
		home,
		now,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		openRegistry: async () => registry,
		observe: async () => observed.map((o): AccountObservation => ({ account: o.account, observation: o })),
	});
	return { code, out, err };
}

// The journal as agent-link records it: the planner runs the executor, which runs two workers. w-1 failed on the first
// account and exited; w-2 is its replacement on the second account and is still working.
function journal(): { planner: SessionRecord; records: SessionRecord[] } {
	const base = { parentName: null, harness: "pihouse", model: null, cwd: process.cwd(), depth: 0 };
	const planner: SessionRecord = {
		...base,
		id: "planner",
		name: "workflow-planner",
		parent: null,
		root: "planner",
		state: "exited",
		task: "/skill:planner build the thing",
		startedAt: iso(T0),
		updatedAt: iso(T0 + 300_000),
	};
	const executor: SessionRecord = {
		...base,
		id: "executor",
		name: "workflow-executor",
		parent: "planner",
		parentName: "workflow-planner",
		root: "planner",
		depth: 1,
		state: "exited",
		task: "/skill:executor docs/plans/lightweight-self-learning.md",
		startedAt: iso(T0 + 1_000),
		updatedAt: iso(T0 + 300_000),
	};
	const worker = (
		id: string,
		name: string,
		state: SessionRecord["state"],
		start: number,
		end: number,
	): SessionRecord => ({
		...base,
		id,
		name,
		parent: "executor",
		parentName: "workflow-executor",
		root: "planner",
		depth: 2,
		state,
		task: "Task T1 of docs/plans/lightweight-self-learning.md: Build the thing\nSkills: build",
		startedAt: iso(start),
		updatedAt: iso(end),
		...(state === "exited" ? { endedAt: iso(end) } : {}),
	});
	const first = worker("w-1-id", "w-1", "exited", T0 + 2_000, T0 + 60_000);
	const replacement = worker("w-2-id", "w-2", "working", T0 + 62_000, T0 + 120_000);
	return { planner, records: [planner, executor, first, replacement] };
}

test("a quota failure replaces a worker on a second account: both decisions reach the report and the captured evidence", async () => {
	const home = mkdtempSync(join(tmpdir(), "pih-routing-lineage-"));
	try {
		writeFileSync(join(home, ROUTING_PROFILES_FILE), JSON.stringify(profiles));

		// w-1 is routed on the first account, which is available.
		const first = await route(home, ["build", "--agent", "w-1", "--task", "T1"], T0, [
			observation("openai", "available", T0),
		]);
		assert.equal(first.code, ROUTE_EXIT.selected);
		assert.equal(first.out[0], "selected: openai-codex/gpt-6-luna");

		// w-1 fails with a quota error a minute later. The executor asks once for the replacement.
		const failedAt = T0 + 61_000;
		const replacement = await route(
			home,
			["build", "--current", "openai-codex/gpt-6-luna", "--failure", "exhausted", "--agent", "w-2", "--task", "T1"],
			failedAt,
			[observation("openai", "exhausted", failedAt), observation("claude", "available", failedAt)],
		);
		assert.equal(replacement.code, ROUTE_EXIT.selected);
		assert.equal(replacement.out[0], "selected: anthropic/claude-sonnet-5-5");
		assert.equal(replacement.out[2], "account: claude");
		assert.match(replacement.out[3] ?? "", /^reason: authorized alternative \(usage endpoint, observed 5s ago\)$/);

		// The journal keeps both decisions, in order, each with its own account and reason.
		const decisions = readRoutingDecisions(home);
		assert.equal(decisions.skipped, 0);
		assert.deepEqual(
			decisions.decisions.map((d) => [d.agent, d.account, d.failure, d.time]),
			[
				["w-1", "openai", null, T0],
				["w-2", "claude", "exhausted", failedAt],
			],
		);

		// Exactly one worker may still write: the replaced one exited, and only the replacement is working.
		const { planner, records } = journal();
		const writers = records.filter((r) => ["starting", "working", "asking"].includes(r.state)).map((r) => r.name);
		assert.deepEqual(writers, ["w-2"], "exactly one active writer");

		// The live report: each worker shows its own decision, and the run is partial while the replacement works.
		const run = buildRun(records, planner);
		const report = renderReport(run, { routing: decisions, messages: false });
		assert.match(report, /\*\*PARTIAL:\*\*/);
		assert.match(
			report,
			/\| w-1 \| build \| openai-codex\/gpt-6-luna \| - \| openai \| available \(usage endpoint, observed 5s ago\) \| - \|/,
		);
		assert.match(
			report,
			/\| w-2 \| build \| anthropic\/claude-sonnet-5-5 \| - \| claude \| authorized alternative \(usage endpoint, observed 5s ago\) \| exhausted \|/,
		);

		// The captured evidence keeps the same two decisions after the raw copies are gone.
		const memory = join(home, "memory");
		assert.equal(captureRun(records, planner, openMemory(memory), { by: "planner" }), "written");
		const stored = JSON.parse(readFileSync(join(memory, "runs", "planner", "run.json"), "utf8"));
		const routed = (id: string) =>
			(
				stored.evidence.participants as { id: string; routing?: { account: string | null; model: string | null } }[]
			).find((p) => p.id === id)?.routing;
		assert.equal(routed("w-1-id")?.account, "openai");
		assert.equal(routed("w-1-id")?.model, "openai-codex/gpt-6-luna");
		assert.equal(routed("w-2-id")?.account, "claude");
		assert.equal(routed("w-2-id")?.model, "anthropic/claude-sonnet-5-5");
		const evidence = renderEvidenceReport(stored.evidence);
		assert.match(evidence, /\| w-1-id \| build \| openai-codex\/gpt-6-luna \| - \| openai \|/);
		assert.match(evidence, /\| w-2-id \| build \| anthropic\/claude-sonnet-5-5 \| - \| claude \|/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// Capture reads the journal beside its store, and the report reads the pihouse home from the environment. Under a custom
// PIHOUSE_HOME both must resolve the same file, so neither depends on the real ~/.pihouse.
test("capture and report resolve the same routing journal under a custom PIHOUSE_HOME", () => {
	const home = mkdtempSync(join(tmpdir(), "pih-routing-custom-home-"));
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = home;
	try {
		const { planner, records } = journal();
		appendRoutingDecision(home, {
			time: T0,
			profile: "build",
			task: "T1",
			agent: "w-1",
			model: "openai-codex/gpt-6-luna",
			account: "openai",
			billing: "subscription",
			reason: "available (usage endpoint, observed 5s ago)",
			failure: null,
			checkpoint: null,
		});
		appendRoutingDecision(home, {
			time: T0 + 61_000,
			profile: "build",
			task: "T1",
			agent: "w-2",
			model: "anthropic/claude-sonnet-5-5",
			account: "claude",
			billing: "subscription",
			reason: "authorized alternative (usage endpoint, observed 5s ago)",
			failure: "exhausted",
			checkpoint: null,
		});
		// The store sits under the custom home, so its sibling routing/ folder is the journal capture reads.
		const store = openMemory(join(home, "memory"));
		assert.equal(captureRun(records, planner, store, { by: "planner" }), "written");
		const stored = JSON.parse(readFileSync(join(home, "memory", "runs", "planner", "run.json"), "utf8"));
		const account = (id: string) =>
			(stored.evidence.participants as { id: string; routing?: { account: string } }[]).find((p) => p.id === id)
				?.routing?.account;
		assert.equal(account("w-1-id"), "openai", "capture read the decision for w-1");
		assert.equal(account("w-2-id"), "claude", "capture read the decision for w-2");

		// The report is given no journal: it must find the same two decisions through PIHOUSE_HOME.
		const report = renderReport(buildRun(records, planner), { messages: false });
		assert.match(report, /\| w-1 \| build \| openai-codex\/gpt-6-luna \| - \| openai \|/);
		assert.match(report, /\| w-2 \| build \| anthropic\/claude-sonnet-5-5 \| - \| claude \| authorized alternative/);
	} finally {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});
