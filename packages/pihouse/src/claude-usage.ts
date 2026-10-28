// Claude subscription quota without a model request or access to Claude Code's OAuth secrets.
// Problem: status-line files only change when Claude Code is active; rereading them cannot refresh an expired 5h window.
// Example: a quiet account still has a 5h/7d balance on Claude's usage endpoint, but its last status-line file is old.
// Solution: ask Claude Code's own SDK for the structured /usage result through a control request on an idle query.
// The SDK authenticates itself; its input iterator never yields a prompt, and we close it even when the request fails.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pihousePaths } from "./paths.ts";
import { USAGE_MAX_AGE_MS, type UsageWindow } from "./usage.ts";
import { type Observation, type PollResult, type PollState, pollAccount } from "./workflow/routing.ts";

const TIMEOUT_MS = 8_000;
const REFRESH_MS = 60_000;

/** An experimental SDK method: keep the unstable response behind a checked boundary. */
type UsageReader = () => Promise<unknown>;
export type UsageQuery = {
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: { skipBehaviors: true }): Promise<unknown>;
	close(): void;
};
export type Sdk = {
	query(options: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): UsageQuery;
};

export async function readClaudeSdkUsage(injected?: Sdk): Promise<unknown> {
	const sdkPath = join(pihousePaths().agentDir, "npm", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
	// The bridge is optional, so its SDK is loaded only when installed. Do not read Claude Code's OAuth store.
	const sdk = injected ?? ((await import(pathToFileURL(sdkPath).href)) as Sdk);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let release = () => {};
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	async function* noPrompt(): AsyncGenerator<never> {
		await waiting;
		yield* [];
	}
	let query: UsageQuery | undefined;
	try {
		query = sdk.query({
			prompt: noPrompt(),
			options: {
				abortController: controller,
				settingSources: [],
				tools: [],
				env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
			},
		});
		return await Promise.race([
			query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
			new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(new Error("Claude usage request timed out")), {
					once: true,
				});
			}),
		]);
	} finally {
		clearTimeout(timer);
		query?.close();
		release();
	}
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Missing, malformed, or expired windows never become zero-percent availability. */
export function claudeWindowsFromUsage(value: unknown, now: number): UsageWindow[] {
	const response = record(value);
	if (response?.rate_limits_available !== true || typeof response.subscription_type !== "string") return [];
	const limits = record(response.rate_limits);
	const windows: UsageWindow[] = [];
	for (const [field, label] of [
		["five_hour", "5h"],
		["seven_day", "7d"],
	] as const) {
		const window = record(limits?.[field]);
		const percent = window?.utilization;
		const reset = window?.resets_at;
		if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
		if (typeof reset !== "string") continue;
		const resetsAt = Date.parse(reset);
		if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
		windows.push({ label, percent: Math.round(percent), resetsAt });
	}
	return windows;
}

export async function fetchClaudeUsage(now: number, read: UsageReader = readClaudeSdkUsage): Promise<Observation> {
	const base = {
		provider: "claude",
		account: "claude",
		observedAt: now,
		source: "Claude Code usage endpoint",
	} as const;
	try {
		const windows = claudeWindowsFromUsage(await read(), now);
		return {
			...base,
			state: !windows.length ? "unknown" : windows.some((window) => window.percent >= 100) ? "exhausted" : "available",
			windows,
		};
	} catch {
		return { ...base, state: "network" };
	}
}

/** One process-wide poll is shared by the status bar, account_usage and startup selection. */
export const claudePoll: PollState = new Map();
let last: Observation | undefined;
export async function pollClaudeUsage(
	now: number,
	read: UsageReader = readClaudeSdkUsage,
	state: PollState = claudePoll,
): Promise<PollResult> {
	if (state === claudePoll && last && now >= last.observedAt && now - last.observedAt < REFRESH_MS) {
		return { status: "observed", observation: last };
	}
	const result = await pollAccount(state, "claude", "claude", now, () => fetchClaudeUsage(now, read));
	if (state === claudePoll && result.status === "observed" && usableClaudeObservation(result.observation, now))
		last = result.observation;
	return result;
}

/** A fresh endpoint reading takes precedence over an older local file, never the other way around. */
export function usableClaudeObservation(observation: Observation | undefined, now: number): boolean {
	return (
		!!observation &&
		observation.windows?.some((window) => window.resetsAt === undefined || window.resetsAt > now) === true &&
		now >= observation.observedAt &&
		now - observation.observedAt <= USAGE_MAX_AGE_MS
	);
}
