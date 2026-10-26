// A fake pane backend: records every call and shows scripted screens.
import type { BackendName, PaneBackend, PaneCommand, PlaceHint } from "../../src/types.ts";

export type BackendCall =
	| { op: "open"; ref: string; cmd: PaneCommand; title: string; place?: PlaceHint }
	| { op: "close"; ref: string }
	| { op: "read"; ref: string }
	| { op: "keys"; ref: string; keys: readonly string[] }
	| { op: "paste"; ref: string; text: string };

export class FakeBackend implements PaneBackend {
	readonly name: BackendName;
	readonly calls: BackendCall[] = [];
	readonly closed = new Set<string>();
	/** Screens per pane: read() shows the first and drops it while more remain. */
	private readonly screens = new Map<string, string[]>();
	/** Screens the next opened pane starts with. */
	nextScreens: string[] = [];
	/** Called after keys are sent, e.g. to show the screen that follows an answered dialog. */
	onKeys?: (ref: string, keys: readonly string[]) => void;
	openError?: Error;
	private count = 0;

	constructor(name: BackendName = "cmux") {
		this.name = name;
	}

	async open(cmd: PaneCommand, opts: { title: string; place?: PlaceHint }): Promise<string> {
		if (this.openError) throw this.openError;
		const ref = `pane:${++this.count}`;
		this.calls.push({ op: "open", ref, cmd, title: opts.title, place: opts.place });
		this.screens.set(ref, [...this.nextScreens]);
		this.nextScreens = [];
		return ref;
	}

	async close(ref: string): Promise<void> {
		this.calls.push({ op: "close", ref });
		this.closed.add(ref);
	}

	async read(ref: string): Promise<string> {
		this.calls.push({ op: "read", ref });
		const list = this.screens.get(ref) ?? [];
		return (list.length > 1 ? list.shift() : list[0]) ?? "";
	}

	async keys(ref: string, keys: readonly string[]): Promise<void> {
		this.calls.push({ op: "keys", ref, keys });
		this.onKeys?.(ref, keys);
	}

	async paste(ref: string, text: string): Promise<void> {
		this.calls.push({ op: "paste", ref, text });
	}

	async alive(ref: string): Promise<boolean> {
		return !this.closed.has(ref);
	}

	/** Replaces what a pane shows from now on. */
	show(ref: string, ...screens: string[]): void {
		this.screens.set(ref, screens);
	}

	opened(): Array<Extract<BackendCall, { op: "open" }>> {
		return this.calls.filter((c): c is Extract<BackendCall, { op: "open" }> => c.op === "open");
	}

	keysSent(ref?: string): string[][] {
		return this.calls
			.filter((c): c is Extract<BackendCall, { op: "keys" }> => c.op === "keys" && (!ref || c.ref === ref))
			.map((c) => [...c.keys]);
	}
}
