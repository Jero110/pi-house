// tmux pane backend: each agent runs in a tmux pane next to the agent that spawned it, or, when the caller is not
// inside tmux, in a window of the detached session "agent-link" that the user can attach to.
//
// Layout: everything stays in the caller's window. A caller's agents form one column to its right (the first split
// right of the caller, each next one below the last still open), and after every open and close the window takes
// tmux's main-vertical layout with the main pane at half the width: the first pane (the executor, once the planner
// handed off and closed) on the left at full height, the others stacked on the right at even heights.
//
// Problem: agents used to move to another tmux window when a split was small. Example: an executor's workers opened
// in a window after the caller's while the user watched the first one, and the user lost them. Solution: agents
// always open in the caller's window and never move; resizing and moving panes is the agents' job, with tmux or the
// cmux MCP.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_LAUNCH_DIR,
	type PaneBackend,
	type PaneCommand,
	type PlaceHint,
	serialOpens,
	shellQuote,
	writeLaunchScript,
} from "agent-link-core";

export interface TmuxBackendOptions {
	/** The tmux executable, looked up on env.PATH. */
	bin?: string;
	/** Arguments before every command for panes with no place.tmuxSocket, e.g. ["-L", "name"] (tests, dev). */
	serverArgs?: string[];
	env?: NodeJS.ProcessEnv;
	/** Session for agents whose caller is not inside tmux. */
	session?: string;
	/** Where launch scripts go (tests). */
	launchDir?: string;
	timeoutMs?: number;
}

/** A pane command that waits (up to 60 s) for the launch script at path to exist, then execs it. */
export function gateCommand(path: string): string {
	const p = shellQuote(path);
	const script = [
		"i=0",
		`while [ ! -e ${p} ]; do i=$((i+1)); [ "$i" -gt 1200 ] && exit 1; sleep 0.05; done`,
		`exec /bin/sh ${p}`,
	].join("; ");
	return `exec /bin/sh -c ${shellQuote(script)}`;
}

/** types.ts key names (as cmux send-key takes them) to tmux send-keys names. */
const KEYS: Record<string, string> = {
	enter: "Enter",
	escape: "Escape",
	esc: "Escape",
	tab: "Tab",
	"shift+tab": "BTab",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	space: "Space",
	backspace: "BSpace",
	delete: "DC",
	home: "Home",
	end: "End",
	pageup: "PPage",
	pagedown: "NPage",
};

export function tmuxKey(key: string): string {
	const k = key.toLowerCase();
	const named = KEYS[k];
	if (named) return named;
	const ctrl = k.match(/^ctrl\+([a-z])$/);
	if (ctrl) return `C-${ctrl[1]}`;
	if (/^[a-z0-9]$/.test(k)) return k;
	throw new Error(`tmux backend: unknown key ${JSON.stringify(key)}`);
}

export function createTmuxBackend(opts: TmuxBackendOptions = {}): PaneBackend {
	const bin = opts.bin ?? "tmux";
	const env = opts.env ?? process.env;
	const session = opts.session ?? "agent-link";
	const timeout = opts.timeoutMs ?? 10_000;
	const launchDir = opts.launchDir ?? DEFAULT_LAUNCH_DIR;

	// Problem: pane ids are unique only within one tmux server. Example: two servers on sockets a and b both
	// answered `new-session -P -F '#{pane_id}'` with %0, so a pane id alone could send keys to the wrong pane.
	// Solution: a pane opened through place.tmuxSocket gets the ref "%N@<socket>", and every later call on that
	// ref passes -S <socket>. A pane on the default server (or serverArgs) keeps the plain ref "%N".
	const parse = (ref: string) => {
		const m = ref.match(/^(%\d+)(?:@(.+))?$/);
		if (!m?.[1]) throw new Error(`tmux backend: bad pane ref ${JSON.stringify(ref)}`);
		return { pane: m[1], socket: m[2] };
	};
	const server = (socket: string | undefined) => (socket ? ["-S", socket] : (opts.serverArgs ?? []));

	const tmux = (socket: string | undefined, args: string[], input?: string) =>
		new Promise<string>((resolve, reject) => {
			const child = spawn(bin, [...server(socket), ...args], { env, timeout });
			let out = "";
			let err = "";
			child.stdout.on("data", (d: Buffer) => {
				out += d;
			});
			child.stderr.on("data", (d: Buffer) => {
				err += d;
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve(out);
				else reject(new Error(`tmux ${args[0]} failed (${code}): ${(err || out).trim()}`));
			});
			// tmux may exit before reading stdin (EPIPE); its exit code says how the command went.
			child.stdin.on("error", () => {});
			child.stdin.end(input ?? "");
		});

	const paneId = (out: string, what: string) => {
		const id = out.trim();
		if (!/^%\d+$/.test(id)) throw new Error(`tmux ${what} returned no pane id: ${id}`);
		return id;
	};

	/** Panes opened per caller (socket and pane; "" for callers outside tmux), oldest first. */
	const stacks = new Map<string, string[]>();

	async function alive(ref: string): Promise<boolean> {
		// Problem: tmux answers for another pane when the target is gone. Example: after kill-pane %1,
		// `display -p -t %1 '#{pane_id}'` printed an empty line and exited 0. Solution: alive only when it
		// prints the pane's own id.
		const { pane, socket } = parse(ref);
		return tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_id}"]).then(
			(out) => out.trim() === pane,
			() => false,
		);
	}

	async function first(command: string, place?: PlaceHint): Promise<string> {
		const socket = place?.tmuxSocket;
		const fmt = ["-P", "-F", "#{pane_id}"];
		if (place?.tmuxPane)
			return paneId(
				await tmux(socket, ["split-window", "-d", "-h", "-t", place.tmuxPane, ...fmt, command]),
				"split-window",
			);
		const exists = await tmux(socket, ["has-session", "-t", `=${session}`]).then(
			() => true,
			() => false,
		);
		// A detached session is 80x24 unless told otherwise, too small for a harness TUI; attaching resizes it.
		if (!exists)
			return paneId(
				await tmux(socket, ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", ...fmt, command]),
				"new-session",
			);
		return paneId(await tmux(socket, ["new-window", "-d", "-t", `=${session}:`, ...fmt, command]), "new-window");
	}

	/** One column right of the first pane, even heights; best effort, since the layout is cosmetic. */
	async function arrange(socket: string | undefined, target: string): Promise<void> {
		try {
			await tmux(socket, ["set-option", "-w", "-t", target, "main-pane-width", "50%"]);
			await tmux(socket, ["select-layout", "-t", target, "main-vertical"]);
		} catch {}
	}

	const backend: PaneBackend = {
		name: "tmux",
		async open(cmd: PaneCommand, o: { title: string; place?: PlaceHint }) {
			// The gate execs the launch script, which execs the harness: the pane closes when the harness exits.
			const path = join(launchDir, `${randomBytes(8).toString("hex")}.go`);
			const command = gateCommand(path);
			const socket = o.place?.tmuxSocket;
			const key = `${socket ?? ""}|${o.place?.tmuxPane ?? ""}`;
			const stack = stacks.get(key) ?? [];
			const below = stack.at(-1);
			const pane = below
				? paneId(
						await tmux(socket, [
							"split-window",
							"-d",
							"-v",
							"-t",
							parse(below).pane,
							"-P",
							"-F",
							"#{pane_id}",
							command,
						]),
						"split-window",
					)
				: await first(command, o.place);
			const from = below ? parse(below).pane : o.place?.tmuxPane;
			if (from) await arrange(socket, pane);
			renameSync(writeLaunchScript(cmd, launchDir), path);
			const ref = socket ? `${pane}@${socket}` : pane;
			stacks.set(key, [...stack, ref]);
			// The harness would retitle its pane with an escape sequence; the title stays the agent's.
			await tmux(socket, ["set-option", "-p", "-t", pane, "allow-set-title", "off"]);
			await tmux(socket, ["select-pane", "-t", pane, "-T", o.title]);
			await tmux(socket, ["set-option", "-w", "-t", pane, "pane-border-status", "top"]);
			return ref;
		},
		async close(ref) {
			const { pane, socket } = parse(ref);
			const win = await tmux(socket, ["display-message", "-p", "-t", pane, "#{window_id}"]).then(
				(out) => out.trim(),
				() => "",
			);
			try {
				await tmux(socket, ["kill-pane", "-t", pane]);
			} catch (err) {
				// The harness may have exited first, which closes the pane itself.
				if (await alive(ref)) throw err;
			}
			// The rest of the window closes up: the column keeps even heights.
			if (/^@\d+$/.test(win)) await arrange(socket, win);
			for (const [k, stack] of stacks) {
				const rest = stack.filter((r) => r !== ref);
				if (rest.length) stacks.set(k, rest);
				else stacks.delete(k);
			}
		},
		async read(ref, lines = 40) {
			// -S reaches into the history, so a short pane still gives `lines` lines; -J joins wrapped lines.
			const { pane, socket } = parse(ref);
			const out = await tmux(socket, ["capture-pane", "-p", "-J", "-t", pane, "-S", `-${lines}`]);
			const rows = out.replace(/\n$/, "").split("\n");
			while (rows.length && rows.at(-1)?.trim() === "") rows.pop();
			return `${rows.slice(-lines).join("\n")}\n`;
		},
		async keys(ref, keys) {
			const { pane, socket } = parse(ref);
			const names = keys.map(tmuxKey);
			for (const k of names) await tmux(socket, ["send-keys", "-t", pane, k]);
		},
		async paste(ref, text) {
			// A named buffer per paste, deleted by paste-buffer -d, so pastes never mix with the user's buffers.
			// -p pastes in bracketed mode when the program asked for it, so newlines do not submit.
			const { pane, socket } = parse(ref);
			const name = `agent-link-${randomBytes(6).toString("hex")}`;
			await tmux(socket, ["load-buffer", "-b", name, "-"], text);
			await tmux(socket, ["paste-buffer", "-p", "-d", "-b", name, "-t", pane]);
		},
		alive,
	};
	return serialOpens(backend);
}
