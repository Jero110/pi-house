import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventLog } from "../src/log.ts";

test("event log: agents, messages with queued, delivered and turn end times, events; kept across runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "xl-log-"));
	try {
		const path = join(dir, "events.sqlite");
		let clock = 1000;
		const log = new EventLog(path, { now: () => clock });
		log.agent({
			name: "w",
			parent: "r",
			harness: "pi",
			model: null,
			cwd: "/",
			state: "starting",
			pull: false,
			depth: 1,
			startedAt: 5,
		});
		log.agentPane("w", "cmux", "surface:3");
		log.messageQueued({ id: "m1", from: "agent-link", to: "w", length: 42, kind: "brief" });
		clock = 1100;
		log.messageDelivered("m1");
		clock = 1500;
		log.messageTurnEnd("m1");
		log.messageDelivered("m1");
		log.agentState("w", "exited");
		log.event("w", "tool-call", { title: "bash" });
		assert.deepEqual(
			log.messages().map(({ run: _, ...m }) => m),
			[
				{
					id: "m1",
					sender: "agent-link",
					recipient: "w",
					length: 42,
					kind: "brief",
					queued_at: 1000,
					delivered_at: 1100,
					turn_end_at: 1500,
				},
			],
		);
		const [a] = log.agents();
		assert.equal(a?.state, "exited");
		assert.equal(a?.ended_at, 1500);
		assert.deepEqual(
			log.events().map((e) => [e.agent, e.kind, e.data]),
			[["w", "tool-call", '{"title":"bash"}']],
		);
		const run = log.run;
		log.close();

		const again = new EventLog(path);
		assert.notEqual(again.run, run);
		assert.equal(again.messages().length, 0);
		assert.equal(again.messages({ allRuns: true }).length, 1);
		assert.equal(again.events({ allRuns: true, agent: "w" }).length, 1);
		again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
