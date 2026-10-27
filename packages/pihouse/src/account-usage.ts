// What the `account_usage` tool answers: for each logged-in account, its usage windows, how fresh they are and
// whether the account can be used right now.
//
// Problem: three workers were spawned on a ChatGPT account whose quota was spent; they failed with 0 tokens. The
// numbers existed (the status bar draws them) but only in the footer, out of the model's reach.
// Example: Claude Code's file says "5h 100%, resets in 40m" and was written 2 minutes ago: the Claude account is
// exhausted. A ChatGPT endpoint that times out says nothing: that account is unknown, not available.
// Solution: gather the same sources the status bar reads (see ./usage.ts), classify each account with routing.ts's
// own rule (route(), so "available / exhausted / stale / unknown" mean the same everywhere) and print only what is
// safe to show: no token, no header, no error text.
//
// The ChatGPT fetch is duplicated from extensions/statusbar.ts on purpose: that file has uncommitted edits, so it is
// not touched, and this fetch needs a configurable URL and timeout.
import {
	CLAUDE_CODE_RATE_LIMITS,
	chatgptAccountId,
	readClaudeCodeObservation,
	type UsageWindow,
	windowsFromJson,
} from "./usage.ts";
import { type Observation, type Profile, route } from "./workflow/routing.ts";

export type AccountStatus = "available" | "exhausted" | "stale" | "unknown";

export interface AccountReport {
	/** "claude", "openai", or the provider's own id when it has no usage source. */
	account: string;
	status: AccountStatus;
	windows: { label: string; percent: number; resetsAt?: string }[];
	/** Seconds since the observation was made; absent when nothing was observed. */
	ageSeconds?: number;
	/** Where the numbers came from. */
	source?: string;
	/** A fixed phrase on why the status is what it is, when that is not obvious. Never provider text. */
	note?: string;
}

/** Windows seen in the response headers of a provider, by account name, with when they were seen. */
export type SeenHeaders = Record<string, { at: number; windows: readonly UsageWindow[] } | undefined>;

export interface GatherInput {
	now: number;
	/** Provider ids of the logins and keys that can run a model here. */
	providers: readonly string[];
	claudeDir?: string;
	headers: SeenHeaders;
	/** The ChatGPT login's token, or undefined when there is none. */
	openaiToken?: () => Promise<string | undefined>;
	openaiUrl?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** An observation older than this no longer proves the account has room (Claude Code writes on its own refresh). */
export const MAX_AGE_MS = 15 * 60_000;
const TIMEOUT_MS = 4000;

/** What a provider id is called here: the account that owns its usage. */
function accountOf(provider: string): string {
	if (provider.includes("claude") || provider === "anthropic") return "claude";
	if (provider === "openai" || provider === "openai-codex" || provider === "azure") return "openai";
	return provider;
}

type Found = { windows: readonly UsageWindow[]; at: number; source: string };

/** The newest of the observations that have a window. */
function newest(...found: (Found | undefined)[]): Found | undefined {
	return found.filter((f): f is Found => !!f?.windows.length).sort((a, b) => b.at - a.at)[0];
}

async function readOpenAi(input: GatherInput): Promise<{ found?: Found; failed: boolean }> {
	const token = await input.openaiToken?.().catch(() => undefined);
	if (!token) return { failed: false };
	try {
		const id = chatgptAccountId(token);
		const res = await (input.fetchFn ?? fetch)(input.openaiUrl ?? CODEX_USAGE_URL, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				...(id ? { "chatgpt-account-id": id } : {}),
			},
			signal: AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS),
		});
		if (!res.ok) return { failed: true };
		const windows = windowsFromJson(await res.json(), input.now);
		return windows.length
			? { found: { windows, at: input.now, source: "usage endpoint" }, failed: false }
			: { failed: true };
	} catch {
		return { failed: true };
	}
}

/** Same rule as route(): one candidate whose account carries the observation. */
function classify(account: string, found: Found | undefined, now: number): AccountStatus {
	if (!found) return "unknown";
	const live = found.windows.filter((w) => !w.resetsAt || w.resetsAt > now);
	if (!live.length) return "unknown";
	const observation: Observation = {
		provider: account,
		account,
		state: live.some((w) => w.percent >= 100) ? "exhausted" : "available",
		observedAt: found.at,
		source: found.source,
	};
	const candidate = {
		harness: "any",
		provider: account,
		model: "any",
		account,
		billing: "subscription",
		capabilities: [],
	};
	const profile: Profile = {
		id: "usage",
		purpose: "usage",
		requiredCapabilities: [],
		allowedBilling: ["subscription"],
		candidates: [candidate],
	};
	const result = route({
		profile,
		resolved: [{ candidate, credentials: true, modelAvailable: true }],
		observations: [observation],
		now,
		maxAgeMs: MAX_AGE_MS,
	});
	if (result.status === "selected") return "available";
	const reason = result.reasons[0]?.reason;
	return reason === "exhausted" || reason === "stale" ? reason : "unknown";
}

export async function gatherAccountUsage(input: GatherInput): Promise<AccountReport[]> {
	const accounts = [...new Set(input.providers.map(accountOf))].sort();
	const reports: AccountReport[] = [];
	for (const account of accounts) {
		let found: Found | undefined;
		let note: string | undefined;
		const seen = input.headers[account];
		const fromHeaders: Found | undefined = seen && { windows: seen.windows, at: seen.at, source: "response headers" };
		if (account === "claude") {
			const file = readClaudeCodeObservation(input.claudeDir ?? CLAUDE_CODE_RATE_LIMITS, input.now);
			found = newest(
				file && { windows: file.windows, at: file.observedAt, source: "Claude Code rate limits" },
				fromHeaders,
			);
			if (!found) note = "no Claude Code rate-limit file and no response headers yet";
		} else if (account === "openai") {
			const read = await readOpenAi(input);
			found = newest(read.found, fromHeaders);
			if (!found) note = read.failed ? "usage endpoint unreachable or unreadable" : "no usage source yet";
		} else {
			found = newest(fromHeaders);
			if (!found) note = "no usage source for this provider";
		}
		const status = classify(account, found, input.now);
		if (status === "unknown" && found && !note) note = "every observed window has already reset";
		reports.push({
			account,
			status,
			windows: (found?.windows ?? []).map((w) => ({
				label: w.label,
				percent: w.percent,
				...(w.resetsAt ? { resetsAt: new Date(w.resetsAt).toISOString() } : {}),
			})),
			...(found ? { ageSeconds: Math.max(0, Math.round((input.now - found.at) / 1000)), source: found.source } : {}),
			...(note ? { note } : {}),
		});
	}
	return reports;
}

/** "2h15m", "40m", "5d2h". */
function left(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

function ago(seconds: number): string {
	if (seconds < 60) return `${seconds}s ago`;
	return seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${left(seconds * 1000)} ago`;
}

export function formatAccountUsage(reports: readonly AccountReport[], now: number): string {
	if (!reports.length) return "No logged-in accounts found, so there is no usage to report.";
	const lines: string[] = [];
	for (const r of reports) {
		const origin = r.source ? ` (${r.source}, ${ago(r.ageSeconds ?? 0)})` : "";
		lines.push(`${r.account}: ${r.status}${origin}${r.note ? ` - ${r.note}` : ""}`);
		for (const w of r.windows) {
			const reset = w.resetsAt ? `, resets in ${left(Date.parse(w.resetsAt) - now)}` : "";
			lines.push(`  ${w.label} ${w.percent}%${reset}`);
		}
	}
	lines.push(
		"",
		"exhausted: do not spawn on it. stale or unknown: not proof of exhaustion; may be used, watch the first result.",
	);
	return lines.join("\n");
}
