import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaneCommand } from "agent-link-core";
import { createTmuxBackend, gateCommand, tmuxKey } from "../src/backend.ts";
import { fakeCli } from "./fake-cli.ts";

const CMD: PaneCommand = { argv: ["cat"], env: { AGENT_LINK_TOKEN: "secret" }, cwd: "/tmp" };

function setup(responses: Record<string, string> = {}) {
	const fake = fakeCli("tmux", {
		"split-window.1": "%11\n",
		"split-window.2": "%12\n",
		"split-window.3": "%13\n",
		...responses,
	});
	const launchDir = mkdtempSync(join(tmpdir(), "xi-tmux-launch-"));
	return { fake, backend: createTmuxBackend({ env: fake.env, launchDir }) };
}

/** The calls without the layout ones (main-pane-width, select-layout), for tests about something else. */
const noLayout = (calls: string[][]) =>
	calls.filter((c) => !c.includes("select-layout") && !c.includes("main-pane-width"));

const opened = (calls: string[][]) =>
	calls.filter((c) => ["split-window", "new-session", "new-window"].includes(c[0] ?? "")).map((c) => c.slice(0, -1));

test("inside tmux: the first worker splits right of the caller, the next ones below the previous", async () => {
	const { fake, backend } = setup();
	const place = { tmuxPane: "%3" };
	assert.equal(await backend.open(CMD, { title: "Claude · a", place }), "%11");
	assert.equal(await backend.open(CMD, { title: "Pi · b", place }), "%12");
	const calls = noLayout(fake.calls());
	assert.deepEqual(opened(calls), [
		["split-window", "-d", "-h", "-t", "%3", "-P", "-F", "#{pane_id}"],
		["split-window", "-d", "-v", "-t", "%11", "-P", "-F", "#{pane_id}"],
	]);
	// The pane runs a gate that starts the launch script once the pane is accepted: no token in the command.
	const command = calls[0]?.at(-1) ?? "";
	const gate = command.match(/\/\S+?\.go\b/)?.[0] ?? "";
	assert.equal(command, gateCommand(gate));
	assert.doesNotMatch(command, /secret/);
	assert.match(readFileSync(gate, "utf8"), /AGENT_LINK_TOKEN=secret/);
	assert.deepEqual(calls.filter((c) => c[0] !== "split-window").slice(0, 3), [
		["set-option", "-p", "-t", "%11", "allow-set-title", "off"],
		["select-pane", "-t", "%11", "-T", "Claude · a"],
		["set-option", "-w", "-t", "%11", "pane-border-status", "top"],
	]);
});

test("outside tmux: the session agent-link is created once, detached, then workers stack below", async () => {
	const { fake, backend } = setup({ "has-session.err": "can't find session", "new-session": "%0\n" });
	assert.equal(await backend.open(CMD, { title: "a" }), "%0");
	assert.equal(await backend.open(CMD, { title: "b" }), "%11");
	assert.deepEqual(opened(fake.calls()), [
		["new-session", "-d", "-s", "agent-link", "-x", "200", "-y", "50", "-P", "-F", "#{pane_id}"],
		["split-window", "-d", "-v", "-t", "%0", "-P", "-F", "#{pane_id}"],
	]);
	await backend.close("%0");
	await backend.close("%11");
	const again = setup({ "new-window": "%7\n" });
	assert.equal(await again.backend.open(CMD, { title: "c" }), "%7");
	assert.deepEqual(opened(again.fake.calls()), [["new-window", "-d", "-t", "=agent-link:", "-P", "-F", "#{pane_id}"]]);
});

test("read joins wrapped lines, reaches into history and drops the blank rows below the cursor", async () => {
	const { fake, backend } = setup({ "capture-pane": "old\nprompt> hi\nanswer\n\n\n\n" });
	assert.equal(await backend.read("%4", 2), "prompt> hi\nanswer\n");
	assert.deepEqual(fake.calls()[0], ["capture-pane", "-p", "-J", "-t", "%4", "-S", "-2"]);
});

test("keys map to tmux names; unknown keys fail before anything is sent", async () => {
	const { fake, backend } = setup();
	await backend.keys("%4", ["down", "enter", "escape", "ctrl+c", "tab", "up"]);
	assert.deepEqual(
		fake.calls().map((c) => c[3]),
		["Down", "Enter", "Escape", "C-c", "Tab", "Up"],
	);
	await assert.rejects(backend.keys("%4", ["enter", "hyper+x"]), /unknown key/);
	assert.equal(fake.calls().length, 6);
	assert.equal(tmuxKey("shift+tab"), "BTab");
});

test("paste goes through a named buffer that paste-buffer deletes, text unchanged", async () => {
	const { fake, backend } = setup();
	const text = "line 'one' $HOME\nline two\n";
	await backend.paste("%4", text);
	const [load, paste] = fake.calls();
	const name = load?.[2] ?? "";
	assert.match(name, /^agent-link-[0-9a-f]+$/);
	assert.deepEqual(load, ["load-buffer", "-b", name, "-"]);
	assert.deepEqual(paste, ["paste-buffer", "-p", "-d", "-b", name, "-t", "%4"]);
	assert.equal(fake.stdin("load-buffer", 1), text);
});

test("alive only when tmux prints the pane's own id; closing a gone pane is not an error", async () => {
	// tmux printed an empty line and exited 0 for a pane that was killed.
	const gone = setup({ "display-message": "\n", "kill-pane.err": "can't find pane: %4" }).backend;
	assert.equal(await gone.alive("%4"), false);
	await gone.close("%4");
	const live = setup({ "display-message": "%4\n", "kill-pane.err": "server exited" }).backend;
	assert.equal(await live.alive("%4"), true);
	await assert.rejects(live.close("%4"), /server exited/);
});

test("serverArgs go before every command", async () => {
	const fake = fakeCli("tmux", { "display-message": "%4\n" }, 2);
	const backend = createTmuxBackend({ env: fake.env, serverArgs: ["-L", "al-test"] });
	assert.equal(await backend.alive("%4"), true);
	assert.deepEqual(fake.calls()[0]?.slice(0, 3), ["-L", "al-test", "display-message"]);
});

test("a place with tmuxSocket opens there, and every later call on that pane uses -S with its socket", async () => {
	const fake = fakeCli("tmux", { "split-window.1": "%3\n", "split-window.2": "%4\n", "display-message": "%3\n" }, 2);
	const backend = createTmuxBackend({ env: fake.env, serverArgs: ["-L", "other"] });
	const place = { tmuxPane: "%1", tmuxSocket: "/tmp/tmux-503/work" };
	const a = await backend.open(CMD, { title: "a", place });
	const b = await backend.open(CMD, { title: "b", place });
	assert.equal(a, "%3@/tmp/tmux-503/work");
	assert.equal(b, "%4@/tmp/tmux-503/work");
	await backend.read(a, 3);
	await backend.keys(a, ["enter"]);
	await backend.paste(a, "hi");
	assert.equal(await backend.alive(a), true);
	await backend.close(b);
	const calls = fake.calls();
	// serverArgs never apply to a pane with its own socket.
	assert.ok(calls.every((c) => c[0] === "-S" && c[1] === "/tmp/tmux-503/work"));
	const cmds = noLayout(calls).map((c) => c.slice(2));
	assert.deepEqual(cmds[0]?.slice(0, 5), ["split-window", "-d", "-h", "-t", "%1"]);
	assert.deepEqual(cmds[4]?.slice(0, 5), ["split-window", "-d", "-v", "-t", "%3"]);
	const rest = cmds.slice(8).map((c) => c.filter((x) => !x.startsWith("agent-link-")));
	assert.deepEqual(rest, [
		["capture-pane", "-p", "-J", "-t", "%3", "-S", "-3"],
		["send-keys", "-t", "%3", "Enter"],
		["load-buffer", "-b", "-"],
		["paste-buffer", "-p", "-d", "-b", "-t", "%3"],
		["display-message", "-p", "-t", "%3", "#{pane_id}"],
		["display-message", "-p", "-t", "%4", "#{window_id}"],
		["kill-pane", "-t", "%4"],
	]);
});

test("the same pane id on two servers stays two panes, each stacked on its own server", async () => {
	// Two tmux servers both gave their first pane %0.
	const fake = fakeCli("tmux", { "split-window": "%5\n" }, 0);
	const backend = createTmuxBackend({ env: fake.env });
	const onA = await backend.open(CMD, { title: "a", place: { tmuxPane: "%0", tmuxSocket: "/s/a" } });
	const onB = await backend.open(CMD, { title: "b", place: { tmuxPane: "%0", tmuxSocket: "/s/b" } });
	const plain = await backend.open(CMD, { title: "c", place: { tmuxPane: "%0" } });
	assert.deepEqual([onA, onB, plain], ["%5@/s/a", "%5@/s/b", "%5"]);
	const splits = fake.calls().filter((c) => c.includes("split-window"));
	assert.deepEqual(
		splits.map((c) => c.slice(0, c.indexOf("-P"))),
		[
			["-S", "/s/a", "split-window", "-d", "-h", "-t", "%0"],
			["-S", "/s/b", "split-window", "-d", "-h", "-t", "%0"],
			["split-window", "-d", "-h", "-t", "%0"],
		],
	);
	await assert.rejects(backend.read("nonsense"), /bad pane ref/);
});

test("a small split stays in the caller's window: it is never killed or moved to another window", async () => {
	const { fake, backend } = setup({ "display-message": "10 5\n" });
	const place = { tmuxPane: "%3" };
	assert.equal(await backend.open(CMD, { title: "a", place }), "%11");
	assert.equal(await backend.open(CMD, { title: "b", place }), "%12");
	const calls = fake.calls();
	assert.equal(
		calls.some((c) => c[0] === "kill-pane" || c[0] === "new-window"),
		false,
	);
	assert.deepEqual(
		calls.filter((c) => c[0] === "split-window").map((c) => c.slice(0, 5)),
		[
			["split-window", "-d", "-h", "-t", "%3"],
			["split-window", "-d", "-v", "-t", "%11"],
		],
	);
});

test("the caller's window keeps one column right of the first pane: main-vertical after every split and close", async () => {
	const { fake, backend } = setup({ "display-message.1": "@7\n" });
	const place = { tmuxPane: "%3" };
	await backend.open(CMD, { title: "a", place });
	await backend.open(CMD, { title: "b", place });
	await backend.close("%11");
	const layout = fake.calls().filter((c) => c.includes("select-layout") || c.includes("main-pane-width"));
	assert.deepEqual(layout.slice(0, 2), [
		["set-option", "-w", "-t", "%11", "main-pane-width", "50%"],
		["select-layout", "-t", "%11", "main-vertical"],
	]);
	assert.deepEqual(layout.at(-1), ["select-layout", "-t", "@7", "main-vertical"], "after the close, on its window");
	assert.equal(layout.length, 6);
});
