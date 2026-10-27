// Production ports for the learning runtime: what the agent-link journal and the native sources say now, read without
// writing anything. Every unknown answers "not safe", so captured evidence stays in place until it is proven unused.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentState, readJournal, type SessionRecord, treeOf } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import { type FlagBy, previewRunFingerprint } from "./capture.ts";
import type { RuntimeOptions } from "./learning-runtime.ts";
import { openMemory } from "./memory.ts";

export interface RuntimePortOptions {
	/** The memory directory: captured copies live under its runs folder. */
	storeDir: string;
	/** The agent-link journal folder (`<agent-link home>/sessions`). */
	journalDir: string;
	roots?: TranscriptRoots;
}

interface StoredRun {
	revision: number;
	agents: { id: string }[];
	by: FlagBy;
}

const REVISION_ID = /^(.+)\.r([0-9]+)$/;
const FLAGGED: readonly FlagBy[] = ["planner", "executor", "save"];

/** The stored package's identity fields, or undefined when run.json is missing or malformed. */
function storedRun(storeDir: string, runId: string): StoredRun | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(storeDir, "runs", runId, "run.json"), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (!Number.isSafeInteger(record.revision) || !Array.isArray(record.agents)) return undefined;
		const agents = record.agents.filter(
			(agent): agent is { id: string } =>
				typeof agent === "object" && agent !== null && typeof Reflect.get(agent, "id") === "string",
		);
		const by = FLAGGED.find((candidate) => candidate === record.flaggedBy) ?? "save";
		return { revision: Number(record.revision), agents, by };
	} catch {
		return undefined;
	}
}

/**
 * Problem: the journal names states starting, working, asking, done, error and exited, but the quiescence check
 * speaks idle and stopped. Example: a finished worker reads as "done", which the check would count as still active.
 * Solution: active states (starting, working, asking) become "working"; finished, failed or exited ones become
 * "stopped".
 */
function runtimeState(state: AgentState): "working" | "stopped" {
	return state === "done" || state === "error" || state === "exited" ? "stopped" : "working";
}

/** The run's root in the journal: a run is identified by its root's journal id. */
function rootOf(records: readonly SessionRecord[], runId: string): SessionRecord | undefined {
	return records.find((record) => record.id === runId && record.parent === null);
}

/**
 * Problem: the runtime cannot clean a run without knowing whether anything in it is still running. Example: a worker
 * was launched after the digest and is still working; cleanup must wait for it.
 * Solution: the journal tree of the run gives every participant's state. A participant the stored package names but
 * the journal no longer has, or a missing journal, is unknown.
 * Deliveries and handoff are not in the journal, so they are known only in the safe case below.
 *
 * Problem: a run with a live participant may still receive a queued message or hand off, and the journal cannot show
 * either. Example: a root in "done" waits for a user message, so cleanup must not assume its queue is empty.
 * Solution: when every participant of the run is "exited", the hub has closed them. A closed agent's queue is emptied
 * and it cannot hand off, so deliveries are 0 and handoff is false. Any other state keeps both null.
 */
export function runtimePorts(
	options: RuntimePortOptions,
): Pick<RuntimeOptions, "operationalState" | "currentFingerprint"> {
	return {
		operationalState: (runId) => {
			const records = readJournal(options.journalDir);
			const root = rootOf(records, runId);
			const stored = storedRun(options.storeDir, runId);
			if (!root || !stored) return { states: [], deliveries: null, handoff: null, livenessKnown: false };
			const tree = treeOf(records, root.id);
			const known = new Set(tree.map((record) => record.id));
			const livenessKnown = stored.agents.length > 0 && stored.agents.every((agent) => known.has(agent.id));
			const closed = livenessKnown && tree.every((record) => record.state === "exited");
			return {
				states: tree.map((record) => runtimeState(record.state)),
				deliveries: closed ? 0 : null,
				handoff: closed ? false : null,
				livenessKnown,
			};
		},
		currentFingerprint: (revision) => {
			const match = REVISION_ID.exec(revision);
			if (!match) return undefined;
			const [, runId, number] = match;
			const stored = storedRun(options.storeDir, runId);
			// Only the newest revision has a source that can be compared with what the digest read.
			if (!stored || stored.revision !== Number(number)) return undefined;
			const records = readJournal(options.journalDir);
			const root = rootOf(records, runId);
			if (!root) return undefined;
			return previewRunFingerprint(records, root, openMemory(options.storeDir), {
				by: stored.by,
				roots: options.roots,
			});
		},
	};
}
