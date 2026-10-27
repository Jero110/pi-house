// The hub: the tree of agents, one FIFO queue per agent, result routing and the event log.
// Ported from an earlier hub; What stays: dedupe by message id, one delivery at a time per
// recipient, askedParent with its held turn end, unknown-agent hints, the result text.
//
// What was rewritten, and why:
// Problem: the earlier hub ran inside the orchestrator's pi process and wrote each message to the worker at once.
// Example: a message that reached a busy worker was folded into its running turn (lab Experiment 7, V1), so
// two messages produced one turn and one result, and the parent could not tell which message it answered.
// Solution: the hub is a daemon that talks to adapters, and it calls adapter.prompt() only while the adapter
// is idle() and no prompt is in flight, so every message gets a turn and a result of its own.

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { keysForChoice } from "../dialogs.ts";
import { checkCommand } from "../guard.ts";
import { type Journal, journalId, type SessionPatch } from "../journal.ts";
import type { EventLog } from "../log.ts";
import type {
	AdapterFactory,
	AgentRecord,
	BackendName,
	GuardVerdict,
	Identity,
	PaneBackend,
	PaneCommand,
	PlaceHint,
	Profile,
	PromptResponse,
	SessionUpdate,
	SetModelResult,
	StopReason,
} from "../types.ts";
import { continuationTask, repoFingerprint } from "./continuation.ts";
import {
	askNotice,
	dialogLines,
	dialogNotice,
	exitedNotice,
	failedStartNotice,
	type MessageKind,
	messageText,
	type QueuedMessage,
	resultText,
	SeenIds,
	type SendResult,
	staleNotice,
	waitingNotice,
} from "./queue.ts";
import { type Agent, type Fence, Registry } from "./registry.ts";
import {
	agentEnv,
	checkSpawn,
	DEFAULT_MCP,
	identityEnv,
	launchSpec,
	type McpCommands,
	type SpawnRequest,
	spawnCwd,
} from "./spawn.ts";
import { watchStartupDialogs } from "./startup.ts";
import { type Cause, causeOf, next, turnEndCause } from "./state.ts";

export interface HubOptions {
	/** Path of the hub's Unix socket, handed to agents as AGENT_LINK_HUB. */
	socket: string;
	/** The hub's folder, handed to agents as AGENT_LINK_HOME. */
	home?: string;
	token: string;
	/** Parent folder of every agent's run folder (<home>/run). */
	runRoot: string;
	log: EventLog;
	/** Where every agent's record is kept on disk; none in tests that do not need it. */
	journal?: Journal;
	adapters: Record<string, AdapterFactory>;
	backends: Partial<Record<BackendName, PaneBackend>>;
	profiles: ReadonlyMap<string, Profile>;
	/**
	 * Reads the profiles again. Problem: a hub started before a harness was installed never knew it. Example: a hub
	 * running since Faro cannot open "pihouse", whose profile was written later, until it is restarted, and
	 * restarting closes the agents it runs. Solution: when a harness is not known, the hub reads the profiles once more.
	 */
	reloadProfiles?: () => ReadonlyMap<string, Profile>;
	mcp?: McpCommands;
	guard?: (command: string, depth: number) => GuardVerdict;
	startup?: { timeoutMs?: number; pollMs?: number };
	/** How often to try delivery again while an adapter is not idle. */
	idlePollMs?: number;
	/**
	 * How long model({ interrupt: true }) waits for the cancelled turn to end and the switch to apply. Problem: a harness
	 * that ignores the cancel would hold the interrupt forever. Example: an opencode abort still running after 20 s. Solution:
	 * the wait is bounded and the answer says the task was not continued.
	 */
	interruptMs?: number;
	/** How often to check that registered root processes still run. */
	pidPollMs?: number;
}

export interface RegisterRequest {
	harness: string;
	/**
	 * The name wanted for a root (the hub keeps it unique). Problem: a root is named after its harness (`pihouse-6`),
	 * so a durable agent such as the keeper had no fixed name to be found by. Example: `pih keeper` registers
	 * `keeper`. Solution: an optional name; without one the harness names it as before.
	 */
	name?: string;
	model?: string | null;
	cwd: string;
	parent?: null;
	pull: boolean;
	/** True for a root opened with `agent-link open`: the hub drives its harness through the profile's adapter. */
	adapter?: boolean;
	pid?: number;
	/** The backend the root's own spawns use; picks the MCP command an adapter root is launched with. */
	backend?: BackendName;
	/** Where the root's terminal is, for its spawns when its MCP server cannot tell (Codex filters MCP env). */
	place?: PlaceHint;
}

export type RegisterResult = { name: string; identity: Identity; command?: PaneCommand } | { error: string };

export interface StatusEntry {
	name: string;
	parent: string | null;
	harness: string;
	model: string | null;
	state: AgentRecord["state"];
	depth: number;
	pull: boolean;
	/** Messages waiting for the agent, the one in its running turn included. */
	queued: number;
}

export interface InboxEntry {
	id: string;
	from: string;
	text: string;
	at: number;
}

/** What model({ retry: true }) did with the message that failed the worker's last turn. */
export type RetryOutcome = { retried: true; messageId: string; error?: string } | { retried: false; reason: string };

/** What model({ interrupt: true }) did with the running turn: its task continues, or the reason it does not. */
export type InterruptOutcome = { continued: true; messageId: string } | { continued: false; reason: string };

export type ModelResult =
	| {
			status: "applied" | "pending";
			model: string;
			previous: string | null;
			retry?: RetryOutcome;
			interrupt?: InterruptOutcome;
	  }
	| { error: string; retry?: RetryOutcome; interrupt?: InterruptOutcome };

/**
 * What replace did: the replacement that continues the task; the old worker's own result when it had already finished
 * (nothing spawned); or the reason nothing was replaced.
 */
export type ReplaceResult =
	| { status: "replaced"; name: string; previous: string; before: string; after: string }
	| { status: "finished"; name: string; result: string }
	| { error: string };

/** A report from a harness-side piece (POST /event). */
export type HarnessEvent = { agent: string; type: string } & Record<string, unknown>;

export class Hub {
	readonly registry = new Registry();
	private readonly seen = new SeenIds();
	private readonly opts: HubOptions;
	private readonly streams = new Map<string, Set<(m: InboxEntry) => void>>();
	private readonly eventListeners = new Map<string, Set<(e: HarnessEvent) => void>>();
	private readonly pidTimer: ReturnType<typeof setInterval>;
	private closed = false;

	/** The profiles in use: the ones the hub started with, plus any it learned of later. */
	private readonly profiles: Map<string, Profile>;

	constructor(opts: HubOptions) {
		this.opts = opts;
		this.profiles = new Map(opts.profiles);
		this.pidTimer = setInterval(() => this.checkPids(), opts.pidPollMs ?? 1000);
		this.pidTimer.unref();
	}

	get log(): EventLog {
		return this.opts.log;
	}

	/** The profile of a harness; one the hub does not know sends it to read the profiles again first. */
	private profileFor(harness: string): Profile | undefined {
		if (!this.profiles.has(harness) && this.opts.reloadProfiles) {
			try {
				for (const [name, profile] of this.opts.reloadProfiles()) this.profiles.set(name, profile);
			} catch {
				// A broken profile file must not take registration down; the known profiles still work.
			}
		}
		return this.profiles.get(harness);
	}

	// -------------------------------------------------------------------------------------------------
	// Registration and spawn
	// -------------------------------------------------------------------------------------------------

	/** Registers a root: a harness the user opened (pull) or one `agent-link open` opened (adapter). */
	async register(req: RegisterRequest): Promise<RegisterResult> {
		if (this.closed) return { error: "the hub is shutting down" };
		if (!req.harness) return { error: "register needs a harness" };
		if (req.parent) return { error: "POST /agents registers roots only; workers come from spawn" };
		const profile = this.profileFor(req.harness);
		const factory = req.adapter ? profile && this.opts.adapters[profile.adapter] : undefined;
		if (req.adapter && !factory)
			return { error: `no adapter for "${req.harness}" in this hub, so it cannot drive it; register with pull: true` };
		const name = this.registry.uniqueName(req.name || req.harness);
		const record: AgentRecord = {
			name,
			parent: null,
			harness: req.harness,
			model: req.model ?? null,
			cwd: req.cwd,
			state: "starting",
			pull: req.pull,
			depth: 0,
			startedAt: Date.now(),
		};
		const agent = this.newAgent(record, profile);
		if (req.pid) agent.pid = req.pid;
		if (req.place) agent.place = req.place;
		const identity = this.identity(name, 0);
		this.registry.add(agent);
		this.log.agent(record);
		this.journalCreate(agent, { place: req.place, pid: req.pid, backend: req.backend });
		if (!factory || !profile) {
			agent.ready = true;
			this.transition(agent, "connected");
			return { name, identity };
		}
		const adapter = this.createAdapter(agent, factory);
		const spec = launchSpec({
			name,
			parent: null,
			model: record.model,
			cwd: record.cwd,
			runRoot: this.opts.runRoot,
			env: agentEnv(profile, identityEnv(identity, this.opts.home)),
			mcp: this.opts.mcp?.[req.backend ?? "cmux"] ?? DEFAULT_MCP[req.backend ?? "cmux"],
			profile,
		});
		agent.runDir = spec.runDir;
		let command: PaneCommand;
		try {
			command = await adapter.launch(spec);
		} catch (e) {
			await this.closeAgent(agent);
			return { error: `${req.harness} adapter could not launch: ${errorText(e)}` };
		}
		// The harness runs in the user's terminal once `agent-link open` execs the command, then connect() reaches it.
		void adapter.connect().then(
			() => this.connected(agent),
			(e) => {
				this.log.event(name, "connect-failed", { error: errorText(e) });
				void this.closeAgent(agent);
			},
		);
		return { name, identity, command };
	}

	/** Spawn flow (design "Message flow" 1). Answers once the pane is open; startup goes on in the background. */
	async spawn(req: SpawnRequest): Promise<{ name: string } | { error: string }> {
		if (this.closed) return { error: "the hub is shutting down" };
		const caller = this.registry.get(req.from);
		if (!caller) return { error: this.registry.unknownAgent(req.from, req.from) };
		if (caller.record.state === "exited" || caller.closing) return { error: `${req.from} has exited` };
		return this.startWorker(caller, req);
	}

	/** The spawn flow below a caller that is known to be live: checks, record, launch, pane, brief. */
	private async startWorker(
		caller: Agent,
		req: SpawnRequest,
		replaces?: string,
	): Promise<{ name: string } | { error: string }> {
		this.profileFor(req.harness);
		const checked = checkSpawn(req, {
			caller,
			profiles: this.profiles,
			adapters: this.opts.adapters,
			backends: this.opts.backends,
		});
		if (!checked.ok) return { error: checked.error };
		const { profile, factory, backend } = checked;
		const name = this.registry.uniqueName(req.name || req.harness);
		const depth = caller.record.depth + 1;
		const record: AgentRecord = {
			name,
			parent: caller.record.name,
			harness: req.harness,
			model: req.model || profile.defaultModel,
			cwd: spawnCwd(caller.record.cwd, req.cwd),
			state: "starting",
			backend: req.backend,
			pull: false,
			depth,
			startedAt: Date.now(),
		};
		const agent = this.newAgent(record, profile);
		agent.task = req.task.trim();
		this.registry.add(agent);
		this.log.agent(record);
		this.journalCreate(agent, { task: req.task, backend: req.backend, replaces }, caller);
		const adapter = this.createAdapter(agent, factory);
		// The brief is the first message; it waits until connect() resolves.
		this.enqueue(agent, {
			from: "agent-link",
			// Problem: the first message wrapped the task in "The orchestrator X launched you on behalf of the user.
			// You are Y." and rules about how results flow. Example: models read that preamble like an injected
			// prompt. Solution: the worker gets the task as a person would write it; the agent-link MCP
			// instructions say how to reach the parent.
			text: req.task.trim(),
			kind: "brief",
		});
		try {
			const spec = launchSpec({
				name,
				parent: caller.record.name,
				model: record.model,
				cwd: record.cwd,
				runRoot: this.opts.runRoot,
				env: agentEnv(profile, identityEnv(this.identity(name, depth), this.opts.home), req.read),
				mcp: this.opts.mcp?.[req.backend] ?? DEFAULT_MCP[req.backend],
				profile,
				readDirs: req.read,
			});
			agent.runDir = spec.runDir;
			const cmd = await adapter.launch(spec);
			if (agent.closing) return { error: `${name} was closed while it started` };
			record.pane = await backend.open(cmd, {
				title: `${name} · ${profile.label}`,
				place: placeOf(caller.record, req, caller.place),
			});
			if (req.handoff) caller.handoff = { to: name, backend: req.backend };
			this.log.agentPane(name, req.backend, record.pane);
			this.journalUpdate(agent, { pane: record.pane, backend: req.backend });
		} catch (e) {
			this.transition(agent, "error");
			await this.closeAgent(agent);
			return { error: `could not start ${name}: ${errorText(e)}` };
		}
		void this.startAgent(agent, backend, record.pane);
		return { name };
	}

	/** Answers startup dialogs while the adapter connects; then the brief goes out. */
	private async startAgent(agent: Agent, backend: PaneBackend, pane: string): Promise<void> {
		const { adapter, profile } = agent;
		if (!adapter || !profile) return;
		const name = agent.record.name;
		const connecting = adapter.connect({ backend, ref: pane }).then(() => this.connected(agent));
		const watching = watchStartupDialogs(backend, pane, profile.dialogs, {
			...this.opts.startup,
			started: () => agent.ready,
			stopped: () => agent.closing !== undefined,
			onKnown: (dialog, keys) => this.log.event(name, "dialog-answered", { dialog, keys }),
			onUnknown: (dialog) => {
				agent.dialog = dialog;
				this.log.event(name, "dialog-unknown", dialog);
				this.transition(agent, "dialog");
				this.notifyParent(agent, dialogNotice(agent.record, dialog));
			},
			onAnswered: () => {
				agent.dialog = undefined;
				this.log.event(name, "dialog-left");
				this.transition(agent, "answered");
			},
		}).catch((e: unknown) => this.log.event(name, "dialog-watch-failed", { error: errorText(e) }));
		try {
			await connecting;
		} catch (e) {
			const error = errorText(e);
			this.log.event(name, "connect-failed", { error });
			if (!agent.closing) {
				this.transition(agent, "error");
				this.notifyParent(agent, failedStartNotice(agent.record, error));
				await this.closeAgent(agent);
			}
		}
		await watching;
	}

	private connected(agent: Agent): void {
		if (agent.closing) return;
		agent.ready = true;
		this.log.event(agent.record.name, "connected");
		this.transition(agent, "connected");
		this.pump(agent);
		const parent = agent.record.parent ? this.registry.get(agent.record.parent) : undefined;
		if (parent?.handoff?.to === agent.record.name) this.tryHandoff(parent);
	}

	/**
	 * Closes an agent that handed off, alone, once the agent that takes over runs and its own turn has ended.
	 * Problem: a planner that handed the plan to an executor stayed open next to it, and closing it closed its
	 * whole tree. Example: the executor and its workers squeezed into half a screen next to the planner.
	 * Solution: spawn with handoff marks the caller; when the new agent
	 * is connected and the caller is idle, the caller closes with its pane (a root's terminal too); its live workers
	 * are adopted by the agent that takes over (adopt). Messages to it from then on are dropped, as for any agent that exited.
	 */
	private tryHandoff(caller: Agent): void {
		const h = caller.handoff;
		if (!h || caller.handedOff || caller.closing) return;
		const to = this.registry.get(h.to);
		if (!to || to.closing || to.record.state === "exited") {
			caller.handoff = undefined;
			return;
		}
		// A pull root has no turns the hub sees (it stays "working"), so it hands off as soon as the new agent runs.
		const state = caller.record.state;
		const busy = !caller.record.pull && (state === "working" || state === "asking" || state === "starting");
		if (!to.ready || busy) return;
		caller.handedOff = true;
		const adopted = this.adopt(caller, to);
		this.log.event(caller.record.name, "handed-off", { to: h.to, adopted });
		void this.closeAgent(caller);
	}

	/**
	 * The agent that takes over stands where the caller stood, and adopts the caller's live workers with their queued
	 * messages. Returns the names of the adopted workers.
	 * Problem: a planner handed off with two workers still running, and the executor could not message, cancel, permit or
	 * switch them: their parent had closed. Example: "routing-4" finished, and its result waited for the planner, which
	 * exited, so nobody read it. Solution: before the caller closes, its live children other than the successor move to the
	 * successor, and every message queued for the caller from them moves too (the same message, not sent again), so each
	 * is delivered once. A message the successor queued for the caller goes to the caller's parent, which now stands where
	 * the caller stood; a root has no parent, so there such a message is dropped, as any notice for a root is.
	 */
	private adopt(caller: Agent, to: Agent): string[] {
		const successor = to.record.name;
		const heir = caller.record.parent ? this.registry.get(caller.record.parent) : undefined;
		const workers = this.registry
			.children(caller.record.name)
			.filter((c) => c !== to && c.record.state !== "exited" && !c.closing);
		const adoptedNames = new Set(workers.map((w) => w.record.name));
		const moves = (m: QueuedMessage) => adoptedNames.has(m.from) || m.from === successor;
		const moved = [...caller.queue, ...caller.inbox].filter(moves);
		caller.queue = caller.queue.filter((m) => !moves(m));
		caller.inbox = caller.inbox.filter((m) => !moves(m));

		// The successor takes the caller's parent (none for a root), so the tree keeps its shape and the same agent answers
		// for it. Example: a planner under the user's root hands off; the executor's results go to the same root.
		to.record.parent = caller.record.parent;
		for (const w of workers) {
			w.record.parent = successor;
			this.log.event(w.record.name, "adopted", { by: successor, from: caller.record.name });
		}
		for (const m of moved) {
			if (m.from !== successor) {
				this.place(to, m);
				this.log.event(successor, "message-adopted", { id: m.id, from: m.from });
			} else if (heir && heir.record.state !== "exited" && !heir.closing) {
				this.place(heir, m);
				this.log.event(heir.record.name, "message-adopted", { id: m.id, from: m.from });
			} else
				this.log.event(successor, "notice-dropped", { kind: m.kind, reason: heir ? "parent exited" : "no parent" });
		}
		for (const a of this.subtree(to)) this.relink(a);
		this.pump(to);
		if (heir) this.pump(heir);
		return [...adoptedNames];
	}

	/** Puts a message that already exists on an agent's queue, or its inbox for a pull agent: moved, not sent again. */
	private place(to: Agent, m: QueuedMessage): void {
		if (to.record.pull) {
			to.inbox.push(m);
			this.publish(to.record.name, m);
		} else to.queue.push(m);
	}

	/** Writes an agent's parent and root into its journal record again, after its tree moved. */
	private relink(a: Agent): void {
		const parent = a.record.parent ? this.registry.get(a.record.parent) : undefined;
		this.journalUpdate(a, {
			parent: parent?.journalId ?? null,
			parentName: a.record.parent,
			root: this.rootJournalId(a) ?? a.journalId,
		});
	}

	private subtree(agent: Agent): Agent[] {
		return [agent, ...this.registry.children(agent.record.name).flatMap((c) => this.subtree(c))];
	}

	private newAgent(record: AgentRecord, profile: Profile | undefined): Agent {
		return {
			record,
			profile,
			ready: false,
			queue: [],
			inbox: [],
			lastText: "",
			askedParent: false,
			retried: new Set(),
		};
	}

	private createAdapter(agent: Agent, factory: AdapterFactory) {
		const name = agent.record.name;
		const guard = this.opts.guard ?? checkCommand;
		const adapter = factory({
			log: (kind, data) => this.log.event(name, kind, data),
			guard,
			depth: agent.record.depth,
		});
		agent.adapter = adapter;
		adapter.onUpdate((u) => this.update(agent, u));
		return adapter;
	}

	private journalCreate(
		agent: Agent,
		extra: { task?: string; place?: PlaceHint; pid?: number; backend?: BackendName; replaces?: string },
		parent?: Agent,
	): void {
		const { journal } = this.opts;
		if (!journal) return;
		const r = agent.record;
		const at = new Date(r.startedAt);
		const id = journalId(r.name, at);
		agent.journalId = id;
		const parentId = parent?.journalId ?? null;
		const root = parent && parentId ? (this.rootJournalId(parent) ?? parentId) : id;
		try {
			journal.create({
				id,
				name: r.name,
				parent: parentId,
				parentName: r.parent,
				root,
				harness: r.harness,
				model: r.model,
				cwd: r.cwd,
				task: extra.task,
				state: r.state,
				depth: r.depth,
				backend: extra.backend,
				place: extra.place,
				pid: extra.pid,
				replaces: extra.replaces,
				startedAt: at.toISOString(),
			});
		} catch (e) {
			this.log.event(r.name, "journal-failed", { error: errorText(e) });
		}
	}

	private rootJournalId(agent: Agent): string | undefined {
		let a: Agent | undefined = agent;
		while (a?.record.parent) a = this.registry.get(a.record.parent);
		return a?.journalId;
	}

	private journalUpdate(agent: Agent, patch: SessionPatch): void {
		if (!this.opts.journal || !agent.journalId) return;
		try {
			this.opts.journal.update(agent.journalId, patch);
		} catch (e) {
			this.log.event(agent.record.name, "journal-failed", { error: errorText(e) });
		}
	}

	private identity(agent: string, depth: number): Identity {
		return { agent, hub: this.opts.socket, token: this.opts.token, depth };
	}

	// -------------------------------------------------------------------------------------------------
	// Queue and delivery
	// -------------------------------------------------------------------------------------------------

	/** Queues a message for `to`: pull agents keep it for inbox(), the others get it on a turn of its own. */
	private enqueue(to: Agent, m: { id?: string; from: string; text: string; kind: MessageKind }): QueuedMessage {
		const msg: QueuedMessage = {
			id: m.id ?? randomUUID(),
			from: m.from,
			to: to.record.name,
			text: m.text,
			kind: m.kind,
			queuedAt: Date.now(),
		};
		this.log.messageQueued({ id: msg.id, from: msg.from, to: msg.to, length: msg.text.length, kind: msg.kind });
		if (to.record.pull) {
			to.inbox.push(msg);
			this.publish(to.record.name, msg);
		} else {
			to.queue.push(msg);
			this.pump(to);
		}
		return msg;
	}

	/**
	 * Hands the next message to the agent if it can take one now: connected, idle, no prompt in flight.
	 * A busy adapter is tried again after idlePollMs, besides every update it sends.
	 */
	private pump(agent: Agent): void {
		const { adapter } = agent;
		// Problem: a queued message sent while an interrupt cancels and switches would run on the old model, before its
		// continuation. Example: "list the folders" queued behind a cancelled turn runs before the switch is confirmed.
		// Solution: the queue waits; the interrupt lifts the fence when it ends, and the continuation goes first.
		if (!adapter || !agent.ready || agent.closing || agent.inflight || agent.interrupt || !agent.queue.length) return;
		if (agent.record.state === "exited") return;
		if (!adapter.idle()) {
			agent.retry ??= setTimeout(() => {
				agent.retry = undefined;
				this.pump(agent);
			}, this.opts.idlePollMs ?? 250);
			return;
		}
		const msg = agent.queue.shift();
		if (!msg) return;
		agent.inflight = msg;
		agent.replyText = undefined;
		agent.lastText = "";
		agent.lastResult = undefined;
		this.log.messageDelivered(msg.id);
		this.publish(agent.record.name, msg);
		this.transition(agent, "wake");
		Promise.resolve()
			.then(() => adapter.prompt({ id: msg.id, from: msg.from, text: msg.text }))
			.then(
				(res) => this.turnEnd(agent, res, msg),
				(e: unknown) => this.turnEnd(agent, { stopReason: "error", text: errorText(e) }, msg),
			);
	}

	/**
	 * A turn ended: prompt() resolved (msg given), or a turn_end update for a turn the user typed.
	 * The result is what the agent passed to reply() in that turn, else its last text.
	 */
	private turnEnd(agent: Agent, res: PromptResponse, msg?: QueuedMessage): void {
		const name = agent.record.name;
		if (msg) {
			if (agent.inflight === msg) agent.inflight = undefined;
			this.log.messageTurnEnd(msg.id);
		}
		if (agent.fence) {
			this.fencedTurnEnd(agent, agent.fence, res);
			return;
		}
		if (agent.closing || agent.record.state === "exited") return;
		// A turn that succeeded, or one the user started in the pane, supersedes the failed message; a failed turn replaces it.
		agent.lastFailed = msg && res.stopReason === "error" ? { msg, error: res.text.trim() || undefined } : undefined;
		const result = agent.replyText ?? (res.text.trim() ? res.text : agent.lastText);
		agent.replyText = undefined;
		this.log.event(name, "turn-end", { stopReason: res.stopReason, length: result.length, message: msg?.id });
		// An interrupt waits for this turn to end, and records how it ended (interruptModel decides what follows).
		if (agent.interrupt) agent.interrupt.stop = res.stopReason;
		// Problem: a cancelled turn reported as a result, then its continuation reported too, gives the parent two answers
		// for one task. Example: "count the files" cancelled, then continued to "42 files". Solution: the cancelled turn ends
		// quietly; its continuation reports the result.
		if (agent.interrupt && res.stopReason === "cancelled") {
			this.transition(agent, turnEndCause(res.stopReason));
			return;
		}
		if (agent.askedParent) {
			// The turn that asked the parent ended. Forwarding it would show the parent the same question
			// twice and it would answer twice. The worker stays asking until the answer reaches it, and the
			// next turn end (after the answer) is its result.
			agent.askedParent = false;
			agent.held = result;
			this.log.event(name, "turn-end-held");
		} else if (this.transition(agent, turnEndCause(res.stopReason))) {
			agent.held = undefined;
			if (res.stopReason !== "cancelled" && res.stopReason !== "error")
				agent.lastResult = { stop: res.stopReason, text: result };
			this.notifyParent(agent, resultText(agent.record, res.stopReason, result), "result");
		}
		this.pump(agent);
	}

	/**
	 * A turn ends on a fenced worker (replace stopped it). Its output never reaches the parent as current. A turn that
	 * finished on its own before the replacement exists is the outcome replace reports; any other is logged as late, and
	 * once a replacement runs the parent hears, once, that the output is stale.
	 * Problem: a cancelled or ignored turn ends after its replacement runs, and its text reaches the parent as a finished
	 * result. Example: a quota-exhausted worker's last answer arriving next to the replacement's answer for the same task.
	 * Solution: only a natural end during the fence is kept; the rest is dropped, with one stale notice.
	 */
	private fencedTurnEnd(agent: Agent, fence: Fence, res: PromptResponse): void {
		const name = agent.record.name;
		const result = agent.replyText ?? (res.text.trim() ? res.text : agent.lastText);
		agent.replyText = undefined;
		const natural = res.stopReason !== "cancelled" && res.stopReason !== "error";
		if (natural && !fence.outcome && !fence.replacement) {
			fence.outcome = { stop: res.stopReason, text: result };
			this.log.event(name, "fence-outcome", { stopReason: res.stopReason, length: result.length });
			this.transition(agent, turnEndCause(res.stopReason));
			return;
		}
		this.log.event(name, "late-result-dropped", { stopReason: res.stopReason, length: result.length });
		const parent = agent.record.parent ? this.registry.get(agent.record.parent) : undefined;
		if (fence.replacement && !fence.noticed && parent && !parent.closing && parent.record.state !== "exited") {
			fence.noticed = true;
			this.enqueue(parent, { from: name, text: staleNotice(agent.record, fence.replacement), kind: "notice" });
		}
	}

	private update(agent: Agent, u: SessionUpdate): void {
		const name = agent.record.name;
		if (u.kind === "agent_message") {
			agent.lastText = u.text;
			return;
		}
		if (u.kind === "tool_call") {
			this.log.event(name, "tool-call", { title: u.title, status: u.status });
			return;
		}
		if (u.kind === "session") {
			this.log.event(name, "session", { sessionId: u.sessionId, transcript: u.transcript });
			this.journalUpdate(agent, { sessionId: u.sessionId, transcript: u.transcript });
			return;
		}
		if (u.kind === "model") {
			this.log.event(name, "model-applied", { model: u.model });
			this.setRecordModel(agent, u.model);
			return;
		}
		if (u.kind === "model_error") {
			this.log.event(name, "model-failed", { model: u.model, error: u.error });
			this.notifyParent(
				agent,
				`${name} could not switch to ${u.model}: ${u.error}. It keeps ${agent.record.model ?? "its model"}.`,
			);
			return;
		}
		this.log.event(name, `update-${u.kind}`, u.kind === "state" ? { state: u.state, detail: u.detail } : {});
		if (agent.closing) return;
		if (u.kind === "exited") {
			void this.agentExited(agent, u.detail ?? (u.code === undefined ? undefined : `code ${u.code}`));
			return;
		}
		if (u.kind === "turn_end") {
			if (agent.inflight) {
				// prompt()'s own promise ends the turns it started; this one would count it twice.
				this.log.event(name, "turn-end-ignored", { reason: "prompt in flight" });
				return;
			}
			this.turnEnd(agent, { stopReason: u.stopReason, text: u.text });
			return;
		}
		const cause = causeOf(u);
		if (cause === "asking" && u.kind === "state") {
			const was = agent.record.state;
			// A new ask while already asking (opencode's next permission) is news for the parent too.
			const changed = JSON.stringify(u.ask) !== JSON.stringify(agent.ask);
			agent.ask = u.ask;
			agent.waitingFor = u.detail;
			const asking = was === "asking" || this.transition(agent, "asking");
			if (asking && (was !== "asking" || (u.ask && changed)))
				this.notifyParent(agent, u.ask ? askNotice(agent.record, u.ask) : waitingNotice(agent.record, u.detail));
		} else {
			agent.ask = undefined;
			agent.waitingFor = undefined;
			if (cause) this.transition(agent, cause);
		}
		this.pump(agent);
	}

	/**
	 * The parent answers what its worker waits on: a permission or question the adapter reported (answered through
	 * the harness's own path, never the pane), or a startup dialog the parent was told about.
	 */
	async permit(req: {
		from: string;
		to: string;
		choice: string;
	}): Promise<{ ok: boolean; answered?: string; error?: string }> {
		const to = this.registry.get(req.to);
		if (!to) return { ok: false, error: this.registry.unknownAgent(req.to, req.from) };
		if (to.record.state === "exited" || to.closing) return { ok: false, error: `${req.to} has exited` };
		if (to.record.parent !== req.from)
			return { ok: false, error: `only ${req.to}'s parent (${to.record.parent ?? "none"}) answers its permissions` };
		const choice = req.choice?.trim() ?? "";
		if (!choice) return { ok: false, error: "the choice is empty" };
		if (to.ask && to.adapter?.answer) {
			const r = await to.adapter.answer(choice);
			this.log.event(req.to, "permit", "error" in r ? { choice, error: r.error } : { choice, answered: r.answered });
			if ("error" in r) return { ok: false, error: r.error };
			return { ok: true, answered: r.answered };
		}
		if (to.dialog && to.record.state === "asking") {
			const r = await this.answerDialog("", to, choice);
			return r.ok ? { ok: true, answered: r.answered } : { ok: false, error: r.error };
		}
		if (to.record.state === "asking" && to.askedParent)
			return { ok: false, error: `${req.to} asked you a question with send: answer it with send, not permit` };
		if (to.record.state === "asking")
			return {
				ok: false,
				error: `${req.to} waits on something agent-link cannot answer for it (${to.waitingFor ?? "a prompt in its pane"}). Ask the user to answer it in ${req.to}'s pane.`,
			};
		return { ok: false, error: `${req.to} is not waiting on a permission or question (it is ${to.record.state})` };
	}

	/** Queues a hub notice or a result for the agent's parent, as if the agent had sent it. */
	private notifyParent(agent: Agent, text: string, kind: MessageKind = "notice"): void {
		// Problem: a fenced worker's dialog or late notice reaches its parent as current. Example: a permission prompt that
		// its cancelled turn left open. Solution: dropped here, and logged; replace reports what matters.
		if (agent.fence) {
			this.log.event(agent.record.name, "late-result-dropped", { kind, fenced: true });
			return;
		}
		const parent = agent.record.parent ? this.registry.get(agent.record.parent) : undefined;
		// Problem: a child reports to a parent that replace is stopping, and the report would be lost. Example: a routing
		// worker finishing while its planner is fenced. Solution: the report waits on the fence and moves to the replacement.
		if (parent?.fence) {
			parent.fence.held.push({ from: agent.record.name, text, kind });
			return;
		}
		if (!parent || parent.closing || parent.record.state === "exited") {
			this.log.event(agent.record.name, "notice-dropped", { kind, reason: parent ? "parent exited" : "no parent" });
			return;
		}
		this.enqueue(parent, { from: agent.record.name, text, kind });
	}

	/** The only way an agent's state changes. False, and an event in the log, when the table rejects it. */
	private transition(agent: Agent, cause: Cause): boolean {
		const from = agent.record.state;
		const to = next(from, cause);
		if (!to) {
			this.log.event(agent.record.name, "ignored-transition", { from, cause });
			return false;
		}
		if (cause === "error" || cause === "exited") agent.askedParent = false;
		if (to !== from) {
			agent.record.state = to;
			this.log.agentState(agent.record.name, to);
			this.journalUpdate(agent, to === "exited" ? { state: to, endedAt: new Date().toISOString() } : { state: to });
			if (agent.handoff && to === "done") this.tryHandoff(agent);
		}
		return true;
	}

	// -------------------------------------------------------------------------------------------------
	// API
	// -------------------------------------------------------------------------------------------------

	/** Routes a message. Nobody waits: the recipient gets it on its next free turn, in FIFO order. */
	async send(req: { from: string; to: string; message: string; id?: string }): Promise<SendResult> {
		const id = req.id || randomUUID();
		const seen = this.seen.get(id);
		if (seen) return { ...seen, duplicate: true };
		const result = await this.route(id, req);
		this.seen.set(id, result);
		return result;
	}

	private async route(id: string, req: { from: string; to: string; message: string }): Promise<SendResult> {
		const from = this.registry.get(req.from);
		const to = this.registry.get(req.to);
		if (!from) return { ok: false, id, error: this.registry.unknownAgent(req.from, req.from) };
		// A cancelled worker that is still shutting down may call send; its parent already moved on.
		if (from.record.state === "exited" || from.closing)
			return { ok: false, id, error: `${req.from} has exited; its messages are not delivered.` };
		if (!to) return { ok: false, id, error: this.registry.unknownAgent(req.to, req.from) };
		if (to.record.state === "exited" || to.closing)
			return {
				ok: false,
				id,
				error: `${req.to} has exited (cancelled or closed). Spawn a new worker to continue its task.`,
			};
		if (!this.registry.canTalk(req.from, req.to))
			return {
				ok: false,
				id,
				error: `${req.from} cannot talk to ${req.to}: a worker talks only with its parent and its own workers. ${this.registry.unknownAgent(req.to, req.from).replace(/^unknown agent "[^"]*"\. /, "")}`,
			};
		if (!req.message?.trim()) return { ok: false, id, error: "the message is empty" };
		// Only while the worker waits on a dialog its parent was told about: the message is the choice.
		if (to.dialog && to.record.state === "asking" && to.record.parent === req.from)
			return this.answerDialog(id, to, req.message);
		// A parent's message reads like its user's; anyone else's says who sent it.
		const text = to.record.parent === req.from ? req.message : messageText(req.from, req.message);
		const msg = this.enqueue(to, { id, from: req.from, text, kind: "message" });
		const asksParent =
			from.record.parent === req.to && (from.inflight !== undefined || from.record.state === "working");
		if (asksParent && this.transition(from, "asking")) from.askedParent = true;
		const queued = to.record.pull ? to.inbox.includes(msg) : to.inflight !== msg;
		return { ok: true, id, queued };
	}

	private async answerDialog(id: string, agent: Agent, choice: string): Promise<SendResult> {
		const { backend, pane } = agent.record;
		const pb = backend ? this.opts.backends[backend] : undefined;
		if (!pb || !pane) return { ok: false, id, error: `${agent.record.name} has no pane to answer in` };
		const screen = await pb.read(pane, 60).catch(() => "");
		const pick = keysForChoice(screen, choice.trim());
		if ("error" in pick) {
			const options = agent.dialog ? `\n\n${dialogLines(agent.dialog.text, agent.dialog.options)}` : "";
			return { ok: false, id, error: `not answered: ${pick.error}, so no keys were sent.${options}` };
		}
		await pb.keys(pane, pick.keys);
		this.log.event(agent.record.name, "dialog-choice", { option: pick.option, keys: pick.keys });
		return { ok: true, id, queued: false, answered: `${pick.index + 1}. ${pick.option}` };
	}

	reply(req: { from: string; result: string }): { ok: boolean; error?: string } {
		const agent = this.registry.get(req.from);
		if (!agent) return { ok: false, error: this.registry.unknownAgent(req.from, req.from) };
		if (agent.record.state === "exited" || agent.closing) return { ok: false, error: `${req.from} has exited` };
		if (!agent.record.parent)
			return { ok: false, error: "you are a root agent: no parent receives a result. Tell the user directly." };
		agent.replyText = String(req.result ?? "");
		this.log.event(req.from, "reply", { length: agent.replyText.length });
		return { ok: true };
	}

	/** Every agent of this hub run, roots first in registration order, each followed by its tree. */
	allAgents(): Array<StatusEntry & { backend?: BackendName; pane?: string; startedAt: number }> {
		const out: Agent[] = [];
		const walk = (a: Agent) => {
			out.push(a);
			for (const c of this.registry.children(a.record.name)) walk(c);
		};
		for (const a of this.registry.agents.values()) if (!a.record.parent) walk(a);
		return out.map((a) => ({
			...statusEntry(a),
			backend: a.record.backend,
			pane: a.record.pane,
			startedAt: a.record.startedAt,
		}));
	}

	status(name: string): { agents: StatusEntry[]; error?: string } {
		if (!this.registry.get(name)) return { agents: [], error: this.registry.unknownAgent(name, name) };
		return { agents: this.registry.scope(name).map(statusEntry) };
	}

	/** Cancels a worker and its tree. Only an agent above it may. */
	async cancel(req: { from: string; name: string }): Promise<{ ok: boolean; error?: string }> {
		const target = this.registry.get(req.name);
		if (!target) return { ok: false, error: this.registry.unknownAgent(req.name, req.from) };
		if (!this.registry.isAncestor(req.from, req.name))
			return { ok: false, error: `${req.from} cannot cancel ${req.name}: only its parent (or an agent above it) can.` };
		if (target.record.state === "exited") return { ok: true };
		this.log.event(req.name, "cancel", { by: req.from });
		await this.closeAgent(target);
		return { ok: true };
	}

	/**
	 * Replaces a worker whose harness cannot switch its model in place (Claude Code, Codex, a paste worker), on behalf of
	 * an agent above it. The old worker is fenced, its turn cancelled and it is closed; its exit is confirmed (bounded by
	 * interruptMs); then a replacement starts in the same folder under the same parent with the same task, a bounded
	 * continuation and the repository fingerprints. Its live children move to it.
	 * Problem: the parent could only cancel the worker and spawn another by hand, which lost the task's context and let the
	 * old worker's late answer arrive as current. Example: a Codex worker out of quota, whose cancelled turn still reports.
	 * Solution: one writer at a time. Anything that does not confirm the exit spawns nothing and says so.
	 */
	async replace(req: {
		from: string;
		to: string;
		harness: string;
		model?: string;
		name?: string;
		notes?: string;
		backend?: BackendName;
		read?: string[];
	}): Promise<ReplaceResult> {
		if (this.closed) return { error: "the hub is shutting down" };
		const target = this.registry.get(req.to);
		if (!target) return { error: this.registry.unknownAgent(req.to, req.from) };
		if (req.from === req.to || !this.registry.isAncestor(req.from, req.to))
			return { error: `${req.from} cannot replace ${req.to}: only its parent (or an agent above it) can.` };
		const parent = target.record.parent ? this.registry.get(target.record.parent) : undefined;
		if (!parent) return { error: `${req.to} has no parent to take its replacement` };
		if (target.fence) return { error: `${req.to} is already being replaced` };
		if (target.interrupt)
			return {
				error: `${req.to} is being interrupted to switch its model: wait for it to continue`,
			};
		if (target.record.state === "exited" || target.closing)
			return { error: `${req.to} has exited: spawn a new worker to continue its task` };
		if (parent.record.state === "exited" || parent.closing)
			return { error: `${parent.record.name} has exited, so it cannot take the replacement` };
		// Problem: a worker that already finished would be stopped and its work repeated. Example: "run the tests" finished
		// with its result delivered; a replace after it answers with that result and spawns nothing.
		if (target.record.state === "done" && target.lastResult)
			return {
				status: "finished",
				name: target.record.name,
				result: resultText(target.record, target.lastResult.stop, target.lastResult.text),
			};
		// Everything that can be refused is refused before the old worker is touched.
		if (req.model && !isExactModel(req.model))
			return {
				error: `the model must be an exact <provider>/<id> (e.g. anthropic/claude-sonnet-5-5), not ${JSON.stringify(req.model)}`,
			};
		const backend = req.backend ?? target.record.backend ?? "cmux";
		const task = target.task ?? "";
		this.profileFor(req.harness);
		const checked = checkSpawn(
			{ from: parent.record.name, harness: req.harness, task, model: req.model, cwd: target.record.cwd, backend },
			{ caller: parent, profiles: this.profiles, adapters: this.opts.adapters, backends: this.opts.backends },
		);
		if (!checked.ok) return { error: checked.error };

		const name = target.record.name;
		const before = repoFingerprint(target.record.cwd);
		const fence: Fence = { held: [], noticed: false };
		target.fence = fence;
		this.log.event(name, "fenced", { by: req.from, before });
		// Cancels the turn in flight, closes the adapter and the pane. Not awaited: the wait below is the bound.
		void this.closeAgent(target);
		const bound = this.opts.interruptMs ?? 20000;
		const deadline = Date.now() + bound;
		while (!this.confirmedExited(target) && !fence.outcome && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, Math.min(this.opts.idlePollMs ?? 250, deadline - Date.now())));

		// A natural end during the fence is the outcome: the work is done, so nothing is spawned.
		if (fence.outcome) {
			this.transferFence(target, parent);
			return {
				status: "finished",
				name,
				result: resultText(target.record, fence.outcome.stop, fence.outcome.text),
			};
		}
		if (!this.confirmedExited(target)) {
			this.transferFence(target, parent);
			return {
				error: `${name} did not confirm its exit within ${Math.round(bound / 1000)} s, so nothing was spawned. It stays fenced: its output is dropped.`,
			};
		}

		const after = repoFingerprint(target.record.cwd);
		const continuation = continuationTask({
			task,
			progress: target.lastText,
			notes: req.notes,
			oldName: name,
			oldJournalId: target.journalId ?? name,
			before,
			after,
			cwd: target.record.cwd,
		});
		const started = await this.startWorker(
			parent,
			{
				from: parent.record.name,
				harness: req.harness,
				task: continuation,
				model: req.model,
				name: req.name || this.nextReplacementName(name),
				cwd: target.record.cwd,
				backend,
				read: req.read,
			},
			target.journalId,
		);
		const replacement = "error" in started ? undefined : this.registry.get(started.name);
		if (!replacement) {
			this.transferFence(target, parent);
			const why = "error" in started ? started.error : "the replacement did not register";
			return { error: `not replaced: ${why}. ${name} stays closed, so nothing writes in its folder.` };
		}
		fence.replacement = replacement.record.name;
		this.transferFence(target, replacement);
		this.journalUpdate(target, { replacedBy: replacement.journalId });
		this.log.event(name, "replaced", { by: replacement.record.name, before, after });
		this.log.event(replacement.record.name, "replaces", { old: name, before, after });
		return { status: "replaced", name: replacement.record.name, previous: name, before, after };
	}

	/** `<base>-r<N>` with the smallest N no agent of this run uses: the replacement of claude-r1 is claude-r2. */
	private nextReplacementName(old: string): string {
		const base = old.replace(/-r\d+$/, "");
		let n = 1;
		while (this.registry.get(`${base}-r${n}`)) n++;
		return `${base}-r${n}`;
	}

	/** The worker is confirmed gone: its record says exited, and when its process is known, the process is gone too. */
	private confirmedExited(agent: Agent): boolean {
		if (agent.record.state !== "exited") return false;
		return agent.pid === undefined || !processAlive(agent.pid);
	}

	/**
	 * Moves what a fenced worker leaves to `heir`: its live children (with their own workers) and the reports they sent
	 * while it was fenced, each delivered once. The heir is the replacement, or the fenced worker's parent when nothing
	 * was replaced. Problem: the children of a fenced worker are not closed, so they need an owner. Example: a planner's
	 * routing worker still running when its planner is replaced; its result must reach the replacement, once.
	 */
	private transferFence(target: Agent, heir: Agent): void {
		const fence = target.fence;
		const held = fence?.held ?? [];
		if (fence) fence.held = [];
		const workers = this.registry
			.children(target.record.name)
			.filter((c) => c !== heir && c.record.state !== "exited" && !c.closing);
		for (const w of workers) {
			w.record.parent = heir.record.name;
			this.log.event(w.record.name, "adopted", { by: heir.record.name, from: target.record.name });
			for (const a of this.subtree(w)) this.relink(a);
		}
		for (const m of held) {
			if (heir.record.state === "exited" || heir.closing) {
				this.log.event(heir.record.name, "notice-dropped", { kind: m.kind, reason: "parent exited" });
				continue;
			}
			this.enqueue(heir, m);
		}
		this.pump(heir);
	}

	/**
	 * Changes the model of a worker, on behalf of an agent above it. The adapter does the switch through its harness's
	 * own path; the record and the journal follow what it reports ("applied" now, "pending" via a model update).
	 * With retry, an applied switch sends the message that failed the worker's last turn once more (retryFailed).
	 * With interrupt, a busy worker's turn is cancelled and its task continued (interruptModel); an idle one switches as usual.
	 */
	async model(req: {
		from: string;
		to: string;
		model: string;
		retry?: boolean;
		interrupt?: boolean;
	}): Promise<ModelResult> {
		const target = this.registry.get(req.to);
		if (!target) return { error: this.registry.unknownAgent(req.to, req.from) };
		const self = req.from === req.to;
		if (!self && !this.registry.isAncestor(req.from, req.to))
			return { error: `${req.from} cannot change the model of ${req.to}: only its parent (or an agent above it) can.` };
		// Problem: a model change on a worker that replace is stopping would race its replacement. Example: a switch that
		// lands on the fenced worker while the replacement starts with the old model. Solution: refused, and named as such.
		if (target.fence) return { error: `${req.to} is being replaced: its model cannot change now` };
		// A self-switch must never cancel or replay the tool request that asked for it.
		if (self && (req.retry || req.interrupt))
			return { error: "a self-switch cannot use retry or interrupt: the current request must finish exactly once" };
		// Problem: retry sends the failed message again, and interrupt continues the interrupted task; both at once repeat
		// work. Example: a quota failure retried and continued together runs the same task twice. Solution: refused.
		if (req.retry && req.interrupt)
			return {
				error:
					"retry and interrupt cannot be combined: interrupt continues the interrupted task itself, and retry would send its failed message again",
			};
		// Problem: an exited worker's failed message can never be sent again, and "has exited" alone does not say so.
		// Example: a parent that retried a quota failure after cancelling the worker waited for a retry that never came.
		// Solution: a retry or an interrupt against an exited worker says the worker must be respawned.
		if (target.record.state === "exited" || target.closing) {
			if (req.retry)
				return {
					error: `${req.to} has exited, so its failed message cannot be retried: spawn a new worker to continue its task`,
				};
			if (req.interrupt)
				return {
					error: `${req.to} has exited, so its turn cannot be continued: spawn a new worker to continue its task`,
				};
			return { error: `${req.to} has exited` };
		}
		if (!isExactModel(req.model))
			return {
				error: `the model must be an exact <provider>/<id> (e.g. anthropic/claude-sonnet-5-5), not ${JSON.stringify(req.model)}`,
			};
		if (!target.adapter?.setModel)
			return { error: `${req.to} cannot change its model through agent-link: its adapter has no model switch` };
		// Problem: a second model change while an interrupt runs would race its cancel and switch. Example: a plain switch
		// landing between the cancel and the continuation. Solution: refused until the interrupt ends.
		if (target.interrupt)
			return { error: `${req.to} is already being interrupted to switch its model: wait for it to continue` };
		if (req.interrupt && this.busy(target)) return this.interruptModel(target, req);
		const previous = target.record.model;
		let res: SetModelResult;
		try {
			res = await target.adapter.setModel(req.model);
		} catch (e) {
			res = { error: errorText(e) };
		}
		this.log.event(req.to, "model", { by: req.from, model: req.model, ...res });
		if (!("error" in res) && res.status === "applied") this.setRecordModel(target, res.model);
		if (!req.retry) return "error" in res ? res : { status: res.status, model: res.model, previous };
		// Problem: a switch that failed or is still pending must not send the failed message again. Example: a quota
		// failure, then a switch that the harness only applies before its next turn: the retry would run on the old model.
		// Solution: only an applied switch retries; the outcome says why not otherwise.
		const retry =
			"error" in res
				? skipped("the model switch failed, so the failed message was not retried")
				: res.status === "applied"
					? this.retryFailed(target)
					: skipped("the switch is pending, so the failed message was not retried");
		this.log.event(req.to, "model-retry", { by: req.from, ...retry });
		return "error" in res ? { error: res.error, retry } : { status: res.status, model: res.model, previous, retry };
	}

	/**
	 * Sends the message that failed the worker's last turn once more, through the normal queue. Only an idle worker
	 * whose last turn failed qualifies. Problem: a retry sent after the worker ran another turn replays a task the
	 * parent may already have dropped. Example: a failed "count files", then "list folders" succeeds; a retry
	 * after that must not run "count files" again. Solution: the failed message stays until a turn succeeds, and
	 * only the error state of an idle worker, with a message not yet retried, qualifies.
	 */
	private retryFailed(agent: Agent): RetryOutcome {
		const name = agent.record.name;
		const failed = agent.lastFailed;
		if (!failed) return skipped(`${name}'s last turn did not fail`);
		if (agent.record.state !== "error" || agent.inflight || agent.closing)
			return skipped(
				`${name} is ${agent.record.state}: only an idle worker whose last turn failed gets the message again`,
			);
		const { msg } = failed;
		if (agent.retried.has(msg.id)) return skipped(`the failed message ${msg.id} was already retried once`);
		agent.retried.add(msg.id);
		this.enqueue(agent, { id: msg.id, from: msg.from, text: msg.text, kind: msg.kind });
		return { retried: true, messageId: msg.id, ...(failed.error !== undefined && { error: failed.error }) };
	}

	/**
	 * Switches the model of a busy worker and continues its interrupted task, with one continuation to the same agent.
	 * Problem: cancelling first loses the turn when the switch is then refused, and Claude and Codex refuse every switch.
	 * Example: a Claude worker cancelled by an interrupt, its switch refused, its task stopped for nothing. Solution: the
	 * switch is asked first; the cancel follows only once the harness accepts it. Once cancelled, the hub waits (bounded)
	 * until the turn has ended as cancelled, the adapter is idle and the switch is confirmed; only then the continuation
	 * goes first in the queue. Every other end is an explicit outcome with no continuation.
	 */
	private async interruptModel(target: Agent, req: { from: string; model: string }): Promise<ModelResult> {
		const name = target.record.name;
		const previous = target.record.model;
		const interrupt: { stop?: StopReason } = {};
		target.interrupt = interrupt;
		let next: QueuedMessage | undefined;
		try {
			let res: SetModelResult;
			try {
				res = (await target.adapter?.setModel?.(req.model)) ?? { error: `${name} has no model switch` };
			} catch (e) {
				res = { error: errorText(e) };
			}
			this.log.event(name, "model", { by: req.from, model: req.model, interrupt: true, ...res });
			if ("error" in res)
				return {
					error: res.error,
					interrupt: { continued: false, reason: "the model switch failed, so the turn was not interrupted" },
				};
			if (res.status === "applied") this.setRecordModel(target, res.model);
			const base = { status: res.status, model: res.model, previous };
			// Problem: a turn that ended while the switch ran has nothing left to cancel, and its own result already went to
			// the parent. Example: "count the files" finished during the switch, and a cancel would only repeat the question.
			// Solution: no cancel, no continuation; the result is the one the parent gets.
			if (target.adapter?.idle() ?? true)
				return {
					...base,
					interrupt: {
						continued: false,
						reason: `${name}'s turn ended on its own before the cancel, so there was nothing to continue`,
					},
				};
			try {
				await target.adapter?.cancel();
			} catch (e) {
				return {
					...base,
					interrupt: { continued: false, reason: `${name}'s turn could not be cancelled: ${errorText(e)}` },
				};
			}
			const end = await this.awaitInterrupt(target, interrupt, res.model);
			if (end === "cancelled") {
				next = {
					id: randomUUID(),
					from: req.from,
					to: name,
					text: `Continue the task from where you stopped; your model changed to ${res.model}.`,
					kind: "message",
					queuedAt: Date.now(),
				};
				return { status: "applied", model: res.model, previous, interrupt: { continued: true, messageId: next.id } };
			}
			const reason =
				end === "timeout"
					? interrupt.stop === undefined
						? `${name} did not stop in time, so its task was not continued`
						: `the switch to ${res.model} did not apply in time, so its task was not continued`
					: end === "exited"
						? `${name} exited while its turn was interrupted, so its task was not continued`
						: `${name}'s turn ended on its own before the cancel took effect, so there was nothing to continue`;
			return { ...base, interrupt: { continued: false, reason } };
		} finally {
			if (target.interrupt === interrupt) target.interrupt = undefined;
			if (next && !target.closing) {
				target.queue.unshift(next);
				this.log.messageQueued({
					id: next.id,
					from: next.from,
					to: next.to,
					length: next.text.length,
					kind: next.kind,
				});
			}
			this.pump(target);
		}
	}

	/**
	 * Waits, bounded by interruptMs, until the interrupted turn has ended, the adapter is idle and the switch to `model` is
	 * confirmed (a pending switch confirms with the adapter's model update). Returns how the turn ended, or "timeout" or
	 * "exited".
	 */
	private async awaitInterrupt(
		target: Agent,
		interrupt: { stop?: StopReason },
		model: string,
	): Promise<StopReason | "timeout" | "exited"> {
		// A harness's cancel takes seconds at most (opencode's abort grace is 5 s): 20 s is the bound for the rest.
		const deadline = Date.now() + (this.opts.interruptMs ?? 20000);
		for (;;) {
			if (target.closing || target.record.state === "exited") return "exited";
			if (interrupt.stop !== undefined && target.adapter?.idle() && target.record.model === model)
				return interrupt.stop;
			const left = deadline - Date.now();
			if (left <= 0) return "timeout";
			await new Promise((r) => setTimeout(r, Math.min(this.opts.idlePollMs ?? 250, left)));
		}
	}

	/** A turn runs or waits on the user: the states an interrupt cancels. */
	private busy(agent: Agent): boolean {
		return agent.inflight !== undefined || agent.record.state === "working" || agent.record.state === "asking";
	}

	private setRecordModel(agent: Agent, model: string): void {
		agent.record.model = model;
		this.journalUpdate(agent, { model });
	}

	/** Pull agents: the messages that wait, oldest first; they count as delivered and read. */
	inbox(name: string): { messages: InboxEntry[]; error?: string } {
		const agent = this.registry.get(name);
		if (!agent) return { messages: [], error: this.registry.unknownAgent(name, name) };
		const taken = agent.inbox.splice(0);
		for (const m of taken) this.log.messageDelivered(m.id);
		return { messages: taken.map(inboxEntry) };
	}

	/** POST /event: logged, and given to whoever listens for that agent's reports. */
	event(e: HarnessEvent): { ok: boolean; error?: string } {
		if (!e.agent || !e.type) return { ok: false, error: "an event needs agent and type" };
		const { agent, type, ...data } = e;
		this.log.event(agent, `harness-${type}`, data);
		for (const fn of this.eventListeners.get(agent) ?? []) fn(e);
		// Problem: a root opened with `agent-link open` ends when its harness exits, and the pid watch notices only on its
		// next poll. Solution: `agent-link open` reports { type: "exited" } and the root's tree closes right away.
		//
		// Problem: a root's name is reused after a hub restart. Example: closing an old terminal whose `agent-link open` had
		// registered "codex" with the previous hub reported "codex exited" to the new hub, which closed the
		// new root "codex" and its app-server. Solution: `agent-link open` sends its pid, and a report from another process
		// than the one registered is ignored.
		const target = this.registry.get(agent);
		const pidMismatch = typeof data.pid === "number" && target?.pid !== undefined && data.pid !== target.pid;
		if (pidMismatch) this.log.event(agent, "exited-ignored", { reason: "pid mismatch", pid: data.pid });
		if (type === "exited" && target && !pidMismatch)
			void this.agentExited(target, typeof data.detail === "string" ? data.detail : undefined);
		return { ok: true };
	}

	onEvent(agent: string, fn: (e: HarnessEvent) => void): () => void {
		return addListener(this.eventListeners, agent, fn);
	}

	/** GET /stream: every message the hub hands to `agent` (a prompt, or a pull message queued). */
	subscribe(agent: string, fn: (m: InboxEntry) => void): () => void {
		return addListener(this.streams, agent, fn);
	}

	private publish(agent: string, m: QueuedMessage): void {
		for (const fn of this.streams.get(agent) ?? []) fn(inboxEntry(m));
	}

	// -------------------------------------------------------------------------------------------------
	// Closing
	// -------------------------------------------------------------------------------------------------

	/**
	 * Closes an agent and its tree, once: its children first, then adapter cancel and close, the pane, the
	 * run folder, and the state exited. Errors along the way are logged; the teardown goes on.
	 */
	closeAgent(agent: Agent): Promise<void> {
		agent.closing ??= (async () => {
			const name = agent.record.name;
			if (agent.retry) clearTimeout(agent.retry);
			// An agent that handed off closes alone: the agent that took over, and its workers, go on.
			// A fenced worker's children are not closed: replace moves them to the replacement (or to the parent).
			if (!agent.handedOff && !agent.fence)
				await Promise.all(
					this.registry
						.children(name)
						.filter((c) => c.record.state !== "exited")
						.map((c) => this.closeAgent(c)),
				);
			const step = async (what: string, run: () => Promise<void> | undefined) => {
				try {
					await run();
				} catch (e) {
					this.log.event(name, `${what}-failed`, { error: errorText(e) });
				}
			};
			if (agent.adapter && agent.inflight) await step("cancel", () => agent.adapter?.cancel());
			await step("close", () => agent.adapter?.close());
			const { backend, pane } = agent.record;
			if (backend && pane) await step("pane-close", () => this.opts.backends[backend]?.close(pane));
			// A root's terminal is the user's and stays open, except when the root handed off.
			const own = agent.handedOff && agent.handoff ? paneOfPlace(agent.place, agent.handoff.backend) : undefined;
			const ownBackend = agent.handoff?.backend;
			if (!pane && own && ownBackend) await step("pane-close", () => this.opts.backends[ownBackend]?.close(own));
			if (agent.runDir) rmSync(agent.runDir, { recursive: true, force: true });
			agent.queue = [];
			this.transition(agent, "exited");
			this.log.event(name, "closed");
		})();
		return agent.closing;
	}

	/** The harness went away by itself: the parent hears it (with a held answer), then the tree closes. */
	private async agentExited(agent: Agent, detail: string | undefined): Promise<void> {
		if (agent.closing) return;
		const wasRunning = agent.record.state !== "done" && agent.record.state !== "error";
		if (agent.record.parent && (wasRunning || agent.held))
			this.notifyParent(agent, exitedNotice(agent.record, detail, agent.held));
		await this.closeAgent(agent);
	}

	private checkPids(): void {
		for (const agent of this.registry.agents.values()) {
			if (!agent.pid || agent.closing || agent.record.state === "exited") continue;
			if (!processAlive(agent.pid)) {
				this.log.event(agent.record.name, "process-gone", { pid: agent.pid });
				void this.agentExited(agent, "its process ended");
			}
		}
	}

	/** Closes every agent tree; the hub takes no new work afterwards. */
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.pidTimer);
		const roots = [...this.registry.agents.values()].filter((a) => !a.record.parent);
		await Promise.all(roots.map((r) => this.closeAgent(r)));
	}
}

function skipped(reason: string): RetryOutcome {
	return { retried: false, reason };
}

function statusEntry(a: Agent): StatusEntry {
	return {
		name: a.record.name,
		parent: a.record.parent,
		harness: a.record.harness,
		model: a.record.model,
		state: a.record.state,
		depth: a.record.depth,
		pull: a.record.pull,
		queued: a.queue.length + (a.inflight ? 1 : 0) + a.inbox.length,
	};
}

function inboxEntry(m: QueuedMessage): InboxEntry {
	return { id: m.id, from: m.from, text: m.text, at: m.queuedAt };
}

function addListener<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(fn);
	return () => {
		set.delete(fn);
		if (!set.size) map.delete(key);
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: it runs, under another user.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Problem: a model name that is only close ("sonnet", "claude-sonnet-5") would be resolved by guesswork somewhere.
 * Example: two providers both serve "claude-sonnet-5-5"; a bare id could switch the worker to the wrong one.
 * Solution: only `<provider>/<id>` with no spaces or wildcards passes; the id may hold more slashes
 * (openrouter/anthropic/claude-sonnet-5-5), the provider is what precedes the first one.
 */
export function isExactModel(model: string): boolean {
	return /^[^\s/*?]+\/[^\s*?]+$/.test(model) && !model.endsWith("/");
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Where a new worker opens: next to its caller's own pane when the hub opened one, else where the caller's
 * MCP server says it is, else where `agent-link open` said the root's terminal is.
 * Problem: an MCP server can read a stale or missing place from its env. Example: a Codex worker's MCP server
 * is a child of its app-server, which the hub started outside the worker's pane, so it carried the CMUX_SURFACE_ID
 * of whichever pane started the hub; Codex's own root had none at all, since Codex filters its MCP env.
 * Solution: the hub knows the pane of every agent it opened and uses it first.
 */
/** The pane ref of a root's terminal (RegisterRequest.place) for a backend. */
export function paneOfPlace(place: PlaceHint | undefined, backend: BackendName): string | undefined {
	if (!place) return undefined;
	if (backend === "cmux") return place.surface;
	if (!place.tmuxPane) return undefined;
	return place.tmuxSocket ? `${place.tmuxPane}@${place.tmuxSocket}` : place.tmuxPane;
}

export function placeOf(caller: AgentRecord, req: SpawnRequest, registered?: PlaceHint): PlaceHint | undefined {
	if (!caller.pane || caller.backend !== req.backend) return req.place ?? registered;
	if (caller.backend === "cmux") return { surface: caller.pane };
	const [pane, socket] = caller.pane.split("@");
	return socket ? { tmuxPane: pane, tmuxSocket: socket } : { tmuxPane: pane };
}
