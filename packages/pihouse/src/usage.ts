// Subscription usage windows ("5h 12%", "7d 3%") for the status bar, read from what each provider already tells us.
//
// Problem: every provider reports its limits differently, and the status bar must show the account in use.
// Example: a Claude login answers each request with `anthropic-ratelimit-unified-5h-utilization: 0.12`, while a
// ChatGPT login has no such header and exposes `used_percent` windows on its usage endpoint.
// Solution: one small window type, one parser per source. Nothing here does I/O; the status bar feeds it.

export interface UsageWindow {
	/** "5h", "7d", "1m": how long the window is. */
	label: string;
	/** Used share of the window, 0 to 100. */
	percent: number;
	/** When the window resets, in epoch milliseconds. */
	resetsAt?: number;
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** "5h" for 300 minutes, "7d" for 10080, "1m" for 1. */
export function windowLabel(minutes: number): string {
	if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
	if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
	return `${Math.max(1, Math.round(minutes))}m`;
}

/** Window length in minutes from a label, to order windows from the shortest. */
function labelMinutes(label: string): number {
	const n = Number.parseInt(label, 10);
	if (label.endsWith("d")) return n * 1440;
	if (label.endsWith("h")) return n * 60;
	return n;
}

/** An epoch in seconds or milliseconds, or an ISO date, as epoch milliseconds. */
function epochMs(v: unknown): number | undefined {
	const n = num(v);
	if (n !== undefined) return n > 1e12 ? n : n * 1000;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isNaN(t) ? undefined : t;
	}
	return undefined;
}

/** OpenAI's "1s", "6m0s", "20ms" as seconds. */
export function parseDuration(text: string): number | undefined {
	const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
	if (!parts.length || parts.map((p) => p[0]).join("") !== text.trim()) return undefined;
	const unit = { ms: 0.001, s: 1, m: 60, h: 3600 } as const;
	return parts.reduce((sum, p) => sum + Number(p[1]) * unit[p[2] as keyof typeof unit], 0);
}

const bySize = (a: UsageWindow, b: UsageWindow) => labelMinutes(a.label) - labelMinutes(b.label);

/**
 * The windows a provider reports in its response headers.
 * - Claude subscription: `anthropic-ratelimit-unified-<5h|7d>-utilization` (0 to 1) and `-reset` (epoch seconds).
 * - ChatGPT (Codex) headers, when present: `x-codex-primary|secondary-used-percent` with `-window-minutes` and
 *   `-reset-at` or `-reset-after-seconds`.
 * - OpenAI API keys: `x-ratelimit-limit-tokens` and `-remaining-tokens`, a one-minute window, only when nothing
 *   better exists.
 */
export function windowsFromHeaders(raw: Record<string, string>, now: number): UsageWindow[] {
	const h: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
	const out: UsageWindow[] = [];

	for (const key of Object.keys(h)) {
		const m = /^anthropic-ratelimit-unified-(\d+[hd])-utilization$/.exec(key);
		const used = m ? num(h[key]) : undefined;
		if (!m?.[1] || used === undefined) continue;
		const resetsAt = epochMs(h[`anthropic-ratelimit-unified-${m[1]}-reset`]);
		out.push({ label: m[1], percent: clampPercent(used * 100), ...(resetsAt ? { resetsAt } : {}) });
	}

	for (const slot of ["primary", "secondary"]) {
		const used = num(h[`x-codex-${slot}-used-percent`]);
		if (used === undefined) continue;
		const minutes = num(h[`x-codex-${slot}-window-minutes`]);
		const after = num(h[`x-codex-${slot}-reset-after-seconds`]);
		const resetsAt = epochMs(h[`x-codex-${slot}-reset-at`]) ?? (after === undefined ? undefined : now + after * 1000);
		out.push({
			label: minutes ? windowLabel(minutes) : slot === "primary" ? "5h" : "7d",
			percent: clampPercent(used),
			...(resetsAt ? { resetsAt } : {}),
		});
	}

	if (!out.length) {
		const limit = num(h["x-ratelimit-limit-tokens"]);
		const left = num(h["x-ratelimit-remaining-tokens"]);
		if (limit && left !== undefined) {
			const after = parseDuration(h["x-ratelimit-reset-tokens"] ?? "");
			out.push({
				label: "1m",
				percent: clampPercent(100 - (left / limit) * 100),
				...(after === undefined ? {} : { resetsAt: now + after * 1000 }),
			});
		}
	}
	return out.sort(bySize);
}

/**
 * The windows in a usage endpoint's JSON: every object with a numeric `used_percent`, wherever it sits.
 * Its length comes from `window_minutes` or `limit_window_seconds`, its reset from `reset_at` (epoch) or
 * `reset_after_seconds`. Reading the shape loosely keeps the bar alive when the provider renames the wrappers.
 */
export function windowsFromJson(body: unknown, now: number): UsageWindow[] {
	const out: UsageWindow[] = [];
	const walk = (node: unknown, depth: number) => {
		if (depth > 6 || typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n, depth + 1);
			return;
		}
		const o = node as Record<string, unknown>;
		const used = num(o.used_percent);
		if (used !== undefined) {
			const minutes = num(o.window_minutes) ?? ((num(o.limit_window_seconds) ?? 0) / 60 || undefined);
			const after = num(o.reset_after_seconds) ?? num(o.resets_in_seconds);
			const resetsAt = epochMs(o.reset_at ?? o.resets_at) ?? (after === undefined ? undefined : now + after * 1000);
			out.push({
				label: minutes ? windowLabel(minutes) : "5h",
				percent: clampPercent(used),
				...(resetsAt ? { resetsAt } : {}),
			});
			return;
		}
		for (const v of Object.values(o)) walk(v, depth + 1);
	};
	walk(body, 0);
	return out.sort(bySize);
}

/** "4h16m", "2d3h", "12m": the time left until a reset. */
export function formatReset(resetsAt: number, now: number): string {
	const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}

/** The account id a ChatGPT token carries, which the usage endpoint wants as a header. */
export function chatgptAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		const auth = payload["https://api.openai.com/auth"];
		const id =
			typeof auth === "object" && auth !== null ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}
