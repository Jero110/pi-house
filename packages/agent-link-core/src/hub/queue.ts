// Messages as the hub queues them, the texts an agent sees, and the dedupe of repeated message ids.
import { askLines } from "../ask.ts";
import type { AgentRecord, PendingAsk, StopReason } from "../types.ts";

/**
 * What a queued message is: a message one agent sent another, the result of a turn, the brief a new
 * agent gets first, or a notice the hub writes for a parent (a dialog, a worker that waits or exited).
 */
export type MessageKind = "message" | "result" | "brief" | "notice";

export interface QueuedMessage {
	id: string;
	/** An agent name, or "agent-link" for the hub itself (the brief). */
	from: string;
	to: string;
	/** The text as the recipient sees it, sender already named. */
	text: string;
	kind: MessageKind;
	queuedAt: number;
}

/** What send answers. A repeated id answers the first result again, with duplicate: true. */
export interface SendResult {
	ok: boolean;
	id?: string;
	/** Not handed to the recipient yet: it waits for the recipient's next free turn, or for inbox(). */
	queued?: boolean;
	duplicate?: boolean;
	/** The dialog option that was picked, when the send answered a worker's dialog. */
	answered?: string;
	error?: string;
}

/** How many message ids the hub remembers for dedupe. */
const SEEN_KEPT = 10_000;

/** Results of the message ids seen, oldest dropped first. */
export class SeenIds {
	private readonly seen = new Map<string, SendResult>();

	get(id: string): SendResult | undefined {
		return this.seen.get(id);
	}

	set(id: string, result: SendResult): void {
		this.seen.delete(id);
		this.seen.set(id, result);
		if (this.seen.size > SEEN_KEPT) {
			const oldest = this.seen.keys().next().value;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
	}
}

/** "<name> (<harness> · <model>)" */
/** A worker waits on a permission or question its adapter can answer: the parent picks with permit(). */
export function askNotice(agent: Pick<AgentRecord, "name" | "harness" | "model">, ask: PendingAsk): string {
	const several = ask.questions.length > 1 ? ', one answer per question separated by ";"' : "";
	return [
		`[agent-link] ${who(agent)} is waiting for your answer to a ${ask.kind}:`,
		"",
		askLines(ask),
		"",
		`Answer with permit({ to: "${agent.name}", choice: "<option number or text>" })${several}. It goes on as soon as you answer. If only the user should decide, ask the user first.`,
	].join("\n");
}

export function who(agent: Pick<AgentRecord, "name" | "harness" | "model">): string {
	return `${agent.name} (${agent.harness}${agent.model ? ` · ${agent.model}` : ""})`;
}

/** A message from another agent as the recipient sees it. */
export function messageText(from: string, message: string): string {
	return `[agent-link] ${from}: ${message}`;
}

/** The result of a turn, for the parent: `[agent-link] <name> (<harness> · <model>) finished:\n\n<result>`. */
export function resultText(agent: Pick<AgentRecord, "name" | "harness" | "model">, stop: StopReason, text: string) {
	const verb =
		stop === "error"
			? "failed"
			: stop === "cancelled"
				? "stopped (its turn was cancelled)"
				: stop === "end_turn"
					? "finished"
					: `finished (stop reason: ${stop})`;
	return text.trim() ? `[agent-link] ${who(agent)} ${verb}:\n\n${text.trim()}` : `[agent-link] ${who(agent)} ${verb}.`;
}

/** A dialog as the parent sees it: the text, then the options numbered from 1. */
export function dialogLines(text: string, options: readonly string[]): string {
	const listed = options.length
		? options.map((o, i) => `${i + 1}. ${o}`).join("\n")
		: "(no options with a cursor were found; look at the pane)";
	return `${text}\n\nOptions:\n${listed}`;
}

export function dialogNotice(agent: AgentRecord, dialog: { text: string; options: readonly string[] }): string {
	return [
		`[agent-link] ${who(agent)} is stuck on a dialog in its pane that agent-link does not know:`,
		"",
		dialogLines(dialog.text, dialog.options),
		"",
		`While it waits on this dialog, a send to ${agent.name} is read as your choice, not as a message: send({ to: "${agent.name}", message: "<option number or text>" }). If the choice belongs to the user (trusting a folder, accepting a risk), ask the user first.`,
	].join("\n");
}

export function waitingNotice(agent: AgentRecord, detail: string | undefined): string {
	return `[agent-link] ${who(agent)} is waiting in its pane${detail ? `: ${detail}` : ""}. It goes on once someone answers there; tell the user if only they can.`;
}

export function exitedNotice(agent: AgentRecord, detail: string | undefined, held: string | undefined): string {
	const head = `[agent-link] ${who(agent)} exited${detail ? ` (${detail})` : ""}`;
	return held?.trim() ? `${head}. Its last answer:\n\n${held.trim()}` : `${head}.`;
}

export function failedStartNotice(agent: AgentRecord, error: string): string {
	return `[agent-link] ${who(agent)} failed to start: ${error}`;
}
