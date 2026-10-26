// The six tools every harness sees through the agent-link MCP server, their answers and the server
// instructions. Ported from an earlier hub; the wording that real runs tuned stays:
// "returns at once", "never call status to wait", exact names.
import type { InboxEntry, StatusEntry } from "../hub/hub.ts";
import type { SendResult } from "../hub/queue.ts";

/** The JSON Schema subset the tools use; MCP clients read it as inputSchema. */
export interface ObjectSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
	additionalProperties?: boolean;
}

export type ToolName = "spawn" | "send" | "permit" | "reply" | "status" | "cancel" | "inbox";

export interface ToolDef {
	name: ToolName;
	description: string;
	inputSchema: ObjectSchema;
}

export interface ToolReply {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export const NAME_RULE =
	"Agent names are exact: a worker's name is the name given to spawn, else its harness (lowercase, plus -2, -3 when taken), as spawn and status return it.";

/**
 * The tools for one MCP server. `pull` is a root with no adapter: results wait in the hub for inbox()
 * instead of arriving as new messages, so the texts say so.
 */
export function toolDefs(opts: { harnesses: readonly string[]; pull: boolean }): ToolDef[] {
	const arrives = opts.pull
		? "it waits in the hub until you read it with inbox()"
		: "it arrives later as a new message after your turn ends";
	return [
		{
			name: "spawn",
			description: `Launch a worker agent (${opts.harnesses.join(", ")}) with a task. Returns at once with the worker's exact name; its final answer ${arrives}. Every worker opens in its own pane next to yours, where the user can watch it.`,
			inputSchema: {
				type: "object",
				properties: {
					harness: { type: "string", enum: [...opts.harnesses], description: "Which harness runs the worker" },
					task: { type: "string", description: "Self-contained task for the worker" },
					model: {
						type: "string",
						description:
							"Model id, e.g. claude-haiku-5-5. When the user names a model for the workers, pass it on every spawn; unset means the harness profile's default",
					},
					name: { type: "string", description: "Short name for the worker, e.g. auth, reviewer; default: the harness" },
					cwd: { type: "string", description: "The worker's folder; default: yours" },
					handoff: {
						type: "boolean",
						description:
							"true when the new agent takes over your work (a planner handing the plan to an executor): once it runs and your turn ends, your pane closes; its workers and its results stay with it",
					},
				},
				required: ["harness", "task"],
			},
		},
		{
			name: "send",
			description: `Send a message to another agent-link agent by its exact name: your parent or one of your workers. Returns at once; the recipient gets it in order, on a turn of its own, and any answer ${arrives}. While a worker waits on a dialog agent-link told you about, a send to it is read as your choice of option instead.`,
			inputSchema: {
				type: "object",
				properties: {
					to: { type: "string", description: "Exact agent name, as status lists it" },
					message: { type: "string", description: "The message; the recipient sees it as coming from you" },
				},
				required: ["to", "message"],
			},
		},
		{
			name: "permit",
			description:
				"Answer the permission or question one of your workers waits on, at any time: agent-link tells you its options in a message that starts with [agent-link] <worker> is waiting for your answer. Pass the option number or its text; the worker goes on at once. If only the user should decide, ask the user first.",
			inputSchema: {
				type: "object",
				properties: {
					to: { type: "string", description: "Exact worker name" },
					choice: {
						type: "string",
						description:
							'Option number or text, e.g. "1" or "Allow once"; "1,3" to pick several; "1; 2" for several questions',
					},
				},
				required: ["to", "choice"],
			},
		},
		{
			name: "reply",
			description:
				"Set the result of your current turn explicitly. When the turn ends your parent gets this text instead of your last message. Returns at once and does not end your turn; call it once, when the result is ready.",
			inputSchema: {
				type: "object",
				properties: { result: { type: "string", description: "The result, complete; your parent sees only this" } },
				required: ["result"],
			},
		},
		{
			name: "status",
			description: `List the agent-link agents around you (your parent, your workers and theirs) with harness, model and state. Shows state, not results: ${opts.pull ? "results wait for inbox()" : "results and questions arrive by themselves as new messages"}, so never call status to wait.`,
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "cancel",
			description:
				"Stop a worker and close its pane. Its own workers are stopped first. Workers also close when the session that launched them exits.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "Exact worker name" } },
				required: ["name"],
			},
		},
		{
			name: "inbox",
			description: opts.pull
				? "Read the messages that wait for you in the hub (results and questions from your workers) and mark them read. Returns at once. When it is empty, tell the user what still runs and end your turn; never call inbox in a loop to wait."
				: "Read messages that wait for you in the hub. Yours arrive by themselves as new messages, so this is usually empty; never call it to wait.",
			inputSchema: { type: "object", properties: {} },
		},
	];
}

const text = (t: string, isError = false): ToolReply =>
	isError ? { content: [{ type: "text", text: t }], isError } : { content: [{ type: "text", text: t }] };

/** Said after each answer to a pull root, which has no other way to get results. */
export const PULL_REMINDER =
	"Results and questions from your workers wait in the hub: call inbox() to read them when the user asks, or before you answer about the workers. They do not arrive by themselves.";

export function withPullReminder(reply: ToolReply, pull: boolean): ToolReply {
	if (!pull || reply.isError) return reply;
	return { ...reply, content: [...reply.content, { type: "text", text: PULL_REMINDER }] };
}

export function errorReply(message: string): ToolReply {
	return text(message, true);
}

export function spawnReply(res: { name: string } | { error: string }, pull: boolean, handoff = false): ToolReply {
	if ("error" in res) return text(`not spawned: ${res.error}`, true);
	if (handoff)
		return text(
			`spawned ${res.name}, which takes over. Tell the user in one or two lines what ${res.name} does next and end your turn; this pane closes then.`,
		);
	const later = pull
		? "Its final answer waits in the hub for inbox()."
		: "Its final answer arrives as a new message after your turn ends. Tell the user what is running and end your turn.";
	return text(`spawned ${res.name}. ${later}`);
}

export function sendReply(res: SendResult, to: string): ToolReply {
	if (!res.ok) return text(`not sent: ${res.error ?? "unknown error"}`, true);
	if (res.answered) return text(`answered ${to}'s dialog: ${res.answered}`);
	const dup = res.duplicate ? " (this message id was sent before; it was not sent again)" : "";
	return text(
		res.queued
			? `queued for ${to}: it gets the message on its next free turn${dup}`
			: `delivered to ${to}: it is handling the message now${dup}`,
	);
}

export function permitReply(res: { ok: boolean; answered?: string; error?: string }, to: string): ToolReply {
	return res.ok
		? text(`answered ${to}: ${res.answered ?? "done"}. It goes on now; its result arrives as usual.`)
		: text(`not answered: ${res.error ?? "unknown error"}`, true);
}

export function replyReply(res: { ok: boolean; error?: string }): ToolReply {
	return res.ok
		? text("result set: your parent gets it when this turn ends. Finish the turn now.")
		: text(`not set: ${res.error ?? "unknown error"}`, true);
}

export function cancelReply(res: { ok?: boolean; error?: string }, name: string): ToolReply {
	return res.error ? text(`not cancelled: ${res.error}`, true) : text(`cancelled ${name} and closed its pane`);
}

/** One line per agent with its relation to `me`, and a reminder that results come by themselves. */
export function statusReply(me: string, agents: readonly StatusEntry[], pull: boolean): ToolReply {
	const names = new Set(agents.map((a) => a.name));
	const relation = (a: StatusEntry) =>
		a.parent === me ? "your worker" : a.parent && names.has(a.parent) ? `worker of ${a.parent}` : "your parent";
	const lines = agents.map(
		(a) =>
			`- ${a.name} · ${a.harness}${a.model ? ` · ${a.model}` : ""} · ${a.state} (${relation(a)})${a.queued ? ` · ${a.queued} queued` : ""}`,
	);
	return text(
		[
			lines.length ? lines.join("\n") : "no other agents yet",
			"",
			pull
				? "Results wait for inbox(); do not call status again to wait for them."
				: "Results and questions arrive as new messages after your turn ends; do not call status again to wait for them.",
		].join("\n"),
	);
}

export function inboxReply(messages: readonly InboxEntry[]): ToolReply {
	if (!messages.length) return text("inbox empty: nothing waits for you. Do not call inbox again to wait.");
	return text(messages.map((m) => m.text).join("\n\n---\n\n"));
}

export interface InstructionsInput {
	/** The MCP client, as clientInfo.name says it. */
	client: string;
	name: string;
	/** The parent's name, null for a root. */
	parent: string | null;
	pull: boolean;
}

/** What the model reads as this server's instructions: who it is, who its parent is, how results flow. */
export function instructions({ client, name, parent, pull }: InstructionsInput): string {
	const lines: string[] = [];
	if (parent) {
		lines.push(
			`agent-link: this session is "${name}"; it was opened by "${parent}".`,
			`- Your final answer at the end of each turn reaches ${parent} by itself. Do not also send it with send.`,
			`- To set the result explicitly, call reply({ result }) before the turn ends; ${parent} gets that instead of your last message.`,
			`- If something blocks you, call send({ to: "${parent}", message }) and end your turn. The answer arrives as a new message. Never wait, sleep or call status in a loop.`,
		);
	} else {
		lines.push(
			`You are "${name}", a root agent of agent-link. Workers you spawn know you by that name.`,
			pull
				? "- spawn and send return at once. Results and questions from your workers wait in the hub; read them with inbox(). They never arrive by themselves, and calling inbox or status in a loop does not make them come sooner."
				: "- spawn and send return at once. A worker's final answer and its questions arrive later as a new message that starts with [agent-link] <name>. After spawning or sending, tell the user what is running and end your turn. Never wait, sleep or call status in a loop.",
			'- Answer a worker\'s question with send({ to: "<worker>", message }), and a permission or question it waits on with permit({ to: "<worker>", choice }). If only the user can answer, ask the user first.',
		);
	}
	lines.push(`- Tools: spawn, send, permit, reply, status, cancel, inbox. ${NAME_RULE}`);
	if (/claude/i.test(client))
		lines.push("- agent-link agents are reached only with these tools, never with SendMessage or ListAgents.");
	return lines.join("\n");
}
