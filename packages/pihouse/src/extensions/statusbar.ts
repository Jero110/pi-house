// pihouse's status bar, laid out like Claude Code's: the model and context on the left, `user@host  ~/folder  ⎇ branch  account` on the right,
// then `◷ claude  5h: 23% (2h15m → 16:00)` for each account.
//
// When the line does not fit, it shortens in a fixed order — folder, branch, host, effort, then the account
// login — and keeps the context and the model to the end: in a narrow pane, which model you are on and how much
// context is left matters more than where you are.
//
// Problem: a usage meter for one provider is wrong the moment the user is logged in to two.
// Example: a Claude login and a ChatGPT login are both active; each needs its own line, or a narrow terminal hides
// one provider's windows. Claude's own quota is shared with Claude Code.
// Solution: usage is kept per account (Claude, OpenAI), from its own endpoint or local fallback, and each provider
// gets one compact line with its 5h and 7d windows.
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { pollClaudeUsage, usableClaudeObservation } from "../claude-usage.ts";
import { chatgptEmail, claudeEmail, gitBranch } from "../identity.ts";
import {
	CLAUDE_CODE_RATE_LIMITS,
	fetchChatGptUsage,
	formatLeft,
	pollChatGptUsage,
	readClaudeCodeObservation,
	subscriptionWindowsFromHeaders,
	USAGE_MAX_AGE_MS,
	type UsageWindow,
} from "../usage.ts";
import type { PollState } from "../workflow/routing.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** The ChatGPT usage endpoint is polled at most this often. */
const REFRESH_MS = 60_000;
/** How often the Claude Code files and the usage of every login are looked at while the bar is up. */
const TICK_MS = 30_000;

type Palette = Pick<Theme, "fg" | "bold">;

/** The usage of one account: its windows, and a name for when there are several. */
export interface Account {
	name: string;
	/** Whether the model in use belongs to this account. */
	active: boolean;
	windows: readonly UsageWindow[];
	status?: "stale" | "unknown";
}

export interface StatusInput {
	width: number;
	cwd: string;
	user: string;
	host: string;
	/** The git branch of the folder, undefined outside a repo. */
	branch?: string;
	/** The login the model in use runs on: its email, or the provider's name when the email is unknown. */
	login?: string;
	/** The model as people read it: "Sonnet 5.5". */
	model?: string;
	/** The thinking effort: "off", "low", "medium", "high"... */
	effort?: string;
	/** Share of the context window in use, or null when unknown. */
	contextPercent: number | null;
	accounts: readonly Account[];
	now: number;
	/** Session totals, shown when no account has a window. */
	cost: number;
	input: number;
	output: number;
}

/** What a provider id is called on the bar. */
export function providerLabel(provider: string): string {
	if (provider.includes("claude") || provider === "anthropic") return "claude";
	if (provider === "openai" || provider === "openai-codex" || provider === "azure") return "openai";
	if (provider.startsWith("google")) return "gemini";
	if (provider === "github-copilot") return "copilot";
	return provider;
}

/** Effort is meaningful only when the selected model declares reasoning support. */
export function thinkingEffort(
	model: { reasoning?: boolean } | undefined,
	level: string | undefined,
): string | undefined {
	return model?.reasoning ? level : undefined;
}

/** "~/folder": the folder's own name, like Claude Code's status line. */
export function shortCwd(cwd: string): string {
	return `~/${basename(cwd)}`;
}

const compact = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}m`);

interface Segment {
	/** Position on the line, left to right. */
	order: number;
	/** What goes first when the line does not fit: higher goes first. */
	drop: number;
	/** The model's side of the line (left) or the place's (right: host, folder, branch, account). */
	side: "left" | "right";
	text: string;
}

/**
 * The status block: first the session, with the model, effort and context on the left and where you are (host,
 * folder, branch, account) on the right, then one line per account with its windows and resets. The accounts never share a line, so one can never push another out.
 */
export function statusLine(theme: Palette, s: StatusInput): string[] {
	const heat = (percent: number) => (percent >= 90 ? "error" : percent >= 70 ? "warning" : "text");
	const segments: Segment[] = [];
	const add = (side: Segment["side"], order: number, drop: number, text: string) =>
		segments.push({ order, drop, side, text });

	// The drop ladder, higher leaves first when the line does not fit: the folder and the branch go before
	// anything else (where you are is what a narrow pane can spare), then the machine and the effort, then the
	// account login (the usage lines below still name every account and accent the active one); the context
	// share and the model stay to the end, so the numbers you act on outlive the place.
	if (s.model) add("left", 0, 1, theme.fg("accent", s.model));
	if (s.effort) add("left", 1, 4, theme.fg("muted", `effort: ${s.effort}`));
	if (s.contextPercent === null) add("left", 2, 2, theme.fg("dim", "ctx: --"));
	else {
		const p = Math.round(s.contextPercent);
		add("left", 2, 2, theme.fg(p >= 90 ? "error" : p >= 70 ? "warning" : "muted", `ctx: ${p}%`));
	}
	add("right", 0, 5, theme.bold(theme.fg("text", `${s.user}@${s.host}`)));
	add("right", 1, 7, theme.bold(theme.fg("text", shortCwd(s.cwd))));
	if (s.branch) add("right", 2, 6, theme.fg("accent", `⎇ ${s.branch}`));
	if (s.login) add("right", 3, 3, theme.fg("muted", s.login));
	const side = (which: Segment["side"]) =>
		segments
			.filter((x) => x.side === which)
			.sort((a, b) => a.order - b.order)
			.map((x) => x.text)
			.join("  ");
	/** Left and right with the gap between them filled, so the right part ends at the edge. */
	const compose = () => {
		const [left, right] = [side("left"), side("right")];
		const gap = s.width - visibleWidth(left) - visibleWidth(right);
		return left && right ? `${left}${" ".repeat(Math.max(2, gap))}${right}` : left || right;
	};
	while (segments.length > 1 && visibleWidth(compose()) > s.width) {
		const last = segments.reduce((a, b) => (b.drop > a.drop ? b : a));
		segments.splice(segments.indexOf(last), 1);
	}
	const lines = [truncateToWidth(compose(), s.width)];

	const accounts = [...s.accounts];
	for (const name of ["claude", "openai"]) {
		if (!accounts.some((account) => account.name === name))
			accounts.push({ name, active: false, windows: [], status: "unknown" });
	}
	const tracked: Account[] = ["claude", "openai"].map(
		(name) =>
			accounts.find((account) => account.name === name) ?? { name, active: false, windows: [], status: "unknown" },
	);
	const renderWindow = (account: Account, label: string, compact: boolean) => {
		const window = account.windows.find((candidate) => candidate.label === label);
		if (!window || (window.resetsAt !== undefined && window.resetsAt <= s.now) || account.status === "unknown")
			return theme.fg("dim", `${label}: unknown`);
		const reset = !compact && window.resetsAt ? ` (${formatLeft(window.resetsAt, s.now)})` : "";
		const stale = account.status === "stale" ? " stale" : "";
		return theme.fg(heat(window.percent), `${label}: ${window.percent}/${100 - window.percent}%${reset}${stale}`);
	};
	const renderName = (account: Account) => theme.fg(account.active ? "accent" : "text", account.name);
	for (const account of tracked) {
		const renderUsage = (compact: boolean) =>
			`◷ ${renderName(account)} used/left ${renderWindow(account, "5h", compact)}, ${renderWindow(account, "7d", compact)}`;
		const detailedUsage = renderUsage(false);
		const usage = visibleWidth(detailedUsage) <= s.width ? detailedUsage : renderUsage(true);
		lines.push(truncateToWidth(usage, s.width));
	}
	const otherAccounts = accounts.filter((account) => account.name !== "claude" && account.name !== "openai");
	const nameWidth = Math.max(0, ...otherAccounts.map((account) => account.name.length));
	for (const a of otherAccounts.filter((account) => account.windows.length || account.status)) {
		const name = theme.fg(a.active ? "accent" : "text", `◷ ${a.name.padEnd(nameWidth)}`);
		const windows = a.windows.map((window) => {
			const reset = window.resetsAt ? `; ${formatLeft(window.resetsAt, s.now)}` : "";
			return theme.fg(
				heat(window.percent),
				`${window.label}: ${window.percent}% used (${100 - window.percent}% left${reset})`,
			);
		});
		const status = a.status ? `  ${theme.fg("warning", a.status)}` : "";
		lines.push(truncateToWidth(`${name}  ${windows.join("   ")}${status}`, s.width));
	}
	if (!s.accounts.some((account) => account.windows.length) && s.input + s.output > 0) {
		const cost = s.cost > 0 ? `  $${s.cost.toFixed(s.cost < 1 ? 3 : 2)}` : "";
		lines.push(truncateToWidth(theme.fg("dim", `↑${compact(s.input)} ↓${compact(s.output)}${cost}`), s.width));
	}
	return lines;
}

type Entry = {
	type?: string;
	message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } };
};

/** Dollars and tokens the session has spent so far. */
export function sessionTotals(entries: readonly unknown[]): { cost: number; input: number; output: number } {
	const t = { cost: 0, input: 0, output: 0 };
	for (const e of entries as Entry[]) {
		if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
		t.input += e.message.usage.input ?? 0;
		t.output += e.message.usage.output ?? 0;
		t.cost += e.message.usage.cost?.total ?? 0;
	}
	return t;
}

/** The ChatGPT login's windows, from its usage endpoint. Empty when it cannot be read. */
export async function fetchCodexWindows(
	token: string,
	now: number,
	fetchFn: typeof fetch = fetch,
): Promise<UsageWindow[]> {
	const observation = await fetchChatGptUsage(token, now, fetchFn, CODEX_USAGE_URL, 5000);
	return observation.windows ?? [];
}

/** A window that has already reset says nothing about the account now. */
const live = (windows: readonly UsageWindow[], now: number) => windows.filter((w) => !w.resetsAt || w.resetsAt > now);

/** A cached window is only usable while its source observation is fresh and at least one window is live. */
export function usageStatus(
	windows: readonly UsageWindow[],
	observedAt: number,
	now: number,
): "stale" | "unknown" | undefined {
	if (now - observedAt > USAGE_MAX_AGE_MS) return "stale";
	return live(windows, now).length ? undefined : "unknown";
}

export default function statusbar(pi: ExtensionAPI): void {
	/** Usage by account name, with the time it was learned, so a newer answer replaces an older one. */
	const known = new Map<string, { windows: readonly UsageWindow[]; at: number }>();
	const poll: PollState = new Map();
	let openaiStatus: "stale" | "unknown" | undefined;
	let redraw: (() => void) | undefined;
	let lastClaude = 0;
	let lastCodex = 0;
	let openaiEmail: string | undefined;

	const learn = (name: string, windows: readonly UsageWindow[], at = Date.now()) => {
		const before = known.get(name);
		if (windows.length && (!before || at >= before.at)) known.set(name, { windows, at });
	};

	const refresh = async (ctx: ExtensionContext) => {
		// Claude: local status-line fallback, then a fresh SDK usage control request when the bridge is installed.
		const claude = readClaudeCodeObservation(CLAUDE_CODE_RATE_LIMITS, Date.now());
		if (claude) learn("claude", claude.windows, claude.observedAt);
		// Ask Claude Code's own SDK for the current subscription windows without sending a model prompt.
		if (
			Date.now() - lastClaude >= REFRESH_MS &&
			ctx.modelRegistry.getAvailable().some((model) => model.provider === "claude-bridge")
		) {
			lastClaude = Date.now();
			const result = await pollClaudeUsage(Date.now());
			if (result.status === "observed" && usableClaudeObservation(result.observation, Date.now()))
				learn("claude", result.observation.windows ?? [], result.observation.observedAt);
		}
		// ChatGPT: asked for whenever it is logged in, not only while its model is the active one.
		if (Date.now() - lastCodex >= REFRESH_MS) {
			lastCodex = Date.now();
			try {
				const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (token) {
					openaiEmail = chatgptEmail(token);
					const result = await pollChatGptUsage(poll, token, Date.now(), fetch, CODEX_USAGE_URL, 5000);
					if (result.status === "observed") {
						const observation = result.observation;
						if (observation.windows?.length) {
							learn("openai", observation.windows, observation.observedAt);
							openaiStatus = undefined;
						} else openaiStatus = "unknown";
					} else openaiStatus = known.has("openai") ? "stale" : "unknown";
				}
			} catch {
				// The bar is never worth an error: without windows it shows tokens and cost.
			}
		}
		redraw?.();
	};

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider) {
			const name = providerLabel(provider);
			const windows = subscriptionWindowsFromHeaders(provider, event.headers, Date.now());
			learn(name, windows);
			if (name === "openai" && windows.length) openaiStatus = undefined;
		}
		redraw?.();
	});
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));
	pi.on("model_select", async (_event, ctx) => refresh(ctx));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		void refresh(ctx);
		const who = { user: userInfo().username, host: hostname().split(".")[0] ?? "" };
		ctx.ui.setFooter((tui, theme, footer) => {
			redraw = () => tui.requestRender();
			const timer = setInterval(() => void refresh(ctx), TICK_MS);
			timer.unref();
			return {
				dispose() {
					clearInterval(timer);
					redraw = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const now = Date.now();
					const provider = ctx.model && ctx.model.id !== "unknown" ? providerLabel(ctx.model.provider) : undefined;
					const accounts: Account[] = [...known]
						.map(([name, v]) => ({
							name,
							active: name === provider,
							windows: v.windows,
							status:
								usageStatus(v.windows, v.at, now) === "stale"
									? "stale"
									: name === "openai"
										? (openaiStatus ?? usageStatus(v.windows, v.at, now))
										: usageStatus(v.windows, v.at, now),
						}))
						.concat(
							!known.has("openai") && openaiStatus
								? [{ name: "openai", active: provider === "openai", windows: [], status: openaiStatus }]
								: [],
						)
						.filter((a) => a.windows.length || a.status)
						.sort((a, b) => a.name.localeCompare(b.name));
					const emails: Record<string, string | undefined> = { claude: claudeEmail(), openai: openaiEmail };
					const lines = statusLine(theme, {
						width,
						cwd: ctx.cwd,
						...who,
						branch: gitBranch(ctx.cwd),
						login: provider ? (emails[provider] ?? provider) : undefined,
						model: ctx.model && ctx.model.id !== "unknown" ? (ctx.model.name ?? ctx.model.id) : undefined,
						effort: thinkingEffort(ctx.model, ctx.thinkingLevel),
						contextPercent: ctx.getContextUsage()?.percent ?? null,
						accounts,
						now,
						...sessionTotals(ctx.sessionManager.getBranch()),
					});
					// The quiet extras other extensions put in the footer (agent-link's), last and only when there are any.
					const extras = [...footer.getExtensionStatuses().values()];
					return extras.length ? [...lines, truncateToWidth(theme.fg("dim", extras.join(" · ")), width)] : lines;
				},
			};
		});
	});
}
