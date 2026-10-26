import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fetchCodexWindows,
	modelLabel,
	providerLabel,
	sessionTotals,
	statusLine,
	tildePath,
} from "../src/extensions/statusbar.ts";
import { THEME } from "../src/paths.ts";
import {
	chatgptAccountId,
	formatReset,
	parseDuration,
	windowLabel,
	windowsFromHeaders,
	windowsFromJson,
} from "../src/usage.ts";

const plain = { fg: (_c: string, t: string) => t } as Parameters<typeof statusLine>[0];
const NOW = Date.parse("2026-10-26T12:00:00Z");
const base = {
	width: 200,
	cwd: "/Users/me/project",
	home: "/Users/me",
	branch: "main",
	provider: "anthropic",
	model: "claude-sonnet-5-5-20260301",
	contextPercent: 23.4,
	windows: [],
	now: NOW,
	cost: 0,
	input: 0,
	output: 0,
	extras: [],
};

test("Claude headers become the 5h and 7d windows, shortest first, with their resets", () => {
	const reset5 = NOW / 1000 + 4 * 3600 + 16 * 60;
	const windows = windowsFromHeaders(
		{
			"Anthropic-Ratelimit-Unified-7d-Utilization": "0.031",
			"anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 5 * 86400),
			"anthropic-ratelimit-unified-5h-utilization": "0.12",
			"anthropic-ratelimit-unified-5h-reset": String(reset5),
			"anthropic-ratelimit-unified-overage-utilization": "0.9",
			"anthropic-ratelimit-unified-grace-5h-utilization": "0.9",
		},
		NOW,
	);
	assert.deepEqual(
		windows.map((w) => [w.label, w.percent]),
		[
			["5h", 12],
			["7d", 3],
		],
	);
	assert.equal(windows[0]?.resetsAt, reset5 * 1000);
	assert.equal(formatReset(reset5 * 1000, NOW), "4h16m");
});

test("ChatGPT headers and the usage endpoint give the same kind of window", () => {
	assert.deepEqual(
		windowsFromHeaders(
			{
				"x-codex-primary-used-percent": "41",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-after-seconds": "600",
				"x-codex-secondary-used-percent": "7.4",
				"x-codex-secondary-window-minutes": "10080",
			},
			NOW,
		),
		[
			{ label: "5h", percent: 41, resetsAt: NOW + 600_000 },
			{ label: "7d", percent: 7 },
		],
	);
	const body = {
		plan_type: "plus",
		rate_limit: {
			secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 },
			primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_after_seconds: 120 },
		},
	};
	assert.deepEqual(windowsFromJson(body, NOW), [
		{ label: "5h", percent: 55, resetsAt: NOW + 120_000 },
		{ label: "7d", percent: 9, resetsAt: NOW + 86_400_000 },
	]);
});

test("an API key with only token limits shows a one-minute window; no limits show nothing", () => {
	assert.deepEqual(
		windowsFromHeaders(
			{ "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "750", "x-ratelimit-reset-tokens": "6m0s" },
			NOW,
		),
		[{ label: "1m", percent: 25, resetsAt: NOW + 360_000 }],
	);
	assert.deepEqual(windowsFromHeaders({ "content-type": "text/event-stream" }, NOW), []);
	assert.deepEqual(windowsFromJson({ ok: true }, NOW), []);
});

test("small helpers", () => {
	assert.equal(windowLabel(300), "5h");
	assert.equal(windowLabel(10080), "7d");
	assert.equal(windowLabel(1), "1m");
	assert.equal(parseDuration("6m0s"), 360);
	assert.equal(parseDuration("20ms"), 0.02);
	assert.equal(parseDuration("soon"), undefined);
	assert.equal(formatReset(NOW + 12 * 60_000, NOW), "12m");
	assert.equal(formatReset(NOW + (2 * 1440 + 180) * 60_000, NOW), "2d3h");
	assert.equal(formatReset(NOW - 1000, NOW), "0m");
	assert.equal(providerLabel("openai-codex"), "openai");
	assert.equal(providerLabel("anthropic"), "claude");
	assert.equal(modelLabel("claude-sonnet-5-5-20260301"), "sonnet-5-5");
	assert.equal(tildePath("/Users/me/project", "/Users/me"), "~/project");
	assert.equal(tildePath("/tmp/x", "/Users/me"), "/tmp/x");
	const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url")}.y`;
	assert.equal(chatgptAccountId(token), "acct_1");
	assert.equal(chatgptAccountId("not a token"), undefined);
});

test("the line shows the account in use: windows when there are some, tokens and cost when there are none", () => {
	const claude = statusLine(plain, {
		...base,
		windows: [{ label: "5h", percent: 12, resetsAt: NOW + (4 * 60 + 16) * 60_000 }],
	});
	assert.equal(claude, "~/project · main · claude sonnet-5-5 · ctx ▰▰▱▱▱▱▱▱ 23% · 5h 12% ↻4h16m");
	const keyOnly = statusLine(plain, {
		...base,
		provider: "openai",
		model: "gpt-5",
		input: 12_345,
		output: 800,
		cost: 0.0421,
	});
	assert.match(keyOnly, /openai gpt-5 · .* · ↑12.3k ↓800 {2}\$0.042$/);
});

test("with no login the line points at /login instead of naming a model", () => {
	const line = statusLine(plain, {
		...base,
		provider: undefined,
		model: undefined,
		contextPercent: null,
		branch: null,
	});
	assert.equal(line, "~/project · no model /login");
});

test("a narrow line drops the least important parts first and never overflows", () => {
	const input = { ...base, windows: [{ label: "5h", percent: 95 }], thinking: "high", extras: ["agent-link on"] };
	const full = statusLine(plain, { ...input, width: 300 });
	assert.match(full, /think high/);
	assert.match(full, /agent-link on$/);
	let previous = Number.POSITIVE_INFINITY;
	for (const width of [120, 90, 70, 50, 30, 12]) {
		const line = statusLine(plain, { ...input, width });
		assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		assert.ok(visibleWidth(line) <= previous);
		previous = visibleWidth(line);
	}
	const medium = statusLine(plain, { ...input, width: 70 });
	assert.match(medium, /~\/project/);
	assert.doesNotMatch(medium, /agent-link/);
});

test("usage is colored by how close the limit is", () => {
	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as Parameters<typeof statusLine>[0];
	const at = (percent: number) => statusLine(tag, { ...base, width: 5000, windows: [{ label: "5h", percent }] });
	assert.match(at(10), /<text>10%<\/text>/);
	assert.match(at(75), /<warning>75%<\/warning>/);
	assert.match(at(95), /<error>95%<\/error>/);
});

test("session totals add up only assistant messages", () => {
	const entries = [
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.01 } } } },
		{ type: "message", message: { role: "assistant", usage: { input: 50, output: 5, cost: { total: 0.005 } } } },
		{ type: "custom" },
	];
	assert.deepEqual(sessionTotals(entries), { cost: 0.015, input: 150, output: 25 });
});

test("the ChatGPT usage endpoint is read with the login's token and account, and a failure is empty", async () => {
	const seen: { url: string; headers: Record<string, string> }[] = [];
	const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url")}.y`;
	const ok = (async (url: string, init: { headers: Record<string, string> }) => {
		seen.push({ url, headers: init.headers });
		return {
			ok: true,
			json: async () => ({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } }),
		};
	}) as unknown as typeof fetch;
	assert.deepEqual(await fetchCodexWindows(token, NOW, ok), [{ label: "5h", percent: 30 }]);
	assert.equal(seen[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(seen[0]?.headers.authorization, `Bearer ${token}`);
	assert.equal(seen[0]?.headers["chatgpt-account-id"], "acct_1");
	const down = (async () => ({ ok: false })) as unknown as typeof fetch;
	assert.deepEqual(await fetchCodexWindows(token, NOW, down), []);
});

test("the theme has exactly the colors pi's schema asks for", () => {
	const schema = JSON.parse(
		readFileSync(
			new URL("../../../node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json", import.meta.url),
			"utf8",
		),
	) as { properties: { colors: { required: string[]; properties: Record<string, unknown> } } };
	const theme = JSON.parse(readFileSync(THEME, "utf8")) as { name: string; colors: Record<string, string> };
	const have = Object.keys(theme.colors).sort();
	assert.equal(theme.name, "pihouse");
	assert.deepEqual(have, Object.keys(schema.properties.colors.properties).sort());
	assert.deepEqual(
		schema.properties.colors.required.filter((k) => !have.includes(k)),
		[],
	);
});
