import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createFleetJobs } from "../src/fleet-jobs.ts";
import { createSlackBridge } from "../src/fleet-slack.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-slack-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const stateDir = join(root, "state");
	mkdirSync(project);
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"commit.gpgSign=false",
			"commit",
			"-qm",
			"seed",
			"--allow-empty",
		],
		{ cwd: project },
	);
	const worker = join(root, "worker.mjs");
	writeFileSync(worker, 'console.log("Answer <!channel> <@UOTHER> & done.");');
	const planner = join(root, "plan.mjs");
	writeFileSync(planner, 'console.log("My plan.");');
	const jobs = createFleetJobs(
		{
			stateDir,
			host: "Book",
			projects: { demo: project },
			planner: {
				label: "Mini",
				host: "peer",
				identityFile: "/id",
				entry: "/plan",
				node: "/node",
				knownHostsFile: "/known",
			},
		},
		worker,
		planner,
	);
	t.after(() => jobs.close());
	const config = {
		stateDir,
		host: "Book",
		project: "demo",
		teamId: "T1",
		ownerId: "U1",
		botId: "U2",
		origin: "https://book.example.test",
		channels: ["C1"],
	};
	return { jobs, config };
}
const first = {
	type: "app_mention",
	user: "U1",
	channel: "C1",
	thread_ts: "100.001",
	ts: "101.002",
	text: "<@U2> a question",
};
async function finished(jobs: ReturnType<typeof createFleetJobs>, id: string) {
	for (let i = 0; i < 300; i++) {
		if (jobs.get(id)?.status === "completed") return;
		await wait(20);
	}
	throw new Error("Chat did not finish");
}

test("one Slack thread shares a web chat, filters unauthorized events, and returns attributed literal text", async (t) => {
	const { jobs, config } = fixture(t);
	const outbound: string[][] = [];
	const bridge = createSlackBridge(config, jobs, async (...args) => {
		outbound.push(args);
	});
	t.after(() => bridge.close());
	for (const [team, event] of [
		["T2", first],
		["T1", { ...first, user: "U3" }],
		["T1", { ...first, channel: "C2" }],
		["T1", { ...first, bot_id: "B1" }],
		["T1", { ...first, subtype: "message_changed" }],
		["T1", { ...first, type: "message", text: "ambient chatter" }],
	] as const) {
		assert.equal(bridge.accept("nope", team, event), false);
	}
	assert.ok(bridge.accept("Ev1", "T1", first));
	assert.ok(bridge.accept("Ev2", "T1", { ...first, type: "message" }));
	await bridge.flush();
	assert.equal(jobs.list().length, 1);
	const job = jobs.list()[0];
	assert.equal(job.agent, "codex");
	assert.equal(jobs.get(job.id)?.messages[0].text, "a question");
	await finished(jobs, job.id);
	await bridge.flush();
	assert.ok(outbound.every(([ch, th]) => ch === "C1" && th === "100.001"));
	assert.ok(outbound.some(([, , msg]) => msg.includes(`/#chat=${job.id}`)));
	assert.ok(outbound.some(([, , msg]) => msg.includes("Mini · Planner") && msg.includes("My plan.")));
	assert.ok(
		outbound.some(([, , msg]) => msg.includes("Book · codex") && msg.includes("Answer <!channel> <@UOTHER> & done.")),
	);
	assert.ok(bridge.accept("Ev3", "T1", { ...first, type: "message", ts: "103.003", text: "next" }));
	await bridge.flush();
	await finished(jobs, job.id);
	jobs.reply(job.id, "from web");
	await finished(jobs, job.id);
	await bridge.flush();
	assert.deepEqual(
		jobs
			.get(job.id)
			?.messages.filter((m) => m.role === "user")
			.map((m) => m.text),
		["a question", "next", "from web"],
	);
	assert.equal(outbound.filter(([, , msg]) => msg.includes("Answer")).length, 3);
});

test("direct messages require the owner, and restart preserves pending output and suppresses duplicate input", async (t) => {
	const { jobs, config } = fixture(t);
	const dm = {
		...first,
		type: "message",
		channel: "D1",
		channel_type: "im",
		thread_ts: undefined,
		text: "direct request",
	};
	let attempted = "";
	const bad = createSlackBridge({ ...config, channels: [] }, jobs, async (_channel, _thread, _body, deliveryId) => {
		attempted = deliveryId;
		throw new Error("offline");
	});
	t.after(() => bad.close());
	assert.equal(bad.accept("Ev0", "T1", { ...dm, user: "U3" }), false);
	assert.ok(bad.accept("Ev1", "T1", dm));
	await assert.rejects(bad.flush(), /offline/);
	bad.close();
	const sent: string[] = [];
	const ids: string[] = [];
	const good = createSlackBridge({ ...config, channels: [] }, jobs, async (_channel, _thread, text, deliveryId) => {
		ids.push(deliveryId);
		sent.push(text);
	});
	t.after(() => good.close());
	assert.ok(good.accept("Ev1", "T1", dm));
	const job = jobs.list()[0];
	await finished(jobs, job.id);
	await Promise.all([good.flush(), good.flush()]);
	assert.equal(jobs.get(job.id)?.messages.filter((m) => m.role === "user").length, 1);
	assert.equal(ids[0], attempted);
	assert.equal(sent.filter((s) => s.includes("Answer")).length, 1);
	assert.equal(sent.filter((s) => s.includes("My plan.")).length, 1);
});

test("a job submission receipt survives a lost bridge transaction and cannot repeat a turn", async (t) => {
	const { jobs } = fixture(t);
	const job = jobs.submitExternalTurn("slack-key", "demo", "codex", "once");
	assert.equal(jobs.submitExternalTurn("slack-key", "demo", "codex", "once").id, job.id);
	await finished(jobs, job.id);
	jobs.submitExternalTurn("reply-key", "demo", "codex", "again", job.id);
	jobs.submitExternalTurn("reply-key", "demo", "codex", "again", job.id);
	await finished(jobs, job.id);
	assert.deepEqual(
		jobs
			.get(job.id)
			?.messages.filter((m) => m.role === "user")
			.map((m) => m.text),
		["once", "again"],
	);
});

test("Slack redirects memory commands to the private web chat and withholds private-context model output", async (t) => {
	const { jobs, config } = fixture(t);
	const sent: string[] = [];
	const bridge = createSlackBridge(config, jobs, async (_channel, _thread, text) => {
		sent.push(text);
	});
	t.after(() => bridge.close());
	assert.ok(bridge.accept("EvPrivate", "T1", { ...first, text: "<@U2> memory save code = forbidden-identity-marker" }));
	assert.ok(!readFileSync(join(config.stateDir, "slack.sqlite")).includes("forbidden-identity-marker"));
	await bridge.flush();
	assert.deepEqual(jobs.list(), []);
	assert.deepEqual(jobs.memoryFacts("demo"), []);
	assert.ok(sent.at(-1)?.includes(config.origin));
	assert.ok(
		bridge.accept("EvDM", "T1", {
			type: "message",
			ts: "33.1",
			channel_type: "im",
			channel: "D1",
			user: "U1",
			text: "/memory status",
		}),
	);
	await bridge.flush();
	assert.deepEqual(jobs.list(), []);
	jobs.create("demo", "codex", "memory save launch date = never-post-this-fact");
	assert.ok(bridge.accept("EvNatural", "T1", { ...first, ts: "105.5", text: "<@U2> What is the launch date?" }));
	await bridge.flush();
	const bound = jobs.list().find((j) => j.title.includes("What is"));
	assert.ok(bound);
	await finished(jobs, bound.id);
	jobs.reply(bound.id, "memory launch");
	await bridge.flush();
	assert.ok(sent.some((s) => s.includes("Mini · Planner")));
	assert.ok(sent.some((s) => s.includes("Book · codex") && s.includes("#chat=")));
	assert.ok(
		sent.every(
			(s) =>
				!s.includes("never-post-this-fact") &&
				!s.includes("forbidden-identity-marker") &&
				!s.includes("My plan.") &&
				!s.includes("Answer <!channel>"),
		),
	);
});
