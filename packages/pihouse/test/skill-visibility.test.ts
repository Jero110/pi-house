import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillVisibility, { SKILL_READ_TYPE } from "../src/extensions/skill-visibility.ts";

test("successful skill reads produce one UI-only entry per operation, not per name", () => {
	const cwd = mkdtempSync(join(tmpdir(), "skill-visibility-"));
	try {
		mkdirSync(join(cwd, "skills", "planner"), { recursive: true });
		writeFileSync(
			join(cwd, "skills", "planner", "SKILL.md"),
			"---\nname: planner\ndescription: plan\n---\nInstructions",
		);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const entries: { type: string; data: unknown }[] = [];
		const messages: unknown[] = [];
		const renderers = new Map<string, unknown>();
		skillVisibility({
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
			registerEntryRenderer: (name: string, fn: unknown) => renderers.set(name, fn),
			appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
			sendMessage: (message: unknown) => messages.push(message),
			sendUserMessage: (message: unknown) => messages.push(message),
		} as unknown as ExtensionAPI);
		const handle = handlers.get("tool_result");
		assert.ok(handle);
		const ctx = { cwd, hasUI: true };
		const event = {
			toolName: "read",
			toolCallId: "one",
			input: { path: "skills/planner/SKILL.md" },
			isError: false,
			content: [{ type: "text", text: "---\nname: planner\n---\nInstructions" }],
		};
		assert.equal(handle(event, ctx), undefined);
		handle(event, ctx);
		handle({ ...event, toolCallId: "two" }, ctx);
		handle({ ...event, toolCallId: "failed", isError: true }, ctx);
		handle({ ...event, toolCallId: "missing", input: { path: "skills/missing/SKILL.md" } }, ctx);
		handle({ ...event, toolCallId: "mention", toolName: "bash" }, ctx);
		handle({ ...event, toolCallId: "ordinary", input: { path: "skills/planner/other.md" } }, ctx);
		assert.deepEqual(
			entries.map((e) => e.type),
			[SKILL_READ_TYPE, SKILL_READ_TYPE],
		);
		assert.deepEqual(
			entries.map((e) => e.data),
			[
				{ name: "planner", toolCallId: "one" },
				{ name: "planner", toolCallId: "two" },
			],
		);
		const render = renderers.get(SKILL_READ_TYPE) as (
			entry: unknown,
			options: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		assert.ok(render);
		assert.match(
			render({ data: { name: "planner" } }, {}, { fg: (_color: string, text: string) => text })
				.render(80)
				.join(""),
			/Read skill: planner/,
		);
		assert.deepEqual(messages, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
