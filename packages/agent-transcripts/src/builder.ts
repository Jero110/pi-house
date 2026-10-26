// Shared helpers for the parsers: JSON lines, text of content blocks, and a builder that numbers messages,
// matches tool results to their calls and works out each answer's duration.
import { skillsInText, skillsInToolCall } from "./skills.ts";
import type { Transcript, TranscriptHarness, TranscriptMessage, Usage } from "./types.ts";

export type Obj = Record<string, unknown>;

export const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : 0;

export function jsonLines(text: string): Obj[] {
	const out: Obj[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v: unknown = JSON.parse(line);
			if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v as Obj);
		} catch {
			// A torn last line (the harness is still writing): skip it.
		}
	}
	return out;
}

/** Text of a content field: a string, or the text blocks of an array. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			const o = obj(b);
			return o.type === "text" || o.type === "input_text" || o.type === "output_text" ? (str(o.text) ?? "") : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Messages agent-link (or another hub) delivered into a session, rather than typed by a person. */
export function fromAgent(text: string): boolean {
	return /^\[agent-link\]|^The orchestrator \S+ launched you/.test(text.trimStart());
}

export class TranscriptBuilder {
	readonly t: Transcript;
	private readonly calls = new Map<string, { message: number; tool: number }>();
	private lastAt: number | undefined;

	constructor(harness: TranscriptHarness, sessionId: string, source: string) {
		this.t = { harness, sessionId, source, messages: [] };
	}

	private touch(at: number): void {
		if (!Number.isFinite(at)) return;
		this.t.startedAt = Math.min(this.t.startedAt ?? at, at);
		this.t.endedAt = Math.max(this.t.endedAt ?? at, at);
	}

	user(at: number, text: string, origin?: "human" | "agent"): TranscriptMessage {
		const m: TranscriptMessage = {
			index: this.t.messages.length,
			at,
			role: "user",
			origin: origin ?? (fromAgent(text) ? "agent" : "human"),
			text,
			tools: [],
			skills: skillsInText(text),
		};
		this.t.messages.push(m);
		this.touch(at);
		this.lastAt = at;
		return m;
	}

	/** A new assistant message; its duration runs from the previous message (or tool result) to `at`. */
	assistant(at: number, text: string, model?: string): TranscriptMessage {
		const m: TranscriptMessage = {
			index: this.t.messages.length,
			at,
			role: "assistant",
			text,
			model,
			durationMs: this.lastAt !== undefined && Number.isFinite(at) ? Math.max(0, at - this.lastAt) : undefined,
			tools: [],
			skills: [],
		};
		if (model) this.t.model = model;
		this.t.messages.push(m);
		this.touch(at);
		this.lastAt = at;
		return m;
	}

	/** More of an assistant message that is written in several lines (Claude writes one per content block). */
	extend(m: TranscriptMessage, at: number, text: string): void {
		if (text) m.text = m.text ? `${m.text}\n${text}` : text;
		if (Number.isFinite(at) && at > m.at) {
			m.durationMs = (m.durationMs ?? 0) + (at - m.at);
			m.at = at;
			this.lastAt = at;
			this.touch(at);
		}
	}

	usage(m: TranscriptMessage, u: Usage): void {
		m.usage = u;
	}

	tool(m: TranscriptMessage, name: string, input: unknown, id?: string): void {
		m.tools.push(id ? { name, input, id } : { name, input });
		if (id) this.calls.set(id, { message: m.index, tool: m.tools.length - 1 });
		for (const s of skillsInToolCall(name, input)) if (!m.skills.includes(s)) m.skills.push(s);
	}

	/** A tool's result: marks the call ok or failed, and moves the clock for the next answer's duration. */
	result(id: string, ok: boolean, at: number): void {
		const ref = this.calls.get(id);
		const tool = ref ? this.t.messages[ref.message]?.tools[ref.tool] : undefined;
		if (tool) tool.ok = ok;
		if (Number.isFinite(at)) {
			this.lastAt = at;
			this.touch(at);
		}
	}

	finish(): Transcript {
		return this.t;
	}
}
