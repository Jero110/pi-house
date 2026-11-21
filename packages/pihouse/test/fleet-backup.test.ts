import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	createFleetSnapshot,
	restoreFleetSnapshot,
	serveFleetBackup,
	verifyFleetSnapshot,
} from "../src/fleet-backup.ts";
import { createFleetJobs } from "../src/fleet-jobs.ts";
import { createSlackBridge } from "../src/fleet-slack.ts";

test("restores completed checkouts, Slack receipts, artifacts and Git refs from a live host; active work is quarantined", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-backup-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const stateDir = join(root, "live"),
		project = join(root, "project"),
		runner = join(root, "run.mjs");
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
			"start",
			"--allow-empty",
		],
		{ cwd: project },
	);
	writeFileSync(
		runner,
		`import fs from 'node:fs';const p=fs.readFileSync(0,"utf8");if(p.includes("wait-forever"))setTimeout(()=>console.log("late"),60000);else{fs.mkdirSync("artifacts",{recursive:true});fs.appendFileSync("artifacts/log.txt","X");console.log(fs.readFileSync("artifacts/log.txt","utf8"));}`,
	);
	const cfg = { stateDir, projects: { demo: project }, host: "Book" };
	const jobs = createFleetJobs(cfg, runner);
	t.after(() => jobs.close());
	const slack = {
		stateDir,
		teamId: "T1",
		ownerId: "U1",
		botId: "U2",
		channels: [],
		project: "demo",
		origin: "https://book.example",
		host: "Book",
	};
	const bridge = createSlackBridge(slack, jobs, async () => {});
	t.after(() => bridge.close());
	const dm = { type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "22.001", text: "start" };
	bridge.accept("E1", "T1", dm);
	await bridge.flush();
	const first = jobs.list()[0];
	for (let i = 0; i < 300 && jobs.get(first.id)?.status !== "completed"; i++) await wait(20);
	assert.equal(jobs.get(first.id)?.status, "completed");
	writeFileSync(join(stateDir, "server.key"), "private-marker-do-not-copy");
	const factory = jobs.factory.save("demo", null, {
		name: "Saved recipe",
		instructions: "Answer",
		agent: "codex",
		cases: [{ input: "Hello", expected: "Hi" }],
	});
	const active = jobs.create("demo", "codex", "wait-forever");
	for (let i = 0; i < 300 && jobs.get(active.id)?.status !== "running"; i++) await wait(20);
	const snap = createFleetSnapshot(cfg, jobs);
	assert.ok(!readFileSync(snap).includes("private-marker-do-not-copy"));
	const report = verifyFleetSnapshot(snap);
	assert.deepEqual(report.interrupted, [active.id]);
	assert.ok(report.artifacts >= 1);
	const restored = join(root, "restored");
	restoreFleetSnapshot(snap, restored);
	assert.throws(() => restoreFleetSnapshot(snap, restored), /exist/i);
	assert.ok(!existsSync(join(restored, "checkouts", active.id)));
	assert.equal(readFileSync(join(restored, "checkouts", first.id, "artifacts", "log.txt"), "utf8"), "X");
	const next = createFleetJobs({ ...cfg, stateDir: restored }, runner);
	t.after(() => next.close());
	assert.equal(next.factory.get("demo", factory.id)?.revisions[0].name, "Saved recipe");
	const after = createSlackBridge({ ...slack, stateDir: restored }, next, async () => {});
	t.after(() => after.close());
	assert.ok(after.accept("E1", "T1", dm));
	await after.flush();
	assert.equal(next.get(active.id)?.status, "interrupted");
	assert.equal(next.get(first.id)?.messages.filter((m) => m.role === "user").length, 1);
	next.reply(first.id, "continue");
	for (let i = 0; i < 300 && next.get(first.id)?.status !== "completed"; i++) await wait(20);
	assert.equal(next.get(first.id)?.messages.at(-1)?.text, "XX");
	const bad = new DatabaseSync(snap);
	bad.exec("UPDATE chunks SET data=zeroblob(length(data)) WHERE rowid=(SELECT min(rowid) FROM chunks)");
	bad.close();
	assert.throws(() => verifyFleetSnapshot(snap), /integrity|checksum|hash/i);
});

test("owner CLI publishes only an absolute package path through its private socket", async (t) => {
	const dir = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "pih-rec-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "src");
	mkdirSync(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	const config = { stateDir: join(dir, "state"), projects: { demo: root } };
	const jobs = createFleetJobs(config);
	t.after(() => jobs.close());
	const ctl = await serveFleetBackup(config, jobs);
	t.after(() => ctl.close());
	const file = join(dir, "host.json");
	writeFileSync(file, JSON.stringify(config));
	const script = fileURLToPath(new URL("../src/fleet-backup.ts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, [script, "snapshot", file], { encoding: "utf8" });
	assert.equal(stdout.trim().split("\n").length, 1);
	assert.ok(stdout.trim().startsWith(`${join(config.stateDir, "recovery")}/`));
	const verified = JSON.parse(execFileSync(process.execPath, [script, "verify", stdout.trim()], { encoding: "utf8" }));
	assert.equal(verified.chats, 0);
	assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/);
});
