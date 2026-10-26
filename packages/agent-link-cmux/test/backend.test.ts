import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaneCommand } from "agent-link-core";
import { createCmuxBackend, gateCommand } from "../src/backend.ts";
import { fakeCli } from "./fake-cli.ts";

const CMD: PaneCommand = { argv: ["cat"], env: { AGENT_LINK_TOKEN: "secret" }, cwd: "/tmp" };
const PLACE = { workspace: "workspace:9", surface: "surface:1" };

function setup(responses: Record<string, string> = {}) {
	const fake = fakeCli("cmux", {
		"new-split.1": "OK surface:11 workspace:9\n",
		"new-split.2": "OK surface:12 workspace:9\n",
		"new-split.3": "OK surface:13 workspace:9\n",
		"new-split.4": "OK surface:14 workspace:9\n",
		...responses,
	});
	const launchDir = mkdtempSync(join(tmpdir(), "xi-cmux-launch-"));
	// The hub may have inherited a pane's identity; none of it may reach a cmux call.
	const env = { ...fake.env, CMUX_SURFACE_ID: "surface:999", CMUX_WORKSPACE_ID: "workspace:999" };
	return { fake, launchDir, backend: createCmuxBackend({ env, launchDir }) };
}

test("the first worker opens right of the caller, the next ones below the previous, titled, never focused", async () => {
	const { fake, backend, launchDir } = setup();
	assert.equal(await backend.open(CMD, { title: "Claude · a", place: PLACE }), "surface:11");
	assert.equal(await backend.open(CMD, { title: "Claude · b", place: PLACE }), "surface:12");
	assert.equal(await backend.open(CMD, { title: "Codex · c", place: PLACE }), "surface:13");
	const calls = fake.calls();
	const splits = calls.filter((c) => c[0] === "new-split");
	assert.deepEqual(
		splits.map((c) => c.slice(0, 8)),
		[
			["new-split", "right", "--workspace", "workspace:9", "--surface", "surface:1", "--focus", "false"],
			["new-split", "down", "--workspace", "workspace:9", "--surface", "surface:11", "--focus", "false"],
			["new-split", "down", "--workspace", "workspace:9", "--surface", "surface:12", "--focus", "false"],
		],
	);
	// The pane runs a gate that starts the launch script once the pane is accepted: no token on screen.
	const command = splits[0]?.[9] ?? "";
	const gate = command.match(/\/\S+?\.go\b/)?.[0] ?? "";
	assert.equal(command, gateCommand(gate));
	assert.doesNotMatch(command, /secret/);
	assert.match(readFileSync(gate, "utf8"), /AGENT_LINK_TOKEN=secret/);
	assert.equal(readdirSync(launchDir).filter((f) => f.endsWith(".go")).length, 3);
	assert.deepEqual(
		calls.filter((c) => c[0] === "rename-tab"),
		[
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:11", "--", "Claude · a"],
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:12", "--", "Claude · b"],
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:13", "--", "Codex · c"],
		],
	);
	// The exact ids: a bare "999" also turns up in the random gate file names now and then.
	assert.doesNotMatch(readFileSync(join(fake.dir, "log"), "utf8"), /(surface|workspace):999/);
});

test("a closed worker leaves the stack: the next one opens below the last still open, or right of the caller", async () => {
	const { fake, backend } = setup();
	await backend.open(CMD, { title: "a", place: PLACE });
	await backend.open(CMD, { title: "b", place: PLACE });
	await backend.close("surface:12");
	await backend.open(CMD, { title: "c", place: PLACE });
	await backend.close("surface:11");
	await backend.close("surface:13");
	await backend.open(CMD, { title: "d", place: PLACE });
	const splits = fake.calls().filter((c) => c[0] === "new-split");
	assert.deepEqual(
		splits.map((c) => [c[1], c[5]]),
		[
			["right", "surface:1"],
			["down", "surface:11"],
			["down", "surface:11"],
			["right", "surface:1"],
		],
	);
	assert.deepEqual(fake.calls().filter((c) => c[0] === "close-surface")[0], [
		"close-surface",
		"--workspace",
		"workspace:9",
		"--surface",
		"surface:12",
		"--force",
	]);
});

test("read, keys and paste name the surface; keys and paste are forced past cmux's dialog guard", async () => {
	const { fake, backend } = setup({ "read-screen": "line 1\nline 2\n" });
	await backend.open(CMD, { title: "a", place: PLACE });
	assert.equal(await backend.read("surface:11", 5), "line 1\nline 2\n");
	await backend.keys("surface:11", ["down", "enter"]);
	await backend.paste("surface:11", "--flag looking text\nsecond line");
	const calls = fake.calls().filter((c) => ["read-screen", "send-key", "send"].includes(c[0] ?? ""));
	const at = ["--workspace", "workspace:9", "--surface", "surface:11"];
	assert.deepEqual(calls, [
		["read-screen", ...at, "--lines", "5"],
		["send-key", "--force", ...at, "--", "down"],
		["send-key", "--force", ...at, "--", "enter"],
		["send", "--force", ...at, "--paste", "--", "--flag looking text\nsecond line"],
	]);
});

test("alive follows read-screen; closing a surface that is already gone is not an error", async () => {
	const { backend } = setup({
		"read-screen.err": "Error: not_found: Surface not found\n",
		"close-surface.err": "nope",
	});
	assert.equal(await backend.alive("surface:5"), false);
	await backend.close("surface:5");
	const live = setup({ "close-surface.err": "Error: something else" }).backend;
	assert.equal(await live.alive("surface:5"), true);
	await assert.rejects(live.close("surface:5"), /something else/);
});

test("a full split retries from the other panes of the same workspace, never another workspace or a tab", async () => {
	const { fake, backend } = setup({
		"new-split.2.err": "Error: no_space: No space for new pane\n",
		"new-split.3": "OK surface:12 workspace:9\n",
	});
	assert.equal(await backend.open(CMD, { title: "a", place: PLACE }), "surface:11");
	assert.equal(await backend.open(CMD, { title: "b", place: PLACE }), "surface:12");
	const calls = fake.calls();
	assert.deepEqual(
		calls.filter((c) => c[0] === "new-split").map((c) => [c[1], c[3], c[5]]),
		[
			["right", "workspace:9", "surface:1"],
			["down", "workspace:9", "surface:11"],
			["right", "workspace:9", "surface:1"],
		],
	);
	assert.equal(
		calls.some((c) => c[0] === "new-surface" || c[0] === "new-workspace"),
		false,
	);
});

test("when no pane of the workspace has room the open fails clearly and opens nothing elsewhere", async () => {
	const { fake, backend } = setup({ "new-split.1.err": "Error: no_space: No space for new pane\n" });
	await assert.rejects(backend.open(CMD, { title: "a", place: PLACE }), /no room for another agent pane/);
	assert.equal(
		fake.calls().some((c) => c[0] === "new-surface" || c[0] === "new-workspace"),
		false,
	);
});

test("after every open and close the workspace's splits are equalized, so the column shares its height", async () => {
	const { fake, backend } = setup();
	await backend.open(CMD, { title: "a", place: PLACE });
	await backend.open(CMD, { title: "b", place: PLACE });
	await backend.close("surface:11");
	const rpcs = fake.calls().filter((c) => c[0] === "rpc");
	assert.equal(rpcs.length, 3);
	assert.deepEqual(rpcs[0], ["rpc", "workspace.equalize_splits", JSON.stringify({ workspace_id: "workspace:9" })]);
});

test("closing a surface it did not open (a root's own terminal) finds its workspace in cmux's tree first", async () => {
	const { fake, backend } = setup({
		tree: JSON.stringify({
			windows: [
				{
					workspaces: [
						{ ref: "workspace:5", panes: [{ surface_refs: ["surface:50"], surface_ids: ["AB-CD"] }] },
						{ ref: "workspace:6", panes: [{ surface_refs: ["surface:60"], surface_ids: ["EF-01"] }] },
					],
				},
			],
		}),
	});
	await backend.close("EF-01");
	const close = fake.calls().find((c) => c[0] === "close-surface");
	assert.deepEqual(close, ["close-surface", "--workspace", "workspace:6", "--surface", "EF-01", "--force"]);
});

test("open without the caller's surface fails instead of guessing", async () => {
	const { backend } = setup();
	await assert.rejects(backend.open(CMD, { title: "a" }), /place.surface/);
});
