// pi and pihouse: <agent dir>/sessions/--<cwd>--/<time>_<session id>.jsonl (~/.pi/agent for pi, ~/.pihouse/agent
// for pihouse). Messages agent-link delivers arrive as custom_message entries; the model sees them as user
// messages, so they become user messages from an agent.
import { basename } from "node:path";
import { contentText, jsonLines, num, obj, str, TranscriptBuilder } from "./builder.ts";
import type { Transcript, TranscriptHarness } from "./types.ts";

const AGENT_MESSAGE_TYPES = new Set(["agent-link"]);

export function parsePi(text: string, source: string, harness: TranscriptHarness = "pi"): Transcript {
	const lines = jsonLines(text);
	const header = lines.find((o) => o.type === "session");
	const b = new TranscriptBuilder(harness, str(header?.id) ?? basename(source, ".jsonl").replace(/^.*_/, ""), source);
	b.t.cwd = str(header?.cwd);
	const seen = new Set<string>();
	let model: string | undefined;
	for (const o of lines) {
		const entryId = str(o.id);
		if (entryId) {
			// A forked session copies earlier entries.
			if (seen.has(entryId)) continue;
			seen.add(entryId);
		}
		const at = Date.parse(str(o.timestamp) ?? "");
		if (!Number.isFinite(at)) continue;
		if (o.type === "model_change" && str(o.modelId))
			model = `${str(o.provider) ?? ""}/${str(o.modelId)}`.replace(/^\//, "");
		if (o.type === "custom_message" && AGENT_MESSAGE_TYPES.has(str(o.customType) ?? "")) {
			const t = contentText(o.content).trim();
			if (t) b.user(at, t, "agent");
			continue;
		}
		if (o.type !== "message") continue;
		const m = obj(o.message);
		const role = str(m.role);
		if (role === "user") {
			const t = contentText(m.content).trim();
			if (t) b.user(at, t);
		} else if (role === "assistant") {
			const content = Array.isArray(m.content) ? m.content : [];
			const msg = b.assistant(at, contentText(content), str(m.model) ?? model);
			const u = obj(m.usage);
			if (Object.keys(u).length)
				b.usage(msg, {
					input: num(u.input),
					output: num(u.output),
					cacheRead: num(u.cacheRead),
					cacheWrite: num(u.cacheWrite),
				});
			for (const block of content) {
				const bl = obj(block);
				if (bl.type === "toolCall") b.tool(msg, str(bl.name) ?? "?", bl.arguments, str(bl.id));
			}
		} else if (role === "toolResult") {
			b.result(str(m.toolCallId) ?? "", m.isError !== true, at);
		}
	}
	return b.finish();
}
