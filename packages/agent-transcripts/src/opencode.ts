// opencode keeps every session in one SQLite database (~/.local/share/opencode/opencode.db). It is opened
// read-only, and only the session, message and part tables are read; JSON fields are extracted inside SQLite
// so large tool outputs never reach JS. Never `immutable=1`: opencode keeps recent writes in the WAL.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { num, str, TranscriptBuilder } from "./builder.ts";
import type { Transcript } from "./types.ts";

type Row = Record<string, unknown>;

export function readOpencode(dbPath: string, sessionId: string): Transcript | undefined {
	if (!existsSync(dbPath)) return undefined;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const s = db.prepare("SELECT id, directory, time_created FROM session WHERE id = ?").get(sessionId);
		if (!s) return undefined;
		const b = new TranscriptBuilder("opencode", sessionId, dbPath);
		b.t.cwd = str(s.directory);
		const messages = db
			.prepare(
				`SELECT id, time_created,
					json_extract(data, '$.role') AS role,
					coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS model,
					json_extract(data, '$.providerID') AS provider,
					json_extract(data, '$.time.completed') AS completed,
					json_extract(data, '$.tokens.input') AS input,
					json_extract(data, '$.tokens.output') AS output,
					json_extract(data, '$.tokens.reasoning') AS reasoning,
					json_extract(data, '$.tokens.cache.read') AS cache_read,
					json_extract(data, '$.tokens.cache.write') AS cache_write
				FROM message WHERE session_id = ? ORDER BY time_created, id`,
			)
			.all(sessionId);
		const parts = db
			.prepare(
				`SELECT message_id,
					json_extract(data, '$.type') AS type,
					CASE WHEN json_extract(data, '$.type') = 'text' THEN json_extract(data, '$.text') END AS text,
					json_extract(data, '$.synthetic') AS synthetic,
					json_extract(data, '$.tool') AS tool,
					json_extract(data, '$.callID') AS call_id,
					json_extract(data, '$.state.status') AS status,
					json_extract(data, '$.state.input') AS input,
					json_extract(data, '$.state.time.end') AS "end"
				FROM part WHERE session_id = ? ORDER BY time_created, id`,
			)
			.all(sessionId);
		const byMessage = new Map<string, Row[]>();
		for (const p of parts) byMessage.set(String(p.message_id), [...(byMessage.get(String(p.message_id)) ?? []), p]);
		for (const m of messages) {
			const ps = byMessage.get(String(m.id)) ?? [];
			const text = ps
				.filter((p) => p.type === "text" && num(p.synthetic) !== 1 && str(p.text))
				.map((p) => String(p.text))
				.join("\n")
				.trim();
			const created = num(m.time_created);
			if (m.role === "user") {
				if (text) b.user(created, text);
				continue;
			}
			if (m.role !== "assistant") continue;
			const model = str(m.model) ? `${str(m.provider) ? `${str(m.provider)}/` : ""}${str(m.model)}` : undefined;
			const msg = b.assistant(num(m.completed) || created, text, model);
			b.usage(msg, {
				input: num(m.input),
				output: num(m.output) + num(m.reasoning),
				cacheRead: num(m.cache_read),
				cacheWrite: num(m.cache_write),
			});
			for (const [i, p] of ps.filter((x) => x.type === "tool").entries()) {
				let input: unknown;
				try {
					input = typeof p.input === "string" ? JSON.parse(p.input) : undefined;
				} catch {}
				const callId = str(p.call_id) ?? `${String(m.id)}:${i}`;
				b.tool(msg, str(p.tool) ?? "?", input, callId);
				if (p.status === "completed" || p.status === "error")
					b.result(callId, p.status === "completed", num(p.end) || msg.at);
			}
		}
		return b.finish();
	} finally {
		db.close();
	}
}
