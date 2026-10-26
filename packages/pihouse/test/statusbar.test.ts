import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fetchCodexWindows, providerLabel, sessionTotals, shortCwd, statusLine } from "../src/extensions/statusbar.ts";
import { THEME } from "../src/paths.ts";
import {
	chatgptAccountId,
	formatLeft,
	parseDuration,
	readClaudeCodeUsage,
	windowLabel,
	windowsFromHeaders,
	windowsFromJson,
} from "../src/usage.ts";

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as Parameters<typeof statusLine>[0];
const NOW = Date.parse("2026-10-26T12:00:00Z");
const base = {
	width: 300,
	cwd: "/Users/me/project",
	user: "me",
	host: "mac",
	model: "Sonnet 5.5",
	contextPercent: 32.4,
	accounts: [],
	now: NOW,
	cost: 0,
	input: 0,
	output: 0,
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
			{
				"x-ratelimit-limit-tokens": "1000",
				"x-ratelimit-remaining-tokens": "750",
				"x-ratelimit-reset-tokens": "6m0s",
			},
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
	assert.equal(providerLabel("openai-codex"), "openai");
	assert.equal(providerLabel("anthropic"), "claude");
	assert.equal(shortCwd("/Users/me/project"), "~/project");
	const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url")}.y`;
	assert.equal(chatgptAccountId(token), "acct_1");
	assert.equal(chatgptAccountId("not a token"), undefined);
});

test("the time left reads like Claude Code's bar: hours and minutes, then the clock time", () => {
	assert.match(formatLeft(NOW + (4 * 60 + 16) * 60_000, NOW), /^4h16m → \d\d:\d\d$/);
	assert.match(formatLeft(NOW + 125 * 60_000, NOW), /^2h5m → \d\d:\d\d$/);
	assert.match(formatLeft(NOW + 12 * 60_000, NOW), /^12m → \d\d:\d\d$/);
	assert.match(formatLeft(NOW - 1000, NOW), /^0m → /);
	assert.equal(formatLeft(NOW + (2 * 1440 + 180) * 60_000, NOW), "2d3h");
});

test("the Claude usage is read from the newest file Claude Code's status line left, and a past window gives nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "rl-"));
	mkdirSync(dir, { recursive: true });
	const write = (name: string, body: string, ageSeconds: number) => {
		const file = join(dir, name);
		writeFileSync(file, body);
		const t = (NOW - ageSeconds * 1000) / 1000;
		utimesSync(file, t, t);
	};
	write("old.json", `{"used_percentage":94,"resets_at":${NOW / 1000 + 600}}`, 5000);
	write("new.json", `{"used_percentage":23.6,"resets_at":${NOW / 1000 + 8100}}`, 10);
	write("notes.txt", "ignored", 1);
	assert.deepEqual(readClaudeCodeUsage(dir, NOW), [{ label: "5h", percent: 24, resetsAt: NOW + 8_100_000 }]);
	assert.deepEqual(readClaudeCodeUsage(dir, NOW + 9_000_000), [], "the window has reset");
	write(
		"new.json",
		`{"used_percentage":23.6,"resets_at":${NOW / 1000 + 8100},"seven_day":{"used_percentage":31,"resets_at":${NOW / 1000 + 259200}}}`,
		10,
	);
	assert.deepEqual(readClaudeCodeUsage(dir, NOW), [
		{ label: "5h", percent: 24, resetsAt: NOW + 8_100_000 },
		{ label: "7d", percent: 31, resetsAt: NOW + 259_200_000 },
	]);
	assert.deepEqual(readClaudeCodeUsage(join(dir, "missing"), NOW), []);
	write("new.json", "not json", 1);
	assert.deepEqual(readClaudeCodeUsage(dir, NOW), []);
});

const win = (label: string, percent: number, resetsAt?: number) => ({
	label,
	percent,
	...(resetsAt ? { resetsAt } : {}),
});

test("the first line is the session: user@host, folder, model, effort and context", () => {
	const [head, ...rest] = statusLine(plain, { ...base, effort: "high" });
	assert.equal(head, "me@mac  ~/project  Sonnet 5.5  effort: high  ctx: 32%");
	assert.deepEqual(rest, [], "no account has a window, so nothing else");
});

test("each account with a window gets its own line, with its limits and resets, aligned", () => {
	const lines = statusLine(plain, {
		...base,
		accounts: [
			{
				name: "claude",
				active: true,
				windows: [win("5h", 23, NOW + (2 * 60 + 15) * 60_000), win("7d", 31, NOW + 3 * 86_400_000)],
			},
			{ name: "openai", active: false, windows: [win("5h", 41, NOW + 3_600_000)] },
			{ name: "gemini", active: false, windows: [] },
		],
	});
	assert.equal(lines.length, 3, "the session line and two accounts; an account without windows has no line");
	assert.match(lines[1] ?? "", /^◷ claude {2}5h: 23% \(2h15m → \d\d:\d\d\) {3}7d: 31% \(3d0h\)$/);
	assert.match(lines[2] ?? "", /^◷ openai {2}5h: 41% \(1h0m → \d\d:\d\d\)$/);
});

test("account names are padded to one width so the limits line up", () => {
	const lines = statusLine(plain, {
		...base,
		accounts: [
			{ name: "openai", active: false, windows: [win("5h", 41)] },
			{ name: "copilot-x", active: false, windows: [win("5h", 5)] },
		],
	});
	assert.equal(lines[1], "◷ openai     5h: 41%");
	assert.equal(lines[2], "◷ copilot-x  5h: 5%");
});

test("the active account is named in the accent color and the others in muted", () => {
	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t } as Parameters<
		typeof statusLine
	>[0];
	const lines = statusLine(tag, {
		...base,
		width: 5000,
		accounts: [
			{ name: "claude", active: true, windows: [win("5h", 10)] },
			{ name: "openai", active: false, windows: [win("5h", 10)] },
		],
	});
	assert.match(lines[1] ?? "", /^<accent>◷ claude<\/accent>/);
	assert.match(lines[2] ?? "", /^<muted>◷ openai<\/muted>/);
});

test("with no windows the session's tokens and cost take the line below; with no model the line says so", () => {
	const spent = statusLine(plain, { ...base, input: 12_345, output: 800, cost: 0.0421 });
	assert.equal(spent[1], "↑12.3k ↓800  $0.042");
	const none = statusLine(plain, { ...base, model: undefined, contextPercent: null });
	assert.deepEqual(none, ["me@mac  ~/project  ctx: --"]);
});

test("a narrow first line drops the least important parts first and never overflows; account lines never merge", () => {
	const input = { ...base, effort: "high", accounts: [{ name: "claude", active: true, windows: [win("5h", 95)] }] };
	let previous = Number.POSITIVE_INFINITY;
	for (const width of [120, 90, 70, 50, 30, 12]) {
		const lines = statusLine(plain, { ...input, width });
		for (const l of lines) assert.ok(visibleWidth(l) <= width, `${width}: ${l}`);
		assert.ok(visibleWidth(lines[0] ?? "") <= previous);
		previous = visibleWidth(lines[0] ?? "");
		assert.equal(lines.length, 2, "the account keeps its own line at every width");
	}
	const medium = statusLine(plain, { ...input, width: 40 })[0] ?? "";
	assert.match(medium, /~\/project/);
	assert.match(medium, /Sonnet 5\.5/);
	assert.doesNotMatch(medium, /me@mac|effort/, "user@host and effort go before the folder and the model");
});

test("context and usage are colored by how close the limit is", () => {
	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t } as Parameters<
		typeof statusLine
	>[0];
	const at = (percent: number) =>
		statusLine(tag, {
			...base,
			width: 5000,
			contextPercent: percent,
			accounts: [{ name: "claude", active: true, windows: [win("5h", percent)] }],
		}).join("\n");
	assert.match(at(10), /<muted>ctx: 10%<\/muted>/);
	assert.match(at(10), /<text>5h: 10%<\/text>/);
	assert.match(at(75), /<warning>ctx: 75%<\/warning>/);
	assert.match(at(95), /<error>5h: 95%<\/error>/);
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
