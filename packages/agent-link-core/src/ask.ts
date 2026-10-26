// What a parent passes to permit() (option numbers or texts) turned into option indexes of a PendingAsk, and the
// ask rendered for the parent's notice.
//
// Problem: a worker that stopped on a permission mid-turn waited forever. Example: an opencode worker asked to
// read its brief outside its folder; the executor sent "Allow once" with send, which only queued a message for
// after a turn that could not end. Solution: adapters report the ask with its options (from the harness's API
// or a hook, so a narrow pane does not matter) and the parent answers with permit({ to, choice }).
import type { AskQuestion, PendingAsk } from "./types.ts";

const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Words a parent may use instead of an option's number or text, and the option labels they stand for. */
const ALIASES: Array<{ words: RegExp; label: RegExp }> = [
	{ words: /^(always|siempre|allowalways|síempre)$/, label: /always|siempre|session/i },
	{
		words: /^(yes|y|sí|si|ok|allow|accept|approve|permit|allowonce|once|permitir)$/,
		label: /^(allow|yes|accept|sí|si)\b/i,
	},
	{ words: /^(no|n|deny|reject|decline|refuse|rechazar|cancel)$/, label: /^(no|deny|reject|decline)\b/i },
];

function pickOne(q: AskQuestion, token: string): number | string {
	const t = token.trim();
	if (/^\d+$/.test(t)) {
		const n = Number(t);
		return n >= 1 && n <= q.options.length ? n - 1 : `there is no option ${n}`;
	}
	const c = compact(t);
	if (!c) return "the choice is empty";
	const exact = q.options.findIndex((o) => compact(o) === c);
	if (exact >= 0) return exact;
	const prefix = q.options.findIndex((o) => compact(o).startsWith(c));
	if (prefix >= 0) return prefix;
	for (const a of ALIASES) {
		if (!a.words.test(c)) continue;
		const i = q.options.findIndex((o) => a.label.test(o.trim()));
		if (i >= 0) return i;
	}
	return `no option matches ${JSON.stringify(t)}`;
}

/**
 * The option indexes `choice` picks, one list per question. Several questions take one part each, separated
 * by ";" ("1; 2"); a question with `multiple` takes several options separated by "," ("1,3").
 */
export function pickChoices(ask: PendingAsk, choice: string): { picks: number[][] } | { error: string } {
	const parts = ask.questions.length > 1 ? choice.split(";") : [choice];
	if (parts.length !== ask.questions.length)
		return { error: `there are ${ask.questions.length} questions: answer each, separated by ";"` };
	const picks: number[][] = [];
	for (const [i, q] of ask.questions.entries()) {
		const tokens = q.multiple ? (parts[i] ?? "").split(",") : [parts[i] ?? ""];
		const chosen: number[] = [];
		for (const token of tokens) {
			const r = pickOne(q, token);
			if (typeof r === "string") return { error: ask.questions.length > 1 ? `question ${i + 1}: ${r}` : r };
			if (!chosen.includes(r)) chosen.push(r);
		}
		picks.push(chosen);
	}
	return { picks };
}

/** The picked options as one line, for the parent ("Allow once", "Sí; No, gracias"). */
export function pickedText(ask: PendingAsk, picks: number[][]): string {
	return picks.map((p, i) => p.map((j) => ask.questions[i]?.options[j] ?? "?").join(", ")).join("; ");
}

/** The ask as the parent reads it: each question, then its numbered options. */
export function askLines(ask: PendingAsk): string {
	const out: string[] = [];
	for (const [i, q] of ask.questions.entries()) {
		const head = ask.questions.length > 1 ? `${i + 1}) ${q.question}` : q.question;
		out.push(q.multiple ? `${head} (pick one or more, e.g. "1,3")` : head);
		for (const [j, o] of q.options.entries()) out.push(`  ${j + 1}. ${o}`);
	}
	return out.join("\n");
}

/** One line for logs and status: the first question. */
export function askSummary(ask: PendingAsk): string {
	return ask.questions[0]?.question ?? ask.kind;
}
