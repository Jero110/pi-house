// A unified diff of two texts, for `/workflow proposals <id>`.
//
// Problem: a proposal holds the full before and after text, and a reader cannot see what changed in two long blocks.
// Example: a 200-line skill with one reworded paragraph shows as 400 lines. Solution: the lines that differ with three
// lines of context around them, in the format `diff -u` prints. No dependency: a longest-common-subsequence table is
// enough for the sizes a proposal has (the intake bounds each field).

const CONTEXT = 3;
/** Beyond this many cells the table is not built; the diff then shows the whole text as removed and added. */
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string };

function lines(text: string): string[] {
	if (text === "") return [];
	const parts = text.replace(/\r\n/g, "\n").split("\n");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

function operations(a: string[], b: string[]): Op[] {
	if (a.length * b.length > MAX_CELLS)
		return [...a.map((text): Op => ({ kind: "-", text })), ...b.map((text): Op => ({ kind: "+", text }))];
	// lcs[i][j]: the length of the common subsequence of a[i..] and b[j..].
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			ops.push({ kind: " ", text: a[i++] });
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", text: a[i++] });
		else ops.push({ kind: "+", text: b[j++] });
	}
	while (i < a.length) ops.push({ kind: "-", text: a[i++] });
	while (j < b.length) ops.push({ kind: "+", text: b[j++] });
	return ops;
}

/** The diff of `before` into `after`, or an empty string when they are the same text. */
export function unifiedDiff(before: string, after: string, beforeName: string, afterName: string): string {
	const ops = operations(lines(before), lines(after));
	const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
	if (changed.length === 0) return "";
	// Changes closer than two contexts apart share a hunk.
	const spans: [number, number][] = [];
	for (const index of changed) {
		const last = spans.at(-1);
		if (last && index - last[1] <= 2 * CONTEXT) last[1] = index;
		else spans.push([index, index]);
	}
	// Line numbers before each operation, for the hunk headers.
	const oldAt: number[] = [];
	const newAt: number[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const op of ops) {
		oldAt.push(oldLine);
		newAt.push(newLine);
		if (op.kind !== "+") oldLine++;
		if (op.kind !== "-") newLine++;
	}
	const out = [`--- ${beforeName}`, `+++ ${afterName}`];
	for (const [first, last] of spans) {
		const from = Math.max(0, first - CONTEXT);
		const to = Math.min(ops.length - 1, last + CONTEXT);
		const slice = ops.slice(from, to + 1);
		const oldCount = slice.filter((op) => op.kind !== "+").length;
		const newCount = slice.filter((op) => op.kind !== "-").length;
		out.push(
			`@@ -${oldCount === 0 ? oldAt[from] - 1 : oldAt[from]},${oldCount} +${newCount === 0 ? newAt[from] - 1 : newAt[from]},${newCount} @@`,
		);
		for (const op of slice) out.push(`${op.kind}${op.text}`);
	}
	return out.join("\n");
}
