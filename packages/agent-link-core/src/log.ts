// The hub's event log, <home>/events.sqlite (node:sqlite, no dependency): agents, messages with their
// queue, delivery and turn-end times, and free-form events. Learning reads it and the latency tables come
// from it. It survives hub restarts: every row carries the id of the hub run that wrote it, because agent
// names are unique only within one run.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
	run TEXT NOT NULL, name TEXT NOT NULL, parent TEXT, harness TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL,
	state TEXT NOT NULL, backend TEXT, pane TEXT, pull INTEGER NOT NULL, depth INTEGER NOT NULL,
	started_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (run, name)
);
CREATE TABLE IF NOT EXISTS messages (
	run TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, length INTEGER NOT NULL,
	kind TEXT NOT NULL, queued_at INTEGER NOT NULL, delivered_at INTEGER, turn_end_at INTEGER, PRIMARY KEY (run, id)
);
CREATE TABLE IF NOT EXISTS events (
	run TEXT NOT NULL, agent TEXT, kind TEXT NOT NULL, data TEXT, at INTEGER NOT NULL
);
`;

export interface MessageRow {
	run: string;
	id: string;
	sender: string;
	recipient: string;
	length: number;
	kind: string;
	queued_at: number;
	delivered_at: number | null;
	turn_end_at: number | null;
}

export interface EventRow {
	run: string;
	agent: string | null;
	kind: string;
	data: string | null;
	at: number;
}

export interface AgentRow {
	run: string;
	name: string;
	parent: string | null;
	harness: string;
	model: string | null;
	state: string;
	pull: number;
	depth: number;
	started_at: number;
	ended_at: number | null;
}

export class EventLog {
	readonly db: DatabaseSync;
	/** This hub run's id. */
	readonly run: string;
	private readonly now: () => number;

	constructor(path: string, opts: { now?: () => number } = {}) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(SCHEMA);
		this.run = `${new Date().toISOString()}-${randomBytes(3).toString("hex")}`;
		this.now = opts.now ?? Date.now;
	}

	agent(a: AgentRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO agents (run, name, parent, harness, model, cwd, state, backend, pane, pull, depth, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.run,
				a.name,
				a.parent,
				a.harness,
				a.model,
				a.cwd,
				a.state,
				a.backend ?? null,
				a.pane ?? null,
				a.pull ? 1 : 0,
				a.depth,
				a.startedAt,
			);
	}

	agentPane(name: string, backend: string, pane: string): void {
		this.db
			.prepare("UPDATE agents SET backend = ?, pane = ? WHERE run = ? AND name = ?")
			.run(backend, pane, this.run, name);
	}

	agentState(name: string, state: string): void {
		const ended = state === "exited" ? this.now() : null;
		this.db
			.prepare("UPDATE agents SET state = ?, ended_at = COALESCE(ended_at, ?) WHERE run = ? AND name = ?")
			.run(state, ended, this.run, name);
	}

	messageQueued(m: { id: string; from: string; to: string; length: number; kind: string }): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO messages (run, id, sender, recipient, length, kind, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(this.run, m.id, m.from, m.to, m.length, m.kind, this.now());
	}

	messageDelivered(id: string): void {
		this.db
			.prepare("UPDATE messages SET delivered_at = COALESCE(delivered_at, ?) WHERE run = ? AND id = ?")
			.run(this.now(), this.run, id);
	}

	messageTurnEnd(id: string): void {
		this.db
			.prepare("UPDATE messages SET turn_end_at = COALESCE(turn_end_at, ?) WHERE run = ? AND id = ?")
			.run(this.now(), this.run, id);
	}

	event(agent: string | null, kind: string, data?: Record<string, unknown>): void {
		this.db
			.prepare("INSERT INTO events (run, agent, kind, data, at) VALUES (?, ?, ?, ?, ?)")
			.run(this.run, agent, kind, data === undefined ? null : JSON.stringify(data), this.now());
	}

	/** Messages, oldest first; only this run's unless `allRuns`. */
	messages(opts: { allRuns?: boolean } = {}): MessageRow[] {
		const sql = `SELECT * FROM messages ${opts.allRuns ? "" : "WHERE run = ?"} ORDER BY queued_at, rowid`;
		const rows = opts.allRuns ? this.db.prepare(sql).all() : this.db.prepare(sql).all(this.run);
		return rows as unknown as MessageRow[];
	}

	events(opts: { allRuns?: boolean; agent?: string } = {}): EventRow[] {
		const where: string[] = [];
		const args: string[] = [];
		if (!opts.allRuns) {
			where.push("run = ?");
			args.push(this.run);
		}
		if (opts.agent) {
			where.push("agent = ?");
			args.push(opts.agent);
		}
		const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
		return this.db.prepare(sql).all(...args) as unknown as EventRow[];
	}

	agents(opts: { allRuns?: boolean } = {}): AgentRow[] {
		const sql = `SELECT * FROM agents ${opts.allRuns ? "" : "WHERE run = ?"} ORDER BY started_at, rowid`;
		const rows = opts.allRuns ? this.db.prepare(sql).all() : this.db.prepare(sql).all(this.run);
		return rows as unknown as AgentRow[];
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}
}
