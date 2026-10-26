// Agent sessions: what cmux recorded about the agents in its panes, joined with the agent-link journal.
//
// cmux keeps a record per agent session (`cmux sessions`, from ~/.cmuxterm/*-hook-sessions.json): harness,
// session id, surface, workspace, lifecycle and, for Claude and Codex, the transcript path. It works without
// a running cmux socket. The agent-link journal (~/.agent-link/sessions) adds who launched whom, the task, and
// sessions cmux does not see (pihouse, tmux panes). Neither needs the agent or the hub to still be alive.
import { agentLinkHome, findSessions, hubPaths, readJournal, type SessionRecord } from "agent-link-core";
import {
	defaultRoots,
	readTranscript,
	selectMessages,
	summarize,
	type Transcript,
	type TranscriptRoots,
} from "agent-transcripts";
import { type CmuxRunner, cmuxJson } from "./cmux.ts";

export interface CmuxSession {
	agent: string;
	session_id: string;
	surface_id?: string | null;
	workspace_id?: string | null;
	cwd?: string | null;
	agent_lifecycle?: string | null;
	runtime_status?: string | null;
	stored_pid_exists?: boolean | null;
	transcript_path?: string | null;
	codex_transcript_path?: string | null;
	updated_at?: string | null;
	started_at?: string | null;
}

export interface AgentSession {
	harness: string;
	sessionId?: string;
	/** agent-link name and journal id, when agent-link launched or registered it. */
	name?: string;
	journalId?: string;
	parent?: string | null;
	task?: string;
	state: string;
	workspaceId?: string;
	surfaceId?: string;
	cwd?: string;
	updatedAt?: string;
	transcript?: string;
	source: "cmux" | "agent-link" | "cmux+agent-link";
}

export interface SessionDeps {
	run: CmuxRunner;
	env: NodeJS.ProcessEnv;
	/** The agent-link journal folder; default ~/.agent-link/sessions. */
	journalDir?: string;
	roots?: TranscriptRoots;
}

export async function cmuxSessions(run: CmuxRunner, all: boolean): Promise<CmuxSession[]> {
	try {
		const out = await cmuxJson<{ sessions?: CmuxSession[] }>(run, ["sessions", ...(all ? ["--all"] : [])]);
		return out.sessions ?? [];
	} catch {
		// No cmux on this machine, or an older cmux: the journal still answers.
		return [];
	}
}

function cmuxState(s: CmuxSession): string {
	if (s.stored_pid_exists === false) return "ended";
	return s.agent_lifecycle && s.agent_lifecycle !== "unknown" ? s.agent_lifecycle : (s.runtime_status ?? "unknown");
}

function journalOf(deps: SessionDeps): SessionRecord[] {
	return readJournal(deps.journalDir ?? hubPaths(agentLinkHome(deps.env)).sessions);
}

/** Every known agent session, newest first. */
export async function listSessions(
	deps: SessionDeps,
	opts: { workspace?: string; all?: boolean; agent?: string; limit?: number } = {},
): Promise<AgentSession[]> {
	const journal = journalOf(deps);
	const bySession = new Map(journal.filter((r) => r.sessionId).map((r) => [r.sessionId, r]));
	const used = new Set<string>();
	const out: AgentSession[] = [];
	for (const s of await cmuxSessions(deps.run, opts.all ?? false)) {
		const j = bySession.get(s.session_id);
		if (j) used.add(j.id);
		out.push({
			harness: j?.harness ?? s.agent,
			sessionId: s.session_id,
			name: j?.name,
			journalId: j?.id,
			parent: j?.parentName,
			task: j?.task,
			state: cmuxState(s),
			workspaceId: s.workspace_id ?? undefined,
			surfaceId: s.surface_id ?? undefined,
			cwd: s.cwd ?? j?.cwd,
			updatedAt: s.updated_at ?? undefined,
			transcript: s.transcript_path ?? s.codex_transcript_path ?? j?.transcript ?? undefined,
			source: j ? "cmux+agent-link" : "cmux",
		});
	}
	for (const r of journal) {
		if (used.has(r.id)) continue;
		if (!opts.all && r.state === "exited" && !r.transcript && !r.sessionId) continue;
		out.push({
			harness: r.harness,
			sessionId: r.sessionId,
			name: r.name,
			journalId: r.id,
			parent: r.parentName,
			task: r.task,
			state: r.state,
			workspaceId: r.place?.workspace,
			surfaceId: r.backend === "cmux" ? r.pane : r.place?.surface,
			cwd: r.cwd,
			updatedAt: r.updatedAt,
			transcript: r.transcript,
			source: "agent-link",
		});
	}
	const filtered = out.filter(
		(s) => (!opts.workspace || s.workspaceId === opts.workspace) && (!opts.agent || s.harness === opts.agent),
	);
	filtered.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/** One line per session, the fields a model needs to pick one. */
export function formatSessions(sessions: readonly AgentSession[], currentWorkspace?: string): string {
	if (!sessions.length) return "No agent sessions found.";
	return sessions
		.map((s, i) => {
			const parts = [
				`${i + 1}. ${s.harness}${s.name ? ` "${s.name}"` : ""}`,
				`state ${s.state}`,
				s.sessionId ? `session ${s.sessionId}` : "no session id yet",
				s.surfaceId ? `surface ${s.surfaceId}` : undefined,
				s.workspaceId
					? `workspace ${s.workspaceId}${s.workspaceId === currentWorkspace ? " (current)" : ""}`
					: undefined,
				s.cwd ? `cwd ${s.cwd}` : undefined,
				s.updatedAt ? `updated ${s.updatedAt}` : undefined,
				s.parent ? `launched by ${s.parent}` : undefined,
				s.transcript ? "transcript yes" : undefined,
			].filter(Boolean);
			const task = s.task ? `\n   task: ${firstLine(s.task, 160)}` : "";
			return `${parts.join(" · ")}${task}`;
		})
		.join("\n");
}

function firstLine(t: string, max: number): string {
	const line = t.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * The session a key names: an agent-link name or journal id, a native session id, or a cmux surface id.
 * Among several matches the newest wins; a surface prefers the session cmux marks active for it.
 */
export async function resolveSession(deps: SessionDeps, key: string): Promise<AgentSession | undefined> {
	const journal = journalOf(deps);
	const [j] = findSessions(journal, key);
	const cmux = await cmuxSessions(deps.run, true);
	const c =
		cmux.find((s) => s.session_id === (j?.sessionId ?? key)) ??
		cmux.filter((s) => s.surface_id === key).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
	if (!j && !c) return undefined;
	const sj = j ?? journal.find((r) => r.sessionId && r.sessionId === c?.session_id);
	return {
		harness: sj?.harness ?? c?.agent ?? "unknown",
		sessionId: sj?.sessionId ?? c?.session_id,
		name: sj?.name,
		journalId: sj?.id,
		parent: sj?.parentName,
		task: sj?.task,
		state: c ? cmuxState(c) : (sj?.state ?? "unknown"),
		workspaceId: c?.workspace_id ?? sj?.place?.workspace,
		surfaceId: c?.surface_id ?? sj?.pane,
		cwd: c?.cwd ?? sj?.cwd,
		updatedAt: c?.updated_at ?? sj?.updatedAt,
		transcript: c?.transcript_path ?? c?.codex_transcript_path ?? sj?.transcript ?? undefined,
		source: sj && c ? "cmux+agent-link" : sj ? "agent-link" : "cmux",
	};
}

/** Reads a resolved session's transcript. pi sessions may be pihouse's, which live in another folder. */
export function sessionTranscript(deps: SessionDeps, s: AgentSession): Transcript {
	const roots = deps.roots ?? defaultRoots(deps.env);
	const worker = Boolean(s.parent);
	try {
		return readTranscript({ harness: s.harness, sessionId: s.sessionId, transcript: s.transcript, worker }, roots);
	} catch (e) {
		if (s.harness === "pi") return readTranscript({ harness: "pihouse", sessionId: s.sessionId, worker }, roots);
		throw e;
	}
}

export function formatTranscript(
	s: AgentSession,
	t: Transcript,
	opts: { limit?: number; search?: string; maxChars?: number; tools?: boolean },
): string {
	const sum = summarize(t);
	const picked = selectMessages(t, { limit: opts.limit ?? 20, search: opts.search });
	const max = opts.maxChars ?? 4000;
	const head = [
		`${t.harness}${s.name ? ` "${s.name}"` : ""} session ${t.sessionId}`,
		`state ${s.state}${s.surfaceId ? ` · surface ${s.surfaceId}` : ""}${t.cwd ? ` · cwd ${t.cwd}` : ""}`,
		`transcript ${t.source}`,
		`${sum.messages} messages (${sum.userMessages} user, ${sum.assistantMessages} assistant) · ${sum.totalTokens} tokens · models ${sum.models.join(", ") || "unknown"}${sum.skills.length ? ` · skills ${sum.skills.join(", ")}` : ""}`,
		s.task ? `task: ${firstLine(s.task, 300)}` : undefined,
		opts.search
			? `${picked.length} messages match "${opts.search}"${opts.limit ? ` (last ${opts.limit} shown)` : ""}:`
			: `last ${picked.length} messages:`,
	].filter(Boolean);
	const body = picked.map((m) => {
		const when = Number.isFinite(m.at) ? new Date(m.at).toISOString().replace("T", " ").slice(0, 19) : "";
		const who = m.role === "user" ? (m.origin === "agent" ? "agent" : "user") : "assistant";
		let txt = m.text.trim() || (m.tools.length ? "(tool calls only)" : "(empty)");
		if (txt.length > max) txt = `${txt.slice(0, max)}\n[... ${txt.length - max} more characters]`;
		const tools =
			opts.tools && m.tools.length
				? `\n  tools: ${m.tools.map((x) => `${x.name}${x.ok === false ? " (failed)" : ""}`).join(", ")}`
				: "";
		return `--- #${m.index} ${who} ${when}\n${txt}${tools}`;
	});
	return [...head, ...body].join("\n");
}
