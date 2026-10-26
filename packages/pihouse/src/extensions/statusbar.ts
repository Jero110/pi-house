// pihouse's status bar, laid out like Claude Code's: the model and context on the left, `user@host  ~/folder  ⎇ branch  account` on the right,
// then `◷ claude  5h: 23% (2h15m → 16:00)` for each account.
//
// Problem: a usage meter for one provider is wrong the moment the user is logged in to two.
// Example: a Claude login and a ChatGPT login are both active; the bar must show both windows side by side, and the
// Claude one must match what Claude Code shows, since the two share one limit.
// Solution: usage is kept per account (Claude, OpenAI), each from its own source (see ../usage.ts), and every account
// that has a live window is drawn, with its name once there is more than one.
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chatgptEmail, claudeEmail, gitBranch } from "../identity.ts";
import {
	CLAUDE_CODE_RATE_LIMITS,
	chatgptAccountId,
	formatLeft,
	readClaudeCodeUsage,
	type UsageWindow,
	windowsFromHeaders,
	windowsFromJson,
} from "../usage.ts";

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

	if (s.model) add("left", 0, 2, theme.fg("accent", s.model));
	if (s.effort) add("left", 1, 4, theme.fg("muted", `effort: ${s.effort}`));
	if (s.contextPercent === null) add("left", 2, 3, theme.fg("dim", "ctx: --"));
	else {
		const p = Math.round(s.contextPercent);
		add("left", 2, 3, theme.fg(p >= 90 ? "error" : p >= 70 ? "warning" : "muted", `ctx: ${p}%`));
	}
	add("right", 0, 5, theme.bold(theme.fg("text", `${s.user}@${s.host}`)));
	add("right", 1, 0, theme.bold(theme.fg("text", shortCwd(s.cwd))));
	if (s.branch) add("right", 2, 1, theme.fg("accent", `⎇ ${s.branch}`));
	if (s.login) add("right", 3, 6, theme.fg("muted", s.login));
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

	const live = s.accounts.filter((a) => a.windows.length);
	const nameWidth = Math.max(0, ...live.map((a) => a.name.length));
	for (const a of live) {
		// The account in use is lilac and the others white, so the one the model runs on stands out at a glance.
		const name = theme.fg(a.active ? "accent" : "text", `◷ ${a.name.padEnd(nameWidth)}`);
		const windows = a.windows.map((w) => {
			const reset = w.resetsAt ? theme.fg("muted", ` (${formatLeft(w.resetsAt, s.now)})`) : "";
			return `${theme.fg(heat(w.percent), `${w.label}: ${w.percent}%`)}${reset}`;
		});
		lines.push(truncateToWidth(`${name}  ${windows.join("   ")}`, s.width));
	}
	if (!live.length && s.input + s.output > 0) {
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
	const account = chatgptAccountId(token);
	const res = await fetchFn(CODEX_USAGE_URL, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json",
			...(account ? { "chatgpt-account-id": account } : {}),
		},
		signal: AbortSignal.timeout(5000),
	});
	return res.ok ? windowsFromJson(await res.json(), now) : [];
}

/** A window that has already reset says nothing about the account now. */
const live = (windows: readonly UsageWindow[], now: number) => windows.filter((w) => !w.resetsAt || w.resetsAt > now);

export default function statusbar(pi: ExtensionAPI): void {
	/** Usage by account name, with the time it was learned, so a newer answer replaces an older one. */
	const known = new Map<string, { windows: readonly UsageWindow[]; at: number }>();
	let redraw: (() => void) | undefined;
	let lastCodex = 0;
	let openaiEmail: string | undefined;

	const learn = (name: string, windows: readonly UsageWindow[], at = Date.now()) => {
		const before = known.get(name);
		if (windows.length && (!before || at >= before.at)) known.set(name, { windows, at });
	};

	const refresh = async (ctx: ExtensionContext) => {
		// Claude: the limit Claude Code last saw, which this login shares.
		learn("claude", readClaudeCodeUsage(CLAUDE_CODE_RATE_LIMITS, Date.now()));
		// ChatGPT: asked for whenever it is logged in, not only while its model is the active one.
		if (Date.now() - lastCodex >= REFRESH_MS) {
			lastCodex = Date.now();
			try {
				const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (token) {
					openaiEmail = chatgptEmail(token);
					learn("openai", await fetchCodexWindows(token, Date.now()));
				}
			} catch {
				// The bar is never worth an error: without windows it shows tokens and cost.
			}
		}
		redraw?.();
	};

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider) learn(providerLabel(provider), windowsFromHeaders(event.headers, Date.now()));
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
						.map(([name, v]) => ({ name, active: name === provider, windows: live(v.windows, now) }))
						.filter((a) => a.windows.length)
						.sort((a, b) => a.name.localeCompare(b.name));
					const emails: Record<string, string | undefined> = { claude: claudeEmail(), openai: openaiEmail };
					const lines = statusLine(theme, {
						width,
						cwd: ctx.cwd,
						...who,
						branch: gitBranch(ctx.cwd),
						login: provider ? (emails[provider] ?? provider) : undefined,
						model: ctx.model && ctx.model.id !== "unknown" ? (ctx.model.name ?? ctx.model.id) : undefined,
						effort: ctx.thinkingLevel,
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
