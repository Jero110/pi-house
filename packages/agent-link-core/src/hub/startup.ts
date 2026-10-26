// Watches a fresh pane and answers the startup dialogs its profile knows, while the adapter connects.
// Ported from an earlier hub; it now reads and types through any
// PaneBackend and recognizes dialogs with matchDialog and the profile's dialog list.
//
// Problem: a dialog the hub did not know left the worker stuck, and nobody saw it.
// Example: a claude worker in a folder with a .mcp.json stops on "New MCP server found in this project".
// Solution: an unknown dialog is reported once (onUnknown) with its text and options, and the watcher keeps
// looking until it leaves the screen (onAnswered), so the parent can pick an option and the agent goes on.
import { matchDialog } from "../dialogs.ts";
import type { DialogSpec, PaneBackend } from "../types.ts";

export interface StartupOptions {
	/** How long to watch for dialogs while nothing else happens. An unknown dialog showing keeps it going. */
	timeoutMs?: number;
	pollMs?: number;
	/** True once the adapter connected; the watcher stops at the first screen with no dialog after that. */
	started?: () => boolean;
	/** True when the watch must end now (the agent was cancelled or exited). */
	stopped?: () => boolean;
	onKnown?: (name: string, keys: readonly string[]) => void;
	onUnknown?: (dialog: { text: string; options: string[] }) => void;
	/** The unknown dialog reported last left the screen. */
	onAnswered?: () => void;
}

/** Returns the names of the dialogs it answered, in order. */
export async function watchStartupDialogs(
	backend: Pick<PaneBackend, "read" | "keys">,
	ref: string,
	dialogs: readonly DialogSpec[],
	opts: StartupOptions = {},
): Promise<string[]> {
	const pollMs = opts.pollMs ?? 400;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	let end = Date.now() + timeoutMs;
	const answered: string[] = [];
	// A dialog that was answered is not answered again until the screen stops showing it: the pane may
	// not have redrawn yet when the next read comes.
	let pending: string | undefined;
	let unknown: string | undefined;
	while (!opts.stopped?.() && (Date.now() < end || unknown !== undefined)) {
		const screen = await backend.read(ref, 60).catch(() => "");
		if (opts.stopped?.()) break;
		const dialog = matchDialog(screen, dialogs);
		if (dialog.kind !== "unknown" && unknown !== undefined) {
			unknown = undefined;
			// Someone answered it (the parent through send, or the user in the pane): give startup time again.
			end = Date.now() + timeoutMs;
			opts.onAnswered?.();
		}
		if (dialog.kind === "none" && opts.started?.()) break;
		if (dialog.kind !== "known" || dialog.name !== pending) pending = undefined;
		if (dialog.kind === "known" && !pending) {
			await backend.keys(ref, dialog.keys);
			answered.push(dialog.name);
			pending = dialog.name;
			opts.onKnown?.(dialog.name, dialog.keys);
		}
		if (dialog.kind === "unknown" && dialog.text !== unknown) {
			unknown = dialog.text;
			opts.onUnknown?.({ text: dialog.text, options: dialog.options });
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return answered;
}
