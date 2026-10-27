import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkerAdapter, type WorkerJob } from "../src/workflow/worker-adapter.ts";

// A fake child writes its attempt output (the Output path in its task), then leaves a native transcript and a
// journal record. The adapter is the only code under test; nothing reaches a real hub or model.

const SECTIONS = [
	"objective",
	"participants",
	"decisions",
	"failures",
	"validations",
	"artifacts",
	"limitations",
	"candidates",
];
const DIGEST = JSON.stringify({
	schemaVersion: 1,
	runId: "run-one",
	project: "fixture",
	revision: "run-one.r1",
	sections: Object.fromEntries(SECTIONS.map((key) => [key, key])),
});

interface Script {
	/** Bytes the child writes to its attempt output; undefined means it writes nothing. */
	write?: string;
	/** Final stop reason in the child's transcript. */
	stop?: "stop" | "error";
	/** Journal state the child ends in; "working" never finishes and forces a timeout. */
	state?: "done" | "working";
	spawnError?: boolean;
}

function setup(root: string, script: Script) {
	const journal = join(root, "journal");
	const out = join(root, "out");
	mkdirSync(journal);
	mkdirSync(out);
	writeFileSync(join(out, "keep.txt"), "not ours");
	const attempts: string[] = [];
	const client = {
		spawn: async (body: { task: string; name: string; cwd: string }) => {
			if (script.spawnError) return { error: "no pane available" };
			const attempt = body.task.match(/Output: ([^\n]+)/)?.[1];
			assert.ok(attempt);
			attempts.push(attempt);
			if (script.write !== undefined) writeFileSync(attempt, script.write);
			const transcript = join(root, `${body.name}.jsonl`);
			writeFileSync(
				transcript,
				JSON.stringify({
					type: "message",
					message: { role: "assistant", stopReason: script.stop ?? "stop", content: [] },
				}),
			);
			writeFileSync(
				join(journal, `${body.name}.json`),
				JSON.stringify({
					id: `20260101T000000Z-${body.name}`,
					name: body.name,
					parent: "coordinator",
					parentName: "coordinator",
					root: "coordinator",
					harness: "pihouse",
					model: null,
					cwd: body.cwd,
					task: body.task,
					state: script.state ?? "done",
					depth: 1,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					transcript,
				}),
			);
			return { name: body.name };
		},
		cancel: async () => ({ ok: true }),
	};
	const adapter = createWorkerAdapter({
		client: client as never,
		from: "coordinator",
		backend: "tmux",
		journalDir: journal,
		timeoutMs: 200,
		pollMs: 20,
	});
	const job: WorkerJob = {
		stage: "digest",
		id: "digest-run-one.r1",
		revision: "run-one.r1",
		project: "fixture",
		inputPath: join(root, "evidence"),
		outputPath: join(out, "digest.json"),
		cwd: root,
		maxOutputBytes: 12_000,
	};
	return { adapter, job, out, attempts };
}

/** Only the sentinel and, when expected, the published digest may remain: the attempt file is always gone. */
function assertOnly(out: string, names: string[], attempts: string[]): void {
	assert.deepEqual(readdirSync(out).sort(), [...names].sort());
	for (const attempt of attempts) assert.equal(existsSync(attempt), false);
}

test("a validated digest is published at the job's final output path and the attempt file is removed", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-success-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: DIGEST });
		const result = await adapter(job);
		assert.deepEqual(result, { status: "success", outputPath: job.outputPath, outputText: DIGEST });
		assert.equal(readFileSync(job.outputPath, "utf8"), DIGEST);
		assertOnly(out, ["digest.json", "keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a finished child with a stop reason of error removes its attempt and publishes nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-failure-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: DIGEST, stop: "error" });
		assert.deepEqual(await adapter(job), { status: "failure" });
		assertOnly(out, ["keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid output removes the attempt and publishes nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-invalid-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: "not a digest" });
		assert.deepEqual(await adapter(job), { status: "failure" });
		assertOnly(out, ["keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a timed-out child is cancelled and its partial attempt is removed", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-timeout-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: "partial", state: "working" });
		assert.deepEqual(await adapter(job), { status: "cancelled" });
		assertOnly(out, ["keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a spawn error leaves every existing file untouched", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-spawn-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { spawnError: true });
		assert.deepEqual(await adapter(job), { status: "failure" });
		assert.deepEqual(attempts, []);
		assertOnly(out, ["keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("success never replaces a different file already at the final path", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-clobber-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: DIGEST });
		writeFileSync(job.outputPath, "an earlier, different artifact");
		assert.deepEqual(await adapter(job), { status: "failure" });
		assert.equal(readFileSync(job.outputPath, "utf8"), "an earlier, different artifact");
		assertOnly(out, ["digest.json", "keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("success accepts an identical file already at the final path", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-identical-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: DIGEST });
		writeFileSync(job.outputPath, DIGEST);
		assert.deepEqual(await adapter(job), { status: "success", outputPath: job.outputPath, outputText: DIGEST });
		assertOnly(out, ["digest.json", "keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("success refuses a symbolic link at the final path and leaves its target alone", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-symlink-"));
	try {
		const { adapter, job, out, attempts } = setup(root, { write: DIGEST });
		const target = join(root, "elsewhere.json");
		writeFileSync(target, DIGEST);
		symlinkSync(target, job.outputPath);
		assert.deepEqual(await adapter(job), { status: "failure" });
		assert.ok(lstatSync(job.outputPath).isSymbolicLink());
		assert.equal(readFileSync(target, "utf8"), DIGEST);
		assertOnly(out, ["digest.json", "keep.txt"], attempts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
