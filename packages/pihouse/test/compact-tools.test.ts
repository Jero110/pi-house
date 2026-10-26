import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import brand, { sessionTitle } from "../src/extensions/brand.ts";
import compactTools, {
	callText,
	describeCall,
	describeResult,
	diffBlock,
	diffRow,
	diffStats,
	quietLine,
	resultLines,
	tilde,
} from "../src/extensions/compact-tools.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t };
const out = (text: string) => ({ content: [{ type: "text", text }] });

test("a call reads as Title(subject): the folder shortened, a range on a read, only the first line of a command", () => {
	assert.deepEqual(describeCall("read", { path: "/Users/me/a.ts", offset: 10, limit: 5 }), {
		title: "Read",
		subject: `${tilde("/Users/me/a.ts")}:10-14`,
	});
	assert.deepEqual(describeCall("bash", { command: "npm test\nnpm run check" }), {
		title: "Bash",
		subject: "npm test",
	});
	assert.deepEqual(describeCall("edit", { path: "src/x.ts" }), { title: "Update", subject: "src/x.ts" });
	assert.deepEqual(describeCall("grep", { pattern: "TODO", path: "src" }), { title: "Search", subject: "TODO in src" });
	assert.deepEqual(describeCall("spawn", { harness: "claude", task: "do it" }), { title: "spawn", subject: "claude" });
	assert.equal(describeCall("bash", { command: "x".repeat(300) }).subject.length, 100);
	assert.equal(tilde("/Users/me/p", "/Users/me"), "~/p");
	assert.equal(tilde("/tmp/p", "/Users/me"), "/tmp/p");
});

test("a finished call says what it did in one line", () => {
	const r = (tool: string, text: string, args = {}, extra = {}) =>
		describeResult(tool, args, { text, isError: false, ...extra });
	assert.equal(r("read", "a\nb\nc\n").summary, "Read 3 lines");
	assert.equal(r("read", "one").summary, "Read 1 line");
	assert.equal(r("grep", "a:1\nb:2").summary, "Found 2 matches");
	assert.equal(r("grep", "").summary, "No matches");
	assert.equal(r("find", "x\ny\nz").summary, "Found 3 files");
	assert.equal(r("ls", "a\nb").summary, "Listed 2 entries");
	const bash = r("bash", "12 passed\nline 2\nline 3");
	assert.deepEqual([bash.summary, bash.hidden], ["12 passed", 2]);
	assert.equal(r("bash", "  \n").summary, "Done");
	const failed = describeResult("bash", {}, { text: "boom\nat x\nat y", isError: true });
	assert.deepEqual([failed.summary, failed.hidden], ["boom", 2]);
});

test("an edit counts its diff and keeps a short preview; a write counts its lines and keeps the first ten", () => {
	const diff = ["-1 old", "+1 new", "+2 newer", " 3 same"].join("\n");
	assert.deepEqual(diffStats(diff), { added: 2, removed: 1 });
	const edit = describeResult("edit", {}, { text: "Edited", diff, isError: false });
	assert.equal(edit.summary, "Added 2 lines, removed 1 line");
	assert.deepEqual(edit.preview, diff.split("\n"));
	assert.equal(edit.hidden, 0);
	const longDiff = Array.from({ length: 30 }, (_, i) => `+${i} line`).join("\n");
	const long = describeResult("edit", {}, { text: "", diff: longDiff, isError: false });
	assert.deepEqual([long.preview.length, long.hidden], [14, 16]);

	const content = Array.from({ length: 160 }, (_, i) => `row ${i + 1}`).join("\n");
	const write = describeResult("write", { path: "a.md", content }, { text: "ok", isError: false });
	assert.equal(write.summary, "Wrote 160 lines");
	assert.equal(write.preview.length, 10);
	assert.match(write.preview[0] ?? "", /^ 1 row 1$/);
	assert.equal(write.hidden, 150);
});

test("collapsed, a call is its summary and a hint; the detail waits for ctrl+o", () => {
	const text = Array.from({ length: 40 }, (_, i) => `out ${i}`).join("\n");
	const collapsed = resultLines(theme, "bash", {}, out(text), { expanded: false, isError: false });
	assert.deepEqual(collapsed, ["  ⎿  out 0 … +39 lines (ctrl+o to expand)"]);
	const expanded = resultLines(theme, "bash", {}, out(text), { expanded: true, isError: false });
	assert.equal(expanded.length, 40);
	assert.equal(expanded[0], "  ⎿  out 0");
	assert.equal(expanded[39], "     out 39");
});

test("an edit shows a short colored diff collapsed and the whole diff expanded", () => {
	const diff = Array.from({ length: 20 }, (_, i) => (i % 2 ? `+${i} added` : `-${i} removed`)).join("\n");
	const result = { ...out("Edited"), details: { diff } };
	const collapsed = resultLines(tag, "edit", {}, result, { expanded: false, isError: false });
	assert.match(collapsed[0] ?? "", /Added 10 lines, removed 10 lines/);
	assert.match(collapsed[1] ?? "", /<toolDiffRemoved>-0 removed<\/toolDiffRemoved>/);
	assert.match(collapsed[2] ?? "", /<toolDiffAdded>\+1 added<\/toolDiffAdded>/);
	assert.match(collapsed.at(-1) ?? "", /… \+6 lines \(ctrl\+o to expand\)/);
	assert.equal(resultLines(tag, "edit", {}, result, { expanded: true, isError: false }).length, 20);
});

test("the dot says whether the call ran, failed or still runs", () => {
	const label = { title: "Bash", subject: "ls" };
	assert.equal(
		callText(tag, label, "done"),
		"<success>●</success> <text>Bash</text><muted>(</muted><text>ls</text><muted>)</muted>",
	);
	assert.match(callText(tag, label, "failed"), /^<error>●<\/error>/);
	assert.match(callText(tag, label, "running"), /^<dim>●<\/dim>/);
	assert.equal(callText(theme, { title: "Think", subject: "" }, "done"), "● Think");
});

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

test("pi's own tools are always drawn here, and a tool with a renderer of its own keeps it", () => {
	let resolver: Resolver | undefined;
	compactTools({ registerToolRenderer: (r: Resolver) => (resolver = r) } as unknown as ExtensionAPI);
	assert.ok(resolver);
	const custom = { renderCall: () => "custom" };
	assert.equal(
		resolver("ask_user_question", () => custom as never),
		custom,
	);
	const mine = resolver("bash", () => custom as never);
	assert.notEqual(mine, custom, "bash is drawn by pihouse even though pi has a renderer for it");
	assert.ok(mine?.renderCall && mine.renderResult);
	const generic = resolver("spawn", () => undefined);
	assert.ok(generic?.renderCall && generic.renderResult, "a tool with no renderer gets the compact one");
});

test("collapsed, a command is one gray line; with ctrl+o it is the call and its whole output", () => {
	let resolver: Resolver | undefined;
	compactTools({ registerToolRenderer: (r: Resolver) => (resolver = r) } as unknown as ExtensionAPI);
	const r = resolver?.("bash", () => undefined);
	const context = (expanded: boolean) =>
		({ args: { command: "npm test" }, isError: false, isPartial: false, executionStarted: true, expanded }) as never;
	const draw = (c: { render(w: number): string[] } | undefined) => (c?.render(80).join("\n") ?? "").trimEnd();

	const call = r?.renderCall?.({ command: "npm test" } as never, theme as never, context(false));
	assert.equal(draw(call), "Ran 1 shell command");
	const done = r?.renderResult?.(
		out("ok\nmore") as never,
		{ expanded: false, isPartial: false },
		theme as never,
		context(false),
	);
	assert.equal(draw(done), "", "nothing under the gray line");

	const openCall = r?.renderCall?.({ command: "npm test" } as never, theme as never, context(true));
	assert.match(draw(openCall), /● Bash\(npm test\)/);
	const open = r?.renderResult?.(
		out("ok\nmore") as never,
		{ expanded: true, isPartial: false },
		theme as never,
		context(true),
	);
	assert.match(draw(open), /⎿ {2}ok +\n {5}more/);

	const running = r?.renderResult?.(
		out("") as never,
		{ expanded: false, isPartial: true },
		theme as never,
		context(false),
	);
	assert.equal(draw(running), "", "while it runs the line above says so");
});

test("an edit keeps its call, its summary and its preview even when collapsed", () => {
	let resolver: Resolver | undefined;
	compactTools({ registerToolRenderer: (r: Resolver) => (resolver = r) } as unknown as ExtensionAPI);
	const r = resolver?.("edit", () => undefined);
	const context = {
		args: { path: "a.ts" },
		isError: false,
		isPartial: false,
		executionStarted: true,
		expanded: false,
	} as never;
	const call = r?.renderCall?.({ path: "a.ts" } as never, theme as never, context);
	assert.match(call?.render(80).join("\n") ?? "", /● Update\(a\.ts\)/);
});

test("a tab is named from the first prompt: a short sentence, a command giving way to what follows it", () => {
	assert.equal(sessionTitle("Add dark mode to the settings page"), "Add dark mode to the settings page");
	assert.equal(sessionTitle("Fix the login bug. It fails on Safari only."), "Fix the login bug.");
	assert.equal(
		sessionTitle("/skill:planner a small CLI that tracks my reading list"),
		"a small CLI that tracks my reading list",
	);
	assert.equal(sessionTitle("/workflow review"), undefined, "a command alone names nothing");
	assert.equal(sessionTitle("   \n  "), undefined);
	const long = sessionTitle("Please rewrite the whole onboarding flow so that new users see the checklist first");
	assert.ok(long && long.length <= 49 && long.endsWith("…"), String(long));
	assert.equal(sessionTitle("```ts\nconst a = 1\n```\nwhy does this fail"), "why does this fail");
});

test("the first prompt names the session and the tab, later prompts do not rename it", () => {
	const handlers = new Map<string, (event: never, ctx: never) => void>();
	let name: string | undefined;
	const titles: string[] = [];
	const pi = {
		on: (event: string, h: (event: never, ctx: never) => void) => handlers.set(event, h),
		getSessionName: () => name,
		setSessionName: (n: string) => {
			name = n;
		},
	} as unknown as ExtensionAPI;
	brand(pi);
	const ctx = { hasUI: true, cwd: "/Users/me/vs", ui: { setTitle: (t: string) => titles.push(t) } } as never;
	handlers.get("input")?.(
		{ type: "input", text: "Add dark mode to the settings page", source: "interactive" } as never,
		ctx,
	);
	assert.equal(name, "Add dark mode to the settings page");
	assert.equal(titles.at(-1), "Add dark mode to the settings page");
	handlers.get("input")?.({ type: "input", text: "Now the footer", source: "interactive" } as never, ctx);
	assert.equal(name, "Add dark mode to the settings page", "the first name stays");
	handlers.get("agent_end")?.({} as never, ctx);
	assert.equal(titles.at(-1), "Add dark mode to the settings page", "pi resetting the title does not undo it");
});

test("before any prompt the tab is the folder, not the product name", () => {
	const handlers = new Map<string, (event: never, ctx: never) => void>();
	const titles: string[] = [];
	brand({
		on: (event: string, h: (event: never, ctx: never) => void) => handlers.set(event, h),
		getSessionName: () => undefined,
		setSessionName: () => {},
	} as unknown as ExtensionAPI);
	handlers.get("agent_start")?.(
		{} as never,
		{ hasUI: true, cwd: "/Users/me/vs", ui: { setTitle: (t: string) => titles.push(t) } } as never,
	);
	assert.deepEqual(titles, ["vs"]);
});

test("a collapsed command, read, search or listing is one gray line; an edit or an unknown tool is not", () => {
	assert.equal(quietLine("bash", false), "Ran 1 shell command");
	assert.equal(quietLine("bash", true), "Running 1 shell command…");
	assert.equal(quietLine("read", false), "Read 1 file");
	assert.equal(quietLine("grep", false), "Searched for 1 pattern");
	assert.equal(quietLine("ls", false), "Listed 1 directory");
	assert.equal(quietLine("edit", false), undefined);
	assert.equal(quietLine("spawn", false), undefined, "agent-link and skills keep their own line");
});

test("an edit's diff has line numbers and a background on added and removed lines, to the edge", () => {
	const bgTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const ESC = String.fromCharCode(27);
	const plainOf = (row: string) =>
		row
			.split(ESC)
			.map((p) => p.replace(/^\[[\d;]*m/, ""))
			.join("");
	const added = diffRow(bgTheme, "+36 const a = 1;", 40);
	assert.ok(added.startsWith(`${ESC}[48;2;27;58;40m`));
	assert.ok(added.endsWith(`${ESC}[49m`));
	assert.equal(plainOf(added), `     36 + const a = 1;${" ".repeat(40 - 22)}`);
	assert.equal(visibleWidth(plainOf(added)), 40);
	assert.ok(diffRow(bgTheme, "-35 const a = 0;", 40).startsWith(`${ESC}[48;2;70;30;40m`));
	assert.equal(diffRow(bgTheme, " 34 context", 40), "     34  context");
	assert.equal(diffRow(bgTheme, " ...", 40).trim(), "...");

	const diff = ["-1 old", "+1 new", ...Array.from({ length: 30 }, (_, i) => ` ${i + 2} same`)].join("\n");
	const collapsed = diffBlock(bgTheme, diff, false).render(60);
	assert.match(collapsed[0] ?? "", /^ {2}⎿ {2}Added 1 line, removed 1 line$/);
	assert.equal(collapsed.length, 1 + 14 + 1);
	assert.match(collapsed.at(-1) ?? "", /… \+18 lines \(ctrl\+o to expand\)/);
	assert.equal(diffBlock(bgTheme, diff, true).render(60).length, 1 + 32);
});
