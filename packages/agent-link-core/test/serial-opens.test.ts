import assert from "node:assert/strict";
import { test } from "node:test";
import { serialOpens } from "../src/serial-opens.ts";
import type { PaneBackend } from "../src/types.ts";

test("opens run one at a time, in order, so each sees the panes opened before it; a failed open does not block", async () => {
	const log: string[] = [];
	let open = 0;
	const backend = serialOpens({
		name: "cmux",
		async open(_cmd, o) {
			open++;
			assert.equal(open, 1, "never two opens at once");
			log.push(`start ${o.title}`);
			await new Promise((r) => setTimeout(r, 20));
			log.push(`end ${o.title}`);
			open--;
			if (o.title === "b") throw new Error("no room");
			return o.title;
		},
		close: async () => {},
		read: async () => "",
		keys: async () => {},
		paste: async () => {},
		alive: async () => true,
	} satisfies PaneBackend);
	const cmd = { argv: ["x"], env: {}, cwd: "/" };
	const [a, b, c] = await Promise.allSettled(["a", "b", "c"].map((title) => backend.open(cmd, { title })));
	assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
	assert.equal(a.status === "fulfilled" && a.value, "a");
	assert.equal(b.status, "rejected");
	assert.equal(c.status === "fulfilled" && c.value, "c");
});
