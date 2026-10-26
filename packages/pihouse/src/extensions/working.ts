// pihouse shows work the way Claude Code does: a spinner with the time and tokens while it runs, and a line when it is done.
//
//   ✻ Working (27s · ↓ 2.5k tokens)                              while the agent works
//   ✻ Worked for 20s · done 2:40 p.m.                           in the transcript, when it stops
//
// Problem: pi's loader says "Working" and nothing marks the end of an answer, so a long run leaves no trace of how
// long it took. Example: a run of 3 minutes looks like one of 3 seconds once it is over.
// Solution: the loader's message is rewritten every second with the elapsed time and the tokens written, and each run
// ends with a short transcript line.
//
// The line is a custom entry (appendEntry), not a custom message (sendMessage). Problem: a message sent on agent_end is
// queued as a follow-up, so it started a new turn the user never asked for, and the model answered it. Example: after
// every long answer the executor answered again ("nothing left to do"), and once it launched an agent the user had not
// approved. Solution: an entry is shown in the transcript, never sent to the model and never starts a turn.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const WORKED_TYPE = "pihouse-worked";
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
/** The loader's glyph is drawn verbatim, so it carries its own color: the theme's lilac (accent). */
const LILAC = "\x1b[38;2;168;170;245m";
const RESET = "\x1b[39m";
/** Runs shorter than this leave no line behind: a one-second answer needs no "Worked for 1s". */
const MIN_REPORT_MS = 5_000;
/** The usual size of a token in English and code, for the count while a message is still being written. */
const CHARS_PER_TOKEN = 4;

/** "27s", "1m 5s", "1h 2m": a duration the way Claude Code writes it. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${total % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "2.5k": tokens as Claude Code abbreviates them. */
export function formatTokens(n: number): string {
	return n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}m`;
}

/** "2:40 p.m.": the clock time of the end of a run. */
export function clockTime(at: number): string {
	const d = new Date(at);
	const hours = d.getHours();
	return `${hours % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${hours < 12 ? "a.m." : "p.m."}`;
}

export interface Progress {
	elapsedMs: number;
	/** Tokens written so far. */
	output: number;
}

/** "Working (27s · ↓ 2.5k tokens)": the loader's message. */
export function workingMessage(p: Progress): string {
	const parts = [formatDuration(p.elapsedMs)];
	if (p.output > 0) parts.push(`↓ ${formatTokens(p.output)} tokens`);
	return `Working (${parts.join(" · ")})`;
}

/** "Worked for 18s · done 2:40 p.m.": the line a finished run leaves. */
export function workedMessage(elapsedMs: number, endedAt: number): string {
	return `Worked for ${formatDuration(elapsedMs)} · done ${clockTime(endedAt)}`;
}

/** The glyph the line at the end starts with. */
export const SUMMARY_GLYPH = "✻";

type Usage = { output?: number };
const outputOf = (message: unknown): number => {
	const usage = (message as { usage?: Usage } | undefined)?.usage;
	return typeof usage?.output === "number" ? usage.output : 0;
};

export default function working(pi: ExtensionAPI): void {
	const line = (text: string | undefined, theme: { fg: (color: "dim", text: string) => string }) =>
		text ? new Text(`${theme.fg("dim", `${SUMMARY_GLYPH} ${text}`)}`, 1, 0) : undefined;
	pi.registerEntryRenderer<{ text: string }>(WORKED_TYPE, (entry, _options, theme) => line(entry.data?.text, theme));
	// Sessions saved before the line became an entry still hold it as a message: draw it, and keep it from the model.
	pi.registerMessageRenderer<{ text: string }>(WORKED_TYPE, (message, _options, theme) =>
		line(message.details?.text, theme),
	);
	pi.on("context", (event) => ({
		messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === WORKED_TYPE)),
	}));

	let startedAt = 0;
	/** Tokens of the answers already finished, and of the one being written. */
	let doneOutput = 0;
	let liveOutput = 0;
	let liveChars = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	pi.on("agent_start", (_event, ctx) => {
		startedAt = Date.now();
		doneOutput = liveOutput = liveChars = 0;
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingIndicator({ frames: SPINNER.map((f) => `${LILAC}${f}${RESET}`), intervalMs: 150 });
		const tick = () => {
			const now = Date.now();
			ctx.ui.setWorkingMessage(workingMessage({ elapsedMs: now - startedAt, output: doneOutput + liveOutput }));
		};
		tick();
		stop();
		timer = setInterval(tick, 1000);
		timer.unref();
	});

	pi.on("message_update", (event) => {
		const sent = event.assistantMessageEvent;
		// Many providers report usage only at the end of a message, so what is written so far is estimated from the text
		// that arrives (about four characters a token) and replaced by the real count when the message ends.
		const delta = "delta" in sent && typeof sent.delta === "string" ? sent.delta : "";
		liveChars += delta.length;
		liveOutput = Math.max(outputOf(event.message), Math.round(liveChars / CHARS_PER_TOKEN));
	});
	pi.on("message_end", (event) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		doneOutput += outputOf(event.message) || liveOutput;
		liveOutput = 0;
		liveChars = 0;
	});

	pi.on("agent_end", (_event, ctx) => {
		stop();
		const elapsed = Date.now() - startedAt;
		if (!ctx.hasUI || !startedAt || elapsed < MIN_REPORT_MS) return;
		const text = workedMessage(elapsed, Date.now());
		pi.appendEntry<{ text: string }>(WORKED_TYPE, { text });
	});
}
