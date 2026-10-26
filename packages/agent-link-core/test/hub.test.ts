import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHubClient } from "../src/client.ts";
import { placeOf } from "../src/hub/hub.ts";
import { hubPaths } from "../src/paths.ts";
import { IDENTITY_ENV, READ_DIRS_ENV, readDirsFromEnv } from "../src/types.ts";
import { echoResponder } from "./fakes/adapter.ts";
import { fakeProfiles, pullRoot, spawned, type TestHub, testHub, waitFor } from "./fakes/hub.ts";

async function withHub(fn: (t: TestHub) => Promise<void>, opts: Parameters<typeof testHub>[0] = {}): Promise<void> {
	const t = await testHub(opts);
	try {
		await fn(t);
	} finally {
		await t.stop();
	}
}

const inboxTexts = async (t: TestHub, name: string) => (await t.client.inbox(name)).messages.map((m) => m.text);
const state = (t: TestHub, name: string) => t.running.hub.registry.get(name)?.record.state;

test("spawn: unique names, run dir 0700, launch, pane next to the caller, connect, brief first", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const place = { workspace: "workspace:1", surface: "surface:7" };
		const a = await t.client.spawn({ from: root, harness: "claude", task: "fix the bug", backend: "cmux", place });
		const b = await t.client.spawn({ from: root, harness: "claude", task: "review", backend: "cmux" });
		const c = await t.client.spawn({ from: root, harness: "codex", task: "x", name: "Auth Worker", backend: "cmux" });
		assert.deepEqual([a, b, c], [{ name: "claude" }, { name: "claude-2" }, { name: "auth-worker" }]);

		const fake = await waitFor(() => t.kit.byName("claude"), "adapter");
		assert.ok(fake.spec);
		const runDir = join(hubPaths(t.home).run, "claude");
		assert.equal(fake.spec.runDir, runDir);
		assert.equal(statSync(runDir).mode & 0o777, 0o700);
		assert.equal(fake.spec.env[IDENTITY_ENV.agent], "claude");
		assert.equal(fake.spec.env[IDENTITY_ENV.hub], t.running.socket);
		assert.equal(fake.spec.env[IDENTITY_ENV.token], t.running.token);
		assert.equal(fake.spec.env[IDENTITY_ENV.depth], "1");
		assert.equal(fake.spec.env[IDENTITY_ENV.home], t.home, "a worker finds the hub's profiles and journal");
		assert.equal(fake.spec.model, "claude-haiku-5-5", "profile default model");
		assert.deepEqual(fake.spec.mcp, { command: "agent-link-cmux", args: ["mcp"] });

		const open = t.backend.opened()[0];
		assert.deepEqual(open?.place, place);
		assert.equal(open?.title, "claude · Claude");
		assert.deepEqual(open?.cmd.argv, ["fake-harness", "--name", "claude"]);

		await waitFor(() => fake.prompts.length === 1, "brief prompt");
		assert.deepEqual(fake.calls.slice(0, 3), ["launch", "connect", "prompt"]);
		assert.equal(fake.pane?.ref, open?.ref);
		const brief = fake.prompts[0];
		assert.equal(brief?.from, "agent-link");
		assert.equal(brief?.text, "fix the bug", "the task alone, as a person would write it");
		assert.equal(state(t, "claude"), "working");
	}));

test("spawn: a profile's env reaches the harness, but cannot replace the identity", () =>
	withHub(
		async (t) => {
			const root = await pullRoot(t.client);
			await t.client.spawn({ from: root, harness: "pihouse", task: "x", backend: "cmux" });
			const fake = await waitFor(() => t.kit.byName("pihouse"), "adapter");
			assert.equal(fake.spec?.env.PIHOUSE_HOME, "/sandbox/pihouse");
			assert.equal(fake.spec?.env[IDENTITY_ENV.agent], "pihouse");
		},
		{
			profiles: fakeProfiles([
				{
					harness: "pihouse",
					adapter: "pi",
					label: "pihouse",
					defaultModel: null,
					dialogs: [],
					env: { PIHOUSE_HOME: "/sandbox/pihouse", [IDENTITY_ENV.agent]: "spoofed" },
				},
			]),
		},
	));

test("spawn: the caller's read folders reach the worker's spec and env, so its own workers get them too", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		await t.client.spawn({ from: root, harness: "opencode", task: "x", backend: "cmux", read: ["/skills", "/refs"] });
		const fake = await waitFor(() => t.kit.byName("opencode"), "adapter");
		assert.deepEqual(fake.spec?.readDirs, ["/skills", "/refs"]);
		assert.equal(fake.spec?.env[READ_DIRS_ENV], "/skills:/refs");
		assert.deepEqual(readDirsFromEnv({ [READ_DIRS_ENV]: "/skills::/refs" }), ["/skills", "/refs"]);
	}));

test("handoff: once the new agent runs and the caller's turn ends, the caller closes alone and its tree goes on", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const planner = await spawned(t, root, "pi", "planner");
		const p = await waitFor(() => t.kit.byName(planner), "planner adapter");
		await waitFor(() => p.inTurn, "planner turn");
		const res = await t.client.spawn({
			from: planner,
			harness: "claude",
			task: "run the plan",
			name: "executor",
			backend: "cmux",
			handoff: true,
		});
		assert.deepEqual(res, { name: "executor" });
		const e = await waitFor(() => t.kit.byName("executor"), "executor adapter");
		await waitFor(() => e.inTurn, "executor brief turn");
		assert.equal(state(t, planner), "working", "the planner's own turn is not cut short");

		p.finish("handed off to executor");
		await waitFor(() => state(t, planner) === "exited", "planner closed");
		assert.ok(t.backend.closed.has(p.pane?.ref ?? "?"), "the planner's pane closed");
		assert.equal(state(t, "executor"), "working", "the executor goes on");
		const w = await t.client.spawn({ from: "executor", harness: "pi", task: "t1", name: "t1", backend: "cmux" });
		assert.deepEqual(w, { name: "t1" }, "and still spawns its workers");
		e.finish("done");
		await waitFor(() => state(t, "executor") === "done", "executor done");
	}));

test("handoff from a root closes the root's own terminal, named by its registered place", () =>
	withHub(async (t) => {
		const reg = await t.client.register({
			harness: "codex",
			cwd: tmpdir(),
			pull: true,
			backend: "cmux",
			place: { surface: "surface:42" },
		});
		assert.ok("name" in reg);
		if (!("name" in reg)) return;
		await t.client.spawn({
			from: reg.name,
			harness: "claude",
			task: "run the plan",
			name: "executor",
			backend: "cmux",
			handoff: true,
		});
		await waitFor(() => state(t, reg.name) === "exited", "root closed once the executor connected");
		assert.ok(t.backend.closed.has("surface:42"));
		assert.notEqual(state(t, "executor"), "exited");
	}));

test("without handoff a root's terminal is never closed", () =>
	withHub(async (t) => {
		const reg = await t.client.register({
			harness: "codex",
			cwd: tmpdir(),
			pull: true,
			backend: "cmux",
			place: { surface: "surface:43" },
		});
		if (!("name" in reg)) return;
		await t.client.spawn({ from: reg.name, harness: "claude", task: "x", backend: "cmux" });
		await waitFor(() => t.kit.byName("claude")?.inTurn, "worker turn");
		await t.client.cancel({ from: reg.name, name: "claude" });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(t.backend.closed.has("surface:43"), false);
		assert.notEqual(state(t, reg.name), "exited");
	}));

test("spawn errors say what exists: unknown harness, caller, backend; a failed pane closes the adapter", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const bad = await t.client.spawn({ from: root, harness: "nope", task: "x", backend: "cmux" });
		assert.ok("error" in bad && /unknown harness "nope". Harnesses: claude, codex, opencode, pi/.test(bad.error));
		const noBackend = await t.client.spawn({ from: root, harness: "pi", task: "x", backend: "tmux" });
		assert.ok("error" in noBackend && /no "tmux" pane backend. Backends: cmux/.test(noBackend.error));
		const noCaller = await t.client.spawn({ from: "ghost", harness: "pi", task: "x", backend: "cmux" });
		assert.ok("error" in noCaller && /unknown agent "ghost"/.test(noCaller.error));

		t.backend.openError = new Error("cmux is not running");
		const failed = await t.client.spawn({ from: root, harness: "pi", task: "x", backend: "cmux" });
		assert.ok("error" in failed && /could not start pi: cmux is not running/.test(failed.error));
		const fake = t.kit.byName("pi");
		assert.ok(fake?.calls.includes("close"));
		assert.equal(existsSync(join(hubPaths(t.home).run, "pi")), false, "run dir removed");
		assert.equal(state(t, "pi"), "exited");
	}));

test("connect failure: the parent hears the agent failed to start, and it closes", () =>
	withHub(async (t) => {
		t.kit.onCreate = (a) => a.holdConnect();
		const root = await pullRoot(t.client);
		const name = await spawned(t, root, "opencode");
		const fake = await waitFor(() => t.kit.byName(name), "adapter");
		fake.connectFail("server did not answer");
		await waitFor(() => state(t, name) === "exited", "exited");
		const texts = await inboxTexts(t, root);
		assert.equal(texts.length, 1);
		assert.match(
			texts[0] ?? "",
			/opencode \(opencode · opencode\/glm-5.3-flash-free\) failed to start: server did not answer/,
		);
		assert.equal(t.backend.closed.size, 1, "pane closed");
	}));

test("queue: one turn per message, FIFO, prompt only while idle and never twice at once", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		const s1 = await t.client.send({ from: root, to: w, message: "one" });
		const s2 = await t.client.send({ from: root, to: w, message: "two" });
		assert.equal(s1.queued, true);
		assert.equal(s2.queued, true);
		assert.equal(fake.prompts.length, 1, "nothing handed while the brief turn runs");

		// The user typed in the pane: the harness is busy though prompt() is not running.
		fake.busy = true;
		fake.finish("brief done");
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(fake.prompts.length, 1, "not idle: wait");
		fake.busy = false;
		await waitFor(() => fake.prompts.length === 2, "second prompt after idle");
		assert.equal(fake.prompts[1]?.text, "one", "a parent's message reads like its user's");
		assert.equal(fake.prompts[1]?.id, s1.id);
		fake.finish("r1");
		await waitFor(() => fake.prompts.length === 3, "third prompt");
		assert.equal(fake.prompts[2]?.text, "two");
		fake.finish("r2");
		await waitFor(() => state(t, w) === "done", "done");
		assert.equal(fake.maxConcurrent, 1);
		const results = await inboxTexts(t, root);
		assert.deepEqual(
			results.map((r) => r.split("\n\n")[1]),
			["brief done", "r1", "r2"],
			"each message got its own result, in order",
		);
		assert.match(results[0] ?? "", /^\[agent-link\] claude \(claude · claude-haiku-5-5\) finished:\n\nbrief done$/);
	}));

test("send is delivered at once to an idle agent (queued: false)", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		fake.finish("ok");
		await waitFor(() => state(t, w) === "done", "done");
		const res = await t.client.send({ from: root, to: w, message: "now" });
		assert.equal(res.ok, true);
		assert.equal(res.queued, false);
		assert.equal(state(t, w), "working");
	}));

test("result text routing reaches the parent through inbox in order, reply text replaces the last text", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		await t.client.reply({ from: w, result: "explicit" });
		fake.finish("chatter");
		await waitFor(() => state(t, w) === "done", "done");
		await t.client.send({ from: root, to: w, message: "again" });
		await waitFor(() => fake.inTurn, "second turn");
		fake.emit({ kind: "agent_message", text: "streamed" });
		fake.finish("");
		await waitFor(() => state(t, w) === "done", "done again");
		const texts = await inboxTexts(t, root);
		assert.deepEqual(
			texts.map((x) => x.split("\n\n")[1]),
			["explicit", "streamed"],
		);
		const reply = await t.client.reply({ from: root, result: "x" });
		assert.equal(reply.ok, false);
		assert.match(reply.error ?? "", /root agent/);
	}));

test("asking: a send to the parent mid-turn holds that turn end; the turn after the answer is the result", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		const ask = await t.client.send({ from: w, to: root, message: "which port?" });
		assert.equal(ask.ok, true);
		assert.equal(state(t, w), "asking");
		fake.finish("I asked codex which port; waiting for the answer");
		await waitFor(() => !fake.inTurn, "turn over");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(state(t, w), "asking", "held: stays asking");
		assert.deepEqual(await inboxTexts(t, root), [`[agent-link] ${w}: which port?`], "only the question, once");

		await t.client.send({ from: root, to: w, message: "8080" });
		await waitFor(() => fake.inTurn, "answer turn");
		assert.equal(state(t, w), "working");
		fake.finish("used 8080");
		await waitFor(() => state(t, w) === "done", "done");
		const texts = await inboxTexts(t, root);
		assert.equal(texts.length, 1);
		assert.match(texts[0] ?? "", /finished:\n\nused 8080$/);
	}));

test("asking: a worker that exits while its turn end is held still hands that text to the parent", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		await t.client.send({ from: w, to: root, message: "question" });
		fake.finish("partial findings");
		await waitFor(() => !fake.inTurn, "turn over");
		await inboxTexts(t, root);
		fake.emit({ kind: "exited", code: 1 });
		await waitFor(() => state(t, w) === "exited", "exited");
		const texts = await inboxTexts(t, root);
		assert.equal(texts.length, 1);
		assert.match(texts[0] ?? "", /exited \(code 1\)\. Its last answer:\n\npartial findings$/);
	}));

test("dedupe: a repeated message id returns the first result with duplicate: true and is queued once", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief turn");
		const first = await t.client.send({ from: root, to: w, message: "hello", id: "m-1" });
		const again = await t.client.send({ from: root, to: w, message: "hello", id: "m-1" });
		assert.deepEqual(again, { ...first, duplicate: true });
		const box = t.running.hub.registry.get(w);
		assert.equal(box?.queue.length, 1);
	}));

test("cancel: children first, then adapter cancel and close, pane close, exited; only an agent above may", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const lead = await spawned(t, root, "claude", "lead");
		const leadFake = await waitFor(() => t.kit.byName(lead), "lead adapter");
		await waitFor(() => leadFake.inTurn, "lead brief");
		const sub = await t.client.spawn({ from: lead, harness: "pi", task: "sub task", backend: "cmux" });
		assert.ok("name" in sub);
		const subFake = await waitFor(() => t.kit.byName(sub.name), "sub adapter");
		await waitFor(() => subFake.inTurn, "sub brief");
		assert.equal(subFake.spec?.env[IDENTITY_ENV.depth], "2", "depth = parent depth + 1");

		const denied = await t.client.cancel({ from: sub.name, name: lead });
		assert.match(denied.error ?? "", /only its parent/);

		const order: string[] = [];
		const track = (name: string, f: typeof leadFake) => {
			const { cancel, close } = f;
			f.cancel = async () => {
				order.push(`${name}.cancel`);
				await cancel.call(f);
			};
			f.close = async () => {
				order.push(`${name}.close`);
				await close.call(f);
			};
		};
		track("lead", leadFake);
		track("sub", subFake);
		const { close } = t.backend;
		t.backend.close = async (ref) => {
			order.push(`pane ${ref}`);
			await close.call(t.backend, ref);
		};
		assert.deepEqual(await t.client.cancel({ from: root, name: lead }), { ok: true });
		const [leadPane, subPane] = t.backend.opened().map((o) => o.ref);
		assert.deepEqual(order, [
			"sub.cancel",
			"sub.close",
			`pane ${subPane}`,
			"lead.cancel",
			"lead.close",
			`pane ${leadPane}`,
		]);
		assert.equal(state(t, lead), "exited");
		assert.equal(state(t, sub.name), "exited");
		assert.equal(existsSync(join(hubPaths(t.home).run, lead)), false);
		assert.deepEqual(await inboxTexts(t, root), [], "a cancelled turn is no result");
		const late = await t.client.send({ from: root, to: lead, message: "x" });
		assert.match(late.error ?? "", /has exited/);
	}));

test("root exit closes its tree: a pull root whose process is gone", () =>
	withHub(async (t) => {
		const child = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
		try {
			const res = await t.client.register({ harness: "codex", cwd: t.home, pull: true, pid: child.pid });
			assert.ok("name" in res);
			const w = await spawned(t, res.name, "pi");
			const fake = await waitFor(() => t.kit.byName(w), "adapter");
			await waitFor(() => fake.inTurn, "brief");
			child.kill("SIGKILL");
			await waitFor(() => state(t, res.name) === "exited" && state(t, w) === "exited", "tree exited", 3000);
			assert.ok(fake.calls.includes("close"));
			assert.equal(t.backend.closed.size, 1);
		} finally {
			child.kill("SIGKILL");
		}
	}));

test("exited update: the parent hears it, the pane closes, the agent's own tree closes", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root, "claude", "w");
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		const sub = await t.client.spawn({ from: w, harness: "pi", task: "t", backend: "cmux" });
		assert.ok("name" in sub);
		await waitFor(() => t.kit.byName(sub.name)?.inTurn, "sub brief");
		fake.emit({ kind: "exited", detail: "pane closed" });
		await waitFor(() => state(t, w) === "exited" && state(t, sub.name) === "exited", "both exited");
		const texts = await inboxTexts(t, root);
		assert.deepEqual(texts, ["[agent-link] w (claude · claude-haiku-5-5) exited (pane closed)."]);
		assert.equal(t.backend.closed.size, 2);
		// Updates after exit are ignored, never thrown.
		fake.emit({ kind: "turn_end", stopReason: "end_turn", text: "late" });
		fake.emit({ kind: "state", state: "busy" });
		assert.equal(state(t, w), "exited");
		assert.ok(t.running.hub.log.events({ agent: w }).some((e) => e.kind === "update-turn_end"));
	}));

test("turn_end update (a turn the user typed) is a result; one during a prompt is ignored", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		fake.emit({ kind: "turn_end", stopReason: "end_turn", text: "not counted" });
		fake.finish("brief result");
		await waitFor(() => state(t, w) === "done", "done");
		fake.emit({ kind: "state", state: "busy" });
		assert.equal(state(t, w), "working");
		fake.emit({ kind: "turn_end", stopReason: "error", text: "typed turn failed" });
		assert.equal(state(t, w), "error");
		const texts = await inboxTexts(t, root);
		assert.equal(texts.length, 2);
		assert.match(texts[1] ?? "", /failed:\n\ntyped turn failed$/);
		// A duplicate turn end with no turn in between is rejected by the state table and logged.
		fake.emit({ kind: "turn_end", stopReason: "end_turn", text: "dup" });
		assert.equal((await inboxTexts(t, root)).length, 0);
		assert.ok(t.running.hub.log.events({ agent: w }).some((e) => e.kind === "ignored-transition"));
	}));

test("state asking update tells the parent what the worker waits on, once", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		fake.emit({ kind: "state", state: "asking", detail: "permission to run rm -rf build" });
		fake.emit({ kind: "state", state: "asking", detail: "permission to run rm -rf build" });
		assert.equal(state(t, w), "asking");
		const texts = await inboxTexts(t, root);
		assert.deepEqual(texts, [
			"[agent-link] claude (claude · claude-haiku-5-5) is waiting in its pane: permission to run rm -rf build. It goes on once someone answers there; tell the user if only they can.",
		]);
		fake.emit({ kind: "state", state: "busy" });
		assert.equal(state(t, w), "working");
	}));

test("permit: the parent hears the ask with its options and answers it through the adapter, at any time", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		const ask = {
			kind: "permission" as const,
			questions: [{ question: "external_directory: /p/docs/*", options: ["Allow once", "Allow always", "Reject"] }],
		};
		fake.emit({ kind: "state", state: "asking", detail: "external_directory: /p/docs/*", ask });
		assert.equal(state(t, w), "asking");
		const texts = await inboxTexts(t, root);
		assert.equal(texts.length, 1);
		assert.match(
			texts[0] ?? "",
			/is waiting for your answer to a permission:\n\nexternal_directory: \/p\/docs\/\*\n {2}1\. Allow once\n {2}2\. Allow always\n {2}3\. Reject/,
		);
		assert.match(texts[0] ?? "", /permit\(\{ to: "claude", choice:/);

		// Only the parent answers; an empty choice is refused before the adapter sees it.
		assert.match((await t.client.permit({ from: "nobody", to: w, choice: "1" })).error ?? "", /parent/);
		assert.match((await t.client.permit({ from: root, to: w, choice: " " })).error ?? "", /empty/);
		fake.answerResult = { answered: "Allow once" };
		assert.deepEqual(await t.client.permit({ from: root, to: w, choice: "1" }), { ok: true, answered: "Allow once" });
		assert.deepEqual(fake.answers, ["1"]);

		// A second ask while still asking is news too.
		fake.emit({
			kind: "state",
			state: "asking",
			detail: "bash: rm x",
			ask: { ...ask, questions: [{ question: "bash: rm x", options: ["Allow once", "Reject"] }] },
		});
		assert.equal((await inboxTexts(t, root)).length, 1);
		fake.emit({ kind: "state", state: "busy" });
		assert.equal(state(t, w), "working");
		assert.match((await t.client.permit({ from: root, to: w, choice: "1" })).error ?? "", /not waiting/);
	}));

test("permit on a wait the adapter cannot answer says to ask the user, without touching the pane", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root);
		const fake = await waitFor(() => t.kit.byName(w), "adapter");
		await waitFor(() => fake.inTurn, "brief");
		fake.emit({ kind: "state", state: "asking", detail: "waiting" });
		const r = await t.client.permit({ from: root, to: w, choice: "1" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /cannot answer for it \(waiting\)\. Ask the user to answer it in claude's pane/);
		assert.deepEqual(fake.answers, []);
	}));

test("status scope: parent, children and grandchildren; unknownAgent lists whom a worker can message", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const a = await spawned(t, root, "claude", "a");
		await waitFor(() => t.kit.byName(a)?.inTurn, "a");
		const b = await t.client.spawn({ from: a, harness: "pi", task: "t", name: "b", backend: "cmux" });
		assert.ok("name" in b);
		await waitFor(() => t.kit.byName("b")?.inTurn, "b");
		const c = await t.client.spawn({ from: "b", harness: "pi", task: "t", name: "c", backend: "cmux" });
		assert.ok("name" in c);
		const names = async (who: string) => (await t.client.status(who)).agents.map((x) => x.name);
		assert.deepEqual(await names(root), ["a", "b"]);
		assert.deepEqual(await names("a"), [root, "b", "c"]);
		assert.deepEqual(await names("c"), ["b"]);
		const entry = (await t.client.status(root)).agents[0];
		assert.deepEqual(entry && Object.keys(entry).sort(), [
			"depth",
			"harness",
			"model",
			"name",
			"parent",
			"pull",
			"queued",
			"state",
		]);

		const typo = await t.client.send({ from: "b", to: "orchestrator", message: "hi" });
		assert.equal(typo.ok, false);
		assert.equal(
			typo.error,
			'unknown agent "orchestrator". You can message: a (your parent), c. Names come from spawn (the name or harness, plus -2, -3 when taken); use status to list them.',
		);
		const far = await t.client.send({ from: "c", to: root, message: "hi" });
		assert.match(
			far.error ?? "",
			/c cannot talk to codex: a worker talks only with its parent and its own workers\. You can message: b \(your parent\)/,
		);
	}));

test("pull roots: results wait for inbox(), which returns them once; /stream sees each message", () =>
	withHub(
		async (t) => {
			const root = await pullRoot(t.client, "opencode");
			assert.equal(root, "opencode");
			const seen: string[] = [];
			const stream = t.client.stream(root, (m) => seen.push(m.text));
			await stream.opened;
			try {
				await spawned(t, root, "pi", "one");
				await spawned(t, root, "pi", "two");
				await waitFor(() => seen.length === 2, "two results streamed");
				const first = await t.client.inbox(root);
				assert.deepEqual(first.messages.map((m) => [m.from, m.text]).sort(), [
					["one", "[agent-link] one (pi · claude-bridge/claude-haiku-5-5) finished:\n\none handled: task of one"],
					["two", "[agent-link] two (pi · claude-bridge/claude-haiku-5-5) finished:\n\ntwo handled: task of two"],
				]);
				assert.deepEqual((await t.client.inbox(root)).messages, [], "marked read");
				const delivered = t.running.hub.log.messages().filter((m) => m.recipient === root);
				assert.ok(delivered.every((m) => m.delivered_at !== null));
			} finally {
				stream.close();
			}
		},
		{ respond: echoResponder },
	));

test("register: names after the harness, root identity at depth 0, adapter roots get the launch command", () =>
	withHub(async (t) => {
		const a = await t.client.register({ harness: "claude", cwd: t.home, pull: true });
		const b = await t.client.register({ harness: "claude", cwd: t.home, pull: true });
		assert.ok("name" in a && "name" in b);
		assert.equal(a.name, "claude");
		assert.equal(b.name, "claude-2");
		assert.deepEqual(a.identity, { agent: "claude", hub: t.running.socket, token: t.running.token, depth: 0 });

		const xl = await t.client.register({ harness: "pi", cwd: t.home, pull: false, adapter: true });
		assert.ok("name" in xl);
		assert.deepEqual(xl.command?.argv, ["fake-harness", "--name", "pi"]);
		const fake = await waitFor(() => t.kit.byName("pi"), "adapter");
		assert.equal(fake.connectedWithoutPane, true);
		// An adapter root gets results as new turns, not through inbox.
		const w = await spawned(t, "pi", "codex");
		const wf = await waitFor(() => t.kit.byName(w), "worker");
		await waitFor(() => wf.inTurn, "brief");
		wf.finish("result for xl root");
		await waitFor(() => fake.prompts.length === 1, "result prompt to the root");
		assert.match(fake.prompts[0]?.text ?? "", /^\[agent-link\] codex \(codex\) finished:\n\nresult for xl root$/);

		const child = await t.client.register({ harness: "x", cwd: t.home, pull: true, adapter: true });
		assert.ok("error" in child);
	}));

test("POST /event is logged and given to listeners", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const got: string[] = [];
		t.running.hub.onEvent(root, (e) => got.push(e.type));
		assert.deepEqual(await t.client.event({ agent: root, type: "hook-stop", detail: "x" }), { ok: true });
		assert.deepEqual(got, ["hook-stop"]);
		const ev = t.running.hub.log.events({ agent: root }).find((e) => e.kind === "harness-hook-stop");
		assert.equal(ev?.data, JSON.stringify({ detail: "x" }));
	}));

test("auth: a request without the right token gets 401; the client says so", () =>
	withHub(async (t) => {
		const raw = await new Promise<number | undefined>((resolve, reject) => {
			const req = request({ socketPath: t.running.socket, path: "/status?agent=x" }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(raw, 401);
		const wrong = createHubClient({ socket: t.running.socket, token: "nope" });
		await assert.rejects(wrong.status("x"), /refused the token/);
	}));

test("socket modes: folder 0700, socket 0600, token 0600 and kept across restarts", async () => {
	const t = await testHub();
	const paths = hubPaths(t.home);
	assert.equal(statSync(paths.home).mode & 0o777, 0o700);
	assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
	assert.equal(statSync(paths.token).mode & 0o777, 0o600);
	assert.equal(statSync(paths.run).mode & 0o777, 0o700);
	await assert.rejects(testHub({ home: t.home }), /a hub already runs/);
	const token = t.running.token;
	await t.stop({ keepHome: true });
	assert.equal(existsSync(paths.socket), false, "socket removed on close");
	const again = await testHub({ home: t.home });
	try {
		assert.equal(again.running.token, token);
	} finally {
		await again.stop();
	}
});

test("hub restart keeps the sqlite log: rows of the first run are still there", async () => {
	const t = await testHub({ respond: echoResponder });
	const root = await pullRoot(t.client);
	await spawned(t, root, "pi", "w");
	await waitFor(() => state(t, "w") === "done", "done");
	const firstRun = t.running.hub.log.run;
	await t.stop({ keepHome: true });
	const again = await testHub({ home: t.home });
	try {
		const log = again.running.hub.log;
		assert.notEqual(log.run, firstRun);
		const old = log.messages({ allRuns: true }).filter((m) => m.run === firstRun);
		assert.deepEqual(
			old.map((m) => [m.sender, m.recipient, m.kind]),
			[
				["agent-link", "w", "brief"],
				["w", root, "result"],
			],
		);
		assert.ok(old[0]?.delivered_at && old[0].turn_end_at, "brief delivered and its turn ended");
		assert.ok(log.agents({ allRuns: true }).some((a) => a.run === firstRun && a.name === "w" && a.state === "exited"));
		assert.deepEqual(log.messages(), [], "the new run starts empty");
	} finally {
		await again.stop();
	}
});

test("register with backend: an adapter root is launched with that backend's MCP command", () =>
	withHub(
		async (t) => {
			const res = await t.client.register({ harness: "pi", cwd: t.home, pull: false, adapter: true, backend: "tmux" });
			assert.ok("name" in res);
			assert.deepEqual(t.kit.byName("pi")?.spec?.mcp, { command: "node", args: ["tmux-mcp.ts"] });
		},
		{ mcp: { cmux: { command: "node", args: ["cmux-mcp.ts"] }, tmux: { command: "node", args: ["tmux-mcp.ts"] } } },
	));

test("GET /agents lists every agent, each root followed by its tree", () =>
	withHub(async (t) => {
		const r1 = await pullRoot(t.client);
		const r2 = await pullRoot(t.client, "opencode");
		await spawned(t, r1, "pi", "a");
		await waitFor(() => t.kit.byName("a")?.inTurn, "a");
		await t.client.spawn({ from: "a", harness: "pi", task: "t", name: "b", backend: "cmux" });
		await spawned(t, r2, "pi", "c");
		const { agents } = await t.client.agents();
		assert.deepEqual(
			agents.map((a) => [a.name, a.parent, a.depth]),
			[
				[r1, null, 0],
				["a", r1, 1],
				["b", "a", 2],
				[r2, null, 0],
				["c", r2, 1],
			],
		);
		assert.equal(agents[1]?.backend, "cmux");
		assert.match(agents[1]?.pane ?? "", /^pane:\d+$/);
	}));

test("POST /event exited closes that agent's tree at once (`agent-link open` reports its harness exited)", () =>
	withHub(async (t) => {
		const root = await pullRoot(t.client);
		const w = await spawned(t, root, "pi");
		await waitFor(() => t.kit.byName(w)?.inTurn, "brief");
		assert.deepEqual(await t.client.event({ agent: root, type: "exited", detail: "harness exited with code 0" }), {
			ok: true,
		});
		await waitFor(() => state(t, root) === "exited" && state(t, w) === "exited", "tree closed");
	}));

test("a worker spawns next to its own pane, not where its MCP server's env says", () => {
	const base = { name: "w", parent: "root", harness: "codex", model: null, cwd: "/", state: "working" as const };
	const rec = { ...base, pull: false, depth: 1, startedAt: 0 };
	const req = { from: "w", harness: "pi", task: "t", backend: "cmux" as const, place: { surface: "surface:1" } };
	assert.deepEqual(placeOf({ ...rec, backend: "cmux", pane: "surface:9" }, req), { surface: "surface:9" });
	assert.deepEqual(placeOf({ ...rec, backend: "tmux", pane: "%3@/tmp/s" }, { ...req, backend: "tmux" }), {
		tmuxPane: "%3",
		tmuxSocket: "/tmp/s",
	});
	// A root opened with `agent-link open` has no pane: its MCP server's place is the one to use.
	assert.deepEqual(placeOf(rec, req), { surface: "surface:1" });
});

test("a root's spawns open where xl said its terminal is, when its MCP server cannot tell", () => {
	const rec = { name: "codex", parent: null, harness: "codex", model: null, cwd: "/", state: "working" as const };
	const root = { ...rec, pull: false, depth: 0, startedAt: 0 };
	const req = { from: "codex", harness: "pi", task: "t", backend: "cmux" as const };
	assert.deepEqual(placeOf(root, req, { surface: "surface:7" }), { surface: "surface:7" });
	assert.deepEqual(placeOf(root, { ...req, place: { surface: "surface:8" } }, { surface: "surface:7" }), {
		surface: "surface:8",
	});
});

test("an exit report from another process than the registered root is ignored", async () => {
	const t = await testHub();
	try {
		const root = await t.client.register({ harness: "claude", cwd: t.home, pull: true, pid: process.pid });
		assert.ok("name" in root);
		const state = async () => (await t.client.agents()).agents.find((a) => a.name === root.name)?.state;
		await t.client.event({ agent: root.name, type: "exited", pid: process.pid + 1 });
		assert.notEqual(await state(), "exited");
		await t.client.event({ agent: root.name, type: "exited", pid: process.pid });
		for (let i = 0; i < 50 && (await state()) !== "exited"; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(await state(), "exited");
	} finally {
		await t.stop();
	}
});

test("a root registered with a place spawns there when the spawn itself has none", async () => {
	const t = await testHub();
	try {
		const root = await t.client.register({
			harness: "claude",
			cwd: t.home,
			pull: true,
			place: { surface: "surface:7" },
		});
		assert.ok("name" in root);
		const res = await t.client.spawn({ from: root.name, harness: "pi", task: "t", backend: "cmux" });
		assert.ok("name" in res, JSON.stringify(res));
		const open = t.backend.calls.find((c) => c.op === "open");
		assert.deepEqual(open && "place" in open ? open.place : undefined, { surface: "surface:7" });
	} finally {
		await t.stop();
	}
});
