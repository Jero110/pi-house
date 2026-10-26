import assert from "node:assert/strict";
import { test } from "node:test";
import { causeOf, next, TRANSITIONS, turnEndCause } from "../src/hub/state.ts";

test("the lifecycle: starting → working ⇄ asking → done | error | exited", () => {
	assert.equal(next("starting", "connected"), "working");
	assert.equal(next("starting", "wake"), "starting", "a message to a starting agent proves nothing");
	assert.equal(next("working", "asking"), "asking");
	assert.equal(next("asking", "wake"), "working");
	assert.equal(next("asking", "answered"), "working");
	assert.equal(next("working", "done"), "done");
	assert.equal(next("done", "wake"), "working", "a new message starts a new turn");
	assert.equal(next("error", "started"), "working");
});

test("transitions seen in real runs are rejected: duplicate turn ends, asking after done, anything after exit", () => {
	assert.equal(next("done", "done"), undefined);
	assert.equal(next("done", "error"), undefined);
	assert.equal(next("done", "asking"), undefined);
	assert.equal(next("done", "dialog"), undefined);
	for (const cause of [
		"started",
		"asking",
		"done",
		"error",
		"exited",
		"wake",
		"connected",
		"dialog",
		"answered",
	] as const)
		assert.equal(next("exited", cause), undefined);
	assert.deepEqual(TRANSITIONS.exited, {});
});

test("adapter updates map to causes", () => {
	assert.equal(causeOf({ kind: "state", state: "busy" }), "started");
	assert.equal(causeOf({ kind: "state", state: "asking" }), "asking");
	assert.equal(causeOf({ kind: "state", state: "idle" }), undefined);
	assert.equal(causeOf({ kind: "turn_end", stopReason: "end_turn", text: "" }), "done");
	assert.equal(causeOf({ kind: "turn_end", stopReason: "error", text: "" }), "error");
	assert.equal(causeOf({ kind: "exited" }), "exited");
	assert.equal(causeOf({ kind: "agent_message", text: "x" }), undefined);
	assert.equal(turnEndCause("max_tokens"), "done");
	assert.equal(turnEndCause("cancelled"), "done");
});
