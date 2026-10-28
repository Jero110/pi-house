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
// The ChatGPT subscription fetch and poll policy are shared with the status bar so both surfaces classify one source
// consistently; this tool injects a configurable URL, timeout and fakeable fetch for its offline tests.
import {
	CLAUDE_CODE_RATE_LIMITS,
	pollChatGptUsage,
	readClaudeCodeObservation,
	USAGE_MAX_AGE_MS,
	type UsageWindow,
} from "./usage.ts";
import { type Observation, type PollState, type Profile, route } from "./workflow/routing.ts";

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
	/** Shared by every report of one process: concurrent calls share a request, and failures back off. */
	poll?: PollState;
}

/** An observation older than this no longer proves the account has room (Claude Code writes on its own refresh). */
export const MAX_AGE_MS = USAGE_MAX_AGE_MS;

/** What a provider id is called here: the account that owns its usage. */
function accountOf(provider: string): string {
	if (provider.includes("claude") || provider === "anthropic") return "claude";
	if (provider === "openai" || provider === "openai-codex" || provider === "azure") return "openai";
	return provider;
}

/** Why a poll failed, in the words the note shows. Each state keeps its own words: a refused login is not a timeout. */
const FAILURE_NOTE: Partial<Record<Observation["state"], string>> = {
	auth: "the usage endpoint refused this login",
	rate: "the usage endpoint is rate-limited",
	network: "usage endpoint unreachable or unreadable",
};

/**
 * One observation from usage windows, whatever the source: exhausted when a live window is full, unknown when no window
 * is still running (or none was seen), available otherwise.
 */
function fromWindows(
	account: string,
	windows: readonly UsageWindow[],
	observedAt: number,
	source: string,
	now: number,
): Observation {
	const live = windows.filter((w) => !w.resetsAt || w.resetsAt > now);
	const state = !live.length ? "unknown" : live.some((w) => w.percent >= 100) ? "exhausted" : "available";
	return { provider: account, account, state, observedAt, source, windows: [...windows] };
}

/** The usage endpoint through the shared poll state: concurrent callers wait for one request, and failures back off. */
async function readOpenAi(
	input: GatherInput,
	poll: PollState,
): Promise<{ observation?: Observation; retryAt?: number }> {
	const token = await input.openaiToken?.().catch(() => undefined);
	if (!token) return {};
	const polled = await pollChatGptUsage(poll, token, input.now, input.fetchFn, input.openaiUrl, input.timeoutMs);
	return polled.status === "observed" ? { observation: polled.observation } : { retryAt: polled.retryAt };
}

/** Same rule as route(): one candidate whose account carries the observation. */
function classify(observation: Observation, now: number): { status: AccountStatus; reason: string } {
	const candidate = {
		harness: "any",
		provider: observation.account,
		model: "any",
		account: observation.account,
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
	if (result.status === "selected") return { status: "available", reason: "available" };
	const reason = result.reasons[0]?.reason ?? "unknown";
	return { status: reason === "exhausted" || reason === "stale" ? reason : "unknown", reason };
}

/** The note for an observation that does not say "available" or "exhausted": code words, never provider text. */
function noteFor(chosen: Observation, status: AccountStatus): string | undefined {
	const hasWindows = !!chosen.windows?.length;
	const failure = FAILURE_NOTE[chosen.state];
	if (failure && !hasWindows) return failure;
	if (status !== "unknown") return undefined;
	return hasWindows ? "every observed window has already reset" : "the source answered without usage windows";
}

/** What one account's sources said: the observation routing reads (absent when no source saw anything) and a note. */
export interface AccountObservation {
	account: string;
	observation?: Observation;
	note?: string;
}

/**
 * The observation for every logged-in account, in the shape routing reads. Every source is polled or read here, and
 * nothing else in this file calls the network.
 */
export async function observeAccounts(input: GatherInput): Promise<AccountObservation[]> {
	const accounts = [...new Set(input.providers.map(accountOf))].sort();
	const poll: PollState = input.poll ?? new Map();
	const observed: AccountObservation[] = [];
	for (const account of accounts) {
		let note: string | undefined;
		const candidates: Observation[] = [];
		const seen = input.headers[account];
		if (seen) candidates.push(fromWindows(account, seen.windows, seen.at, "response headers", input.now));
		if (account === "claude") {
			const file = readClaudeCodeObservation(input.claudeDir ?? CLAUDE_CODE_RATE_LIMITS, input.now);
			if (file) {
				candidates.push(fromWindows("claude", file.windows, file.observedAt, "Claude Code rate limits", input.now));
			} else if (!candidates.length) {
				note = "no Claude Code rate-limit file and no response headers yet";
			}
		} else if (account === "openai") {
			const read = await readOpenAi(input, poll);
			if (read.observation) candidates.push(read.observation);
			else if (read.retryAt !== undefined) {
				note = `usage endpoint backed off after a failure; asked again after ${new Date(read.retryAt).toISOString()}`;
			}
		} else if (!candidates.length) {
			note = "no usage source for this provider";
		}
		// The newest observation that carries windows wins; a failure is shown only when nothing better was seen.
		candidates.sort((a, b) => Number(!!b.windows?.length) - Number(!!a.windows?.length) || b.observedAt - a.observedAt);
		observed.push({ account, observation: candidates[0], ...(note ? { note } : {}) });
	}
	return observed;
}

export async function gatherAccountUsage(input: GatherInput): Promise<AccountReport[]> {
	const reports: AccountReport[] = [];
	for (const { account, observation, note: sourceNote } of await observeAccounts(input)) {
		const { status } = observation ? classify(observation, input.now) : { status: "unknown" as const };
		const note = sourceNote ?? (observation ? noteFor(observation, status) : "no usage source yet");
		reports.push({
			account,
			status,
			windows: (observation?.windows ?? []).map((w) => ({
				label: w.label,
				percent: w.percent,
				...(w.resetsAt ? { resetsAt: new Date(w.resetsAt).toISOString() } : {}),
			})),
			...(observation
				? {
						ageSeconds: Math.max(0, Math.round((input.now - observation.observedAt) / 1000)),
						source: observation.source,
					}
				: {}),
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
			lines.push(`  ${w.label} ${w.percent}% (${100 - w.percent}% remaining)${reset}`);
		}
	}
	lines.push(
		"",
		"exhausted: do not spawn on it. stale or unknown: not proof of exhaustion; may be used, watch the first result.",
	);
	return lines.join("\n");
}
