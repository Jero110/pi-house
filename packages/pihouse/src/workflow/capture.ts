// Flags and capture: which workflow runs the memory keeps, and how one is written down.
// A run is the whole agent tree from the agent-link journal. Capture is code only (ADR-001, D5): it builds the run,
// computes the metrics, copies every transcript and hands the package to the store. No model runs, and no model
// reads a transcript here. Spec: docs/specs/workflow-memory.md, "Flags and capture (T4)".

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionRecord } from "agent-link-core";
import { treeOf } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import type { MemoryStore, RunAgentEntry, RunPackage, RunTranscript } from "./memory.ts";
import { newTokens, renderReport } from "./report.ts";
import { buildRun, isExecutor, type WorkflowRun } from "./run.ts";

export type FlagBy = RunPackage["flaggedBy"];

export interface Flag {
	reason?: string;
	by: FlagBy;
	at: string;
}

export interface FlagsFile {
	schema: 1;
	runs: Record<string, Flag>;
}

export const TITLE_MAX = 80;
const WORKFLOW_PREFIX = "workflow-";

const flagsFile = (dir: string) => join(dir, "flags.json");

function atomicWrite(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** flags.json of the memory dir; an unreadable or missing file is an empty one. */
export function readFlags(dir: string): FlagsFile {
	try {
		const v = JSON.parse(readFileSync(flagsFile(dir), "utf8")) as Partial<FlagsFile>;
		return { schema: 1, runs: v.runs && typeof v.runs === "object" ? v.runs : {} };
	} catch {
		return { schema: 1, runs: {} };
	}
}

/**
 * Flags a run. An earlier flag keeps its reason unless a new one is given, and a `save` is never downgraded by the
 * automatic flags that come after it.
 * Problem: the user saves a planner run with a reason, then the planner's next agent_end flags it again as "planner"
 * with no reason, and the reason is gone. Solution: merge, with the explicit save winning.
 */
export function addFlag(dir: string, runId: string, flag: { reason?: string; by: FlagBy }, now = new Date()): Flag {
	const file = readFlags(dir);
	const old = file.runs[runId];
	const merged: Flag = {
		by: old?.by === "save" ? "save" : flag.by,
		at: old?.at ?? now.toISOString(),
	};
	const reason = flag.reason ?? old?.reason;
	if (reason) merged.reason = reason;
	file.runs[runId] = merged;
	atomicWrite(flagsFile(dir), `${JSON.stringify(file, null, "\t")}\n`);
	return merged;
}

/**
 * Whether a run is flagged, and by whom: the explicit flag first, then an executor in its tree, then an agent named
 * `workflow-…`. Undefined means the run stays out of the memory.
 */
export function isFlagged(
	records: readonly SessionRecord[],
	root: SessionRecord,
	flags: FlagsFile,
): { by: FlagBy; reason?: string } | undefined {
	const flag = flags.runs[root.id];
	if (flag) return { by: flag.by, reason: flag.reason };
	const tree = treeOf(records, root.id);
	if (tree.some((r) => r.id !== root.id && isExecutor(r))) return { by: "executor" };
	const named = tree.find((r) => r.name.startsWith(WORKFLOW_PREFIX));
	if (!named) return undefined;
	return { by: named.name.startsWith("workflow-planner") ? "planner" : "executor" };
}

/** The tree of the session asking, found by its pi session id or agent-link name. Unlike pickRoot, never a guess. */
export function ownRoot(
	records: readonly SessionRecord[],
	current: { sessionId?: string; agent?: string },
): SessionRecord | undefined {
	const mine =
		(current.sessionId ? records.find((r) => r.sessionId === current.sessionId) : undefined) ??
		(current.agent ? records.find((r) => r.name === current.agent) : undefined);
	return mine ? (records.find((r) => r.id === mine.root) ?? mine) : undefined;
}

/**
 * A root for a session the hub never saw (`PIHOUSE_NO_LINK=1`): the session alone, read from its own file.
 * Problem: no hub means no journal record, so /workflow save had no run to capture. Example: a plain chat in a
 * terminal. Solution: a made-up record with the id `local-<pi session id>`.
 */
export function localRecord(
	sessionId: string,
	cwd: string,
	transcript: string | undefined,
	now = new Date(),
): SessionRecord {
	const id = `local-${sessionId}`;
	const at = now.toISOString();
	return {
		id,
		name: "pihouse",
		parent: null,
		parentName: null,
		root: id,
		harness: "pihouse",
		model: null,
		cwd,
		state: "exited",
		depth: 0,
		sessionId,
		transcript,
		startedAt: at,
		updatedAt: at,
	};
}

/** The git top-level of a folder, else the folder; with its short name. Not chosen by a model. */
export function projectOf(cwd: string): { project: string; projectSlug: string } {
	let project = cwd;
	try {
		project = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Not a git folder, or no git: the folder itself.
	}
	return { project, projectSlug: basename(project) || "project" };
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

export function capTitle(text: string, max = TITLE_MAX): string {
	const t = flat(text);
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The title of a run: the plan's slug, else the reason, else the root's first request. At most 80 chars.
 * Problem: a captured run needs a short name for the index, and a model call to write one would make every capture
 * cost tokens (ADR-001, D5). Solution: pick from what is already there.
 */
export function titleOf(run: WorkflowRun, reason: string | undefined): string {
	const slug = run.plan?.split("/").pop()?.replace(/\.md$/, "");
	if (slug) return capTitle(slug);
	if (reason && flat(reason)) return capTitle(reason);
	return capTitle(run.root.name);
}

function wallOf(run: WorkflowRun): number {
	const starts = run.agents.map((a) => a.transcript?.startedAt).filter((x): x is number => x !== undefined);
	const ends = run.agents.map((a) => a.transcript?.endedAt).filter((x): x is number => x !== undefined);
	return starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
}

/** The raw harness file, when the transcript came from one (opencode's is a database shared by every session). */
function rawOf(harness: string, source: string | undefined): Uint8Array | null {
	if (!source || harness === "opencode") return null;
	try {
		return readFileSync(source);
	} catch {
		return null;
	}
}

/** The package and the files to copy for a run. Pure but for reading the transcripts' raw files. */
export function packageOf(
	run: WorkflowRun,
	opts: { by: FlagBy; reason?: string; now?: Date },
): { pkg: RunPackage; transcripts: RunTranscript[] } {
	const transcripts: RunTranscript[] = [];
	const agents = run.agents.map((a): RunAgentEntry => {
		const id = a.record.id;
		if (a.transcript)
			transcripts.push({ agentId: id, normalized: a.transcript, raw: rawOf(a.record.harness, a.transcript.source) });
		const raw = transcripts.find((t) => t.agentId === id)?.raw;
		return {
			id,
			name: a.record.name,
			parent: a.record.parent,
			role: a.role,
			harness: a.record.harness,
			model: a.summary?.models.join(", ") || a.record.model || "",
			taskId: a.taskId,
			taskTitle: a.taskTitle ? capTitle(a.taskTitle, 120) : undefined,
			assignedSkills: a.assignedSkills,
			loadedSkills: a.summary?.skills ?? [],
			usage: { ...(a.summary?.usage ?? {}) },
			activeMs: a.summary?.activeMs ?? 0,
			messages: a.summary?.messages ?? 0,
			transcript: a.transcript ? `transcripts/${id}.json` : "",
			raw: raw ? `transcripts/${id}.jsonl` : null,
			missing: a.missing ?? (a.transcript ? null : "no transcript"),
		};
	});
	let newT = 0;
	let cacheRead = 0;
	for (const a of run.agents) {
		if (!a.summary) continue;
		newT += newTokens(a.summary.usage);
		cacheRead += a.summary.usage.cacheRead;
	}
	const pkg: RunPackage = {
		schema: 1,
		id: run.root.id,
		...projectOf(run.root.cwd),
		flaggedBy: opts.by,
		capturedAt: (opts.now ?? new Date()).toISOString(),
		title: titleOf(run, opts.reason),
		metrics: {
			newTokens: newT,
			cacheRead,
			activeMs: agents.reduce((n, a) => n + a.activeMs, 0),
			wallMs: wallOf(run),
			agents: agents.length,
			messages: agents.reduce((n, a) => n + a.messages, 0),
		},
		agents,
	};
	if (opts.reason) pkg.reason = opts.reason;
	if (run.plan) pkg.plan = run.plan;
	return { pkg, transcripts };
}

type StoredPackage = RunPackage & {
	review?: string;
	evidence?: unknown;
	fingerprint?: string;
	revision?: number;
	cursor?: Record<string, string>;
};

const runFile = (store: MemoryStore, id: string) => join(store.dir, "runs", id, "run.json");

function readPackage(store: MemoryStore, id: string): StoredPackage | undefined {
	try {
		return JSON.parse(readFileSync(runFile(store, id), "utf8")) as StoredPackage;
	} catch {
		return undefined;
	}
}

/**
 * Captures one run through the store: the tree as one package, `report.md` and a copy of every transcript.
 * Capturing a pending run again replaces it; a processed run is left alone ("processed").
 * Problem: the planner's agent_end fires after every answer, and a review recorded in run.json was lost each time.
 * Solution: the earlier package's `review` path is carried over.
 */
export function captureRun(
	records: readonly SessionRecord[],
	root: SessionRecord,
	store: MemoryStore,
	opts: { by: FlagBy; reason?: string; roots?: TranscriptRoots; now?: Date },
): "written" | "processed" {
	const run = buildRun(records, root, opts.roots);
	const { pkg, transcripts } = packageOf(run, opts);
	const previous = readPackage(store, pkg.id);
	const completeUsage = pkg.agents.every((agent) =>
		["input", "output", "cacheRead", "cacheWrite"].every(
			(key) => typeof agent.usage[key] === "number" && Number.isFinite(agent.usage[key]),
		),
	);
	const completeSummaries = pkg.agents.every((agent) => agent.missing === null);
	const evidence = {
		lineage: pkg.id,
		title: root.name,
		project: pkg.project,
		plan: pkg.plan ?? null,
		participants: pkg.agents.map(
			({
				id,
				parent,
				role,
				harness,
				model,
				taskId,
				taskTitle,
				assignedSkills,
				loadedSkills,
				usage,
				activeMs,
				messages,
				missing,
			}) => ({
				id,
				parent,
				role,
				harness,
				model,
				taskId: taskId ?? null,
				taskTitle: taskTitle ?? null,
				assignedSkills,
				loadedSkills,
				usage,
				activeMs: missing ? null : activeMs,
				messages: missing ? null : messages,
				missing,
				summary: run.agents.find((item) => item.record.id === id)?.summary
					? {
							assistantMessages: run.agents.find((item) => item.record.id === id)?.summary?.assistantMessages,
							slowestMs: run.agents.find((item) => item.record.id === id)?.summary?.slowestMs,
							failedToolCalls: run.agents.find((item) => item.record.id === id)?.summary?.failedToolCalls,
							toolCalls: run.agents.find((item) => item.record.id === id)?.summary?.toolCalls,
						}
					: null,
			}),
		),
		metrics: {
			newTokens: completeUsage ? pkg.metrics.newTokens : null,
			cacheRead: completeUsage ? pkg.metrics.cacheRead : null,
			activeMs: completeSummaries ? pkg.metrics.activeMs : null,
			wallMs: completeSummaries ? pkg.metrics.wallMs : null,
			agents: pkg.metrics.agents,
			messages: completeSummaries ? pkg.metrics.messages : null,
		},
		cursor: Object.fromEntries(run.agents.map((agent) => [agent.record.id, agent.record.updatedAt])),
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
	const revision = previous?.fingerprint === fingerprint ? (previous.revision ?? 1) : (previous?.revision ?? 0) + 1;
	const review = previous?.review;
	const stored: StoredPackage = {
		...pkg,
		evidence,
		fingerprint,
		revision,
		cursor: Object.fromEntries(run.agents.map((agent) => [agent.record.id, agent.record.updatedAt])),
		...(review ? { review } : {}),
	};
	const reportRun = {
		...run,
		root: { ...run.root, task: undefined },
		agents: run.agents.map((agent) => ({
			...agent,
			record: { ...agent.record, task: undefined },
			transcript: undefined,
		})),
	};
	return store.writeRun(stored, transcripts, `${renderReport(reportRun, { messages: false })}\n`);
}

/** Records in run.json where a review of the run was written. A run not captured has nowhere to record it. */
export function recordReview(store: MemoryStore, id: string, reportPath: string): boolean {
	const pkg = readPackage(store, id);
	if (!pkg) return false;
	atomicWrite(runFile(store, id), `${JSON.stringify({ ...pkg, review: reportPath }, null, "\t")}\n`);
	return true;
}

/** The journal's roots, oldest first. */
export function rootsOf(records: readonly SessionRecord[]): SessionRecord[] {
	return records.filter((r) => r.parent === null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Captures every flagged root that is not in the memory yet. The keeper runs it before it counts, and
 * `review --last` before it picks, so a run whose session ended without an agent_end is still kept.
 * Returns the run ids it captured.
 */
export function sweepFlagged(
	records: readonly SessionRecord[],
	store: MemoryStore,
	opts: { roots?: TranscriptRoots; now?: Date } = {},
): string[] {
	const flags = readFlags(store.dir);
	const known = new Set(store.readIndex().map((e) => e.id));
	const done: string[] = [];
	for (const root of rootsOf(records)) {
		if (known.has(`run:${root.id}`)) continue;
		const flag = isFlagged(records, root, flags);
		if (!flag) continue;
		captureRun(records, root, store, { by: flag.by, reason: flag.reason, roots: opts.roots, now: opts.now });
		done.push(root.id);
	}
	return done;
}

export type LastFlagged = { root: SessionRecord } | { stored: string };

/**
 * The newest flagged run: a flagged tree in the journal, or a captured run the journal no longer has (a local
 * session). Unflagged trees never count.
 */
export function lastFlagged(records: readonly SessionRecord[], store: MemoryStore): LastFlagged | undefined {
	const flags = readFlags(store.dir);
	const inJournal = new Set(records.map((r) => r.id));
	const candidates: { at: string; pick: LastFlagged }[] = [];
	for (const root of rootsOf(records))
		if (isFlagged(records, root, flags)) candidates.push({ at: root.startedAt, pick: { root } });
	for (const e of store.readIndex())
		if (e.kind === "run" && e.status !== "archived") {
			const id = e.id.slice("run:".length);
			if (!inJournal.has(id)) candidates.push({ at: e.createdAt, pick: { stored: id } });
		}
	candidates.sort((a, b) => a.at.localeCompare(b.at));
	return candidates.at(-1)?.pick;
}

/** The report text and plan of a captured run, for a review of a run the journal no longer has. */
export function storedReport(store: MemoryStore, id: string): { report: string; plan?: string } | undefined {
	const file = join(store.dir, "runs", id, "report.md");
	if (!existsSync(file)) return undefined;
	return { report: readFileSync(file, "utf8"), plan: readPackage(store, id)?.plan };
}
