// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
// Typed prompts come from event_msg item_completed UserMessage items (user_message events in older
// rollouts); response_item user messages also carry injected context, so they are not used. Usage comes
// from token_usage_record lines, else from token_count events deduped by their running total. Codex's
// input_tokens includes cached input, so the cache share is subtracted to get fresh input.
import { contentText, jsonLines, num, obj, str, TranscriptBuilder } from "./builder.ts";
import type { Transcript, TranscriptMessage, Usage } from "./types.ts";

const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

function failed(output: string): boolean {
	return /"exit_code":\s*[1-9]|Process exited with code [1-9]|^(Error:|error:)/m.test(output.slice(0, 2000));
}

function usageOf(u: Record<string, unknown>): Usage {
	const cached = num(u.cached_input_tokens);
	return {
		input: Math.max(0, num(u.input_tokens) - cached),
		output: num(u.output_tokens),
		cacheRead: cached,
		cacheWrite: 0,
	};
}

export function parseCodex(text: string, source: string): Transcript {
	const lines = jsonLines(text);
	const meta = obj(lines.find((o) => o.type === "session_meta")?.payload);
	const b = new TranscriptBuilder("codex", str(meta.id) ?? str(meta.session_id) ?? source, source);
	b.t.cwd = str(meta.cwd);
	const hasItems = lines.some((o) => o.type === "event_msg" && obj(obj(o.payload).item).type === "UserMessage");
	const hasRecords = lines.some((o) => o.type === "token_usage_record");
	const seenTotals = new Set<string>();
	let model: string | undefined;
	let current: TranscriptMessage | undefined;
	const answer = (at: number) => {
		current ??= b.assistant(at, "", model);
		return current;
	};
	for (const o of lines) {
		const at = Date.parse(str(o.timestamp) ?? "");
		if (!Number.isFinite(at)) continue;
		const pl = obj(o.payload);
		const ptype = str(pl.type);
		if (o.type === "turn_context" && str(pl.model)) model = str(pl.model);
		if (o.type === "event_msg") {
			const item = obj(pl.item);
			let prompt: string | undefined;
			if (hasItems && ptype === "item_completed" && item.type === "UserMessage") prompt = contentText(item.content);
			if (!hasItems && ptype === "user_message") prompt = str(pl.message);
			if (prompt?.trim()) {
				b.user(at, prompt.trim());
				current = undefined;
			}
			if (ptype === "token_count" && !hasRecords) {
				const info = obj(pl.info);
				const total = String(num(obj(info.total_token_usage).total_tokens));
				const last = obj(info.last_token_usage);
				if (Object.keys(last).length && !seenTotals.has(total)) {
					seenTotals.add(total);
					b.usage(answer(at), usageOf(last));
					current = undefined;
				}
			}
			continue;
		}
		if (o.type === "token_usage_record") {
			b.usage(answer(at), usageOf(obj(pl.usage)));
			current = undefined;
			continue;
		}
		if (o.type !== "response_item") continue;
		if (ptype === "message" && pl.role === "assistant") {
			const m = answer(at);
			b.extend(m, at, contentText(pl.content));
		} else if (ptype && CALLS.has(ptype)) {
			const raw = str(pl.input) ?? str(pl.arguments) ?? pl.action;
			let input: unknown = raw;
			if (typeof raw === "string" && raw.trim().startsWith("{")) {
				try {
					input = JSON.parse(raw);
				} catch {}
			}
			b.tool(answer(at), str(pl.name) ?? "shell", input, str(pl.call_id));
		} else if (ptype && OUTPUTS.has(ptype)) {
			const out = typeof pl.output === "string" ? pl.output : JSON.stringify(pl.output ?? "");
			b.result(str(pl.call_id) ?? "", !failed(out), at);
		}
	}
	return b.finish();
}
