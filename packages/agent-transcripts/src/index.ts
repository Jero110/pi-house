// Finds and reads one session's transcript, whatever harness wrote it, and sums it up.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaude } from "./claude.ts";
import { parseCodex } from "./codex.ts";
import { readOpencode } from "./opencode.ts";
import { parsePi } from "./pi.ts";
import type { Transcript, TranscriptHarness, TranscriptLocator, TranscriptMessage, Usage } from "./types.ts";

export { parseClaude } from "./claude.ts";
export { parseCodex } from "./codex.ts";
export { readOpencode } from "./opencode.ts";
export { parsePi } from "./pi.ts";
export * from "./skills.ts";
export * from "./types.ts";

/** Where each harness keeps its sessions. Tests point these at temp folders. */
export interface TranscriptRoots {
	claude: string;
	codex: string;
	opencodeDb: string;
	pi: string;
	pihouse: string;
}

export function defaultRoots(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): TranscriptRoots {
	const data = env.XDG_DATA_HOME || join(home, ".local", "share");
	return {
		claude: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
		codex: join(env.CODEX_HOME || join(home, ".codex"), "sessions"),
		opencodeDb: join(data, "opencode", "opencode.db"),
		pi: join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "sessions"),
		pihouse: join(env.PIHOUSE_HOME || join(home, ".pihouse"), "agent", "sessions"),
	};
}

/** The harness name as transcripts know it; unknown harnesses (paste profiles) have no transcript reader. */
export function transcriptHarness(harness: string): TranscriptHarness | undefined {
	return harness === "claude" ||
		harness === "codex" ||
		harness === "opencode" ||
		harness === "pi" ||
		harness === "pihouse"
		? harness
		: undefined;
}

/** Files under dir (two levels for Claude and pi, date folders for Codex) whose name ends with suffix. */
function findFile(dir: string, matches: (name: string) => boolean, depth: number): string | undefined {
	if (!existsSync(dir)) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	for (const e of entries) if (matches(e)) return join(dir, e);
	if (depth <= 0) return undefined;
	// Newest folders first: a session searched for is usually recent.
	for (const e of entries.sort().reverse()) {
		const p = join(dir, e);
		try {
			if (!statSync(p).isDirectory()) continue;
		} catch {
			continue;
		}
		const found = findFile(p, matches, depth - 1);
		if (found) return found;
	}
	return undefined;
}

/** The transcript file (or opencode's database) for a session, or undefined when it is not on disk. */
export function locateTranscript(loc: TranscriptLocator, roots: TranscriptRoots = defaultRoots()): string | undefined {
	if (loc.transcript && existsSync(loc.transcript)) return loc.transcript;
	const id = loc.sessionId;
	if (!id) return undefined;
	switch (transcriptHarness(loc.harness)) {
		case "claude":
			return findFile(roots.claude, (n) => n === `${id}.jsonl`, 1);
		case "codex":
			return findFile(roots.codex, (n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`), 3);
		case "opencode":
			return existsSync(roots.opencodeDb) ? roots.opencodeDb : undefined;
		case "pi":
			return findFile(roots.pi, (n) => n.endsWith(`_${id}.jsonl`), 1);
		case "pihouse":
			return findFile(roots.pihouse, (n) => n.endsWith(`_${id}.jsonl`), 1);
		default:
			return undefined;
	}
}

/** Reads one session's transcript. Throws with a plain reason when it cannot. */
export function readTranscript(loc: TranscriptLocator, roots: TranscriptRoots = defaultRoots()): Transcript {
	const harness = transcriptHarness(loc.harness);
	if (!harness) throw new Error(`no transcript reader for harness "${loc.harness}"`);
	const source = locateTranscript(loc, roots);
	if (!source) throw new Error(`no transcript on disk for ${loc.harness} session ${loc.sessionId ?? "(unknown id)"}`);
	const t = parse(harness, source, loc.sessionId);
	if (loc.worker) for (const m of t.messages) if (m.role === "user") m.origin = "agent";
	return t;
}

function parse(harness: TranscriptHarness, source: string, sessionId: string | undefined): Transcript {
	if (harness === "opencode") {
		const t = sessionId ? readOpencode(source, sessionId) : undefined;
		if (!t) throw new Error(`opencode session ${sessionId} is not in ${source}`);
		return t;
	}
	const text = readFileSync(source, "utf8");
	if (harness === "claude") return parseClaude(text, source);
	if (harness === "codex") return parseCodex(text, source);
	return parsePi(text, source, harness);
}

export interface TranscriptSummary {
	messages: number;
	userMessages: number;
	assistantMessages: number;
	usage: Usage;
	/** input + output + cache reads + cache writes. */
	totalTokens: number;
	toolCalls: number;
	failedToolCalls: number;
	skills: string[];
	/** Sum of the answers' durations: the time the agent spent working. */
	activeMs: number;
	/** From the first message to the last. */
	wallMs: number;
	slowestMs: number;
	models: string[];
}

export function totalTokens(u: Usage): number {
	return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function summarize(t: Transcript): TranscriptSummary {
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let toolCalls = 0;
	let failed = 0;
	let activeMs = 0;
	let slowestMs = 0;
	const skills = new Set<string>();
	const models = new Set<string>();
	for (const m of t.messages) {
		for (const s of m.skills) skills.add(s);
		if (m.role !== "assistant") continue;
		if (m.model) models.add(m.model);
		if (m.usage) {
			usage.input += m.usage.input;
			usage.output += m.usage.output;
			usage.cacheRead += m.usage.cacheRead;
			usage.cacheWrite += m.usage.cacheWrite;
		}
		toolCalls += m.tools.length;
		failed += m.tools.filter((x) => x.ok === false).length;
		activeMs += m.durationMs ?? 0;
		slowestMs = Math.max(slowestMs, m.durationMs ?? 0);
	}
	return {
		messages: t.messages.length,
		userMessages: t.messages.filter((m) => m.role === "user").length,
		assistantMessages: t.messages.filter((m) => m.role === "assistant").length,
		usage,
		totalTokens: totalTokens(usage),
		toolCalls,
		failedToolCalls: failed,
		skills: [...skills],
		activeMs,
		wallMs: t.startedAt !== undefined && t.endedAt !== undefined ? t.endedAt - t.startedAt : 0,
		slowestMs,
		models: [...models],
	};
}

/** The last `limit` messages, optionally only those whose text contains `search` (case-insensitive). */
export function selectMessages(t: Transcript, opts: { limit?: number; search?: string } = {}): TranscriptMessage[] {
	const q = opts.search?.toLowerCase();
	const hits = q ? t.messages.filter((m) => m.text.toLowerCase().includes(q)) : t.messages;
	return opts.limit && opts.limit > 0 ? hits.slice(-opts.limit) : hits;
}
