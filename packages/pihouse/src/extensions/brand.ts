// pihouse's identity on top of pi: a quiet text header, laid out like Claude Code's, and the terminal title. Nothing else of pi changes.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { PIHOUSE_VERSION } from "../paths.ts";
import { providerLabel } from "./statusbar.ts";

export interface HeaderInfo {
	linked: boolean;
	cwd: string;
	home: string;
	/** The model as people read it, or undefined before a login. */
	model?: string;
	provider?: string;
}

/** "~/Desktop/other/vs": the folder with the home folder shortened. */
function tilde(cwd: string, home: string): string {
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * The header, laid out like Claude Code's: the name and version, the model and its provider, the folder. Then the
 * few commands worth knowing. No logo and no slogan.
 */
export function headerLines(theme: Theme, width: number, info: HeaderInfo): string[] {
	const who = info.model
		? `${info.model}${info.provider ? ` · ${providerLabel(info.provider)}` : ""}`
		: `no model · ${theme.fg("accent", "/login")}`;
	const lines = [
		"",
		` ${theme.bold("pi-house")} ${theme.fg("dim", `v${PIHOUSE_VERSION} · on pi v${PI_VERSION}`)}`,
		` ${theme.fg("muted", who)}`,
		` ${theme.fg("muted", tilde(info.cwd, info.home))}`,
		"",
		` ${theme.fg("accent", "/skill:planner")} ${theme.fg("dim", "plan a project, then hand it to an executor")}`,
		` ${theme.fg("accent", "/workflow review")} ${theme.fg("dim", "what the last run did")}  ${theme.fg("accent", "/workflow ask")} ${theme.fg("dim", "<question>")}`,
		` ${theme.fg(
			"dim",
			info.linked ? "agent-link on: pi-house can launch claude, codex, opencode and pihouse agents" : "agent-link off",
		)}`,
		"",
	];
	return lines.map((l) => truncateToWidth(l, width));
}

/**
 * A tab name from the first thing the user asks, like Claude Code's: "Add dark mode to the settings page" and not
 * "pi-house · vs". A slash command gives way to what follows it, and a command with nothing after it names nothing.
 */
export function sessionTitle(prompt: string): string | undefined {
	let text = prompt.replace(/```[\s\S]*?```/g, " ").trim();
	if (/^\/[\w:.-]+/.test(text)) {
		// A command names the tab only through what follows it, and only when that reads as a request.
		text = text.replace(/^\/[\w:.-]+\s*/, "");
		if (text.trim().split(/\s+/).length < 3) return undefined;
	}
	const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
	if (sentence.length <= 48) return sentence;
	const cut = sentence.slice(0, 48);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).trimEnd()}…`;
}

export default function brand(pi: ExtensionAPI): void {
	// pi sets its own title ("π - <folder>") after startup and on some events; pi-house sets it back. The tab is named
	// after the session, so several of them can be told apart; before the first prompt it is the folder.
	const title = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setTitle(pi.getSessionName() ?? (ctx.cwd.split("/").pop() || "pi-house"));
	};
	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || pi.getSessionName()) return;
		const name = sessionTitle(event.text);
		if (!name) return;
		pi.setSessionName(name);
		title(ctx);
	});
	pi.on("agent_start", (_event, ctx) => title(ctx));
	pi.on("agent_end", (_event, ctx) => title(ctx));
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		title(ctx);
		setTimeout(() => title(ctx), 500);
		if (ctx.mode !== "tui") return;
		const linked = Boolean(process.env.AGENT_LINK_AGENT);
		ctx.ui.setHeader((_tui, theme) => ({
			render: (width: number) =>
				headerLines(theme, width, {
					linked,
					cwd: ctx.cwd,
					home: process.env.HOME ?? "",
					model: ctx.model && ctx.model.id !== "unknown" ? (ctx.model.name ?? ctx.model.id) : undefined,
					provider: ctx.model && ctx.model.id !== "unknown" ? ctx.model.provider : undefined,
				}),
			invalidate() {},
		}));
	});
}
