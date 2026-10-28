// account_usage against fake rate-limit files, a fake ChatGPT usage server, fake headers and a fake clock.
// No live API, no real login: tokens are made up and must never reach the output.
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AccountReport, formatAccountUsage, gatherAccountUsage } from "../src/account-usage.ts";
import accountUsage from "../src/extensions/account-usage.ts";
import { EXTENSIONS } from "../src/paths.ts";
import type { PollState } from "../src/workflow/routing.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const SECRET = "sk-secret-token-value";

function claudeDir(file: object | undefined, mtime = NOW) {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-acct-"));
	if (file) {
		const path = join(dir, "s1.json");
		writeFileSync(path, JSON.stringify(file));
		utimesSync(path, mtime / 1000, mtime / 1000);
	}
	return dir;
}

async function usageServer(handler: (res: import("node:http").ServerResponse) => void) {
	const server: Server = createServer((_req, res) => handler(res));
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/usage`;
	return { url, close: () => server.close() };
}

const codexBody = (percent: number) => ({
	rate_limit: {
		primary_window: { used_percent: percent, limit_window_seconds: 18000, reset_after_seconds: 3600 },
		secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 86400 },
	},
});

const find = (reports: AccountReport[], account: string) => reports.find((r) => r.account === account);

test("fresh Claude SDK usage supersedes a stale status-line file without calling a model", async () => {
	const dir = claudeDir({ used_percentage: 100, resets_at: NOW / 1000 + 600 }, NOW - 3_600_000);
	const [claude] = await gatherAccountUsage({
		now: NOW,
		providers: ["claude-bridge"],
		claudeDir: dir,
		headers: {},
		claudeUsage: async () => ({
			provider: "claude",
			account: "claude",
			observedAt: NOW,
			source: "Claude Code usage endpoint",
			state: "available",
			windows: [
				{ label: "5h", percent: 12, resetsAt: NOW + 3_600_000 },
				{ label: "7d", percent: 32, resetsAt: NOW + 86_400_000 },
			],
		}),
	});
	assert.equal(claude?.status, "available");
	assert.equal(claude?.source, "Claude Code usage endpoint");
	assert.deepEqual(
		claude?.windows.map((window) => window.percent),
		[12, 32],
	);
});

test("a Claude Code file seen a minute ago is available, with its windows and reset", async () => {
	const dir = claudeDir(
		{
			used_percentage: 23,
			resets_at: NOW / 1000 + 7200,
			seven_day: { used_percentage: 4, resets_at: NOW / 1000 + 86400 },
		},
		NOW - 60_000,
	);
	const reports = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	const claude = find(reports, "claude");
	assert.equal(claude?.status, "available");
	assert.equal(claude?.ageSeconds, 60);
	assert.deepEqual(
		claude?.windows.map((w) => [w.label, w.percent]),
		[
			["5h", 23],
			["7d", 4],
		],
	);
	assert.equal(claude?.windows[0]?.resetsAt, new Date(NOW + 7_200_000).toISOString());
});

test("a Claude observation merges current 5h and 7d windows, drops expired windows and rejects malformed siblings", async () => {
	const dir = claudeDir(undefined);
	const old = join(dir, "old.json");
	const fresh = join(dir, "fresh.json");
	writeFileSync(old, JSON.stringify({ used_percentage: 100, resets_at: NOW / 1000 - 1 }));
	utimesSync(old, (NOW - 10_000) / 1000, (NOW - 10_000) / 1000);
	writeFileSync(
		fresh,
		JSON.stringify({
			used_percentage: 100,
			resets_at: NOW / 1000 + 600,
			seven_day: { used_percentage: 49, resets_at: NOW / 1000 + 86_400 },
		}),
	);
	utimesSync(fresh, (NOW - 1_000) / 1000, (NOW - 1_000) / 1000);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "exhausted");
	assert.deepEqual(
		claude?.windows.map((w) => [w.label, w.percent]),
		[
			["5h", 100],
			["7d", 49],
		],
	);
	assert.match(formatAccountUsage(claude ? [claude] : [], NOW), /7d 49% \(51% remaining\)/);
});

test("a malformed newest Claude file cannot hide an older valid observation or become fresh", async () => {
	const dir = claudeDir({ used_percentage: 75, resets_at: NOW / 1000 + 600 }, NOW - 60_000);
	const broken = join(dir, "newer.json");
	writeFileSync(broken, "{not json");
	utimesSync(broken, (NOW - 1_000) / 1000, (NOW - 1_000) / 1000);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["claude-bridge"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "unknown");
	assert.deepEqual(claude?.windows, []);
});

test("a window at 100% is exhausted", async () => {
	const dir = claudeDir({ used_percentage: 100, resets_at: NOW / 1000 + 600 }, NOW - 1000);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "exhausted");
});

test("an old observation is stale, not available", async () => {
	const dir = claudeDir({ used_percentage: 20, resets_at: NOW / 1000 + 7200 }, NOW - 3 * 3600_000);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "stale");
	assert.equal(claude?.windows.length, 1);
	const text = formatAccountUsage(claude ? [claude] : [], NOW);
	assert.match(text, /claude: stale/);
	assert.match(text, /5h 20% \(80% remaining\)/);
	assert.doesNotMatch(text, /claude: available/);
});

test("a missing source is unknown with no windows, never 0% or available", async () => {
	const dir = claudeDir(undefined);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "unknown");
	assert.deepEqual(claude?.windows, []);
});

test("a window that already reset says nothing: unknown", async () => {
	const dir = claudeDir({ used_percentage: 100, resets_at: NOW / 1000 - 60 }, NOW - 1000);
	const [claude] = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	assert.equal(claude?.status, "unknown");
});

test("response headers seen lately stand in for a missing file", async () => {
	const dir = claudeDir(undefined);
	const [claude] = await gatherAccountUsage({
		now: NOW,
		providers: ["anthropic"],
		claudeDir: dir,
		headers: {
			claude: {
				at: NOW - 30_000,
				windows: [{ label: "5h", percent: 100, resetsAt: NOW + 3600_000 }],
			},
		},
	});
	assert.equal(claude?.status, "exhausted");
	assert.equal(claude?.source, "response headers");
	assert.equal(claude?.ageSeconds, 30);
});

test("ChatGPT usage comes from the endpoint with the login's token, which never appears in the output", async () => {
	const seen: Array<string | undefined> = [];
	const server = await usageServer((res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(codexBody(100)));
	});
	try {
		const reports = await gatherAccountUsage({
			now: NOW,
			providers: ["openai-codex"],
			claudeDir: claudeDir(undefined),
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
			fetchFn: (url, init) => {
				seen.push((init?.headers as Record<string, string> | undefined)?.authorization);
				return fetch(url, init);
			},
		});
		const openai = find(reports, "openai");
		assert.equal(openai?.status, "exhausted");
		assert.equal(openai?.ageSeconds, 0);
		assert.deepEqual(seen, [`Bearer ${SECRET}`]);
		const text = formatAccountUsage(reports, NOW);
		assert.ok(!text.includes(SECRET) && !JSON.stringify(reports).includes(SECRET));
		assert.match(text, /openai/);
		assert.match(text, /5h 100%/);
	} finally {
		server.close();
	}
});

test("an endpoint that hangs is reported as unknown within the timeout", async () => {
	const server = await usageServer(() => {
		// never answers
	});
	try {
		const started = Date.now();
		const reports = await gatherAccountUsage({
			now: NOW,
			providers: ["openai-codex"],
			claudeDir: claudeDir(undefined),
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
			timeoutMs: 100,
		});
		assert.ok(Date.now() - started < 2000);
		const openai = find(reports, "openai");
		assert.equal(openai?.status, "unknown");
		assert.match(openai?.note ?? "", /unreachable/);
		assert.ok(!JSON.stringify(reports).includes(SECRET));
	} finally {
		server.close();
	}
});

test("partial ChatGPT windows remain usable while missing windows are not invented", async () => {
	const server = await usageServer((res) => {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: NOW / 1000 + 1800 } },
			}),
		);
	});
	try {
		const [report] = await gatherAccountUsage({
			now: NOW,
			providers: ["openai-codex"],
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
		});
		assert.equal(report?.status, "available");
		assert.deepEqual(
			report?.windows.map((w) => [w.label, w.percent, w.resetsAt]),
			[["5h", 40, new Date(NOW + 1_800_000).toISOString()]],
		);
		assert.match(formatAccountUsage(report ? [report] : [], NOW), /5h 40% \(60% remaining\), resets in 30m/);
	} finally {
		server.close();
	}
});

test("an expired ChatGPT response has no live windows and is unknown", async () => {
	const server = await usageServer((res) => {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: NOW / 1000 - 1 } },
			}),
		);
	});
	try {
		const [report] = await gatherAccountUsage({
			now: NOW,
			providers: ["openai-codex"],
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
		});
		assert.equal(report?.status, "unknown");
		assert.deepEqual(report?.windows, []);
	} finally {
		server.close();
	}
});

test("an endpoint error status is unknown", async () => {
	const server = await usageServer((res) => {
		res.statusCode = 500;
		res.end("boom");
	});
	try {
		const reports = await gatherAccountUsage({
			now: NOW,
			providers: ["openai-codex"],
			claudeDir: claudeDir(undefined),
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
		});
		assert.equal(find(reports, "openai")?.status, "unknown");
	} finally {
		server.close();
	}
});

test("only logged-in providers are listed", async () => {
	const reports = await gatherAccountUsage({ now: NOW, providers: [], claudeDir: claudeDir(undefined), headers: {} });
	assert.deepEqual(reports, []);
	assert.match(formatAccountUsage(reports, NOW), /No logged-in/);
});

test("the text shows status, windows, resets and freshness for each account", async () => {
	const dir = claudeDir({ used_percentage: 23, resets_at: NOW / 1000 + 8100 }, NOW - 120_000);
	const reports = await gatherAccountUsage({ now: NOW, providers: ["anthropic"], claudeDir: dir, headers: {} });
	const text = formatAccountUsage(reports, NOW);
	assert.match(text, /claude: available/);
	assert.match(text, /5h 23%/);
	assert.match(text, /resets in 2h15m/);
	assert.match(text, /2m ago/);
});

test("the tool is registered once with a bounded schema and reads no secrets into its answer", async () => {
	const tools: Array<{
		name: string;
		parameters: { additionalProperties?: boolean; properties: Record<string, { maxLength?: number }> };
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
	}> = [];
	const handlers = new Map<string, unknown>();
	accountUsage({
		registerTool: (t: (typeof tools)[number]) => tools.push(t),
		on: (e: string, h: unknown) => handlers.set(e, h),
	} as unknown as ExtensionAPI);
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool?.name, "account_usage");
	assert.equal(tool?.parameters.additionalProperties, false);
	for (const p of Object.values(tool?.parameters.properties ?? {})) assert.ok(typeof p.maxLength === "number");
	assert.ok(handlers.has("after_provider_response"));
	const ctx = { modelRegistry: { getAvailable: () => [], getApiKeyForProvider: async () => SECRET } };
	const result = await tool?.execute("id", {}, undefined, undefined, ctx);
	assert.ok(!result?.content[0]?.text.includes(SECRET));
});

test("every pihouse root and worker loads the extension", () => {
	assert.ok(EXTENSIONS.some((e) => e.endsWith("extensions/account-usage.ts")));
});

test("concurrent reports share one usage request, and a refused login backs off instead of retrying", async () => {
	// Problem: every status bar redraw and every account_usage call asked the usage endpoint again, so a refused login
	// was retried on each call.
	// Example: two reports in the same moment and one more shortly after must cost one request, not three.
	let hits = 0;
	const server = await usageServer((res) => {
		hits++;
		res.statusCode = 401;
		res.end("no");
	});
	try {
		const poll: PollState = new Map();
		const args = {
			now: NOW,
			providers: ["openai-codex"],
			claudeDir: claudeDir(undefined),
			headers: {},
			openaiToken: async () => SECRET,
			openaiUrl: server.url,
			poll,
		};
		const [first, second] = await Promise.all([gatherAccountUsage(args), gatherAccountUsage(args)]);
		assert.equal(hits, 1);
		const later = await gatherAccountUsage(args);
		assert.equal(hits, 1);
		for (const reports of [first, second, later]) {
			const openai = find(reports, "openai");
			assert.equal(openai?.status, "unknown");
			assert.match(openai?.note ?? "", /backed off|refused/);
			assert.ok(!JSON.stringify(reports).includes(SECRET));
		}
	} finally {
		server.close();
	}
});

test("a refused login, a rate limit and an unreachable endpoint have distinct notes, all unknown", async () => {
	const cases: [number, RegExp][] = [
		[401, /refused this login/],
		[429, /rate-limited/],
		[500, /unreachable or unreadable/],
	];
	for (const [code, note] of cases) {
		const server = await usageServer((res) => {
			res.statusCode = code;
			res.end("no");
		});
		try {
			const reports = await gatherAccountUsage({
				now: NOW,
				providers: ["openai-codex"],
				claudeDir: claudeDir(undefined),
				headers: {},
				openaiToken: async () => SECRET,
				openaiUrl: server.url,
				poll: new Map(),
			});
			const openai = find(reports, "openai");
			assert.equal(openai?.status, "unknown", String(code));
			assert.match(openai?.note ?? "", note, String(code));
		} finally {
			server.close();
		}
	}
});
