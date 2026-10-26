// The session journal: one JSON file per agent in <home>/sessions, written by the hub as the agent starts,
// changes state, reports its native session and ends.
//
// Problem: everything the hub knows about its agents lives in its memory, so it is gone when the hub or an
// agent dies. Example: a Claude worker stops halfway through a task and the hub is restarted; nobody can tell
// which pane it ran in, which session it was, or where its transcript is, to read what it got done.
// Solution: the hub writes each agent's record to disk on every change (atomic rename), with the harness's
// own session id and transcript path. Any later process (another agent, the cmux MCP, `agent-link sessions`)
// reads these files and the harness's transcript, without a running hub.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentState, BackendName, PlaceHint } from "./types.ts";

export interface SessionRecord {
	/** Unique across hub runs: start time and name, e.g. 20261023T101500Z-claude-2. */
	id: string;
	name: string;
	/** The parent's journal id; null for a root. */
	parent: string | null;
	parentName: string | null;
	/** The journal id of the tree's root. */
	root: string;
	harness: string;
	model: string | null;
	cwd: string;
	/** The task the parent gave, for workers. */
	task?: string;
	state: AgentState;
	depth: number;
	backend?: BackendName;
	/** The pane the hub opened for a worker (cmux surface ref, tmux pane id). */
	pane?: string;
	/** Where a root's terminal is, as it said at registration. */
	place?: PlaceHint;
	/** The harness's own session: Claude session id, Codex thread id, opencode session id, pi session id. */
	sessionId?: string;
	/** The transcript file, when the harness keeps one and the adapter knows it. */
	transcript?: string;
	pid?: number;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
}

/** The fields a later change may set. */
export type SessionPatch = Partial<Omit<SessionRecord, "id" | "name" | "root" | "startedAt">>;

export function journalId(name: string, at: Date): string {
	const stamp = at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return `${stamp}-${name}`;
}

export class Journal {
	readonly dir: string;
	private readonly cache = new Map<string, SessionRecord>();

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	create(record: Omit<SessionRecord, "updatedAt">): SessionRecord {
		const full: SessionRecord = { ...record, updatedAt: record.startedAt };
		this.write(full);
		return full;
	}

	update(id: string, patch: SessionPatch): SessionRecord | undefined {
		const current = this.cache.get(id) ?? readRecord(join(this.dir, `${id}.json`));
		if (!current) return undefined;
		const next: SessionRecord = { ...current, ...dropUndefined(patch), updatedAt: new Date().toISOString() };
		this.write(next);
		return next;
	}

	private write(record: SessionRecord): void {
		this.cache.set(record.id, record);
		const file = join(this.dir, `${record.id}.json`);
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, file);
	}
}

/** Every record in a journal folder, newest first. Unreadable files are skipped. */
export function readJournal(dir: string): SessionRecord[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	return files
		.map((f) => readRecord(join(dir, f)))
		.filter((r): r is SessionRecord => r !== undefined)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Finds records by journal id, agent name (newest first), native session id, or pane ref. A name is reused
 * across hub runs, so it can match several records; the newest comes first.
 */
export function findSessions(records: readonly SessionRecord[], key: string): SessionRecord[] {
	const exact = records.filter((r) => r.id === key || r.sessionId === key);
	if (exact.length) return exact;
	return records.filter((r) => r.name === key || r.pane === key);
}

/** A record and every record below it, parents before children. */
export function treeOf(records: readonly SessionRecord[], rootId: string): SessionRecord[] {
	const out: SessionRecord[] = [];
	const walk = (id: string) => {
		const r = records.find((x) => x.id === id);
		if (!r) return;
		out.push(r);
		for (const c of records.filter((x) => x.parent === id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
			walk(c.id);
	};
	walk(rootId);
	return out;
}

function readRecord(file: string): SessionRecord | undefined {
	try {
		const v = JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
		return typeof v.id === "string" && typeof v.name === "string" ? v : undefined;
	} catch {
		return undefined;
	}
}

function dropUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
