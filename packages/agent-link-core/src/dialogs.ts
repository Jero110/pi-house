// Startup dialogs a visible worker can stop on, recognized from the text of its pane (cmux read-screen).
// matchDialog is pure: give it the screen, it says which dialog is showing and which keys answer it.
//
// Problem: spawn used to send keys when a pattern appeared anywhere on the screen, and the patterns broke
// in narrow panes. Example: a claude worker stayed on "Loading development channels" because the option
// wrapped as "I am using / this for / local deve / lopment", even splitting words. Solution: compare
// phrases with every space and line break removed, read the options and the cursor from the screen, and
// send keys only for a dialog that is showing and whose option was found; anything else is "unknown"
// with its text and options.
//
// Problem: a dialog the hub does not know left the worker stuck, and the parent had no way to answer it.
// Example: a claude worker in a folder with a .mcp.json stops on "New MCP server found in this project".
// Solution: the unknown dialog goes to the parent with its own text and numbered options, and
// keysForChoice turns the parent's pick (a number or the option's text) into keys from the cursor.

import type { DialogSpec } from "./types.ts";

export type DialogMatch =
	| { kind: "known"; name: string; keys: string[] }
	| { kind: "unknown"; text: string; options: string[] }
	| { kind: "none" };

export interface DialogOption {
	label: string;
	selected: boolean;
}

const BOX = /[│┃║╭╮╰╯┌┐└┘├┤─━═]/g;
/** Selection markers: Claude's ❯ (› in older versions) and pi's → (pi-tui SelectList, trust selector). */
const CURSOR = /^[❯›→]\s*/;
/** pi marks the saved choice with a check before the label. */
const SAVED = /^✓\s*/;
const NUMBERED = /^\d+\.\s+/;
/** A line of box drawing only: the rule Claude and pi draw above a dialog. */
const RULE = /^\s*[─━═]{3,}\s*$/;
/** Footers right below a dialog's options: Claude's "Enter to confirm · Esc to cancel", pi's "↑↓ navigate ...". */
const FOOTERS = ["Entertoconfirm", "↑↓navigate"];
const isFooter = (compacted: string) => FOOTERS.some((f) => compacted.startsWith(f));

/** Text without box borders, spaces or line breaks, for comparing phrases a pane may have wrapped anywhere. */
const compact = (text: string) => text.replace(BOX, "").replace(/\s+/g, "");

/** The screen as one line: box borders dropped and every run of whitespace (wraps included) as one space. */
export function normalizeScreen(screen: string): string {
	return screen.replace(BOX, " ").replace(/\s+/g, " ").trim();
}

/** Where the dialog at the bottom of the screen sits: its first line, its options block and its footer. */
function dialogLayout(lines: readonly string[]): { top: number; start: number; end: number } | undefined {
	let footer = -1;
	for (let i = lines.length - 1; i >= 0 && footer < 0; i--) {
		if (isFooter(compact(lines.slice(i, i + 3).join("")))) footer = i;
	}
	if (footer < 0) return undefined;
	const blank = (i: number) => !(lines[i] ?? "").replace(BOX, "").trim();
	let end = footer - 1;
	while (end >= 0 && blank(end)) end--;
	let start = end;
	while (start > 0 && !blank(start - 1)) start--;
	let top = start;
	while (top > 0 && !RULE.test(lines[top - 1] ?? "")) top--;
	return { top, start, end: footer };
}

/**
 * The options of the dialog at the bottom of the screen: the block of lines right above its footer.
 * Options may wrap in a narrow pane. A numbered option's continuation is any line without a number.
 * pi wraps an option to the left of where the options start (" → Trust" / "   Trust parent" /
 * " folder"), so when some line in the menu starts there, that indent alone says what continues.
 * Otherwise (Claude) a line continues the option above when it starts in lowercase ("Yes, I trust
 * this / folder"), or when the line above was full: its first word would not have fit after it within
 * the pane ("Use this and / all future / MCP servers / in this / project" in 17 columns). The pane's
 * width is the rule above the dialog (Claude's options reach its last column, as "    Use this MCP"
 * in a 16-column pane does); without a rule it is the dialog's widest line.
 */
export function dialogOptions(screen: string): DialogOption[] {
	const lines = screen.split("\n").map((l) => l.replace(BOX, " ").trimEnd());
	const layout = dialogLayout(screen.split("\n"));
	if (!layout) return [];
	const rule = layout.top > 0 ? (screen.split("\n")[layout.top - 1] ?? "").trim().length : 0;
	const width = rule || Math.max(...lines.slice(layout.top, layout.end).map((l) => l.length));
	const block = lines.slice(layout.start, layout.end).filter((l) => l.trim());
	const numbered = block.some((l) => NUMBERED.test(l.trim().replace(CURSOR, "")));
	// In a numbered menu, lines above the first option are the question ("Do you want to proceed?").
	const first = numbered ? block.findIndex((l) => NUMBERED.test(l.trim().replace(CURSOR, ""))) : 0;
	const indent = (l: string) => l.length - l.trimStart().length;
	// Where option text starts: right after the cursor on the selected line.
	const cursorLine = block.find((l) => CURSOR.test(l.trim()));
	const optionCol = cursorLine ? indent(cursorLine) + (cursorLine.trim().match(CURSOR)?.[0].length ?? 0) : 0;
	const hanging = block.slice(first).some((l) => !CURSOR.test(l.trim()) && indent(l) < optionCol);
	const options: DialogOption[] = [];
	let above = "";
	for (const raw of block.slice(first)) {
		const line = raw.trim();
		const selected = CURSOR.test(line);
		const text = line.replace(CURSOR, "").replace(SAVED, "");
		const last = options.at(-1);
		const firstWord = text.split(/\s/)[0] ?? "";
		const full = above.length + 1 + firstWord.length > width;
		const continues = numbered
			? !NUMBERED.test(text)
			: hanging
				? indent(raw) < optionCol
				: !/^\p{Lu}/u.test(text) || full;
		if (continues && last && !selected) last.label += ` ${text}`;
		else options.push({ label: text, selected });
		above = raw;
	}
	for (const o of options) o.label = o.label.replace(NUMBERED, "").replace(/\s+/g, " ").trim();
	return options.some((o) => o.selected) ? options : [];
}

/**
 * The dialog's own text, one line: from the rule above it (or the top of the screen) to its footer.
 * Leaves out what the pane showed before the dialog, such as the shell command that started the worker.
 */
export function dialogText(screen: string): string {
	const lines = screen.split("\n");
	const layout = dialogLayout(lines);
	return normalizeScreen(layout ? lines.slice(layout.top).join("\n") : screen);
}

/** Which dialog the screen shows, and the keys that pick its option from where the cursor is. */
export function matchDialog(screen: string, dialogs: readonly DialogSpec[]): DialogMatch {
	const text = dialogText(screen);
	const options = dialogOptions(screen);
	const unknown = (): DialogMatch => ({ kind: "unknown", text, options: options.map((o) => o.label) });
	const screenText = compact(screen);
	const spec = dialogs.find((d) => d.match.every((phrase) => screenText.includes(compact(phrase))));
	if (!spec) return options.length || FOOTERS.some((f) => screenText.includes(f)) ? unknown() : { kind: "none" };
	const { choose } = spec;
	// Literal keys, for a dialog whose options the hub does not read (Codex: "esc skip").
	if (typeof choose === "object") return { kind: "known", name: spec.name, keys: [...choose.keys] };
	const target =
		typeof choose === "number"
			? choose < options.length
				? choose
				: -1
			: options.findIndex((o) => compact(o.label) === compact(choose));
	const keys = keysTo(options, target);
	return keys ? { kind: "known", name: spec.name, keys } : unknown();
}

/** Arrow keys from the cursor to option `target` (0-based), then enter; undefined without a cursor or target. */
function keysTo(options: readonly DialogOption[], target: number): string[] | undefined {
	const cursor = options.findIndex((o) => o.selected);
	if (target < 0 || target >= options.length || cursor < 0) return undefined;
	const move = target > cursor ? "down" : "up";
	return [...Array(Math.abs(target - cursor)).fill(move), "enter"];
}

/**
 * The keys that pick `choice` in the dialog on screen: an option number as the parent was shown it
 * (1 is the first), or the option's text (spaces and case ignored). Says why when it cannot.
 */
export function keysForChoice(
	screen: string,
	choice: number | string,
): { keys: string[]; option: string; index: number } | { error: string } {
	const options = dialogOptions(screen);
	if (!options.length) return { error: "no options with a cursor were found on screen" };
	const asNumber = typeof choice === "number" ? choice : /^\s*\d+\s*$/.test(choice) ? Number(choice) : undefined;
	const wanted = (label: string) => compact(label).toLowerCase() === compact(String(choice)).toLowerCase();
	const index = asNumber !== undefined ? asNumber - 1 : options.findIndex((o) => wanted(o.label));
	const keys = keysTo(options, index);
	const option = options[index]?.label;
	if (!keys || option === undefined) return { error: `there is no option ${JSON.stringify(choice)}` };
	return { keys, option, index };
}
