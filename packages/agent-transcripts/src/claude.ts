// Claude Code: ~/.claude/projects/<cwd slug>/<session id>.jsonl, one JSON object per line.
// An assistant message is written as several lines (one per content block) that share message.id, each
// repeating the usage; the last one carries the final numbers.
import { basename } from "node:path";
import { contentText, jsonLines, num, obj, str, TranscriptBuilder } from "./builder.ts";
import type { Transcript, TranscriptMessage } from "./types.ts";

// Lines Claude adds as "user" that nobody typed.
const INJECTED = ["<local-command", "<task-notification", "<system-reminder", "Caveat:", "[Request interrupted"];

export function parseClaude(text: string, source: string): Transcript {
	const lines = jsonLines(text);
	const b = new TranscriptBuilder("claude", basename(source, ".jsonl"), source);
	const byId = new Map<string, TranscriptMessage>();
	for (const o of lines) {
		if (o.isSidechain === true) continue;
		if (!b.t.cwd && str(o.cwd)) b.t.cwd = str(o.cwd);
		const sid = str(o.sessionId);
		if (sid) b.t.sessionId = sid;
		const at = Date.parse(str(o.timestamp) ?? "");
		if (!Number.isFinite(at)) continue;
		const message = obj(o.message);
		const content = message.content;
		if (o.type === "assistant") {
			const model = str(message.model);
			if (model === "<synthetic>") continue;
			const id = str(message.id) ?? str(o.uuid) ?? String(at);
			const textPart = contentText(content);
			let m = byId.get(id);
			if (!m) {
				m = b.assistant(at, textPart, model);
				byId.set(id, m);
			} else b.extend(m, at, textPart);
			for (const block of Array.isArray(content) ? content : []) {
				const bl = obj(block);
				if (bl.type === "tool_use") b.tool(m, str(bl.name) ?? "?", bl.input, str(bl.id));
			}
			const u = obj(message.usage);
			if (Object.keys(u).length)
				b.usage(m, {
					input: num(u.input_tokens),
					output: num(u.output_tokens),
					cacheRead: num(u.cache_read_input_tokens),
					cacheWrite: num(u.cache_creation_input_tokens),
				});
			continue;
		}
		if (o.type !== "user") continue;
		if (Array.isArray(content) && content.some((x) => obj(x).type === "tool_result")) {
			for (const block of content) {
				const bl = obj(block);
				if (bl.type === "tool_result") b.result(str(bl.tool_use_id) ?? "", bl.is_error !== true, at);
			}
			continue;
		}
		if (o.isMeta === true && !/^Base directory for this skill:/.test(contentText(content))) continue;
		if (o.isCompactSummary === true) continue;
		let value = contentText(content).trim();
		const command = /<command-name>([^<]*)<\/command-name>/.exec(value);
		if (command) {
			const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(value)?.[1] ?? "";
			const name = (command[1] ?? "").trim();
			value = `${name.startsWith("/") ? name : `/${name}`} ${args}`.trim();
		}
		if (!value || INJECTED.some((p) => value.startsWith(p))) continue;
		const origin = obj(o.origin);
		const peer = o.turnOrigin === "peer" || origin.kind === "channel";
		b.user(at, value, peer ? "agent" : undefined);
	}
	return b.finish();
}
