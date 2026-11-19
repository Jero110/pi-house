import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFleetJobs } from "../src/fleet-jobs.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-jobs-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const stateDir = join(root, "state");
	mkdirSync(project);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
	git("init", "--quiet");
	writeFileSync(join(project, "hello.txt"), "committed");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgSign=false", "commit", "-qm", "seed");
	writeFileSync(join(project, "hello.txt"), "owner edits");
	const runner = join(root, "fake-sandbox.mjs");
	writeFileSync(
		runner,
		`
import fs from "node:fs";
import {execFileSync} from "node:child_process";
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("overflow-test")) { process.stdout.write("x".repeat(2 ** 20)); }
else {
 const before = fs.readFileSync("hello.txt","utf8");
 fs.writeFileSync("hello.txt","agent edit");
 const remote = execFileSync("git",["remote"],{encoding:"utf8"}).trim() || "none";
 console.log([process.argv[2], remote, before, prompt.includes("first question"),prompt.includes("previous answer")].join("|") + " previous answer");
}
`,
	);
	const options = { stateDir, projects: { demo: project } };
	return { root, project, runner, options };
}

async function settled(jobs: ReturnType<typeof createFleetJobs>, id: string) {
	for (let i = 0; i < 350; i++) {
		const job = jobs.get(id);
		assert.ok(job);
		if (job.status !== "running" && job.status !== "queued") return job;
		await delay(20);
	}
	throw new Error("Timed out waiting for the chat");
}

test("each chat edits an independent clone and follow-ups reuse the transcript and checkout", async (t) => {
	const { project, options, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	const first = jobs.create("demo", "pi", "first question");
	assert.throws(() => jobs.reply(first.id, "overlap"), /busy/i);
	const a = await settled(jobs, first.id);
	assert.equal(a.status, "completed", JSON.stringify(a.messages));
	assert.match(a.messages.at(-1)?.text ?? "", /pi\|none\|committed\|true\|false/);
	jobs.reply(first.id, "follow-up");
	const b = await settled(jobs, first.id);
	assert.match(b.messages.at(-1)?.text ?? "", /pi\|none\|agent edit\|true\|true/);
	const second = jobs.create("demo", "codex", "another thread");
	const c = await settled(jobs, second.id);
	assert.match(c.messages.at(-1)?.text ?? "", /codex\|none\|committed\|false\|false/);
	assert.equal(readFileSync(join(project, "hello.txt"), "utf8"), "owner edits");
	assert.equal(jobs.list().length, 2);
	jobs.close();
	const reopened = createFleetJobs(options, runner);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.get(first.id), b);
});

test("store ownership is exclusive and unsent work is never replayed after restart", async (t) => {
	const { options, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	assert.throws(() => createFleetJobs(options, runner), /locked|busy|already/i);
	const first = jobs.create("demo", "claude", "do this once");
	jobs.close();
	const reopened = createFleetJobs(options, runner);
	t.after(() => reopened.close());
	const job = await settled(reopened, first.id);
	assert.equal(job.status, "interrupted");
	assert.equal(job.messages.at(-1)?.role, "system");
	assert.throws(() => reopened.reply(first.id, "retry"), /interrupted/i);
});

test("checks project identity and owner-state overlap before accepting work", (t) => {
	const { project, options, root, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	assert.throws(() => jobs.create("__proto__", "pi", "hi"), /project/i);
	assert.throws(() => jobs.create("demo", "pi", " "), /message/i);
	assert.throws(() => jobs.create("demo", "pi", "x".repeat(100_000)), /message/i);
	const alias = join(root, "project-alias");
	symlinkSync(project, alias);
	assert.throws(
		() => createFleetJobs({ stateDir: join(alias, ".state"), projects: { demo: project } }, runner),
		/state/i,
	);
});

test("oversized child output ends the turn with bounded retained diagnostics", async (t) => {
	const { options, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	const first = jobs.create("demo", "codex", "overflow-test");
	const job = await settled(jobs, first.id);
	assert.equal(job.status, "failed");
	assert.match(job.messages.at(-1)?.text ?? "", /output/i);
	assert.ok(JSON.stringify(job.messages).length < 10_000);
});

test("a process that exits before dispatch leaves a durable interrupted turn on the next host", async (t) => {
	const { root, options, runner } = fixture(t);
	const driver = join(root, "abrupt-exit.mjs");
	writeFileSync(
		driver,
		`
import {createFleetJobs} from ${JSON.stringify(new URL("../src/fleet-jobs.ts", import.meta.url).href)};
import {writeSync} from "node:fs";
const jobs = createFleetJobs(JSON.parse(process.argv[2]), process.argv[3]);
writeSync(1,jobs.create("demo","pi","once only").id);
process.exit(0);
`,
	);
	const id = execFileSync(process.execPath, [driver, JSON.stringify(options), runner], { encoding: "utf8" }).trim();
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	const job = await settled(jobs, id);
	assert.equal(job.status, "interrupted");
	assert.equal(job.messages.filter((m) => m.role === "user").length, 1);
	assert.throws(() => jobs.reply(id, "retry"), /interrupted/i);
});

test("an operator-specified deadline stops the active runner and its separate-group child", async (t) => {
	const { options, runner, root } = fixture(t);
	const started = join(root, "started");
	const late = join(root, "late");
	writeFileSync(
		runner,
		`
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const worker = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(late)}) + ", 'late'), 1800)"], {detached:true,stdio:"ignore"});
worker.unref();
writeFileSync(${JSON.stringify(started)},"started");
setTimeout(()=>console.log("too late"),2000);
`,
	);
	const jobs = createFleetJobs({ ...options, turnTimeoutMs: 1000 }, runner);
	t.after(() => jobs.close());
	const job = jobs.create("demo", "pi", "deadline");
	const done = await settled(jobs, job.id);
	assert.equal(readFileSync(started, "utf8"), "started");
	assert.equal(done.status, "failed");
	assert.match(done.messages.at(-1)?.text ?? "", /timed out/i);
	await delay(1100);
	assert.throws(() => readFileSync(late), { code: "ENOENT" });
});

test("invalid operator deadlines fail at startup", (t) => {
	const { options, runner } = fixture(t);
	assert.throws(() => createFleetJobs({ ...options, turnTimeoutMs: 86400001 }, runner), /timeout/i);
});

test("worker startup traces stay private while tagged sandbox diagnostics reach the transcript", async (t) => {
	const { options, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	writeFileSync(runner, 'console.error("an unstructured startup trace /private/account"); process.exit(1);');
	const job = jobs.create("demo", "pi", "first");
	const failed = await settled(jobs, job.id);
	assert.equal(failed.messages.at(-1)?.text, "Sandbox runner failed.");
	writeFileSync(runner, 'console.error("Fleet sandbox: Agent login required."); process.exit(1);');
	jobs.reply(job.id, "check again");
	const retried = await settled(jobs, job.id);
	assert.equal(retried.messages.at(-1)?.text, "Agent login required.");
});

test("timestamps task events and messages, exposes changed artifact snapshots and persists them", async (t) => {
	const { options, runner, project } = fixture(t);
	mkdirSync(join(project, "artifacts"));
	writeFileSync(join(project, "artifacts", "old.txt"), "pre-existing");
	execFileSync("git", ["add", "artifacts"], { cwd: project });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@localhost",
			"-c",
			"commit.gpgSign=false",
			"commit",
			"-qm",
			"artifact fixture",
		],
		{ cwd: project },
	);
	writeFileSync(
		runner,
		`import fs from "node:fs"; const p=fs.readFileSync(0,"utf8");if(!p.includes("artifacts/"))process.exit(3);fs.writeFileSync("artifacts/result.txt","answer");console.log("ready");`,
	);
	const jobs = createFleetJobs({ ...options, host: "MacBook" }, runner);
	t.after(() => jobs.close());
	const first = jobs.create("demo", "pi", "write a report");
	const done = await settled(jobs, first.id);
	assert.equal(done.status, "completed", JSON.stringify(done.messages));
	assert.deepEqual(
		done.events?.map((e) => e.type),
		["queued", "started", "finished"],
	);
	assert.match(done.events?.[1]?.text ?? "", /MacBook/);
	assert.ok(done.messages.every((m) => typeof m.at === "number"));
	assert.match(done.messages.at(-1)?.actor ?? "", /MacBook/);
	assert.deepEqual(
		done.artifacts?.map((a) => a.name),
		["result.txt"],
	);
	assert.equal(jobs.artifact(first.id, done.artifacts?.[0]?.id ?? "")?.bytes.toString(), "answer");
	jobs.close();
	const resumed = createFleetJobs(options, runner);
	t.after(() => resumed.close());
	assert.deepEqual(resumed.get(first.id), done);
});

test("planner messages and primary responses share one durable chat with distinct actors", async (t) => {
	const { options, root, runner } = fixture(t);
	const plannerScript = join(root, "planner.mjs");
	writeFileSync(
		plannerScript,
		`import fs from "node:fs";const cfg=JSON.parse(process.argv[2]);if(cfg.host!=="peer" || !fs.readFileSync(0,"utf8").includes("question"))process.exit(3); console.log("a plan");`,
	);
	writeFileSync(
		runner,
		`import fs from "node:fs";const input=fs.readFileSync(0,"utf8");console.log(input.includes("a plan") && input.includes("untrusted")?"executed plan":"missing plan");`,
	);
	const planner = {
		label: "Mac mini",
		host: "peer",
		node: "/node",
		entry: "/fleet",
		identityFile: "/id",
		knownHostsFile: "/known",
	};
	const jobs = createFleetJobs({ ...options, host: "MacBook", planner }, runner, plannerScript);
	t.after(() => jobs.close());
	const first = jobs.create("demo", "codex", "question");
	const done = await settled(jobs, first.id);
	assert.equal(done.status, "completed");
	assert.deepEqual(
		done.messages.slice(1).map((m) => [m.actor, m.text]),
		[
			["Mac mini · Planner", "a plan"],
			["MacBook · codex", "executed plan"],
		],
	);
	assert.deepEqual(
		done.events?.map((e) => e.type),
		["queued", "started", "finished", "started", "finished"],
	);
	writeFileSync(plannerScript, `process.exit(2);`);
	jobs.reply(first.id, "another");
	const fallback = await settled(jobs, first.id);
	assert.equal(fallback.status, "completed");
	assert.ok(fallback.events?.some((e) => e.type === "failed" && e.text.includes("Mac mini")));
});

test("owner memory commands answer locally and a later normal turn receives a fresh checkout", async (t) => {
	const { options, runner } = fixture(t);
	const jobs = createFleetJobs(options, runner);
	t.after(() => jobs.close());
	const first = jobs.create("demo", "codex", "/memory status");
	assert.equal(first.status, "completed");
	assert.equal(first.messages.at(-1)?.kind, "memory");
	assert.equal(jobs.memoryProfile("demo"), "balanced");
	const second = jobs.reply(first.id, "memory status");
	assert.equal(second.status, "completed");
	assert.equal(second.messages.at(-1)?.kind, "memory");
	jobs.reply(first.id, "first question");
	const final = await settled(jobs, first.id);
	assert.equal(final.status, "completed", JSON.stringify(final.messages));
	assert.match(final.messages.at(-1)?.text ?? "", /codex\|none\|committed/);
});

test("only matching owner-confirmed project facts reach the planner and worker", async (t) => {
	const { options, project, root, runner } = fixture(t);
	const script = `import fs from "node:fs";const p=fs.readFileSync(0,"utf8");console.log(p.includes("thursday-identity-marker")?"confirmed context":"no matching context");`;
	const plannerScript = join(root, "plan.mjs");
	writeFileSync(plannerScript, script);
	writeFileSync(runner, script);
	const planner = {
		label: "Mini",
		host: "peer",
		identityFile: "/id",
		entry: "/plan",
		node: "/node",
		knownHostsFile: "/known",
	};
	const jobs = createFleetJobs(
		{ ...options, projects: { demo: project, other: project }, planner },
		runner,
		plannerScript,
	);
	t.after(() => jobs.close());
	const memory = jobs.create("demo", "codex", "memory save launch date = thursday-identity-marker");
	assert.equal(memory.status, "completed");
	const one = jobs.create("demo", "codex", "What is the launch date?");
	const matched = await settled(jobs, one.id);
	assert.deepEqual(
		matched.messages.slice(1).map((m) => m.text),
		["confirmed context", "confirmed context"],
	);
	const other = jobs.create("other", "codex", "What is the launch date?");
	const separate = await settled(jobs, other.id);
	assert.deepEqual(
		separate.messages.slice(1).map((m) => m.text),
		["no matching context", "no matching context"],
	);
});

test("rejects unknown planner addresses before admission and stops after an explicitly selected peer fails", async (t) => {
	const { options, root, runner } = fixture(t);
	const peer = (label: string) => ({
		label,
		host: "peer",
		identityFile: "/id",
		entry: "/plan",
		node: "/node",
		knownHostsFile: "/known",
	});
	const plan = join(root, "peer.mjs");
	writeFileSync(
		plan,
		'const config=JSON.parse(process.argv[2]);if(config.label==="Mini")process.exit(1);console.log(config.label+" here");',
	);
	const jobs = createFleetJobs({ ...options, planners: [peer("Mini"), peer("Studio")] }, runner, plan);
	t.after(() => jobs.close());
	assert.throws(() => jobs.create("demo", "codex", "@unknown hello"), /unknown|address|planner/i);
	assert.equal(jobs.list().length, 0);
	const job = jobs.create("demo", "codex", "@Studio hello");
	const done = await settled(jobs, job.id);
	assert.equal(done.messages[1].actor, "Studio · Planner");
	assert.equal(done.messages[1].text, "Studio here");
	assert.throws(() => jobs.reply(job.id, "@unknown again"), /unknown|address|planner/i);
	assert.equal(jobs.get(job.id)?.messages.length, 3);
	jobs.reply(job.id, "@Mini hello");
	const failed = await settled(jobs, job.id);
	assert.equal(failed.status, "failed");
	assert.equal(failed.messages.at(-1)?.kind, "error");
	assert.match(failed.messages.at(-1)?.text ?? "", /Mini/);
	assert.equal(failed.messages.filter((m) => m.actor?.endsWith("· codex")).length, 1);
});
