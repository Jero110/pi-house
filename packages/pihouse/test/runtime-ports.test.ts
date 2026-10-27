import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "agent-link-core";
import { captureRun } from "../src/workflow/capture.ts";
import { isQuiescent } from "../src/workflow/jobs.ts";
import { produceDigestCandidates } from "../src/workflow/learning-runtime.ts";
import { openMemory } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { runtimePorts } from "../src/workflow/runtime-ports.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

// Fake journal files and fake pi JSONL sources only. Nothing here reaches a hub, a harness or a real session.

const RUN = "root-ports";
const SESSION = "native-ports";

function message(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text },
	});
}

function root(home: string, source: string): SessionRecord {
	return {
		id: RUN,
		name: "workflow-planner",
		parent: null,
		parentName: null,
		root: RUN,
		harness: "pihouse",
		model: null,
		cwd: home,
		state: "done",
		depth: 0,
		sessionId: SESSION,
		transcript: source,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
	};
}

/** A worker with no native source: it is a participant the package names but its cursor is unverifiable. */
function worker(parent: string, id: string, state: SessionRecord["state"]): SessionRecord {
	return {
		id,
		name: id,
		parent,
		parentName: "workflow-planner",
		root: RUN,
		harness: "pihouse",
		model: null,
		cwd: "/",
		state,
		depth: 1,
		startedAt: "2026-01-01T00:00:30.000Z",
		updatedAt: "2026-01-01T00:00:30.000Z",
	};
}

function writeJournal(dir: string, records: SessionRecord[]): void {
	mkdirSync(dir, { recursive: true });
	for (const record of records) writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
}

/** Path, size and content hash of every file under a folder: equal snapshots mean nothing was written. */
function snapshot(dir: string): string {
	const entries: string[] = [];
	const walk = (folder: string) => {
		for (const name of readdirSync(folder).sort()) {
			const path = join(folder, name);
			if (statSync(path).isDirectory()) walk(path);
			else
				entries.push(`${path}:${statSync(path).size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(dir);
	return entries.join("\n");
}

function setup(home: string) {
	const source = join(home, "native.jsonl");
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: SESSION, cwd: home })}\n${message("m1", "first-note")}\n`,
	);
	const memoryDir = join(home, "memory");
	const journalDir = join(home, "journal");
	mkdirSync(memoryDir, { recursive: true });
	const store = openMemory(memoryDir);
	// The real activation, so the operational database carries its migration row, as in production.
	migrateLegacyStore(memoryDir);
	return { source, memoryDir, journalDir, store };
}

test("operational state reads every participant from the journal and fails closed when one is unknown or the journal is missing", () => {
	const home = mkdtempSync(join(tmpdir(), "runtime-ports-state-"));
	try {
		const { source, memoryDir, journalDir, store } = setup(home);
		const planner = root(home, source);
		const child = worker(RUN, "worker-known", "done");
		// The package names the child, so the child is a stored participant.
		captureRun([planner, child], planner, store, { by: "planner" });
		const ports = runtimePorts({ storeDir: memoryDir, journalDir });

		writeJournal(journalDir, [planner, child]);
		const idle = ports.operationalState(RUN);
		assert.deepEqual(idle.states.sort(), ["stopped", "stopped"]);
		assert.equal(idle.livenessKnown, true);
		// Queued deliveries and a handoff are not in the journal, so the run is never quiescent from it alone.
		assert.equal(isQuiescent(idle), false);
		// Once a hub reports them as zero and false, the finished journal states are quiescent.
		assert.equal(isQuiescent({ ...idle, deliveries: 0, handoff: false }), true);

		writeJournal(journalDir, [planner, worker(RUN, "worker-known", "working")]);
		assert.ok(ports.operationalState(RUN).states.includes("working"));

		rmSync(join(journalDir, "worker-known.json"));
		assert.equal(ports.operationalState(RUN).livenessKnown, false);

		assert.equal(
			runtimePorts({ storeDir: memoryDir, journalDir: join(home, "absent") }).operationalState(RUN).livenessKnown,
			false,
		);
		assert.equal(ports.operationalState("no-such-run").livenessKnown, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the current fingerprint recomputes the revision's fingerprint from its sources and writes nothing", () => {
	const home = mkdtempSync(join(tmpdir(), "runtime-ports-fingerprint-"));
	try {
		const { source, memoryDir, journalDir, store } = setup(home);
		const planner = root(home, source);
		assert.equal(captureRun([planner], planner, store, { by: "planner" }), "written");
		writeJournal(journalDir, [planner]);
		const stored = JSON.parse(readFileSync(join(memoryDir, "runs", RUN, "run.json"), "utf8")) as {
			fingerprint: string;
		};
		const ports = runtimePorts({ storeDir: memoryDir, journalDir });

		const before = snapshot(memoryDir);
		assert.equal(ports.currentFingerprint(`${RUN}.r1`), stored.fingerprint);
		assert.equal(snapshot(memoryDir), before);

		appendFileSync(source, `${message("m2", "second-note")}\n`);
		const changed = ports.currentFingerprint(`${RUN}.r1`);
		assert.ok(changed !== undefined && changed !== stored.fingerprint);
		assert.equal(snapshot(memoryDir), before);

		writeFileSync(source, `${JSON.stringify({ type: "session", id: SESSION, cwd: home })}\n`);
		assert.equal(ports.currentFingerprint(`${RUN}.r1`), undefined);
		assert.equal(ports.currentFingerprint(`${RUN}.r9`), undefined);
		assert.equal(ports.currentFingerprint("not-a-revision"), undefined);
		assert.equal(existsSync(join(memoryDir, "runs", RUN, "run.json")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

/** A run captured with its root and one worker, both in the journal, ready for the candidate gate. */
function capturedRun(home: string, childState: SessionRecord["state"]) {
	const { source, memoryDir, journalDir, store } = setup(home);
	// The worker has its own fake pi stream: a participant without a verifiable source is never a candidate.
	const childSource = join(home, "child.jsonl");
	writeFileSync(
		childSource,
		`${JSON.stringify({ type: "session", id: "native-child", cwd: home })}\n${message("c1", "child-note")}\n`,
	);
	const planner = { ...root(home, source), state: "exited" as const };
	const child = { ...worker(RUN, "worker-known", childState), sessionId: "native-child", transcript: childSource };
	captureRun([planner, child], planner, store, { by: "planner" });
	writeJournal(journalDir, [planner, child]);
	const operational = openOperationalStore(join(memoryDir, "memory.sqlite"), { fts: false, legacy: true });
	return { memoryDir, journalDir, planner, child, operational };
}

test("a run whose whole journal tree is exited is quiescent end to end and becomes a digest candidate", () => {
	const home = mkdtempSync(join(tmpdir(), "runtime-ports-exited-"));
	try {
		const { memoryDir, journalDir, operational } = capturedRun(home, "exited");
		try {
			const ports = runtimePorts({ storeDir: memoryDir, journalDir });
			assert.equal(ports.operationalState(RUN).deliveries, 0);
			assert.equal(ports.operationalState(RUN).handoff, false);
			const candidates = produceDigestCandidates({
				storeDir: memoryDir,
				db: operational.db,
				ownedRoot: memoryDir,
				...ports,
			});
			assert.deepEqual(
				candidates.candidates.map((candidate) => candidate.revision),
				[`${RUN}.r1`],
			);
		} finally {
			operational.close();
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a live participant in any state keeps deliveries and handoff unknown, so the run is deferred", () => {
	const home = mkdtempSync(join(tmpdir(), "runtime-ports-done-"));
	try {
		const { memoryDir, journalDir, operational } = capturedRun(home, "done");
		try {
			const ports = runtimePorts({ storeDir: memoryDir, journalDir });
			assert.equal(ports.operationalState(RUN).deliveries, null);
			assert.equal(ports.operationalState(RUN).handoff, null);
			assert.equal(
				produceDigestCandidates({ storeDir: memoryDir, db: operational.db, ownedRoot: memoryDir, ...ports }).candidates
					.length,
				0,
			);
		} finally {
			operational.close();
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a stored participant missing from the journal keeps the run deferred even when the rest exited", () => {
	const home = mkdtempSync(join(tmpdir(), "runtime-ports-missing-"));
	try {
		const { memoryDir, journalDir, child, operational } = capturedRun(home, "exited");
		try {
			rmSync(join(journalDir, `${child.id}.json`));
			const ports = runtimePorts({ storeDir: memoryDir, journalDir });
			assert.equal(ports.operationalState(RUN).livenessKnown, false);
			assert.equal(ports.operationalState(RUN).deliveries, null);
			assert.equal(
				produceDigestCandidates({ storeDir: memoryDir, db: operational.db, ownedRoot: memoryDir, ...ports }).candidates
					.length,
				0,
			);
		} finally {
			operational.close();
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
