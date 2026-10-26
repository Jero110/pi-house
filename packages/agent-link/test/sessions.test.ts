import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hubPaths, Journal } from "agent-link-core";
import { type CliIo, main } from "../src/cli.ts";

test("sessions and transcript read the journal and the transcript with no hub running", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "al-sessions-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const file = join(home, "sid-1.jsonl");
	writeFileSync(
		file,
		[
			{ type: "user", sessionId: "sid-1", timestamp: "2026-10-23T10:00:00Z", message: { content: "fix the parser" } },
			{
				type: "assistant",
				timestamp: "2026-10-23T10:00:09Z",
				message: {
					id: "m",
					model: "x",
					content: [{ type: "text", text: "Half done: the lexer works, the parser does not." }],
				},
			},
		]
			.map((o) => JSON.stringify(o))
			.join("\n"),
	);
	new Journal(hubPaths(home).sessions).create({
		id: "20261023T100000Z-claude-2",
		name: "claude-2",
		parent: "p",
		parentName: "pihouse",
		root: "p",
		harness: "claude",
		model: null,
		cwd: "/w",
		task: "Task T1: fix the parser",
		state: "error",
		depth: 1,
		backend: "tmux",
		pane: "%7",
		sessionId: "sid-1",
		transcript: file,
		startedAt: "2026-10-23T10:00:00.000Z",
	});
	const lines: string[] = [];
	const io: CliIo = { env: { AGENT_LINK_HOME: home }, home, out: (l) => lines.push(l), err: (l) => lines.push(l) };
	assert.equal(await main(["sessions"], io), 0);
	assert.deepEqual(lines, [
		"2026-10-23 10:00:00 ·   claude-2 · claude · default · error · session sid-1 · tmux %7 · from pihouse",
	]);
	lines.length = 0;
	assert.equal(await main(["transcript", "claude-2"], io), 0);
	assert.equal(lines[0], `claude-2 · claude · error · session sid-1 · ${file}`);
	assert.ok(lines.includes("Half done: the lexer works, the parser does not."));
	lines.length = 0;
	assert.equal(await main(["transcript", "nobody"], io), 1);
	assert.match(lines[0] ?? "", /no agent "nobody"/);
});
