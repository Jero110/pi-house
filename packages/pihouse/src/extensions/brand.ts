// pihouse's identity on top of pi: a quiet text header and the terminal title. Nothing else of pi changes.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { PIHOUSE_VERSION } from "../paths.ts";

/** The header: the name and the few commands worth knowing. No logo and no slogan. */
export function headerLines(theme: Theme, width: number, linked: boolean): string[] {
	const lines = [
		"",
		` ${theme.bold("pi-house")} ${theme.fg("dim", `v${PIHOUSE_VERSION} · on pi v${PI_VERSION}`)}`,
		"",
		` ${theme.fg("accent", "/skill:planner")} ${theme.fg("dim", "plan a project, then hand it to an executor")}`,
		` ${theme.fg("accent", "/workflow review")} ${theme.fg("dim", "what the last run did")}  ${theme.fg("accent", "/workflow ask")} ${theme.fg("dim", "<question>")}`,
		` ${theme.fg(
			"dim",
			linked ? "agent-link on: pi-house can launch claude, codex, opencode and pihouse agents" : "agent-link off",
		)}`,
		"",
	];
	return lines.map((l) => truncateToWidth(l, width));
}

export default function brand(pi: ExtensionAPI): void {
	// pi sets its own title ("π - <folder>") after startup and on some events; pi-house sets it back.
	const title = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setTitle(`pi-house · ${ctx.cwd.split("/").pop() ?? ""}`);
	};
	pi.on("agent_start", (_event, ctx) => title(ctx));
	pi.on("agent_end", (_event, ctx) => title(ctx));
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		title(ctx);
		setTimeout(() => title(ctx), 500);
		if (ctx.mode !== "tui") return;
		const linked = Boolean(process.env.AGENT_LINK_AGENT);
		ctx.ui.setHeader((_tui, theme) => ({
			render: (width: number) => headerLines(theme, width, linked),
			invalidate() {},
		}));
	});
}
