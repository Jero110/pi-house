// Inbound Slack retries must never launch a second turn. Bind the verified Slack
// thread to one normal fleet chat and mirror only the replies of that chat.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { type createFleetJobs, FleetJobError } from "./fleet-jobs.ts";

import { isFleetMemoryCommand } from "./fleet-recall.ts";

type Settings = {
	stateDir: string;
	teamId: string;
	ownerId: string;
	botId: string;
	channels: readonly string[];
	project: string;
	origin: string;
	host: string;
};
type Jobs = Pick<ReturnType<typeof createFleetJobs>, "list" | "get" | "submitExternalTurn">;
// The transport renders these literal chunks as plain_text blocks and escapes its notification fallback.
type Post = (channel: string, thread: string, text: string, deliveryId: string) => Promise<void>;
type Row = Record<string, SQLOutputValue>;
const validTs = (value: unknown): value is string => typeof value === "string" && /^\d{1,16}\.\d{1,10}$/.test(value);

function literalParts(text: string, limit: number) {
	const chunks: string[] = [];
	let part = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
		if (part.length + ch.length > limit) {
			chunks.push(part);
			part = "";
		}
		part += ch;
	}
	if (part) chunks.push(part);
	return chunks;
}

const liveLedgers = new Map<string, DatabaseSync>();
export function copySlackForRecovery(stateDir: string, target: string) {
	const source = join(stateDir, "slack.sqlite");
	const open = liveLedgers.get(source);
	if (open) {
		open.prepare("VACUUM INTO ?").run(target);
		return;
	}
	if (!existsSync(source)) return;
	if (!lstatSync(source).isFile()) throw new Error("Invalid Slack recovery source.");
	const db = new DatabaseSync(source, { readOnly: true });
	try {
		db.prepare("VACUUM INTO ?").run(target);
	} finally {
		db.close();
	}
}

export function createSlackBridge(config: Settings, jobs: Jobs, post: Post) {
	const state = lstatSync(config.stateDir);
	if (
		!state.isDirectory() ||
		state.uid !== process.getuid?.() ||
		state.mode & 0o077 ||
		realpathSync(config.stateDir) !== resolve(config.stateDir)
	)
		throw new Error("Slack requires the private fleet state directory.");
	const path = join(config.stateDir, "slack.sqlite");
	const db = new DatabaseSync(path);
	const scope = JSON.stringify([config.teamId, config.ownerId, config.botId, config.project]);
	const allowed = new Set(config.channels);
	const dm = (channel: string) => /^D[A-Z0-9]+$/.test(channel);
	const permitted = (channel: string) => dm(channel) || allowed.has(channel);
	let closed = false;
	let flushing: Promise<void> | undefined;
	try {
		chmodSync(path, 0o600);
		db.exec(`PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
			CREATE TABLE IF NOT EXISTS inbox(scope TEXT NOT NULL, event TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY(scope,event),UNIQUE(scope,channel,ts));
			CREATE INDEX IF NOT EXISTS pending_inbox ON inbox(scope,done);
			CREATE TABLE IF NOT EXISTS threads(scope TEXT NOT NULL,channel TEXT NOT NULL,thread TEXT NOT NULL,chat TEXT NOT NULL,version INTEGER NOT NULL DEFAULT -1,cursor INTEGER NOT NULL DEFAULT 0,event_cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,channel,thread));
			CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,channel TEXT NOT NULL,thread TEXT NOT NULL,text TEXT NOT NULL,delivery TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS pending_outbox ON outbox(scope,id); COMMIT;`);
		db.prepare("DELETE FROM inbox WHERE done=1 AND at<?").run(Date.now() - 60 * 86400000);
	} catch (error) {
		db.close();
		throw error;
	}

	liveLedgers.set(path, db);
	function closeLedger() {
		liveLedgers.delete(path);
		db.close();
	}
	function transaction(fn: () => void) {
		db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	function binding(channel: string, thread: string) {
		return db.prepare("SELECT * FROM threads WHERE scope=? AND channel=? AND thread=?").get(scope, channel, thread);
	}
	function queue(channel: string, thread: string, actor: string, body: string) {
		const prefix = literalParts(actor, 200)[0] ?? "Fleet";
		const insert = db.prepare("INSERT INTO outbox(scope,channel,thread,text,delivery) VALUES(?,?,?,?,?)");
		for (const part of literalParts(body, 3000 - prefix.length - 1))
			insert.run(scope, channel, thread, `${prefix}\n${part}`, randomUUID());
	}
	function accept(eventId: string, teamId: string, value: unknown): boolean {
		if (closed) throw new Error("Slack bridge closed.");
		if (teamId !== config.teamId || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !value || typeof value !== "object")
			return false;
		const e = value as Record<string, unknown>;
		if (
			(e.type !== "message" && e.type !== "app_mention") ||
			e.user !== config.ownerId ||
			e.subtype ||
			e.bot_id ||
			e.bot_profile ||
			e.hidden ||
			[e.team, e.source_team, e.user_team].some((t) => t !== undefined && t !== teamId) ||
			typeof e.channel !== "string" ||
			typeof e.text !== "string" ||
			!validTs(e.ts) ||
			(e.thread_ts !== undefined && !validTs(e.thread_ts))
		)
			return false;
		const channel = e.channel,
			thread = e.thread_ts ?? e.ts;
		const direct = dm(channel) && e.channel_type === "im" && e.type === "message";
		if (!direct && (!allowed.has(channel) || !/^[CG][A-Z0-9]+$/.test(channel))) return false;
		if (
			db
				.prepare("SELECT 1 FROM inbox WHERE scope=? AND (event=? OR (channel=? AND ts=?))")
				.get(scope, eventId, channel, e.ts)
		)
			return true;
		const mention = `<@${config.botId}>`;
		if (
			!direct &&
			e.type !== "app_mention" &&
			!e.text.includes(mention) &&
			!binding(channel, thread) &&
			!db.prepare("SELECT 1 FROM inbox WHERE scope=? AND channel=? AND thread=? AND done=0").get(scope, channel, thread)
		)
			return false;
		const n = db.prepare("SELECT count(*) AS n FROM inbox WHERE scope=? AND done=0").get(scope);
		if (Number(n?.n) >= 256) throw new Error("Slack input queue is full.");
		let text = e.text
			.replaceAll(mention, "")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&")
			.trim();
		// Keep private memory arguments out of the transport database even while awaiting dispatch.
		if (isFleetMemoryCommand(text)) text = "/memory";
		if (Buffer.byteLength(text) > 16384) text = ""; // A bounded, durable error is delivered by the dispatcher.
		db.prepare("INSERT INTO inbox(scope,event,channel,ts,thread,text,at) VALUES(?,?,?,?,?,?,?)").run(
			scope,
			eventId,
			channel,
			e.ts,
			thread,
			text,
			Date.now(),
		);
		return true;
	}
	function dispatch(row: Row) {
		const channel = String(row.channel),
			thread = String(row.thread),
			text = String(row.text);
		const finished = () =>
			db.prepare("UPDATE inbox SET done=1,text='' WHERE scope=? AND event=?").run(scope, row.event);
		if (!permitted(channel)) {
			finished();
			return;
		}
		const prior = binding(channel, thread);
		if (isFleetMemoryCommand(text)) {
			const target = prior ? `${config.origin}/#chat=${encodeURIComponent(String(prior.chat))}` : `${config.origin}/`;
			transaction(() => {
				queue(channel, thread, `${config.host} · Fleet`, `Manage project memory in the private web chat. ${target}`);
				finished();
			});
			return;
		}
		const receipt = createHash("sha256")
			.update(JSON.stringify([scope, channel, row.ts]))
			.digest("hex");
		try {
			const job = jobs.submitExternalTurn(
				receipt,
				config.project,
				"codex",
				text,
				prior ? String(prior.chat) : undefined,
			);
			transaction(() => {
				if (!prior) {
					db.prepare("INSERT INTO threads(scope,channel,thread,chat) VALUES(?,?,?,?)").run(
						scope,
						channel,
						thread,
						job.id,
					);
					queue(
						channel,
						thread,
						`${config.host} · codex`,
						`Chat opened. ${config.origin}/#chat=${encodeURIComponent(job.id)}`,
					);
				}
				finished();
			});
		} catch (error) {
			if (!(error instanceof FleetJobError)) throw error;
			const status = prior && jobs.get(String(prior.chat))?.status;
			if (error.statusCode === 429 || (error.statusCode === 409 && (status === "running" || status === "queued")))
				return;
			transaction(() => {
				queue(channel, thread, `${config.host} · Fleet`, error.message);
				finished();
			});
		}
	}
	function queueHasRoom() {
		return Number(db.prepare("SELECT count(*) AS n FROM outbox WHERE scope=?").get(scope)?.n) < 256;
	}
	function collect() {
		const versions = new Map(jobs.list().map((j) => [j.id, j.updatedAt]));
		for (const row of db.prepare("SELECT * FROM threads WHERE scope=?").all(scope)) {
			if (!queueHasRoom()) break;
			const channel = String(row.channel),
				thread = String(row.thread),
				id = String(row.chat);
			if (!permitted(channel) || versions.get(id) === Number(row.version)) continue;
			const job = jobs.get(id);
			if (!job) continue;
			transaction(() => {
				let eventCursor = Number(row.event_cursor),
					cursor = Number(row.cursor);
				const events = job.events ?? [];
				for (; eventCursor < events.length && queueHasRoom(); eventCursor++) {
					const e = events[eventCursor];
					if (e.type === "failed" && e.text.includes("Planner unavailable."))
						queue(channel, thread, `${config.host} · Fleet`, e.text);
				}
				for (; cursor < job.messages.length && queueHasRoom(); cursor++) {
					const m = job.messages[cursor];
					if (m.role === "user" || m.kind === "memory") continue;
					if (
						m.privateContext ||
						(m.kind === "plan" && job.messages.slice(0, cursor).some((n) => n.kind === "memory"))
					) {
						queue(
							channel,
							thread,
							m.actor ?? config.host,
							`Private result ready. ${config.origin}/#chat=${encodeURIComponent(id)}`,
						);
						continue;
					}
					queue(channel, thread, m.actor ?? `${config.host} · ${m.role === "system" ? "Fleet" : job.agent}`, m.text);
				}
				db.prepare("UPDATE threads SET cursor=?,event_cursor=?,version=? WHERE scope=? AND channel=? AND thread=?").run(
					cursor,
					eventCursor,
					cursor === job.messages.length && eventCursor === events.length ? job.updatedAt : -1,
					scope,
					channel,
					thread,
				);
			});
		}
	}
	async function drain() {
		for (const row of db.prepare("SELECT * FROM inbox WHERE scope=? AND done=0 ORDER BY rowid LIMIT 256").all(scope)) {
			if (!queueHasRoom()) break;
			dispatch(row);
		}
		collect();
		for (const row of db.prepare("SELECT * FROM outbox WHERE scope=? ORDER BY id LIMIT 32").all(scope)) {
			if (closed) break;
			if (permitted(String(row.channel)))
				await post(String(row.channel), String(row.thread), String(row.text), String(row.delivery));
			db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
		}
	}
	return {
		accept,
		flush(): Promise<void> {
			if (closed) return Promise.resolve();
			if (!flushing)
				flushing = drain().finally(() => {
					flushing = undefined;
					if (closed) closeLedger();
				});
			return flushing;
		},
		close() {
			if (closed) return;
			closed = true;
			if (!flushing) closeLedger();
		},
	};
}
