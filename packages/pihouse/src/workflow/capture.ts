// Flags and capture: which workflow runs the memory keeps, and how one is written down.
// A run is the whole agent tree from the agent-link journal. Capture is code only (ADR-001, D5): it builds the run,
// computes the metrics, copies every transcript and hands the package to the store. No model runs, and no model
// reads a transcript here. Spec: docs/specs/workflow-memory.md, "Flags and capture (T4)".

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SessionRecord } from "agent-link-core";
import { treeOf } from "agent-link-core";
import { locateTranscript, parsePi, type Transcript, type TranscriptRoots, type Usage } from "agent-transcripts";
import { capturedAdmission, cleanedCursors } from "./cleanup.ts";
import { persistEvidence } from "./evidence-store.ts";
import type { MemoryStore, RunAgentEntry, RunPackage, RunTranscript } from "./memory.ts";
import { ACTIVE_MARKER } from "./migration.ts";
import { newTokens, renderEvidenceReport, type WorkflowEvidence, type WorkflowEvidenceParticipant } from "./report.ts";
import { buildRun, isExecutor, type RunAgent, type WorkflowRun } from "./run.ts";
import { inspectJsonlCursor, type JsonlSourceCursor } from "./source-cursor.ts";
import { openOperationalStore } from "./storage.ts";

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
	opts: { by: FlagBy; reason?: string; now?: Date; includeRaw?: boolean },
): { pkg: RunPackage; transcripts: RunTranscript[] } {
	const transcripts: RunTranscript[] = [];
	const agents = run.agents.map((a): RunAgentEntry => {
		const id = a.record.id;
		if (a.transcript)
			transcripts.push({
				agentId: id,
				normalized: a.transcript,
				raw: opts.includeRaw === false ? null : rawOf(a.record.harness, a.transcript.source),
			});
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
	cursor?: Record<string, StoredSourceCursor>;
};

type StoredSourceCursor =
	| (JsonlSourceCursor & { appendedRecordIds: string[] })
	| { sourceKind: "unknown"; sourceId: string | null; reason: string; appendedRecordIds: [] };

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function usageEvidence(value: Record<string, unknown>): Partial<Usage> {
	const usage: Partial<Usage> = {};
	for (const key of USAGE_KEYS) {
		const count = value[key];
		if (typeof count === "number" && Number.isFinite(count)) usage[key] = count;
	}
	return usage;
}

function observedUsage(
	agent: RunAgent | undefined,
	value: Record<string, unknown>,
	continuation: boolean,
): Partial<Usage> {
	if (!agent?.transcript || agent.missing) return {};
	const assistants = agent.transcript.messages.filter((message) => message.role === "assistant");
	if (assistants.length === 0) return continuation ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : {};
	if (assistants.some((message) => message.usage === undefined)) return {};
	return usageEvidence(value);
}

function timingKnown(agent: RunAgent | undefined): boolean {
	if (!agent?.transcript || agent.missing) return false;
	return agent.transcript.messages
		.filter((message) => message.role === "assistant")
		.every((message) => message.durationMs !== undefined);
}

function mergeUsage(previous: Partial<Usage>, next: Partial<Usage>): Partial<Usage> {
	const merged: Partial<Usage> = {};
	for (const key of USAGE_KEYS) {
		const oldValue = previous[key];
		const nextValue = next[key];
		if (oldValue !== undefined && nextValue !== undefined) merged[key] = oldValue + nextValue;
	}
	return merged;
}

function mergeMetric(previous: number | null, next: number | null): number | null {
	return previous === null || next === null ? null : previous + next;
}

function mergeEvidence(
	previous: StoredPackage | undefined,
	next: WorkflowEvidence,
	sourceChanged: boolean,
): WorkflowEvidence {
	const oldEvidence = previous?.evidence as WorkflowEvidence | undefined;
	if (!oldEvidence || !Array.isArray(oldEvidence.participants)) return next;
	const oldById = new Map(oldEvidence.participants.map((participant) => [participant.id, participant]));
	const participants = next.participants.map((participant) => {
		const old = oldById.get(participant.id);
		const cursor = next.cursor[participant.id];
		const appendedRecordIds =
			cursor && typeof cursor === "object" ? Reflect.get(cursor, "appendedRecordIds") : undefined;
		const hasNewEvidence = Array.isArray(appendedRecordIds) && appendedRecordIds.length > 0;
		return old ? mergeParticipant(old, participant, hasNewEvidence) : participant;
	});
	const usageComplete = participants.every((participant) =>
		USAGE_KEYS.every((key) => participant.usage[key] !== undefined),
	);
	const usage = participants.reduce<Usage>(
		(total, participant) => ({
			input: total.input + (participant.usage.input ?? 0),
			output: total.output + (participant.usage.output ?? 0),
			cacheRead: total.cacheRead + (participant.usage.cacheRead ?? 0),
			cacheWrite: total.cacheWrite + (participant.usage.cacheWrite ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
	const activeKnown = participants.every((participant) => participant.activeMs !== null);
	const messagesKnown = participants.every((participant) => participant.messages !== null);
	return {
		...next,
		participants,
		metrics: {
			newTokens: usageComplete ? newTokens(usage) : null,
			cacheRead: usageComplete ? usage.cacheRead : null,
			activeMs: activeKnown
				? participants.reduce((total, participant) => total + (participant.activeMs ?? 0), 0)
				: null,
			wallMs: sourceChanged ? null : oldEvidence.metrics.wallMs,
			agents: participants.length,
			messages: messagesKnown
				? participants.reduce((total, participant) => total + (participant.messages ?? 0), 0)
				: null,
		},
	};
}

function mergeParticipant(
	previous: WorkflowEvidenceParticipant,
	next: WorkflowEvidenceParticipant,
	hasNewEvidence: boolean,
): WorkflowEvidenceParticipant {
	const a = previous.summary;
	const b = next.summary;
	const summary =
		a || b
			? {
					...(a?.assistantMessages !== undefined && b?.assistantMessages !== undefined
						? { assistantMessages: a.assistantMessages + b.assistantMessages }
						: {}),
					...(a?.slowestMs !== undefined && b?.slowestMs !== undefined
						? { slowestMs: Math.max(a.slowestMs, b.slowestMs) }
						: {}),
					...(a?.failedToolCalls !== undefined && b?.failedToolCalls !== undefined
						? { failedToolCalls: a.failedToolCalls + b.failedToolCalls }
						: {}),
					...(a?.toolCalls !== undefined && b?.toolCalls !== undefined ? { toolCalls: a.toolCalls + b.toolCalls } : {}),
				}
			: null;
	return {
		...next,
		taskId: next.taskId ?? previous.taskId,
		taskTitle: next.taskTitle ?? previous.taskTitle,
		assignedSkills: [...new Set([...previous.assignedSkills, ...next.assignedSkills])],
		loadedSkills: [...new Set([...previous.loadedSkills, ...next.loadedSkills])],
		usage: hasNewEvidence ? mergeUsage(previous.usage, next.usage) : previous.usage,
		activeMs: hasNewEvidence ? mergeMetric(previous.activeMs, next.activeMs) : previous.activeMs,
		messages: hasNewEvidence ? mergeMetric(previous.messages, next.messages) : previous.messages,
		missing: next.missing ?? previous.missing,
		summary: hasNewEvidence ? summary : previous.summary,
	};
}

const runFile = (store: MemoryStore, id: string) => join(store.dir, "runs", id, "run.json");

function readPackage(store: MemoryStore, id: string): StoredPackage | undefined {
	try {
		return JSON.parse(readFileSync(runFile(store, id), "utf8")) as StoredPackage;
	} catch {
		return undefined;
	}
}

function lineageForSession(store: MemoryStore, sessionId: string, project: string): string | undefined {
	for (const entry of store.readIndex()) {
		if (entry.kind !== "run") continue;
		const id = entry.id.slice("run:".length);
		const pkg = readPackage(store, id);
		const cursors = pkg?.cursor ? Object.values(pkg.cursor) : [];
		if (
			pkg?.project === project &&
			cursors.some((cursor) => cursor?.sourceKind === "jsonl" && cursor.sourceId === sessionId)
		) {
			const evidence = pkg?.evidence;
			if (evidence && typeof evidence === "object") {
				const lineage = Reflect.get(evidence, "lineage");
				if (typeof lineage === "string") return lineage;
			}
			return pkg?.id;
		}
	}
	return undefined;
}

/** What one capture did. A deferred run says why; a processed, discarded or deferred run writes nothing. */
export type CaptureOutcome =
	| { status: "written" | "processed" | "discarded" }
	| { status: "deferred"; reason: string }
	| { status: "previewed"; fingerprint: string };

/** The newest revision of a run when its captured copies were cleaned; undefined when it was not (legacy or pending). */
function cleanedLatest(
	db: DatabaseSync,
	runId: string,
): { sourceHash: string; cursors: Record<string, StoredSourceCursor> | undefined } | undefined {
	const row = db
		.prepare(
			"SELECT r.source_hash, m.state FROM revisions r LEFT JOIN cleanup_manifests m ON m.id = r.id WHERE r.run_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1",
		)
		.get(runId);
	if (row?.state !== "cleaned" || typeof row.source_hash !== "string") return undefined;
	const cursors = cleanedCursors(db, runId);
	const verifiable = typeof cursors === "object" && cursors !== null && !Array.isArray(cursors);
	return {
		sourceHash: row.source_hash,
		cursors: verifiable ? (cursors as Record<string, StoredSourceCursor>) : undefined,
	};
}

/** Runs a read on the operational store of an activated memory; an unactivated memory has none. */
function operationalRead<T>(store: MemoryStore, read: (db: DatabaseSync) => T): T | undefined {
	if (!existsSync(join(store.dir, ACTIVE_MARKER))) return undefined;
	const operational = openOperationalStore(join(store.dir, "memory.sqlite"), { fts: false, legacy: true });
	try {
		return read(operational.db);
	} finally {
		operational.close();
	}
}

/** Captures one run through the store: the tree as one package, `report.md` and a copy of every transcript. */
export function captureRun(
	records: readonly SessionRecord[],
	root: SessionRecord,
	store: MemoryStore,
	opts: { by: FlagBy; reason?: string; roots?: TranscriptRoots; now?: Date },
): CaptureOutcome["status"] {
	return captureRunOutcome(records, root, store, opts).status;
}

/**
 * Captures one run through the store. Capturing a pending run again replaces it. A legacy processed run, one with no
 * cleanup receipt, is left alone ("processed").
 * Problem: the planner's agent_end fires after every answer, and a review recorded in run.json was lost each time.
 * Solution: the earlier package's `review` path is carried over.
 * Problem: a session that continues after its digest was committed and its copies cleaned. Example: the planner
 * resumes and appends two answers. Re-importing the whole native file would recapture evidence the digest already
 * covered. Solution: an activated store resumes from the cleaned revision's cursors, writes only the appended delta as
 * a new revision under the same lineage, and discards a capture whose evidence fingerprint was already cleaned.
 * Anything unverifiable (rotated, truncated, a fork without its parent) is deferred with its reason, never reimported.
 */
export function captureRunOutcome(
	records: readonly SessionRecord[],
	root: SessionRecord,
	store: MemoryStore,
	opts: { by: FlagBy; reason?: string; roots?: TranscriptRoots; now?: Date; preview?: boolean },
): CaptureOutcome {
	const defer = (reason: string): CaptureOutcome => ({ status: "deferred", reason });
	const previous = readPackage(store, root.id);
	const cleaned = operationalRead(store, (db) => cleanedLatest(db, root.id));
	if (!cleaned && store.readIndex().some((entry) => entry.id === `run:${root.id}` && entry.status === "processed"))
		return { status: "processed" };
	if (cleaned && (!previous || previous.fingerprint !== cleaned.sourceHash))
		return defer("retained run package does not match its cleaned revision");
	if (cleaned && !cleaned.cursors) return defer("cleaned revision retains no verifiable source cursor");
	const priorCursors = cleaned ? cleaned.cursors : previous?.cursor;
	const tree = treeOf(records, root.id);
	const currentIds = new Set(tree.map((record) => record.id));
	if (priorCursors && Object.keys(priorCursors).some((id) => !currentIds.has(id)))
		return defer("a captured participant is no longer in the journal tree");
	const sourceCursors: Record<string, StoredSourceCursor> = {};
	const sourcePaths: Record<string, string> = {};
	const transcriptOverrides = new Map<string, Transcript>();
	for (const record of tree) {
		const prior = priorCursors?.[record.id];
		if (prior?.sourceKind === "unknown") return defer("a participant with an unverifiable source cannot be resumed");
		if (prior && prior.sourceKind !== "jsonl") return defer("a participant with a non-pi cursor cannot be resumed");
		const sourcePath = locateTranscript(
			{
				harness: record.harness,
				sessionId: record.sessionId,
				transcript: record.transcript,
				worker: record.parent !== null,
			},
			opts.roots,
		);
		if ((record.harness !== "pi" && record.harness !== "pihouse") || !sourcePath || !record.sessionId) {
			if (prior) return defer("a resumed participant is no longer a verifiable pi JSONL stream");
			sourceCursors[record.id] = {
				sourceKind: "unknown",
				sourceId: record.sessionId ?? null,
				reason: "source is not a verifiable pi JSONL stream",
				appendedRecordIds: [],
			};
			continue;
		}
		const inspected = inspectJsonlCursor(sourcePath, record.sessionId, prior ?? null);
		if (inspected.state !== "verified") return defer(inspected.reason);
		const cursorUnchanged =
			prior?.sourceKind === "jsonl" &&
			prior.byteOffset === inspected.cursor.byteOffset &&
			prior.prefixFingerprint === inspected.cursor.prefixFingerprint;
		sourceCursors[record.id] = {
			...inspected.cursor,
			appendedRecordIds: cursorUnchanged ? prior.appendedRecordIds : inspected.appendedRecordIds,
		};
		sourcePaths[record.id] = sourcePath;
		if (prior?.sourceKind === "jsonl") {
			const delta = parsePi(inspected.appendedText, sourcePath, record.harness);
			transcriptOverrides.set(record.id, { ...delta, cwd: record.cwd });
		}
	}
	const run = buildRun(records, root, opts.roots, transcriptOverrides);
	for (const [id, cursor] of Object.entries(sourceCursors)) {
		if (cursor.sourceKind !== "jsonl") continue;
		const record = tree.find((item) => item.id === id);
		const path = sourcePaths[id];
		if (!record?.sessionId || !path) return defer("source identity is unknown");
		const confirmed = inspectJsonlCursor(path, record.sessionId, null);
		if (
			confirmed.state !== "verified" ||
			confirmed.cursor.byteOffset !== cursor.byteOffset ||
			confirmed.cursor.prefixFingerprint !== cursor.prefixFingerprint
		)
			return defer("source changed while it was being read");
	}
	const { pkg, transcripts } = packageOf(run, { ...opts, includeRaw: !previous });
	const completeSummaries = pkg.agents.every((agent) => agent.missing === null);
	const rootCursor = sourceCursors[root.id];
	const forkedFrom = rootCursor?.sourceKind === "jsonl" ? rootCursor.forkedFrom : null;
	const forkLineage = forkedFrom ? lineageForSession(store, forkedFrom, pkg.project) : undefined;
	if (cleaned && forkedFrom && !forkLineage)
		return defer("fork parent lineage is not retained, so a cleaned fork cannot be resumed");
	const evidenceUsageComplete = pkg.agents.every((agent) => {
		const runAgent = run.agents.find((item) => item.record.id === agent.id);
		const continuation = priorCursors?.[agent.id]?.sourceKind === "jsonl";
		const usage = observedUsage(runAgent, agent.usage, continuation);
		return USAGE_KEYS.every((key) => usage[key] !== undefined);
	});
	const evidenceTimingComplete = pkg.agents.every(
		(agent) => agent.missing === null && timingKnown(run.agents.find((item) => item.record.id === agent.id)),
	);
	let evidence: WorkflowEvidence = {
		lineage: forkLineage ?? pkg.id,
		lineageStatus: forkedFrom
			? forkLineage
				? "fork-parent-lineage-resolved"
				: "unknown; fork parent not retained"
			: "root-id",
		forkProvenance: forkedFrom ?? "unknown",
		destructiveEligibility: "deferred",
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
			}) => {
				const runAgent = run.agents.find((item) => item.record.id === id);
				const sourceCursor = sourceCursors[id];
				const continuation = sourceCursor?.sourceKind === "jsonl" && priorCursors?.[id]?.sourceKind === "jsonl";
				const measuredTiming = timingKnown(runAgent);
				return {
					id,
					parent,
					role,
					harness,
					model,
					taskId: taskId ?? null,
					taskTitle: taskTitle ?? null,
					assignedSkills,
					loadedSkills,
					usage: observedUsage(runAgent, usage, continuation),
					activeMs: missing || !measuredTiming ? null : activeMs,
					messages: missing ? null : messages,
					missing,
					summary: runAgent?.summary
						? {
								assistantMessages: runAgent.summary.assistantMessages,
								...(measuredTiming ? { slowestMs: runAgent.summary.slowestMs } : {}),
								failedToolCalls: runAgent.summary.failedToolCalls,
								toolCalls: runAgent.summary.toolCalls,
							}
						: null,
				};
			},
		),
		metrics: {
			newTokens: evidenceUsageComplete ? pkg.metrics.newTokens : null,
			cacheRead: evidenceUsageComplete ? pkg.metrics.cacheRead : null,
			activeMs: evidenceTimingComplete ? pkg.metrics.activeMs : null,
			wallMs:
				completeSummaries &&
				run.agents.every((agent) => agent.transcript?.startedAt !== undefined && agent.transcript.endedAt !== undefined)
					? pkg.metrics.wallMs
					: null,
			agents: pkg.metrics.agents,
			messages: completeSummaries ? pkg.metrics.messages : null,
		},
		cursor: sourceCursors,
	};
	const sourceChanged = Object.entries(sourceCursors).some(([id, cursor]) => {
		const old = priorCursors?.[id];
		return (
			cursor.sourceKind !== "jsonl" ||
			old?.sourceKind !== "jsonl" ||
			old.byteOffset !== cursor.byteOffset ||
			old.prefixFingerprint !== cursor.prefixFingerprint
		);
	});
	evidence = mergeEvidence(previous, evidence, sourceChanged);
	const evidenceById = new Map(evidence.participants.map((participant) => [participant.id, participant]));
	pkg.agents = pkg.agents.map((agent) => {
		const participant = evidenceById.get(agent.id);
		return participant
			? {
					...agent,
					usage: { ...participant.usage },
					activeMs: participant.activeMs ?? 0,
					messages: participant.messages ?? 0,
					assignedSkills: participant.assignedSkills,
					loadedSkills: participant.loadedSkills,
				}
			: agent;
	});
	pkg.metrics = {
		newTokens: evidence.metrics.newTokens ?? 0,
		cacheRead: evidence.metrics.cacheRead ?? 0,
		activeMs: evidence.metrics.activeMs ?? 0,
		wallMs: evidence.metrics.wallMs ?? 0,
		agents: evidence.metrics.agents,
		messages: evidence.metrics.messages ?? 0,
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
	const revision = previous?.fingerprint === fingerprint ? (previous.revision ?? 1) : (previous?.revision ?? 0) + 1;
	const review = previous?.review;
	const stored: StoredPackage = {
		...pkg,
		evidence,
		fingerprint,
		revision,
		cursor: sourceCursors,
		...(review ? { review } : {}),
	};
	if (opts.preview) return { status: "previewed", fingerprint };
	// Problem: a cleaned revision's evidence fingerprint can come back unchanged. Example: a resume with no new lines.
	// Solution: an identical cleaned fingerprint is discarded before anything is written, so it is never reimported.
	const admitted = operationalRead(store, (db) => capturedAdmission(db, pkg.id, fingerprint)) ?? "admit";
	if (admitted === "discarded") return { status: "discarded" };
	const result = store.writeRun(stored, transcripts, renderEvidenceReport(evidence), { reopen: cleaned !== undefined });
	if (result === "written" && existsSync(join(store.dir, ACTIVE_MARKER))) {
		const operational = openOperationalStore(join(store.dir, "memory.sqlite"), { fts: false, legacy: true });
		try {
			persistEvidence(operational.db, {
				runId: pkg.id,
				revision,
				fingerprint,
				evidence,
				capturedAt: pkg.capturedAt,
			});
		} finally {
			operational.close();
		}
	}
	return { status: result };
}

/**
 * The evidence fingerprint a capture of this run would write now, and nothing is written.
 * Problem: cleanup may delete captured copies only while their source is unchanged, and that check must not change
 * the source or the store. Example: a session appended a line after its digest; the preview differs and cleanup waits.
 * Solution: the capture pipeline runs up to the point where it would write, then stops; anything it cannot verify
 * yields undefined.
 */
export function previewRunFingerprint(
	records: readonly SessionRecord[],
	root: SessionRecord,
	store: MemoryStore,
	opts: { by: FlagBy; roots?: TranscriptRoots; now?: Date },
): string | undefined {
	const outcome = captureRunOutcome(records, root, store, { ...opts, preview: true });
	return outcome.status === "previewed" ? outcome.fingerprint : undefined;
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
		if (
			captureRun(records, root, store, { by: flag.by, reason: flag.reason, roots: opts.roots, now: opts.now }) ===
			"written"
		)
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
