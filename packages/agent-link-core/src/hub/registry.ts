// The tree of agents the hub runs: names, parents, who may talk to whom and what status shows to whom.
// The hub keeps it in memory; the event log (src/log.ts) keeps its history.
import type { AgentAdapter, AgentRecord, BackendName, PendingAsk, PlaceHint, Profile, StopReason } from "../types.ts";
import type { MessageKind, QueuedMessage } from "./queue.ts";

/**
 * A worker that replace stops so a replacement can continue its task. Problem: until the old worker is confirmed closed,
 * its late output or its children's reports could reach the parent as current, and two workers could write. Example: a
 * quota-exhausted worker whose cancelled turn still ends with its last text. Solution: the fence drops the worker's own
 * output (logged, one stale notice at most), holds its children's reports until the replacement adopts them, and keeps
 * a natural finish during the fence as the outcome replace reports.
 */
export interface Fence {
	/** A turn that finished on its own during the fence: the outcome of replace, not a result for the parent. */
	outcome?: { stop: StopReason; text: string };
	/** Reports from the fenced worker's children, delivered to the replacement (or to the parent) once it is known. */
	held: Array<{ from: string; text: string; kind: MessageKind }>;
	/** The stale notice went to the parent: at most once. */
	noticed: boolean;
	/** The replacement's name, once it runs. */
	replacement?: string;
}

/** One agent as the hub tracks it: its record plus what the queue and result routing need. */
export interface Agent {
	record: AgentRecord;
	adapter?: AgentAdapter;
	profile?: Profile;
	/** A root's terminal as `agent-link open` reported it at registration (RegisterRequest.place). */
	place?: PlaceHint;
	/** connect() resolved: prompt() may be called. */
	ready: boolean;
	/** The message whose prompt() is running. */
	inflight?: QueuedMessage;
	/** Messages waiting for their own turn, oldest first. */
	queue: QueuedMessage[];
	/** Pull agents only: messages not read with inbox() yet. */
	inbox: QueuedMessage[];
	/** What the agent passed to reply() during the current turn. */
	replyText?: string;
	/** The last agent_message text of the current turn, for a prompt() that resolves without text. */
	lastText: string;
	/**
	 * The message whose turn failed last, with the error the adapter reported (none when it reported no text).
	 * Kept until a turn succeeds or ends without a message; model({ retry: true }) sends it again.
	 */
	lastFailed?: { msg: QueuedMessage; error?: string };
	/** Message ids already sent again by a retry: a message is retried once. */
	retried: Set<string>;
	/**
	 * A model switch that interrupts the running turn is in progress (model({ interrupt: true })): the queue waits meanwhile.
	 * `stop` is how the interrupted turn ended, once it did.
	 */
	interrupt?: { stop?: StopReason };
	/** The current turn asked the parent with send: its turn end repeats the question and is held. */
	askedParent: boolean;
	/** The held turn end; it still reaches the parent if the agent exits before answering again. */
	held?: string;
	/** An unknown dialog in the agent's pane that the parent was asked about. */
	dialog?: { text: string; options: string[] };
	/** The permission or question the adapter reported and can answer (AgentAdapter.answer): permit() picks. */
	ask?: PendingAsk;
	/** What the agent waits on while asking, as the adapter said it; for permit()'s error when it cannot answer. */
	waitingFor?: string;
	/** Process to watch, for roots: when it is gone, the root and its tree close. */
	pid?: number;
	runDir?: string;
	/** The agent's id in the session journal (src/journal.ts). */
	journalId?: string;
	/** Set once the agent starts closing; the teardown runs once. */
	closing?: Promise<void>;
	/** Timer that retries delivery while the adapter is not idle. */
	retry?: ReturnType<typeof setTimeout>;
	/** spawn with handoff: the agent that takes over, and the backend of this agent's pane. */
	handoff?: { to: string; backend: BackendName };
	/** Handed off: it closed with its pane; its live workers went to the agent that took over (Hub.adopt). */
	handedOff?: boolean;
	/** The task spawn gave it; replace hands the same task to the replacement. */
	task?: string;
	/**
	 * The result of its last turn when that turn ended on its own (not cancelled, not failed), kept until the next turn.
	 * Problem: replace would stop a worker that already finished and repeat its work. Example: "run the tests" finished,
	 * then replace is asked; the answer is that result, and nothing is spawned.
	 */
	lastResult?: { stop: StopReason; text: string };
	/** Set while replace stops this worker (see Fence). */
	fence?: Fence;
}

export class Registry {
	readonly agents = new Map<string, Agent>();

	get(name: string): Agent | undefined {
		return this.agents.get(name);
	}

	add(agent: Agent): void {
		this.agents.set(agent.record.name, agent);
	}

	/**
	 * A name nobody in this hub run used: the wanted one (lowercase, letters, digits and dashes), else
	 * with -2, -3. Exited agents keep their names, so a message for an old worker never reaches a new one.
	 */
	uniqueName(wanted: string): string {
		const base =
			wanted
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "agent";
		if (!this.agents.has(base)) return base;
		for (let i = 2; ; i++) if (!this.agents.has(`${base}-${i}`)) return `${base}-${i}`;
	}

	children(name: string): Agent[] {
		return [...this.agents.values()].filter((a) => a.record.parent === name);
	}

	/** True when `ancestor` is above `name` in the tree. */
	isAncestor(ancestor: string, name: string): boolean {
		let parent = this.agents.get(name)?.record.parent;
		while (parent) {
			if (parent === ancestor) return true;
			parent = this.agents.get(parent)?.record.parent;
		}
		return false;
	}

	/** A worker talks with its parent and its own workers, nobody else. */
	canTalk(from: string, to: string): boolean {
		if (from === to) return false;
		return this.agents.get(from)?.record.parent === to || this.agents.get(to)?.record.parent === from;
	}

	/** What status shows to `name`: its parent, its children and their children. */
	scope(name: string): Agent[] {
		const me = this.agents.get(name);
		if (!me) return [];
		const parent = me.record.parent ? this.agents.get(me.record.parent) : undefined;
		const children = this.children(name);
		const grandchildren = children.flatMap((c) => this.children(c.record.name));
		return [...(parent ? [parent] : []), ...children, ...grandchildren];
	}

	/**
	 * Problem and fix for a name that is not in this hub, e.g. a typo or a worker of another session.
	 * A worker sees the names it may message, its parent first, so a worker told to ask "the orchestrator"
	 * learns the right name. Ported from an earlier hub; 	 */
	unknownAgent(name: string, from: string): string {
		const tail = "Names come from spawn (the name or harness, plus -2, -3 when taken); use status to list them.";
		const me = this.agents.get(from);
		if (!me) return `unknown agent "${name}". ${tail}`;
		const parent = me.record.parent;
		const reachable = [...this.agents.values()]
			.filter((a) => a.record.state !== "exited" && this.canTalk(from, a.record.name))
			.map((a) => (a.record.name === parent ? `${a.record.name} (your parent)` : a.record.name))
			.sort((a, b) => Number(b.endsWith("(your parent)")) - Number(a.endsWith("(your parent)")));
		const list = reachable.length ? `You can message: ${reachable.join(", ")}.` : "You have no one to message yet.";
		return `unknown agent "${name}". ${list} ${tail}`;
	}
}
