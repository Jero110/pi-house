// `agent-link sessions` and `agent-link transcript <agent>`: recover what agents did from disk, with or without
// a running hub. The journal (~/.agent-link/sessions) says which agent was which session; the transcript says
// what it did. This is the tmux user's way in; in cmux the cmux MCP's tools give the same, to agents.
import { findSessions, hubPaths, readJournal, type SessionRecord } from "agent-link-core";
import { readTranscript, selectMessages, summarize } from "agent-transcripts";

export function formatJournal(records: readonly SessionRecord[], limit = 30): string[] {
	if (!records.length) return ["no agents in the journal yet"];
	return records.slice(0, limit).map((r) => {
		const parts = [
			`${r.startedAt.slice(0, 19).replace("T", " ")}`,
			`${"  ".repeat(r.depth)}${r.name}`,
			r.harness,
			r.model ?? "default",
			r.state,
			r.sessionId ? `session ${r.sessionId}` : "no session yet",
			r.pane ? `${r.backend} ${r.pane}` : undefined,
			r.parentName ? `from ${r.parentName}` : undefined,
		].filter(Boolean);
		return parts.join(" · ");
	});
}

export function sessions(home: string, out: (l: string) => void, limit?: number): number {
	for (const line of formatJournal(readJournal(hubPaths(home).sessions), limit)) out(line);
	return 0;
}

/** Prints an agent's last messages: by agent-link name, journal id or session id; the newest match wins. */
export function transcript(
	home: string,
	key: string,
	out: (l: string) => void,
	opts: { limit?: number; search?: string } = {},
): number {
	const [r] = findSessions(readJournal(hubPaths(home).sessions), key);
	if (!r) {
		out(`no agent "${key}" in the journal; \`agent-link sessions\` lists them`);
		return 1;
	}
	let t: ReturnType<typeof readTranscript>;
	try {
		t = readTranscript({
			harness: r.harness,
			sessionId: r.sessionId,
			transcript: r.transcript,
			worker: r.parent !== null,
		});
	} catch (e) {
		out(`${r.name}: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
	const s = summarize(t);
	out(`${r.name} · ${r.harness} · ${r.state} · session ${t.sessionId} · ${t.source}`);
	out(`${s.messages} messages · ${s.totalTokens} tokens${s.skills.length ? ` · skills ${s.skills.join(", ")}` : ""}`);
	if (r.task) out(`task: ${r.task.trim().split("\n")[0]}`);
	for (const m of selectMessages(t, { limit: opts.limit ?? 10, search: opts.search })) {
		out("");
		out(`--- #${m.index} ${m.role === "user" ? (m.origin === "agent" ? "agent" : "user") : "assistant"}`);
		out(m.text.trim() || (m.tools.length ? `(tools: ${m.tools.map((x) => x.name).join(", ")})` : "(empty)"));
	}
	return 0;
}
