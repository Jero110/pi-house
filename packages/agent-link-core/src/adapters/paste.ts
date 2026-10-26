// Paste adapter: for a harness with no native path, given by a profile with `adapter: "paste"` and `command`.
// It talks to the harness only through its pane: it pastes the message, presses enter, and watches the screen.
//
// What it cannot know, because the screen is all it sees:
// - When a turn ends. A turn ends when the screen has stopped changing for `quietMs` after it first changed.
//   A harness that thinks longer than that without moving anything on screen (no spinner, no timer) looks done
//   early; one that redraws a clock all the time never looks done.
// - The exact text. The turn's text is the screen lines that were not on screen before the prompt, in order,
//   without the echo of the prompt (its lines, also after a marker such as "> "). Lines that scrolled out of the
//   read window are lost, a reply line equal to one already on screen or to a prompt line is dropped, and TUI
//   chrome that changed (status bars) is included.
// - Tool calls, permission prompts and dialogs: no tool_call updates, no "asking" state.
// - Turns the user types in the pane: no turn_end updates. They only keep idle() false while the screen moves.
// - Whether the harness accepted the message. A screen that never changes after enter ends the prompt with
//   stopReason "error".

import type {
	AdapterDeps,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
} from "../types.ts";

export interface PasteOptions {
	/** How long the screen must stay unchanged for a turn (or startup) to count as finished. */
	quietMs?: number;
	pollMs?: number;
	/** Lines read from the pane each poll. */
	lines?: number;
	/** connect() resolves after this even if the screen never settles (logged as connect_timeout). */
	connectTimeoutMs?: number;
	/** A prompt whose screen has not changed this long after enter ends with stopReason "error". */
	startTimeoutMs?: number;
}

interface Turn {
	before: string;
	prompt: string;
	changed: boolean;
	resolve: (r: PromptResponse) => void;
	startedAt: number;
}

/** The screen lines of `after` that were not in `before` (as a multiset), minus the lines of the prompt. */
export function newLines(before: string, after: string, prompt = ""): string {
	const seen = new Map<string, number>();
	for (const line of before.split("\n")) {
		const k = line.trimEnd();
		seen.set(k, (seen.get(k) ?? 0) + 1);
	}
	const promptLines = new Set(
		prompt
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);
	const longPromptLines = [...promptLines].filter((l) => l.length >= 8);
	const out: string[] = [];
	for (const line of after.split("\n")) {
		const k = line.trimEnd();
		const n = seen.get(k) ?? 0;
		if (n > 0) {
			seen.set(k, n - 1);
			continue;
		}
		// The harness echoes the prompt after its own marker ("> ", "❯ ", "sh$ "). A marker made of symbols is
		// ignored for every prompt line; any marker is, for prompt lines of 8 or more characters (a short line
		// like "ok" ends too many reply lines).
		const t = k.trim();
		const bare = t.replace(/^[^\p{L}\p{N}]+/u, "").trim();
		if (t === "" || promptLines.has(t) || promptLines.has(bare) || longPromptLines.some((p) => t.endsWith(p))) continue;
		out.push(k);
	}
	return out.join("\n");
}

export function fillCommand(command: readonly string[], vars: { model: string | null; cwd: string }): string[] {
	return command.map((arg) => {
		if (arg.includes("{model}") && vars.model === null) {
			throw new Error(`paste adapter: the command uses {model} and no model was given: ${arg}`);
		}
		return arg.replaceAll("{model}", vars.model ?? "").replaceAll("{cwd}", vars.cwd);
	});
}

export function createPasteAdapter(deps: AdapterDeps, opts: PasteOptions = {}): AgentAdapter {
	const quietMs = opts.quietMs ?? 3000;
	const pollMs = opts.pollMs ?? 250;
	const lines = opts.lines ?? 200;
	const connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
	const startTimeoutMs = opts.startTimeoutMs ?? 30_000;

	const listeners: ((u: SessionUpdate) => void)[] = [];
	const emit = (u: SessionUpdate) => {
		for (const l of listeners) l(u);
	};

	let pane: PaneHandle | undefined;
	let screen: string | undefined;
	let changedAt = Date.now();
	let turn: Turn | undefined;
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	let exited = false;
	let settled: (() => void) | undefined;

	const quiet = () => screen !== undefined && Date.now() - changedAt >= quietMs;

	function finish(stopReason: PromptResponse["stopReason"]) {
		const t = turn;
		if (!t) return;
		turn = undefined;
		const text = newLines(t.before, screen ?? "", t.prompt);
		deps.log("paste_turn_end", { stopReason, ms: Date.now() - t.startedAt, chars: text.length });
		emit({ kind: "state", state: "idle" });
		t.resolve({ stopReason, text });
	}

	async function tick() {
		const p = pane;
		if (!p || closed || exited) return;
		let next: string;
		try {
			next = await p.backend.read(p.ref, lines);
		} catch (err) {
			if (await p.backend.alive(p.ref).catch(() => false)) {
				deps.log("paste_read_failed", { error: String(err) });
				return;
			}
			exited = true;
			settled?.();
			settled = undefined;
			finish("error");
			emit({ kind: "exited", detail: "pane closed" });
			return;
		}
		const now = Date.now();
		if (next !== screen) {
			screen = next;
			changedAt = now;
			if (turn && next !== turn.before) turn.changed = true;
		}
		if (settled && quiet()) {
			settled();
			settled = undefined;
		}
		if (!turn) return;
		if (turn.changed && quiet()) finish("end_turn");
		else if (!turn.changed && now - turn.startedAt >= startTimeoutMs) {
			deps.log("paste_no_change", { ms: now - turn.startedAt });
			finish("error");
		}
	}

	function loop() {
		if (closed || exited) return;
		timer = setTimeout(() => {
			tick().then(loop, loop);
		}, pollMs);
	}

	return {
		async launch(spec: LaunchSpec): Promise<PaneCommand> {
			const command = spec.profile.command;
			if (!command?.length) throw new Error(`paste adapter: profile ${spec.profile.harness} has no command`);
			const model = spec.model ?? spec.profile.defaultModel;
			return { argv: fillCommand(command, { model, cwd: spec.cwd }), env: spec.env, cwd: spec.cwd };
		},

		async connect(handle?: PaneHandle) {
			if (!handle) throw new Error("paste adapter: needs a pane; a root opened with `agent-link open` has none");
			pane = handle;
			const ready = new Promise<void>((resolve) => {
				settled = resolve;
			});
			loop();
			let timeout: NodeJS.Timeout | undefined;
			const late = new Promise<void>((resolve) => {
				timeout = setTimeout(() => {
					deps.log("connect_timeout", { ms: connectTimeoutMs });
					settled = undefined;
					resolve();
				}, connectTimeoutMs);
			});
			await Promise.race([ready, late]);
			clearTimeout(timeout);
			if (exited) throw new Error("paste adapter: the pane closed before the harness settled");
		},

		async prompt(req: PromptRequest): Promise<PromptResponse> {
			const p = pane;
			if (!p) throw new Error("paste adapter: prompt before connect");
			if (turn) throw new Error("paste adapter: a prompt is already in flight");
			if (exited) return { stopReason: "error", text: "" };
			const before = await p.backend.read(p.ref, lines);
			screen = before;
			changedAt = Date.now();
			const done = new Promise<PromptResponse>((resolve) => {
				turn = { before, prompt: req.text, changed: false, resolve, startedAt: Date.now() };
			});
			emit({ kind: "state", state: "busy" });
			await p.backend.paste(p.ref, req.text);
			await p.backend.keys(p.ref, ["enter"]);
			return done;
		},

		idle: () => !turn && !exited && quiet(),

		async cancel() {
			if (pane && !exited) await pane.backend.keys(pane.ref, ["escape"]);
			finish("cancelled");
		},

		async close() {
			closed = true;
			clearTimeout(timer);
			finish("cancelled");
		},

		onUpdate(listener) {
			listeners.push(listener);
		},
	};
}

export const pasteAdapter = (deps: AdapterDeps): AgentAdapter => createPasteAdapter(deps);
