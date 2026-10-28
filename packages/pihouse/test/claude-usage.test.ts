import assert from "node:assert/strict";
import { test } from "node:test";
import {
	claudeWindowsFromUsage,
	fetchClaudeUsage,
	pollClaudeUsage,
	readClaudeSdkUsage,
	type Sdk,
} from "../src/claude-usage.ts";
import type { PollState } from "../src/workflow/routing.ts";

const NOW = Date.parse("2026-10-28T15:00:00Z");
const valid = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 24.6, resets_at: new Date(NOW + 3_600_000).toISOString() },
		seven_day: { utilization: 74, resets_at: new Date(NOW + 86_400_000).toISOString() },
	},
};

test("Claude's SDK control request sends no prompt, skips transcript scans and closes its query", async () => {
	let closed = 0;
	let read = 0;
	const sdk: Sdk = {
		query({ prompt, options }) {
			const iterator = prompt[Symbol.asyncIterator]();
			assert.deepEqual(options.tools, []);
			assert.deepEqual(options.settingSources, []);
			assert.equal((options.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
			return {
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors }) {
					read++;
					assert.equal(skipBehaviors, true);
					// An unyielded iterator cannot send a model prompt.
					assert.equal((await Promise.race([iterator.next(), Promise.resolve("pending")])) === "pending", true);
					return valid;
				},
				close() {
					closed++;
				},
			};
		},
	};
	assert.deepEqual(await readClaudeSdkUsage(sdk), valid);
	assert.equal(read, 1);
	assert.equal(closed, 1);
});

test("Claude SDK query is closed when the usage control request fails", async () => {
	let closed = 0;
	const sdk: Sdk = {
		query: () => ({
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
				throw new Error("fake endpoint refusal");
			},
			close() {
				closed++;
			},
		}),
	};
	await assert.rejects(readClaudeSdkUsage(sdk), /fake endpoint refusal/);
	assert.equal(closed, 1);
});

test("Claude Code's structured usage result yields the real 5h and 7d percentages and resets", async () => {
	assert.deepEqual(claudeWindowsFromUsage(valid, NOW), [
		{ label: "5h", percent: 25, resetsAt: NOW + 3_600_000 },
		{ label: "7d", percent: 74, resetsAt: NOW + 86_400_000 },
	]);
	const observation = await fetchClaudeUsage(NOW, async () => valid);
	assert.equal(observation.state, "available");
	assert.equal(observation.source, "Claude Code usage endpoint");
	assert.equal(observation.windows?.length, 2);
});

test("a null, malformed or expired window is not invented, and API billing is not subscription quota", async () => {
	const partial = { ...valid, rate_limits: { ...valid.rate_limits, five_hour: null } };
	assert.deepEqual(
		claudeWindowsFromUsage(partial, NOW).map((window) => window.label),
		["7d"],
	);
	assert.deepEqual(claudeWindowsFromUsage({ ...valid, rate_limits_available: false }, NOW), []);
	assert.deepEqual(claudeWindowsFromUsage({ ...valid, subscription_type: null }, NOW), []);
	assert.deepEqual(
		claudeWindowsFromUsage(
			{ ...valid, rate_limits: { five_hour: { utilization: 100, resets_at: new Date(NOW - 1).toISOString() } } },
			NOW,
		),
		[],
	);
	assert.deepEqual(
		claudeWindowsFromUsage(
			{ ...valid, rate_limits: { five_hour: { utilization: "0", resets_at: new Date(NOW + 1).toISOString() } } },
			NOW,
		),
		[],
	);
	assert.equal((await fetchClaudeUsage(NOW, async () => partial)).state, "available");
	assert.equal((await fetchClaudeUsage(NOW, async () => ({ ...valid, rate_limits: null }))).state, "unknown");
	assert.equal(
		(
			await fetchClaudeUsage(NOW, async () => {
				throw new Error("secret");
			})
		).state,
		"network",
	);
});

test("Claude usage polling deduplicates concurrent readers and backs off failed requests", async () => {
	const state: PollState = new Map();
	let calls = 0;
	const read = async () => {
		calls++;
		return valid;
	};
	const [a, b] = await Promise.all([pollClaudeUsage(NOW, read, state), pollClaudeUsage(NOW, read, state)]);
	assert.equal(a.status, "observed");
	assert.equal(b.status, "observed");
	assert.equal(calls, 1);
	assert.equal((await pollClaudeUsage(NOW + 500, read, state)).status, "backoff");
});
