import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogLines, exitedNotice, messageText, resultText, SeenIds, who } from "../src/hub/queue.ts";
import type { AgentRecord } from "../src/types.ts";

const agent: AgentRecord = {
	name: "auth",
	parent: "claude",
	harness: "codex",
	model: "gpt-5",
	cwd: "/",
	state: "working",
	pull: false,
	depth: 1,
	startedAt: 0,
};

test("result text: [agent-link] <name> (<harness> · <model>) finished, with the result after a blank line", () => {
	assert.equal(
		resultText(agent, "end_turn", "  all green \n"),
		"[agent-link] auth (codex · gpt-5) finished:\n\nall green",
	);
	assert.equal(resultText({ ...agent, model: null }, "end_turn", ""), "[agent-link] auth (codex) finished.");
	assert.equal(resultText(agent, "error", "boom"), "[agent-link] auth (codex · gpt-5) failed:\n\nboom");
	assert.equal(
		resultText(agent, "max_tokens", "cut"),
		"[agent-link] auth (codex · gpt-5) finished (stop reason: max_tokens):\n\ncut",
	);
	assert.match(resultText(agent, "cancelled", ""), /stopped \(its turn was cancelled\)\.$/);
	assert.equal(who(agent), "auth (codex · gpt-5)");
	assert.equal(messageText("claude", "hi"), "[agent-link] claude: hi");
	assert.equal(exitedNotice(agent, undefined, undefined), "[agent-link] auth (codex · gpt-5) exited.");
	assert.equal(dialogLines("Q?", []), "Q?\n\nOptions:\n(no options with a cursor were found; look at the pane)");
});

test("seen ids: a repeated id gets the first result; the oldest ids are forgotten first", () => {
	const seen = new SeenIds();
	seen.set("a", { ok: true, id: "a", queued: true });
	assert.deepEqual(seen.get("a"), { ok: true, id: "a", queued: true });
	for (let i = 0; i < 10_000; i++) seen.set(`x${i}`, { ok: true });
	assert.equal(seen.get("a"), undefined);
	assert.ok(seen.get("x9999"));
});
