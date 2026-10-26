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
} from "../types.ts";
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
	waitingNotice,
} from "./queue.ts";
import { type Agent, Registry } from "./registry.ts";
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
	mcp?: McpCommands;
	guard?: (command: string, depth: number) => GuardVerdict;
	startup?: { timeoutMs?: number; pollMs?: number };
	/** How often to try delivery again while an adapter is not idle. */
	idlePollMs?: number;
	/** How often to check that registered root processes still run. */
	pidPollMs?: number;
}

export interface RegisterRequest {
	harness: string;
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

	constructor(opts: HubOptions) {
		this.opts = opts;
		this.pidTimer = setInterval(() => this.checkPids(), opts.pidPollMs ?? 1000);
		this.pidTimer.unref();
	}

	get log(): EventLog {
		return this.opts.log;
	}

	// -------------------------------------------------------------------------------------------------
	// Registration and spawn
	// -------------------------------------------------------------------------------------------------

	/** Registers a root: a harness the user opened (pull) or one `agent-link open` opened (adapter). */
	async register(req: RegisterRequest): Promise<RegisterResult> {
		if (this.closed) return { error: "the hub is shutting down" };
		if (!req.harness) return { error: "register needs a harness" };
		if (req.parent) return { error: "POST /agents registers roots only; workers come from spawn" };
		const profile = this.opts.profiles.get(req.harness);
		const factory = req.adapter ? profile && this.opts.adapters[profile.adapter] : undefined;
		if (req.adapter && !factory)
			return { error: `no adapter for "${req.harness}" in this hub, so it cannot drive it; register with pull: true` };
		const name = this.registry.uniqueName(req.harness);
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
		const checked = checkSpawn(req, {
			caller,
			profiles: this.opts.profiles,
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
		this.registry.add(agent);
		this.log.agent(record);
		this.journalCreate(agent, { task: req.task, backend: req.backend }, caller);
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
	 * is connected and the caller is idle, the caller closes with its pane (a root's terminal too) and its tree
	 * goes on. Messages to it from then on are dropped, as for any agent that exited.
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
		this.log.event(caller.record.name, "handed-off", { to: h.to });
		void this.closeAgent(caller);
	}

	private newAgent(record: AgentRecord, profile: Profile | undefined): Agent {
		return { record, profile, ready: false, queue: [], inbox: [], lastText: "", askedParent: false };
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
		extra: { task?: string; place?: PlaceHint; pid?: number; backend?: BackendName },
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
		if (!adapter || !agent.ready || agent.closing || agent.inflight || !agent.queue.length) return;
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
		if (agent.closing || agent.record.state === "exited") return;
		const result = agent.replyText ?? (res.text.trim() ? res.text : agent.lastText);
		agent.replyText = undefined;
		this.log.event(name, "turn-end", { stopReason: res.stopReason, length: result.length, message: msg?.id });
		if (agent.askedParent) {
			// The turn that asked the parent ended. Forwarding it would show the parent the same question
			// twice and it would answer twice. The worker stays asking until the answer reaches it, and the
			// next turn end (after the answer) is its result.
			agent.askedParent = false;
			agent.held = result;
			this.log.event(name, "turn-end-held");
		} else if (this.transition(agent, turnEndCause(res.stopReason))) {
			agent.held = undefined;
			this.notifyParent(agent, resultText(agent.record, res.stopReason, result), "result");
		}
		this.pump(agent);
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
		const parent = agent.record.parent ? this.registry.get(agent.record.parent) : undefined;
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
			if (!agent.handedOff)
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
