import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { watchStartupDialogs } from "../src/hub/startup.ts";
import { loadProfiles } from "../src/profiles.ts";
import { FakeBackend } from "./fakes/backend.ts";
import { pullRoot, testHub, waitFor } from "./fakes/hub.ts";

const CLAUDE = loadProfiles().get("claude")?.dialogs ?? [];
// Read with cmux read-screen from a real Claude Code 2.1.309 pane.
const TRUST = readFileSync(new URL("./fixtures/claude-trust-2.1.309.txt", import.meta.url), "utf8");
const TELEMETRY = " Do you want to enable telemetry?\n\n ❯ 1. Yes\n   2. No\n\n Enter to confirm · Esc to cancel\n";
const WORKING = "╭───╮\n│ > │\n╰───╯\n  ? for shortcuts\n";

test("a known dialog is answered once with the profile's keys; the watch ends once started and clear", async () => {
	const b = new FakeBackend();
	const ref = await b.open({ argv: ["x"], env: {}, cwd: "/" }, { title: "t" });
	// The pane has not redrawn yet on the read after the keys: still the trust dialog.
	b.show(ref, TRUST, TRUST, WORKING);
	let started = false;
	b.onKeys = () => {
		started = true;
	};
	const answered = await watchStartupDialogs(b, ref, CLAUDE, { pollMs: 1, timeoutMs: 1000, started: () => started });
	assert.deepEqual(answered, ["trust"]);
	assert.deepEqual(b.keysSent(), [["down", "enter"]]);
});

test("an unknown dialog is reported once and watched past the timeout until it leaves the screen", async () => {
	const b = new FakeBackend();
	const ref = await b.open({ argv: ["x"], env: {}, cwd: "/" }, { title: "t" });
	b.show(ref, TELEMETRY);
	const seen: string[] = [];
	const watch = watchStartupDialogs(b, ref, CLAUDE, {
		pollMs: 1,
		timeoutMs: 20,
		started: () => true,
		onUnknown: (d) => seen.push(`unknown ${d.options.join("/")}`),
		onAnswered: () => seen.push("answered"),
	});
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(seen, ["unknown Yes/No"], "still watching after timeoutMs, reported once");
	b.show(ref, WORKING);
	assert.deepEqual(await watch, []);
	assert.deepEqual(seen, ["unknown Yes/No", "answered"]);
	assert.deepEqual(b.keysSent(), [], "no key is sent to a dialog the profile does not know");
});

test("the watch stops when the agent closes", async () => {
	const b = new FakeBackend();
	const ref = await b.open({ argv: ["x"], env: {}, cwd: "/" }, { title: "t" });
	b.show(ref, TELEMETRY);
	let stopped = false;
	const watch = watchStartupDialogs(b, ref, CLAUDE, { pollMs: 1, timeoutMs: 10_000, stopped: () => stopped });
	await new Promise((r) => setTimeout(r, 10));
	stopped = true;
	assert.deepEqual(await watch, []);
});

test("hub: an unknown startup dialog puts the agent in asking, the parent gets text and options and answers with send", async () => {
	const t = await testHub();
	try {
		t.kit.onCreate = (a) => a.holdConnect();
		t.backend.nextScreens = [TELEMETRY];
		const root = await pullRoot(t.client);
		const res = await t.client.spawn({ from: root, harness: "claude", task: "t", backend: "cmux" });
		assert.ok("name" in res);
		const agent = () => t.running.hub.registry.get(res.name);
		await waitFor(() => agent()?.record.state === "asking", "asking");
		const notice = (await t.client.inbox(root)).messages;
		assert.equal(notice.length, 1);
		assert.equal(
			notice[0]?.text,
			[
				"[agent-link] claude (claude · claude-haiku-5-5) is stuck on a dialog in its pane that agent-link does not know:",
				"",
				"Do you want to enable telemetry? ❯ 1. Yes 2. No Enter to confirm · Esc to cancel",
				"",
				"Options:",
				"1. Yes",
				"2. No",
				"",
				'While it waits on this dialog, a send to claude is read as your choice, not as a message: send({ to: "claude", message: "<option number or text>" }). If the choice belongs to the user (trusting a folder, accepting a risk), ask the user first.',
			].join("\n"),
		);

		const wrong = await t.client.send({ from: root, to: res.name, message: "7" });
		assert.equal(wrong.ok, false);
		assert.match(
			wrong.error ?? "",
			/^not answered: there is no option "7", so no keys were sent\.\n\n.*Options:\n1\. Yes\n2\. No$/s,
		);

		t.backend.onKeys = (ref) => t.backend.show(ref, WORKING);
		const pick = await t.client.send({ from: root, to: res.name, message: "No" });
		assert.deepEqual(
			{ ok: pick.ok, answered: pick.answered, queued: pick.queued },
			{ ok: true, answered: "2. No", queued: false },
		);
		assert.deepEqual(t.backend.keysSent(), [["down", "enter"]]);
		await waitFor(() => agent()?.record.state === "working", "back to working once the dialog left");
		assert.equal(agent()?.dialog, undefined);

		// Out of the dialog, a send is a normal message again: it waits behind the brief.
		const normal = await t.client.send({ from: root, to: res.name, message: "No" });
		assert.equal(normal.answered, undefined);
		assert.equal(agent()?.queue.length, 2);
		const fake = t.kit.byName(res.name);
		fake?.connectNow();
		await waitFor(() => fake?.prompts.length === 1, "brief after connect");
		assert.equal(fake?.prompts[0]?.from, "agent-link");
		const events = t.running.hub.log.events({ agent: res.name }).map((e) => e.kind);
		assert.ok(events.includes("dialog-unknown") && events.includes("dialog-choice") && events.includes("dialog-left"));
	} finally {
		await t.stop();
	}
});

test("hub: a known startup dialog is answered from the profile while connect runs", async () => {
	const t = await testHub();
	try {
		t.kit.onCreate = (a) => a.holdConnect();
		t.backend.nextScreens = [TRUST, TRUST, WORKING];
		const root = await pullRoot(t.client);
		const res = await t.client.spawn({ from: root, harness: "claude", task: "t", backend: "cmux" });
		assert.ok("name" in res);
		await waitFor(() => t.backend.keysSent().length === 1, "keys");
		assert.deepEqual(t.backend.keysSent(), [["down", "enter"]]);
		t.kit.byName(res.name)?.connectNow();
		await waitFor(() => t.kit.byName(res.name)?.prompts.length === 1, "brief");
		assert.deepEqual((await t.client.inbox(root)).messages, [], "the parent is not bothered with known dialogs");
	} finally {
		await t.stop();
	}
});
