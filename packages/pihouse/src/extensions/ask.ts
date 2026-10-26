// ask_user_question: questions the user answers in a picker instead of typing in the chat.
//
// Problem: skills that interview the user (planner, grilling) asked in plain chat text, so the user had to
// retype option names and the agent had to parse free prose. Solution: one tool, the same shape as Claude
// Code's AskUserQuestion: 1-4 questions, each with 2-4 options (label + description), single or multiple
// choice, and always a "Type something" option. Several questions show as tabs with a Submit tab.
// Adapted from pi's examples/extensions/questionnaire.ts (MIT), with multiple choice added.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Catalog, readCatalog, skillPath } from "../workflow/catalog.ts";

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	header?: string;
	options: AskOption[];
	multiSelect?: boolean;
}

type PickerQuestion = AskQuestion & { header: string; multiSelect: boolean };

export interface AskAnswer {
	header: string;
	/** Chosen labels; a typed answer is one entry. */
	picked: string[];
	typed?: string;
}

export interface AskResult {
	answers: AskAnswer[];
	cancelled: boolean;
}

const Params = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The full question, ending with a question mark" }),
			header: Type.Optional(Type.String({ description: "A short tab label, at most 12 characters, e.g. 'Skills'" })),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "1-5 words. Put the recommended option first, ending in (Recommended)" }),
					description: Type.Optional(Type.String({ description: "What choosing it means, one line" })),
				}),
				{
					description:
						"2-4 options (up to 16 when multiSelect is true, e.g. a full list of skills); the user can always type their own answer",
				},
			),
			multiSelect: Type.Optional(Type.Boolean({ description: "true when the user may pick several options" })),
		}),
		{ description: "1-4 questions" },
	),
});

/** The answers as the model reads them. */
export function answersText(result: AskResult): string {
	if (result.cancelled) return "The user closed the questions without answering. Ask in a different way or go on.";
	return result.answers
		.map(
			(a) =>
				`${a.header}: ${a.typed !== undefined ? `user wrote: ${a.typed}` : a.picked.length ? a.picked.join(", ") : "(nothing selected)"}`,
		)
		.join("\n");
}

// pick_skills: the planner's skill picker, built from the catalog so no skill can be left out.
//
// Problem: the planner wrote the skills picker itself and dropped the ones it found irrelevant. Example: of 12
// development skills it showed 7 (no security, performance, observability, git or CI) and slipped in an extra.
// Solution: the model only names its recommendations (with why) and any skill the user asked for by name; the
// options are every development skill of the catalog, recommended first, then the rest in catalog order.

export interface SkillPick {
	/** Development skills the model recommends, with one line on what each changes in this work. */
	recommended: Array<{ name: string; why: string }>;
	/** Optional one line per other development skill: when it would fit this work. */
	notes?: Record<string, string>;
	/** Skills from other groups the user asked for by name (an extra such as impeccable). */
	include?: string[];
}

/** The picker question with every development skill, or an error naming the unknown skills and the valid ones. */
export function skillPickerQuestion(
	catalog: Catalog,
	pick: SkillPick,
): { question: AskQuestion; names: string[] } | { error: string } {
	const dev = catalog.skills.filter((s) => s.group === "build" && s.name !== "executor" && !s.external);
	const byName = new Map(catalog.skills.map((s) => [s.name, s]));
	const devNames = new Set(dev.map((s) => s.name));
	const unknownRec = pick.recommended.map((r) => r.name).filter((n) => !devNames.has(n));
	const extras = (pick.include ?? []).filter((n) => !devNames.has(n));
	const unknownInc = extras.filter((n) => {
		const s = byName.get(n);
		return !s || s.group === "pre-build" || s.name === "executor";
	});
	if (unknownRec.length || unknownInc.length)
		return {
			error: [
				unknownRec.length ? `not development skills: ${unknownRec.join(", ")}` : "",
				unknownInc.length ? `cannot include: ${unknownInc.join(", ")}` : "",
				`development skills: ${dev.map((s) => s.name).join(", ")}`,
				`other skills that can be included: ${catalog.skills
					.filter((s) => s.group === "post-build" || s.group === "extras")
					.map((s) => s.name)
					.join(", ")}`,
			]
				.filter(Boolean)
				.join("\n"),
		};
	const why = new Map(pick.recommended.map((r) => [r.name, r.why]));
	const ordered = [
		...pick.recommended.map((r) => byName.get(r.name)).filter((s) => s !== undefined),
		...dev.filter((s) => !why.has(s.name)),
	];
	const options: AskOption[] = ordered.map((s) => ({
		label: `${pickerName(s)}${why.has(s.name) ? " (Recommended)" : ""}`,
		description: why.get(s.name) ?? pick.notes?.[s.name] ?? s.summary,
	}));
	const names = ordered.map((s) => s.name);
	for (const n of extras) {
		const s = byName.get(n);
		if (!s || names.includes(n)) continue;
		options.push({ label: `${pickerName(s)} (you asked for it)`, description: s.summary });
		names.push(n);
	}
	return {
		question: {
			header: "Skills",
			question: "Which skills should the plan use? Pick any, several or none.",
			options,
			multiSelect: true,
		},
		names,
	};
}

/** A skill's name in the picker: its author in brackets, except Addy's, which are most of the list. */
function pickerName(s: { name: string; author: string }): string {
	return s.author === "Addy" ? s.name : `${s.name} (${s.author})`;
}

/** The picked skills as the model reads them: names and the SKILL.md paths for the plan's Skills table. */
export function pickedSkillsText(result: AskResult, names: string[], catalog: Catalog, dir?: string): string {
	if (result.cancelled) return "The user closed the skills picker without answering. Ask again or plan with no skills.";
	const a = result.answers[0];
	if (a?.typed !== undefined) return `The user wrote instead of picking: ${a.typed}`;
	const picked = names.filter((n) => a?.picked.some((l) => l === n || l.startsWith(`${n} (`)));
	if (!picked.length) return "The user picked no skills: the plan uses none.";
	const lines = picked.map((n) => {
		const s = catalog.skills.find((x) => x.name === n);
		return s ? `- ${n} (${s.author}): ${skillPath(s, dir)}` : `- ${n}`;
	});
	return `The user picked these skills; only these go into the plan:\n${lines.join("\n")}`;
}

/** Shows the picker for `questions` and resolves with the user's answers (Esc: cancelled). */
export function showPicker(ctx: ExtensionContext, questions: PickerQuestion[]): Promise<AskResult> {
	return ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
		const multi = questions.length > 1;
		let tab = 0;
		let cursor = 0;
		let typing = false;
		let cached: string[] | undefined;
		const answers = new Map<number, AskAnswer>();
		const checked = questions.map(() => new Set<number>());
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const finish = (cancelled: boolean) =>
			done({ answers: questions.map((q, i) => answers.get(i) ?? { header: q.header, picked: [] }), cancelled });
		const allAnswered = () => questions.every((_, i) => answers.has(i));
		// Rows of the current question: its options, then "Type something", then "Done" for multiple choice.
		const rows = () => {
			const q = questions[tab];
			if (!q) return [];
			return [
				...q.options.map((o, i) => ({
					kind: "option" as const,
					index: i,
					label: o.label,
					description: o.description,
				})),
				{ kind: "other" as const, index: -1, label: "Type something.", description: undefined },
				...(q.multiSelect ? [{ kind: "done" as const, index: -2, label: "Done", description: undefined }] : []),
			];
		};
		const next = () => {
			if (!multi) return finish(false);
			tab = tab < questions.length - 1 ? tab + 1 : questions.length;
			cursor = 0;
			refresh();
		};

		editor.onSubmit = (value) => {
			const q = questions[tab];
			if (!q) return;
			const typed = value.trim() || "(no answer)";
			answers.set(tab, { header: q.header, picked: [typed], typed });
			typing = false;
			editor.setText("");
			next();
		};

		const handleInput = (data: string) => {
			if (typing) {
				if (matchesKey(data, Key.escape)) {
					typing = false;
					editor.setText("");
				} else editor.handleInput(data);
				refresh();
				return;
			}
			if (multi && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
				tab = (tab + 1) % (questions.length + 1);
				cursor = 0;
				return refresh();
			}
			if (multi && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
				tab = (tab - 1 + questions.length + 1) % (questions.length + 1);
				cursor = 0;
				return refresh();
			}
			if (tab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
				else if (matchesKey(data, Key.escape)) finish(true);
				return;
			}
			const list = rows();
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				return refresh();
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(list.length - 1, cursor + 1);
				return refresh();
			}
			if (matchesKey(data, Key.escape)) return finish(true);
			const q = questions[tab];
			const row = list[cursor];
			if (!q || !row) return;
			const toggle =
				data === " " || matchesKey(data, Key.space) || (matchesKey(data, Key.enter) && row.kind === "option");
			if (q.multiSelect && row.kind === "option" && toggle) {
				const set = checked[tab];
				if (set?.has(row.index)) set.delete(row.index);
				else set?.add(row.index);
				return refresh();
			}
			if (!matchesKey(data, Key.enter)) return;
			if (row.kind === "other") {
				typing = true;
				editor.setText("");
				return refresh();
			}
			if (row.kind === "done") {
				const picked = [...(checked[tab] ?? [])].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "");
				answers.set(tab, { header: q.header, picked });
				return next();
			}
			answers.set(tab, { header: q.header, picked: [row.label] });
			next();
		};

		const render = (width: number): string[] => {
			if (cached) return cached;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const wrap = (prefix: string, t: string, out: string[] = lines) => {
				const pw = visibleWidth(prefix);
				const parts = wrapTextWithAnsi(t, Math.max(1, w - pw));
				parts.forEach((p, i) => {
					out.push(`${i === 0 ? prefix : " ".repeat(pw)}${p}`);
				});
			};
			lines.push(theme.fg("accent", "─".repeat(w)));
			if (multi) {
				const tabs = questions.map((q, i) => {
					const text = ` ${answers.has(i) ? "■" : "□"} ${q.header} `;
					return i === tab
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(answers.has(i) ? "success" : "muted", text);
				});
				const submit = " ✓ Submit ";
				tabs.push(
					tab === questions.length
						? theme.bg("selectedBg", theme.fg("text", submit))
						: theme.fg(allAnswered() ? "success" : "dim", submit),
				);
				wrap(" ", tabs.join(" "));
				lines.push("");
			}
			const q = questions[tab];
			if (tab === questions.length) {
				wrap(" ", theme.fg("accent", theme.bold("Ready to submit")));
				for (const [i, a] of [...answers.entries()].sort(([x], [y]) => x - y))
					wrap(" ", `${theme.fg("muted", `${questions[i]?.header}: `)}${a.picked.join(", ") || "(nothing)"}`);
				lines.push("");
				wrap(
					" ",
					allAnswered()
						? theme.fg("success", "Enter to submit")
						: theme.fg("warning", "Some questions have no answer yet"),
				);
			} else if (q) {
				wrap(" ", theme.fg("text", theme.bold(q.question)));
				if (q.multiSelect) wrap(" ", theme.fg("dim", "Choose any: Space or Enter to tick, then Done"));
				lines.push("");
				const blocks = rows().map((row, i) => {
					const out: string[] = [];
					const here = i === cursor;
					const box = row.kind === "option" && q.multiSelect ? (checked[tab]?.has(row.index) ? "[x] " : "[ ] ") : "";
					const num = row.kind === "option" ? `${row.index + 1}. ` : "";
					wrap(
						here ? theme.fg("accent", "> ") : "  ",
						theme.fg(here ? "accent" : "text", `${box}${num}${row.label}`),
						out,
					);
					if (row.description) wrap("     ", theme.fg("muted", row.description), out);
					return out;
				});
				// Problem: with many options the list was taller than the terminal, so the rows below the screen (and
				// Done) could not be reached. Solution: show only the window of rows that fits, always holding the cursor.
				const room = Math.max(4, (tui.terminal.rows || 24) - lines.length - (typing ? 12 : 6));
				const height = (a: number, b: number) => blocks.slice(a, b).reduce((n, x) => n + x.length, 0);
				let start = Math.min(cursor, blocks.length - 1);
				let end = start + 1;
				while (end < blocks.length && height(start, end + 1) <= room) end++;
				while (start > 0 && height(start - 1, end) <= room) start--;
				if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
				for (const b of blocks.slice(start, end)) lines.push(...b);
				if (end < blocks.length) lines.push(theme.fg("dim", `  ↓ ${blocks.length - end} more`));
				if (typing) {
					lines.push("");
					for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
					wrap(" ", theme.fg("dim", "Enter to send · Esc to go back"));
				}
			}
			lines.push("");
			if (!typing)
				wrap(" ", theme.fg("dim", `${multi ? "Tab/←→ questions · " : ""}↑↓ move · Enter choose · Esc cancel`));
			lines.push(theme.fg("accent", "─".repeat(w)));
			cached = lines;
			return lines;
		};

		return { render, invalidate: () => (cached = undefined), handleInput };
	});
}

export default function ask(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Question",
		description:
			"Ask the user 1-4 questions they answer in a picker (single or multiple choice, or their own text). Use it whenever you need a decision from the user: put your recommended option first and mark it (Recommended). Never ask such questions in plain chat text.",
		parameters: Params,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI)
				return {
					content: [
						{
							type: "text",
							text: "No interactive user here (a worker or a non-interactive run): decide yourself and say what you assumed.",
						},
					],
					details: { answers: [], cancelled: true } satisfies AskResult,
				};
			const questions = params.questions.slice(0, 4).map((q, i) => ({
				...q,
				header: q.header || `Q${i + 1}`,
				multiSelect: q.multiSelect === true,
			}));
			if (!questions.length)
				return { content: [{ type: "text", text: "No questions given." }], details: { answers: [], cancelled: true } };

			const result = await showPicker(ctx, questions);

			return { content: [{ type: "text", text: answersText(result) }], details: result };
		},

		renderCall(args, theme) {
			const qs = (args.questions as AskQuestion[] | undefined) ?? [];
			return new Text(
				`${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", qs.map((q) => q.header || q.question).join(" · "))}`,
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as AskResult | undefined;
			if (!d || d.cancelled) return new Text(theme.fg("warning", "No answer"), 0, 0);
			return new Text(
				d.answers
					.map((a) => `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${a.picked.join(", ")}`)
					.join("\n"),
				0,
				0,
			);
		},
	});
	pi.registerTool({
		name: "pick_skills",
		label: "Skills",
		description:
			"The planner's skills picker. Name the development skills you recommend for this work, each with one line on what it changes, plus any skill the user asked for by name (include). The picker always shows every development skill of the catalog, yours first; returns the ones the user picked with their SKILL.md paths.",
		parameters: Type.Object({
			recommended: Type.Array(
				Type.Object({
					name: Type.String({ description: "A development skill's name, as the catalog has it" }),
					why: Type.String({ description: "One line: what it changes in this work" }),
				}),
				{ description: "Your recommendations, best first; may be empty" },
			),
			notes: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Optional: other development skills by name, one line each on when they would fit this work",
				}),
			),
			include: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skills outside the development group the user asked for by name, e.g. impeccable",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const catalog = readCatalog();
			const built = skillPickerQuestion(catalog, params);
			if ("error" in built)
				return { content: [{ type: "text", text: built.error }], details: { answers: [], cancelled: true } };
			if (ctx.mode !== "tui" || !ctx.hasUI)
				return {
					content: [
						{
							type: "text",
							text: "No interactive user here: use your recommended skills and say so under Assumptions.",
						},
					],
					details: { answers: [], cancelled: true } satisfies AskResult,
				};
			const q = built.question;
			const result = await showPicker(ctx, [{ ...q, header: q.header ?? "Skills", multiSelect: true }]);
			return { content: [{ type: "text", text: pickedSkillsText(result, built.names, catalog) }], details: result };
		},

		renderResult(result, _opts, theme) {
			const d = result.details as AskResult | undefined;
			if (!d || d.cancelled) return new Text(theme.fg("warning", "No skills picked"), 0, 0);
			const picked = d.answers[0]?.picked ?? [];
			return new Text(
				`${theme.fg("success", "✓ ")}${theme.fg("accent", "Skills")}: ${picked.join(", ") || "none"}`,
				0,
				0,
			);
		},
	});
}
