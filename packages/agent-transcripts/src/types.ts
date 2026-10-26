// One shape for every harness's transcript, so readers (the cmux MCP, /workflow review) never parse a
// harness format themselves.

/** pi and pihouse write the same session format; they differ only in where the files live. */
export type TranscriptHarness = "claude" | "codex" | "opencode" | "pi" | "pihouse";

export interface Usage {
	/** Fresh input tokens, without cache reads and writes. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ToolUse {
	name: string;
	input?: unknown;
	/** Set once the result is seen: false when the harness marked it as an error. */
	ok?: boolean;
	id?: string;
}

export interface TranscriptMessage {
	index: number;
	/** When the message was written (ms since the epoch); for an assistant message, when it ended. */
	at: number;
	role: "user" | "assistant";
	/** For user messages: typed by a person, or delivered by another agent (agent-link, a hub). */
	origin?: "human" | "agent";
	text: string;
	model?: string;
	usage?: Usage;
	/** Assistant messages: from the previous message to this one's end, the time this answer took. */
	durationMs?: number;
	tools: ToolUse[];
	/** Skills this message loaded: a SKILL.md read, a skill tool call, a /skill command. */
	skills: string[];
}

export interface Transcript {
	harness: TranscriptHarness;
	sessionId: string;
	/** The file (or database) read. */
	source: string;
	cwd?: string;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	messages: TranscriptMessage[];
}

/** Where to find one session's transcript. */
export interface TranscriptLocator {
	harness: string;
	sessionId?: string;
	/** A known transcript path; wins over a search by session id. */
	transcript?: string;
	/** Another agent opened this session: its parent wrote every user message, which carries no sender tag. */
	worker?: boolean;
}
