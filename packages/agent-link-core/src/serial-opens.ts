// Pane backends open one pane at a time.
//
// Problem: a backend stacks each agent below the last one its caller has open, and an open takes a few hundred ms
// (split, equalize, size check). Example: an executor spawned three workers at once; all three saw an empty stack
// and split right of it, so the window had four columns instead of the executor and one column of three. Solution:
// opens run in order, each after the previous one finished, so each sees the panes opened before it.
import type { PaneBackend } from "./types.ts";

export function serialOpens(backend: PaneBackend): PaneBackend {
	const open = backend.open.bind(backend);
	let last: Promise<unknown> = Promise.resolve();
	backend.open = (cmd, opts) => {
		const run = last.then(() => open(cmd, opts));
		last = run.catch(() => undefined);
		return run;
	};
	return backend;
}
