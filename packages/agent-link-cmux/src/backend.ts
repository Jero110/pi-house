// cmux pane backend: each agent runs in a cmux split next to the agent that spawned it.
//
// The hub is a daemon outside any pane, so every call names its surface (and workspace when known) explicitly;
// cmux accepts that from a process outside cmux because surface refs are global (Experiment 7, C0).
//
// Problem: cmux fills a missing --surface from $CMUX_SURFACE_ID. Example: the hub was started on demand by an MCP
// server inside a pane, inherited that pane's CMUX_SURFACE_ID, and a close-surface without --surface would have
// closed the user's own pane. Solution: those variables are removed from the env of every cmux call, and every
// call passes its target.
//
// Layout: a caller's agents form one column to its right, the first split right of the caller and each next one
// below the last still open; after every open and close the workspace's splits are equalized, so the column's
// panes share its height evenly. Agents never open as tabs.
//
// Problem: agents used to move to another cmux workspace when a split was small or the workspace was full. Example:
// an executor's workers opened in a workspace called "agent-link" while the user watched the first one, and the
// user lost them. Solution: agents always open in the caller's workspace and never move. A split that does not fit
// is retried from the other panes of that workspace, and when none fits the open fails with a clear error. Resizing
// and moving panes is the agents' job, with the cmux MCP (resize_pane, move_surface, swap_pane).

import { execFile } from "node:child_process";
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

export interface CmuxBackendOptions {
	/** The cmux executable, looked up on env.PATH. */
	bin?: string;
	env?: NodeJS.ProcessEnv;
	/** Where launch scripts go (tests). */
	launchDir?: string;
	timeoutMs?: number;
}

interface Gate {
	/** Where the launch script goes once the pane is accepted; the pane runs it then. */
	path: string;
	/** The pane's command: wait for the script, exec it. */
	command: string;
}

/**
 * A pane command that waits (up to 60 s) for <path> to exist, then execs it. `exec` replaces the pane's shell, so the surface closes when the harness exits and alive() says so.
 */
export function gateCommand(path: string): string {
	const p = shellQuote(path);
	const script = [
		"i=0",
		`while [ ! -e ${p} ]; do i=$((i+1)); [ "$i" -gt 1200 ] && exit 1; sleep 0.05; done`,
		`exec /bin/sh ${p}`,
	].join("; ");
	return `exec /bin/sh -c ${shellQuote(script)}`;
}

const DEFAULT_ENV_VARS = ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_PANEL_ID"];

export function createCmuxBackend(opts: CmuxBackendOptions = {}): PaneBackend {
	const bin = opts.bin ?? "cmux";
	const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CMUX_QUIET: "1" };
	for (const k of DEFAULT_ENV_VARS) delete env[k];
	const timeout = opts.timeoutMs ?? 10_000;
	const launchDir = opts.launchDir ?? DEFAULT_LAUNCH_DIR;

	const cmux = (...args: string[]) =>
		new Promise<string>((resolve, reject) => {
			execFile(bin, args, { env, timeout }, (err, stdout, stderr) => {
				if (err) reject(new Error(`cmux ${args[0]} failed: ${(stderr || stdout || err.message).trim()}`));
				else resolve(stdout);
			});
		});

	/** Workspace of each pane this backend opened, so later calls can name it. */
	const workspaceOf = new Map<string, string>();
	/** Panes opened per caller surface, oldest first: the next worker opens below the last one still open. */
	const stacks = new Map<string, string[]>();

	const newGate = (): Gate => {
		const path = join(launchDir, `${randomBytes(8).toString("hex")}.go`);
		return { path, command: gateCommand(path) };
	};

	/** Lets the gate start the harness: the launch script appears at the path the gate waits for. */
	const release = (gate: Gate, cmd: PaneCommand) => renameSync(writeLaunchScript(cmd, launchDir), gate.path);

	/**
	 * The workspace of a surface this backend did not open, from cmux's tree (by ref or by id).
	 * Problem: closing a root's own terminal on handoff failed with "close-surface requires --workspace or --window
	 * with explicit --surface", since only the surface was known. Solution: look its workspace up first.
	 */
	async function findWorkspace(surface: string): Promise<string | undefined> {
		const tree = JSON.parse(await cmux("tree", "--all", "--json", "--id-format", "both")) as {
			windows?: Array<{
				workspaces?: Array<{ ref?: string; panes?: Array<{ surface_refs?: string[]; surface_ids?: string[] }> }>;
			}>;
		};
		for (const w of tree.windows?.flatMap((x) => x.workspaces ?? []) ?? [])
			for (const pane of w.panes ?? [])
				if (pane.surface_refs?.includes(surface) || pane.surface_ids?.includes(surface)) return w.ref;
		return undefined;
	}

	/** Gives the workspace's splits even sizes; best effort, since the layout is cosmetic. */
	async function equalize(workspace: string | undefined): Promise<void> {
		if (!workspace) return;
		await cmux("rpc", "workspace.equalize_splits", JSON.stringify({ workspace_id: workspace })).catch(() => undefined);
	}

	const where = (ref: string) => {
		const ws = workspaceOf.get(ref);
		return ws ? ["--workspace", ws, "--surface", ref] : ["--surface", ref];
	};

	const parseSurface = (out: string, what: string) => {
		const ref = out.match(/surface:\d+/)?.[0];
		if (!ref) throw new Error(`cmux ${what} returned no surface: ${out.trim()}`);
		return { ref, workspace: out.match(/workspace:\d+/)?.[0] };
	};

	async function split(direction: "right" | "down", workspace: string | undefined, from: string, command: string) {
		const ws = workspace ? ["--workspace", workspace] : [];
		const args = ["new-split", direction, ...ws, "--surface", from, "--focus", "false", "--command", command];
		return parseSurface(await cmux(...args), "new-split");
	}

	// A workspace with many panes refuses another split: "no_space: No space for new pane".
	const noSpace = (err: unknown) => String(err).includes("no_space");

	const backend: PaneBackend = {
		name: "cmux",
		async open(cmd: PaneCommand, o: { title: string; place?: PlaceHint }) {
			const caller = o.place?.surface;
			if (!caller) throw new Error("cmux backend: place.surface (the caller's surface) is required");
			const stack = stacks.get(caller) ?? [];
			const gate = newGate();
			const triedWs = (stack.length ? workspaceOf.get(stack.at(-1) ?? "") : undefined) ?? o.place?.workspace;
			// Below the last agent still open; when that is full, below an older one; last, right of the caller.
			const spots = [
				...[...stack].reverse().map((from) => ({ from, direction: "down" as const })),
				{ from: caller, direction: "right" as const },
			];
			let made: { ref: string; workspace?: string } | undefined;
			let full: unknown;
			for (const spot of spots) {
				try {
					made = await split(spot.direction, triedWs, spot.from, gate.command);
					break;
				} catch (err) {
					if (!noSpace(err)) throw err;
					full = err;
				}
			}
			if (!made)
				throw new Error(`cmux backend: no room for another agent pane in ${triedWs ?? "the workspace"}: ${full}`);
			const workspace = made.workspace ?? triedWs;
			await equalize(workspace);
			release(gate, cmd);
			if (workspace) workspaceOf.set(made.ref, workspace);
			stacks.set(caller, [...stack, made.ref]);
			await cmux("rename-tab", ...where(made.ref), "--", o.title);
			return made.ref;
		},
		async close(ref) {
			const ws = workspaceOf.get(ref) ?? (await findWorkspace(ref).catch(() => undefined));
			if (ws) workspaceOf.set(ref, ws);
			try {
				await cmux("close-surface", ...where(ref), "--force");
			} catch (err) {
				// The harness may have exited first, which closes the surface itself.
				if (await this.alive(ref)) throw err;
			}
			workspaceOf.delete(ref);
			if (ws) await equalize(ws);
			for (const [caller, stack] of stacks) {
				const rest = stack.filter((r) => r !== ref);
				if (rest.length) stacks.set(caller, rest);
				else stacks.delete(caller);
			}
		},
		read: (ref, lines = 40) => cmux("read-screen", ...where(ref), "--lines", String(lines)),
		async keys(ref, keys) {
			// cmux refuses keys to a pane it sees waiting on a question or dialog ("nothing was sent ... pass
			// --force"), and answering dialogs is what keys are for.
			for (const key of keys) await cmux("send-key", "--force", ...where(ref), "--", key);
		},
		async paste(ref, text) {
			// --paste must come before the text; --force because a pane with a draft or a dialog refuses it.
			await cmux("send", "--force", ...where(ref), "--paste", "--", text);
		},
		alive: (ref) =>
			cmux("read-screen", ...where(ref), "--lines", "1").then(
				() => true,
				() => false,
			),
	};
	return serialOpens(backend);
}
