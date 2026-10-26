// pihouse draws tool calls the way Claude Code does: one line for the call and one for what it did, with the
// detail behind ctrl+o.
//
// Problem: pi prints every tool's whole output into the transcript. Example: a `write` of a 400 line report fills
// the screen with 400 green lines, and a `bash` call prints everything it wrote to stdout.
// Solution: collapsed, a command, read, search or listing is one gray line, `Ran 1 shell command`, like Claude Code's;
// an edit or write keeps `● Update(file)` and a short colored preview, and any other tool (a skill, agent-link) keeps
// `● spawn(claude)` and its first line. Expanded (ctrl+o), every call is `● Bash(npm test)` with its whole output. The describing is pure
// (describeCall, describeResult) so it is tested without pi.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The tools pi ships, drawn by pihouse whatever their own renderer is. */
const BUILT_IN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const TITLES: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	edit: "Update",
	write: "Write",
	grep: "Search",
	find: "Find",
	ls: "List",
};
/** Lines of an edit's diff or a write's content kept under a collapsed call. */
const DIFF_PREVIEW = 14;
const WRITE_PREVIEW = 10;
const SUBJECT_MAX = 100;
const SUMMARY_MAX = 110;

type Args = Record<string, unknown>;

export interface CallLabel {
	title: string;
	subject: string;
}

export interface ResultSummary {
	summary: string;
	/** Lines shown under the summary while collapsed. */
	preview: string[];
	/** How many lines the collapsed view leaves out. */
	hidden: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "~/folder/file" for a path inside the home folder. */
export function tilde(path: string, home = process.env.HOME ?? ""): string {
	return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** What goes in `● Title(subject)`. */
export function describeCall(tool: string, args: Args): CallLabel {
	const title = TITLES[tool] ?? tool;
	const first = (...keys: string[]) => keys.map((k) => str(args[k])).find((v) => v) ?? "";
	let subject: string;
	switch (tool) {
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const range =
				offset !== undefined || limit !== undefined
					? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}`
					: "";
			subject = `${tilde(str(args.path))}${range}`;
			break;
		}
		case "bash":
			subject = (str(args.command).split("\n")[0] ?? "").trim();
			break;
		case "edit":
		case "write":
		case "ls":
			subject = tilde(first("path"));
			break;
		case "grep":
			subject = `${str(args.pattern)}${str(args.path) ? ` in ${tilde(str(args.path))}` : ""}`;
			break;
		case "find":
			subject = first("pattern", "name", "path");
			break;
		default: {
			// A tool pihouse knows nothing about: its first text argument says the most.
			const value = Object.values(args).find((v) => typeof v === "string" && v.trim());
			subject = typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
		}
	}
	return { title, subject: clip(subject, SUBJECT_MAX) };
}

/** Added and removed lines of a diff in pi's format: "+36 text", "-35 text", " 34 text". */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

const linesOf = (text: string) => (text.trim() ? text.replace(/\n+$/, "").split("\n") : []);

/** What a finished call says in one line, and the few lines kept under it. */
export function describeResult(
	tool: string,
	args: Args,
	result: { text: string; diff?: string; isError: boolean },
): ResultSummary {
	const lines = linesOf(result.text);
	if (result.isError)
		return { summary: clip(lines[0] ?? "Failed", SUMMARY_MAX), preview: [], hidden: Math.max(0, lines.length - 1) };
	switch (tool) {
		case "read":
			return { summary: `Read ${plural(lines.length, "line")}`, preview: [], hidden: 0 };
		case "edit": {
			const diff = linesOf(result.diff ?? "");
			if (!diff.length) return { summary: lines[0] ? clip(lines[0], SUMMARY_MAX) : "Updated", preview: [], hidden: 0 };
			const { added, removed } = diffStats(result.diff ?? "");
			return {
				summary: `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`,
				preview: diff.slice(0, DIFF_PREVIEW),
				hidden: Math.max(0, diff.length - DIFF_PREVIEW),
			};
		}
		case "write": {
			const content = linesOf(str(args.content));
			const width = String(Math.min(content.length, WRITE_PREVIEW)).length;
			return {
				summary: `Wrote ${plural(content.length, "line")}`,
				preview: content.slice(0, WRITE_PREVIEW).map((l, i) => `${String(i + 1).padStart(width)} ${l}`),
				hidden: Math.max(0, content.length - WRITE_PREVIEW),
			};
		}
		case "grep":
			return {
				summary: lines.length ? `Found ${plural(lines.length, "match", "matches")}` : "No matches",
				preview: [],
				hidden: 0,
			};
		case "find":
			return {
				summary: lines.length ? `Found ${plural(lines.length, "file")}` : "No files found",
				preview: [],
				hidden: 0,
			};
		case "ls":
			return { summary: `Listed ${plural(lines.length, "entry", "entries")}`, preview: [], hidden: 0 };
		default:
			return {
				summary: lines.length ? clip(lines[0] ?? "", SUMMARY_MAX) : "Done",
				preview: [],
				hidden: Math.max(0, lines.length - 1),
			};
	}
}

type ResultLike = { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown };

function textOf(result: ResultLike): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function diffOf(result: ResultLike): string | undefined {
	const d = result.details;
	return typeof d === "object" && d !== null && typeof (d as { diff?: unknown }).diff === "string"
		? (d as { diff: string }).diff
		: undefined;
}

type Palette = Pick<Theme, "fg" | "bold">;

/** A diff line in the color of what it did. */
function colorDiff(theme: Palette, line: string): string {
	if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
	return theme.fg("toolDiffContext", line);
}

/** The tools whose collapsed view is one gray line, with that line while they run and after. */
const QUIET: Record<string, readonly [string, string]> = {
	bash: ["Running 1 shell command…", "Ran 1 shell command"],
	read: ["Reading 1 file…", "Read 1 file"],
	grep: ["Searching for 1 pattern…", "Searched for 1 pattern"],
	find: ["Searching for 1 pattern…", "Searched for 1 pattern"],
	ls: ["Listing 1 directory…", "Listed 1 directory"],
};

/** The one line a collapsed, successful quiet call leaves, or undefined for a tool that draws more. */
export function quietLine(tool: string, running: boolean): string | undefined {
	return QUIET[tool]?.[running ? 0 : 1];
}

/** Backgrounds of added and removed lines, drawn verbatim like the spinner's glyphs: pi's theme has no diff backgrounds. */
const ADDED_BG = "\x1b[48;2;27;58;40m";
const REMOVED_BG = "\x1b[48;2;70;30;40m";
const BG_OFF = "\x1b[49m";

/**
 * One line of pi's diff (`+36 text`, `-35 text`, ` 34 text`) as Claude Code draws it: the line number, the sign and the
 * text, with added and removed lines on a colored background that runs to the edge.
 */
export function diffRow(theme: Palette, line: string, width: number): string {
	const m = /^([+\- ])(\s*\d*) (.*)$/.exec(line);
	if (!m) return truncateToWidth(theme.fg("dim", `     ${line.trim()}`), width);
	const [, sign = " ", num = "", text = ""] = m;
	const gutter = `     ${theme.fg("dim", num)} `;
	if (sign === " ") return truncateToWidth(`${gutter} ${theme.fg("muted", text)}`, width);
	const body = truncateToWidth(
		`${gutter}${theme.fg(sign === "+" ? "toolDiffAdded" : "toolDiffRemoved", sign)} ${theme.fg("text", text)}`,
		width,
	);
	const bg = sign === "+" ? ADDED_BG : REMOVED_BG;
	return `${bg}${body}${" ".repeat(Math.max(0, width - visibleWidth(body)))}${BG_OFF}`;
}

/** An edit's result: what changed in one line, then its diff, a few lines when collapsed and all of it on ctrl+o. */
export function diffBlock(theme: Palette, diff: string, expanded: boolean): Component {
	const lines = linesOf(diff);
	const { added, removed } = diffStats(diff);
	const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW);
	const hidden = lines.length - shown.length;
	const head = `${theme.fg("dim", "  ⎿  ")}${theme.fg("muted", `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`)}`;
	return {
		invalidate() {},
		render(width: number): string[] {
			const out = [truncateToWidth(head, width), ...shown.map((l) => diffRow(theme, l, width))];
			if (hidden > 0)
				out.push(truncateToWidth(theme.fg("dim", `     … +${plural(hidden, "line")} (ctrl+o to expand)`), width));
			return out;
		},
	};
}

/** `● Title(subject)`: the dot says whether it ran, failed or still runs. */
export function callText(theme: Palette, label: CallLabel, state: "running" | "done" | "failed"): string {
	const dot =
		state === "failed" ? theme.fg("error", "●") : state === "running" ? theme.fg("dim", "●") : theme.fg("success", "●");
	const subject = label.subject
		? `${theme.fg("muted", "(")}${theme.fg("text", label.subject)}${theme.fg("muted", ")")}`
		: "";
	return `${dot} ${theme.bold(theme.fg("text", label.title))}${subject}`;
}

/** The lines under a call: collapsed, its summary and a short preview; expanded, everything. */
export function resultLines(
	theme: Palette,
	tool: string,
	args: Args,
	result: ResultLike,
	opts: { expanded: boolean; isError: boolean },
): string[] {
	const text = textOf(result);
	const diff = diffOf(result);
	const corner = theme.fg("dim", "  ⎿  ");
	const pad = "     ";
	if (opts.expanded) {
		const full =
			tool === "edit" && diff
				? linesOf(diff).map((l) => colorDiff(theme, l))
				: linesOf(text).map((l) => theme.fg(opts.isError ? "error" : "toolOutput", l));
		return full.length ? [corner + full[0], ...full.slice(1).map((l) => pad + l)] : [corner + theme.fg("dim", "Done")];
	}
	const s = describeResult(tool, args, { text, diff, isError: opts.isError });
	const head = corner + theme.fg(opts.isError ? "error" : "muted", s.summary);
	const out = [head];
	for (const l of s.preview) out.push(pad + (tool === "edit" ? colorDiff(theme, l) : theme.fg("dim", l)));
	if (s.hidden > 0) {
		const more = theme.fg("dim", `… +${plural(s.hidden, "line")} (ctrl+o to expand)`);
		if (s.preview.length) out.push(pad + more);
		else out[0] = `${head} ${more}`;
	}
	return out;
}

export default function compactTools(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		// A tool with a renderer of its own (a picker, a form) keeps it; pi's built-in tools are always drawn here.
		const own = BUILT_IN.has(toolName) ? undefined : next();
		if (own?.renderCall || own?.renderResult) return own;
		return {
			renderCall(args, theme, context) {
				const state = context.isError ? "failed" : context.isPartial || !context.executionStarted ? "running" : "done";
				const quiet = !context.expanded && state !== "failed" ? quietLine(toolName, state === "running") : undefined;
				if (quiet) return new Text(theme.fg("muted", quiet), 0, 0);
				return new Text(callText(theme, describeCall(toolName, (args ?? {}) as Args), state), 0, 0);
			},
			renderResult(result, options, theme, context) {
				if (!options.expanded && !context.isError && quietLine(toolName, false)) return new Text("", 0, 0);
				const diff = toolName === "edit" && !context.isError && !options.isPartial ? diffOf(result) : undefined;
				if (diff) return diffBlock(theme, diff, options.expanded);
				if (options.isPartial) return new Text(`${theme.fg("dim", "  ⎿  ")}${theme.fg("dim", "Running…")}`, 0, 0);
				const lines = resultLines(theme, toolName, (context.args ?? {}) as Args, result, {
					expanded: options.expanded,
					isError: context.isError,
				});
				return new Text(lines.join("\n"), 0, 0);
			},
		};
	});
}
