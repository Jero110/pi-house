// pihouse's identity on top of pi: the lighthouse header and the terminal title. Nothing else of pi changes.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LOGO_WIDTH, logoLines } from "../logo.ts";
import { PIHOUSE_VERSION } from "../paths.ts";

export const TAGLINE = "Bring light to your agents.";

/** The header: the logo, with name, tagline and the few commands worth knowing beside it. */
export function headerLines(theme: Theme, width: number, linked: boolean): string[] {
	const logo = logoLines();
	const side = [
		`${theme.bold("pihouse")} ${theme.fg("dim", `v${PIHOUSE_VERSION} · on pi v${PI_VERSION}`)}`,
		theme.fg("muted", TAGLINE),
		"",
		`${theme.fg("accent", "/skill:planner")} ${theme.fg("dim", "plan a project, then hand it to an executor")}`,
		`${theme.fg("accent", "/workflow review")} ${theme.fg("dim", "what the last run did")}  ${theme.fg("accent", "/workflow ask")} ${theme.fg("dim", "<question>")}`,
		theme.fg(
			"dim",
			linked ? "agent-link on: pihouse can launch claude, codex, opencode and pihouse agents" : "agent-link off",
		),
	];
	const gap = "  ";
	const fits = width >= LOGO_WIDTH + gap.length + 30;
	const lines: string[] = [""];
	const rows = Math.max(logo.length, fits ? side.length : 0);
	for (let i = 0; i < rows; i++) {
		const l = logo[i] ?? " ".repeat(LOGO_WIDTH);
		const s = fits ? (side[i] ?? "") : "";
		const line = ` ${l}${s ? gap + s : ""}`;
		lines.push(visibleWidth(line) > width ? ` ${l}` : line);
	}
	if (!fits) lines.push(` ${theme.bold("pihouse")} ${theme.fg("muted", TAGLINE)}`);
	lines.push("");
	return lines;
}

export default function brand(pi: ExtensionAPI): void {
	// pi sets its own title ("π - <folder>") after startup and on some events; pihouse sets it back.
	const title = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setTitle(`pihouse · ${ctx.cwd.split("/").pop() ?? ""}`);
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
