// pihouse's status bar: one quiet line with the folder, the model, the context and the usage of the account in use.
//
// Problem: a usage meter for one provider is wrong the moment the user logs in with another.
// Example: on a Claude login the bar shows "5h 12% ↻4h16m"; after /model to a ChatGPT model it must show that
// account's window, and on a key without windows only the cost.
// Solution: usage is kept per provider, from the provider's own answers (see ../usage.ts), and the line reads the
// entry of the model that is active now.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chatgptAccountId, formatReset, type UsageWindow, windowsFromHeaders, windowsFromJson } from "../usage.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** The usage endpoint is polled at most this often. */
const REFRESH_MS = 60_000;
const BAR_CELLS = 8;

export interface StatusInput {
	width: number;
	cwd: string;
	home: string;
	branch: string | null;
	provider?: string;
	model?: string;
	/** Share of the context window in use, or null when unknown. */
	contextPercent: number | null;
	windows: readonly UsageWindow[];
	now: number;
	/** Session totals: dollars and tokens in and out. */
	cost: number;
	input: number;
	output: number;
	thinking?: string;
	/** Texts other extensions put in the footer (agent-link's, for one). */
	extras: readonly string[];
}

/** What a provider id is called on the bar. */
export function providerLabel(provider: string): string {
	if (provider.includes("claude") || provider === "anthropic") return "claude";
	if (provider === "openai" || provider === "openai-codex" || provider === "azure") return "openai";
	if (provider.startsWith("google")) return "gemini";
	if (provider === "github-copilot") return "copilot";
	return provider;
}

/** The model id without the vendor prefix and the date suffix: "claude-sonnet-5-5-20260301" -> "sonnet-5-5". */
export function modelLabel(id: string): string {
	return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function tildePath(cwd: string, home: string): string {
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

/** The last two folders of a long path, so the folder you are in is always visible. */
function shortPath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

const compact = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}m`);

interface Segment {
	/** Position on the line, left to right. */
	order: number;
	/** What goes first when the line does not fit: higher goes first. */
	drop: number;
	text: string;
}

/** The status line for one width. Segments that do not fit leave in order of least importance. */
export function statusLine(theme: Pick<Theme, "fg">, s: StatusInput): string {
	const heat = (percent: number) => (percent >= 90 ? "error" : percent >= 70 ? "warning" : "text");
	const segments: Segment[] = [];
	const add = (order: number, drop: number, text: string) => segments.push({ order, drop, text });

	const dir = tildePath(s.cwd, s.home);
	add(0, 0, theme.fg("text", dir));
	if (s.branch) add(1, 4, theme.fg("dim", s.branch));
	if (!s.provider && !s.model) {
		add(2, 1, `${theme.fg("muted", "no model")} ${theme.fg("dim", "/login")}`);
	} else {
		const who = s.provider ? theme.fg("accent", providerLabel(s.provider)) : "";
		const what = s.model ? theme.fg("muted", modelLabel(s.model)) : "";
		add(2, 1, [who, what].filter(Boolean).join(" "));
	}
	if (s.contextPercent !== null) {
		const p = Math.round(s.contextPercent);
		const filled = Math.min(BAR_CELLS, Math.round((p / 100) * BAR_CELLS));
		const bar = theme.fg(p >= 90 ? "error" : p >= 70 ? "warning" : "accent", "▰".repeat(filled));
		add(
			3,
			2,
			`${theme.fg("dim", "ctx")} ${bar}${theme.fg("dim", "▱".repeat(BAR_CELLS - filled))} ${theme.fg("muted", `${p}%`)}`,
		);
	}
	if (s.windows.length) {
		const parts = s.windows.map((w) => {
			const reset = w.resetsAt ? ` ${theme.fg("dim", `↻${formatReset(w.resetsAt, s.now)}`)}` : "";
			return `${theme.fg("dim", w.label)} ${theme.fg(heat(w.percent), `${w.percent}%`)}${reset}`;
		});
		add(4, 3, parts.join("  "));
	} else if (s.input + s.output > 0) {
		const cost = s.cost > 0 ? `  ${theme.fg("dim", `$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}`)}` : "";
		add(4, 5, `${theme.fg("dim", `↑${compact(s.input)} ↓${compact(s.output)}`)}${cost}`);
	}
	if (s.thinking && s.thinking !== "off") add(5, 6, theme.fg("dim", `think ${s.thinking}`));
	if (s.extras.length) add(6, 7, theme.fg("dim", s.extras.join(" ")));

	const sep = theme.fg("dim", " · ");
	const compose = () =>
		[...segments]
			.sort((a, b) => a.order - b.order)
			.map((x) => x.text)
			.join(sep);
	while (segments.length > 1 && visibleWidth(compose()) > s.width) {
		const last = segments.reduce((a, b) => (b.drop > a.drop ? b : a));
		segments.splice(segments.indexOf(last), 1);
	}
	const line = compose();
	if (visibleWidth(line) <= s.width) return line;
	return truncateToWidth(theme.fg("text", shortPath(dir)), s.width);
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

/** The ChatGPT login's windows, from its usage endpoint. Empty when it cannot be read: the bar then shows tokens. */
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

export default function statusbar(pi: ExtensionAPI): void {
	const windows = new Map<string, readonly UsageWindow[]>();
	let redraw: (() => void) | undefined;
	let lastFetch = 0;

	const refreshCodex = async (ctx: ExtensionContext) => {
		if (ctx.model?.provider !== "openai-codex" || Date.now() - lastFetch < REFRESH_MS) return;
		lastFetch = Date.now();
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			const found = token ? await fetchCodexWindows(token, Date.now()) : [];
			if (found.length) windows.set("openai-codex", found);
		} catch {
			// The bar is never worth an error: without windows it shows tokens and cost.
		}
		redraw?.();
	};

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		const found = provider ? windowsFromHeaders(event.headers, Date.now()) : [];
		if (provider && found.length) windows.set(provider, found);
		redraw?.();
	});
	pi.on("agent_end", async (_event, ctx) => {
		await refreshCodex(ctx);
		redraw?.();
	});
	pi.on("model_select", async (_event, ctx) => {
		await refreshCodex(ctx);
		redraw?.();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		void refreshCodex(ctx);
		ctx.ui.setFooter((tui, theme, footer) => {
			redraw = () => tui.requestRender();
			const stop = footer.onBranchChange(() => tui.requestRender());
			return {
				dispose() {
					stop();
					redraw = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const provider = ctx.model?.provider;
					const totals = sessionTotals(ctx.sessionManager.getBranch());
					return [
						` ${statusLine(theme, {
							width: width - 2,
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							branch: footer.getGitBranch(),
							provider: provider === "unknown" ? undefined : provider,
							model: ctx.model?.id === "unknown" ? undefined : ctx.model?.id,
							contextPercent: ctx.getContextUsage()?.percent ?? null,
							windows: (provider && windows.get(provider)) || [],
							now: Date.now(),
							...totals,
							thinking: ctx.thinkingLevel,
							extras: [...footer.getExtensionStatuses().values()],
						})}`,
					];
				},
			};
		});
	});
}
