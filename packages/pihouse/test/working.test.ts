import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import working, {
	clockTime,
	formatDuration,
	formatTokens,
	WORKED_TYPE,
	workedMessage,
	workingMessage,
} from "../src/extensions/working.ts";

test("durations and tokens read like Claude Code's", () => {
	assert.equal(formatDuration(27_400), "27s");
	assert.equal(formatDuration(65_000), "1m 5s");
	assert.equal(formatDuration(3_720_000), "1h 2m");
	assert.equal(formatTokens(800), "800");
	assert.equal(formatTokens(2_540), "2.5k");
	assert.equal(formatTokens(1_200_000), "1.2m");
});

test("the loader says Working, the time and the tokens; with no tokens yet it is the time alone", () => {
	assert.equal(workingMessage({ elapsedMs: 26_000, output: 1_700 }), "Working (26s · ↓ 1.7k tokens)");
	assert.equal(workingMessage({ elapsedMs: 3_000, output: 0 }), "Working (3s)");
});

test("the line at the end says how long the run took and when it ended", () => {
	assert.match(clockTime(new Date(2026, 9, 26, 14, 40).getTime()), /^2:40 p\.m\.$/);
	assert.match(clockTime(new Date(2026, 9, 26, 0, 5).getTime()), /^12:05 a\.m\.$/);
	assert.equal(workedMessage(18_000, new Date(2026, 9, 26, 9, 3).getTime()), "Worked for 18s · done 9:03 a.m.");
});

test("the end-of-run line is an entry: shown to the person, never sent to the model, never a new turn", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const renderers = new Map<string, unknown>();
	const sent: { customType: string; data: unknown }[] = [];
	const messages: unknown[] = [];
	working({
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
		registerEntryRenderer: (type: string, fn: unknown) => renderers.set(type, fn),
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => sent.push({ customType, data }),
		sendMessage: (m: unknown) => messages.push(m),
		sendUserMessage: (m: unknown) => messages.push(m),
	} as unknown as ExtensionAPI);
	assert.ok(renderers.has(WORKED_TYPE));
	const kept = { role: "user", content: "hi" };
	const hidden = { role: "custom", customType: WORKED_TYPE, content: "Worked for 9s" };
	const other = { role: "custom", customType: "something-else", content: "x" };
	const result = handlers.get("context")?.({ messages: [kept, hidden, other] }, {}) as { messages: unknown[] };
	assert.deepEqual(result.messages, [kept, other]);

	const shown: string[] = [];
	const ui = {
		setWorkingIndicator() {},
		setWorkingMessage: (m: string) => shown.push(m),
	};
	const ctx = { hasUI: true, ui };
	const realNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;
	try {
		handlers.get("agent_start")?.({}, ctx);
		now += 2_000;
		handlers.get("agent_end")?.({}, ctx);
		assert.equal(sent.length, 0, "a run of two seconds leaves no line");
		handlers.get("agent_start")?.({}, ctx);
		const delta = (text: string) =>
			handlers.get("message_update")?.(
				{
					message: { role: "assistant", usage: { output: 0 } },
					assistantMessageEvent: { type: "text_delta", delta: text },
				},
				ctx,
			);
		delta("x".repeat(4000));
		delta("y".repeat(4000));
		now += 1_000;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.match(shown.at(-1) ?? "", /↓ 2\.0k tokens/, "tokens are estimated while the provider reports none");
		now += 19_000;
		handlers.get("agent_end")?.({}, ctx);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.customType, WORKED_TYPE);
		assert.match((sent[0]?.data as { text: string } | undefined)?.text ?? "", /^Worked for 20s/);
		assert.equal(messages.length, 0, "a message here would start a turn nobody asked for");
	} finally {
		Date.now = realNow;
	}
});
