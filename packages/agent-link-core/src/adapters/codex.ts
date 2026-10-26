// Codex adapter: one `codex app-server --listen ws://127.0.0.1:<port>` per agent, child of the adapter. The pane
// runs Codex's own TUI as a client of that server (`codex --remote ws://...`) and the adapter is a second client
// on the same thread: it starts turns, watches their items and answers approval requests with the guard.
// The protocol is Codex's app-server JSON-RPC (schema: `codex app-server generate-json-schema`).
//
// Problem: the TUI must show the thread the adapter drives, with no manual step. Two ways were tried for real
// (codex-cli 0.163.0, cmux):
// - `codex resume <thread> --remote ws://...` after the adapter's first turn/start. It works (the TUI shows the
//   turn live), but resume fails for a thread with no turns ("no rollout found"), so the pane must wait in a
//   shell loop for the first turn; and resume shows "Hooks need review" only then, after the hub's
//   startup-dialog step, so someone has to press escape before the TUI shows anything.
// - `codex --remote ws://...` at once. The TUI creates its thread at startup; the server announces it with
//   thread/started to every client; the adapter's turn/start on that thread shows in the TUI live
//   ("› Reply with exactly SECOND." / "• SECOND"), and after that first turn thread/resume subscribes the
//   adapter to the thread's events (see subscribe()). Startup dialogs come at startup, where the hub answers
//   them as for every harness.
// Solution: the second. The adapter keeps the first thread the TUI starts; a /new typed in the pane is not
// followed, since sub-agent threads announce themselves the same way.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	AdapterDeps,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
	StopReason,
} from "../types.ts";
import { IDENTITY_ENV, PLACE_ENV, READ_DIRS_ENV } from "../types.ts";

/** The app-server process, as much of it as the adapter uses (tests give a fake). */
export interface ServerProcess {
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null) => void): unknown;
}

export interface CodexAdapterOptions {
	/** The codex executable (default "codex", from PATH). */
	command?: string;
	/** Starts the app-server. Default: spawn(command, args) with its output in <runDir>/app-server.log. */
	spawnServer?: (
		command: string,
		args: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv; log: string },
	) => ServerProcess;
	/** Names of the MCP servers Codex has installed globally. Default: `codex mcp list --json`. */
	listMcpServers?: () => Promise<string[]>;
	/** How long launch() waits for the app-server and connect() for the TUI's thread (default 60 s). */
	timeoutMs?: number;
}

const MCP_NAME = "agent-link";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** A TOML value for `-c key=value`: strings and arrays of strings in JSON form are valid TOML. */
const toml = (v: string | readonly string[]) => JSON.stringify(v);

/**
 * The `-c` overrides for the app-server: the model when given, and the agent-link MCP server unless Codex has it
 * installed. Codex filters the env of its MCP servers, so the identity vars must be listed in env_vars, and it
 * asks before every MCP tool call unless default_tools_approval_mode is "approve" (lab Experiment 7, V4).
 *
 * Workers also get the workspace-write sandbox. Problem: in a folder Codex has not trusted, it starts read-only,
 * so a worker cannot write even inside its own cwd, and the model often gives up instead of asking to escalate.
 * Example: a researcher told to write src/data/trip.json answered "Operation not permitted" and ended its turn;
 * no approval request ever reached the hub, so the parent was never asked. Solution: workspace-write with network,
 * like Claude and opencode workers have; anything outside cwd still goes through an approval the parent answers.
 */
export function codexConfigArgs(spec: LaunchSpec, mcpInstalled: boolean): string[] {
	const args: string[] = [];
	const model = spec.model ?? spec.profile.defaultModel;
	if (model) args.push("-c", `model=${toml(model)}`);
	if (spec.parent) {
		args.push("-c", `sandbox_mode="workspace-write"`, "-c", "sandbox_workspace_write.network_access=true");
	}
	if (!mcpInstalled) {
		const key = `mcp_servers.${MCP_NAME}`;
		args.push(
			"-c",
			`${key}.command=${toml(spec.mcp.command)}`,
			"-c",
			`${key}.args=${toml(spec.mcp.args)}`,
			"-c",
			`${key}.env_vars=${toml([...Object.values(IDENTITY_ENV), READ_DIRS_ENV, ...PLACE_ENV])}`,
			"-c",
			`${key}.default_tools_approval_mode="approve"`,
		);
	}
	return args;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			const port = isRecord(address) && typeof address.port === "number" ? address.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string }) {
	const fd = openSync(opts.log, "a", 0o600);
	const child: ChildProcess = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	return child;
}

async function defaultListMcp(command: string): Promise<string[]> {
	try {
		const { stdout } = await promisify(execFile)(command, ["mcp", "list", "--json"], { timeout: 15_000 });
		const list: unknown = JSON.parse(stdout);
		return Array.isArray(list)
			? list.map((s) => (isRecord(s) ? str(s.name) : undefined)).filter((n) => n !== undefined)
			: [];
	} catch {
		return [];
	}
}

type Json = Record<string, unknown>;

/** JSON-RPC over the app-server's WebSocket: requests with ids, notifications, and requests from the server. */
class Rpc {
	private ws: WebSocket;
	private next = 1;
	private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	onNotification: (method: string, params: Json) => void = () => {};
	onRequest: (id: number | string, method: string, params: Json) => void = () => {};
	onClose: () => void = () => {};

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (e) => this.receive(typeof e.data === "string" ? e.data : "");
		ws.onclose = () => {
			for (const c of this.calls.values()) c.reject(new Error("app-server connection closed"));
			this.calls.clear();
			this.onClose();
		};
	}

	/** Opens the socket, retrying while the server starts, then runs initialize / initialized. */
	static async open(url: string, deadline: number, alive: () => boolean): Promise<Rpc> {
		for (;;) {
			const ws = await new Promise<WebSocket | undefined>((resolve) => {
				const w = new WebSocket(url);
				w.onopen = () => resolve(w);
				w.onerror = () => resolve(undefined);
			});
			if (ws) {
				const rpc = new Rpc(ws);
				await rpc.request("initialize", { clientInfo: { name: "agent-link", title: "agent-link", version: "0" } });
				rpc.notify("initialized");
				return rpc;
			}
			if (!alive()) throw new Error("codex adapter: the app-server exited before it listened");
			if (Date.now() > deadline) throw new Error(`codex adapter: no app-server at ${url}`);
			await sleep(100);
		}
	}

	request(method: string, params: Json = {}): Promise<unknown> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.calls.set(id, { resolve, reject });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params?: Json): void {
		this.send(params ? { method, params } : { method });
	}

	respond(id: number | string, result: Json): void {
		this.send({ id, result });
	}

	close(): void {
		this.ws.close();
	}

	private send(message: Json): void {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
	}

	private receive(data: string): void {
		let m: unknown;
		try {
			m = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(m)) return;
		const id = typeof m.id === "number" || typeof m.id === "string" ? m.id : undefined;
		const method = str(m.method);
		const params = isRecord(m.params) ? m.params : {};
		if (method && id !== undefined) this.onRequest(id, method, params);
		else if (method) this.onNotification(method, params);
		else if (typeof id === "number") {
			const call = this.calls.get(id);
			this.calls.delete(id);
			if (!call) return;
			if (isRecord(m.error)) call.reject(new Error(`${str(m.error.message) ?? "app-server error"}`));
			else call.resolve(m.result);
		}
	}
}

const STOP: Record<string, StopReason> = { completed: "end_turn", interrupted: "cancelled", failed: "error" };

/** The tool line the hub shows for an item, or undefined for items that are not tool calls. */
function toolTitle(item: Json): string | undefined {
	switch (item.type) {
		case "commandExecution":
			return str(item.command);
		case "fileChange":
			return `edit ${filePaths(item).join(", ")}`.trim();
		case "mcpToolCall":
			return `${str(item.server)}.${str(item.tool)}`;
		case "dynamicToolCall":
			return str(item.tool);
		case "webSearch":
			return `web search: ${str(item.query) ?? ""}`;
		default:
			return undefined;
	}
}

function filePaths(item: Json): string[] {
	return Array.isArray(item.changes) ? item.changes.map((c) => (isRecord(c) ? (str(c.path) ?? "") : "")) : [];
}

export function createCodexAdapter(deps: AdapterDeps, options: CodexAdapterOptions = {}): AgentAdapter {
	const command = options.command ?? "codex";
	const timeoutMs = options.timeoutMs ?? 60_000;
	const listeners: ((u: SessionUpdate) => void)[] = [];
	let rpc: Rpc | undefined;
	let server: ServerProcess | undefined;
	let serverAlive = false;
	let closed = false;
	let threadId: string | undefined;
	/** Set once thread/resume succeeded: from then on the server sends this client the thread's turn events. */
	let subscribed = false;
	let subscribing: Promise<void> | undefined;
	/** Turns already reported, so a turn seen both in a resume answer and in turn/completed counts once. */
	const handled = new Set<string>();
	/** Wakes connect() as soon as a thread is adopted. */
	let wake: () => void = () => {};
	let currentTurn: string | undefined;
	let state: "idle" | "busy" | "asking" = "idle";
	/** The prompt in flight; turnId arrives with turn/start's answer. */
	let pending: { turnId?: string; resolve: (r: PromptResponse) => void } | undefined;
	/** Turns that completed before turn/start answered (a race the protocol allows). */
	const early = new Map<string, PromptResponse>();
	const lastText = new Map<string, string>();
	const fileItems = new Map<string, Json>();
	/** Server requests left for the TUI to answer (guard said ask, or a kind the adapter does not handle). */
	const waiting = new Map<number | string, string>();

	const emit = (u: SessionUpdate) => {
		for (const l of listeners) l(u);
	};
	const setState = (next: "idle" | "busy" | "asking", detail?: string) => {
		if (next === state && next !== "asking") return;
		state = next;
		emit(detail ? { kind: "state", state: next, detail } : { kind: "state", state: next });
	};
	const settle = (r: PromptResponse) => {
		const p = pending;
		pending = undefined;
		p?.resolve(r);
	};
	const gone = (detail: string) => {
		if (closed) return;
		closed = true;
		deps.log("codex_gone", { detail });
		settle({ stopReason: "error", text: detail });
		emit({ kind: "exited", detail });
		server?.kill("SIGTERM");
		rpc?.close();
	};

	const adopt = (id: string) => {
		if (threadId) return;
		threadId = id;
		deps.log("codex_thread", { threadId: id });
		emit({ kind: "session", sessionId: id });
		wake();
	};

	const onTurnCompleted = (turn: Json) => {
		const id = str(turn.id) ?? "";
		if (handled.has(id)) return;
		handled.add(id);
		const stopReason = STOP[str(turn.status) ?? ""] ?? "error";
		const items = Array.isArray(turn.items) ? turn.items.filter(isRecord) : [];
		const fromItems = items.filter((i) => i.type === "agentMessage").map((i) => str(i.text) ?? "");
		const error = isRecord(turn.error) ? str(turn.error.message) : undefined;
		const text = lastText.get(id) ?? fromItems.at(-1) ?? (stopReason === "error" ? (error ?? "") : "");
		lastText.delete(id);
		if (currentTurn === id) currentTurn = undefined;
		waiting.clear();
		setState("idle");
		const result = { stopReason, text };
		if (pending?.turnId === id) {
			deps.log("turn_end", { turn: id, stopReason });
			settle(result);
		} else if (pending && pending.turnId === undefined) {
			early.set(id, result);
		} else {
			deps.log("turn_end_unprompted", { turn: id, stopReason });
			emit({ kind: "turn_end", stopReason, text });
		}
	};

	/**
	 * Subscribes this client to the thread's turn events.
	 *
	 * Problem: thread/resume fails with "no rollout found" for a thread with no turns yet, which is every TUI's
	 * thread at startup (seen in the first real run). turn/start works without a subscription, but then only
	 * thread/status/changed reaches this client, not turn/started, items or turn/completed.
	 * Solution: subscribe once a turn exists (after turn/start answers, or when a turn typed in the TUI makes
	 * the thread active), retrying briefly while Codex writes the rollout; the resume answer lists the turns,
	 * so a turn that ended before the subscription is still reported.
	 */
	const subscribe = (): Promise<void> => {
		subscribing ??= (async () => {
			const deadline = Date.now() + 10_000;
			while (!closed && rpc && threadId) {
				try {
					const res = await rpc.request("thread/resume", { threadId });
					subscribed = true;
					deps.log("codex_subscribed", { threadId });
					const turns =
						isRecord(res) && isRecord(res.thread) && Array.isArray(res.thread.turns) ? res.thread.turns : [];
					const last = turns.filter(isRecord).at(-1);
					if (last && last.status !== "inProgress") onTurnCompleted(last);
					else if (last) currentTurn = str(last.id);
					return;
				} catch (e) {
					if (Date.now() > deadline) {
						deps.log("codex_subscribe_failed", { error: String(e) });
						subscribing = undefined;
						return;
					}
					await sleep(100);
				}
			}
		})();
		return subscribing;
	};

	const onNotification = (method: string, p: Json) => {
		if (method === "thread/started") {
			const id = isRecord(p.thread) ? str(p.thread.id) : undefined;
			if (id) adopt(id);
			return;
		}
		if (!threadId || str(p.threadId) !== threadId) return;
		const item = isRecord(p.item) ? p.item : undefined;
		switch (method) {
			case "turn/started":
				currentTurn = isRecord(p.turn) ? str(p.turn.id) : undefined;
				setState("busy");
				break;
			case "turn/completed":
				if (isRecord(p.turn)) onTurnCompleted(p.turn);
				break;
			case "item/started": {
				if (!item) break;
				if (item.type === "fileChange" && str(item.id)) fileItems.set(str(item.id) ?? "", item);
				const title = toolTitle(item);
				if (title) emit({ kind: "tool_call", title, status: "in_progress" });
				break;
			}
			case "item/completed":
				if (item?.type === "agentMessage" && str(item.text)) {
					const text = str(item.text) ?? "";
					lastText.set(str(p.turnId) ?? "", text);
					emit({ kind: "agent_message", text });
				}
				break;
			case "thread/status/changed": {
				const status = isRecord(p.status) ? p.status : {};
				const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
				// waitingOnApproval comes just before the approval request itself, which the guard may answer at
				// once (real run: asking, then busy 1 ms later for a blocked git push). Only requests left for the
				// TUI (in waiting) put the agent in asking, so the parent never hears of a wait that did not happen.
				if (status.type === "active" && flags.length > 0 && waiting.size > 0)
					setState("asking", [...waiting.values()].at(-1));
				else if (status.type === "active" && waiting.size === 0) setState("busy");
				if (status.type === "active" && !subscribed) void subscribe();
				else if (status.type === "idle" && !currentTurn) setState("idle");
				break;
			}
			case "serverRequest/resolved": {
				const rid = p.requestId;
				if ((typeof rid === "number" || typeof rid === "string") && waiting.delete(rid) && waiting.size === 0) {
					setState(currentTurn ? "busy" : "idle");
				}
				break;
			}
		}
	};

	const decline = (id: number | string, turnId: string | undefined, what: string, reason: string) => {
		rpc?.respond(id, { decision: "decline" });
		// The approval answer has no reason field; the model learns why from a steer into the same turn.
		if (rpc && threadId && turnId) {
			const text = `[agent-link] ${reason}. It was not run: ${what}`;
			rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] }).catch((e) => {
				deps.log("codex_steer_failed", { error: String(e) });
			});
		}
	};

	const onRequest = (id: number | string, method: string, p: Json) => {
		if (str(p.threadId) !== threadId) return;
		const turnId = str(p.turnId);
		if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
			// A file change is not a command; the guard sees it as `apply_patch <paths>`, which it allows today.
			const what =
				method === "item/commandExecution/requestApproval"
					? (str(p.command) ?? "")
					: `apply_patch ${filePaths(fileItems.get(str(p.itemId) ?? "") ?? {}).join(" ")}`.trim();
			const verdict = deps.guard(what, deps.depth);
			deps.log("codex_approval", { method, command: what, verdict: verdict.action });
			if (verdict.action === "allow") rpc?.respond(id, { decision: "accept" });
			else if (verdict.action === "block") decline(id, turnId, what, verdict.reason);
			else {
				// ask: the TUI shows Codex's own approval prompt; the user answers there.
				waiting.set(id, what);
				setState("asking", what);
			}
			return;
		}
		// User input, MCP elicitation, permission requests: the TUI shows them; the agent waits on the user.
		waiting.set(id, method);
		setState("asking", method);
	};

	return {
		async launch(spec: LaunchSpec): Promise<PaneCommand> {
			const installed = (await (options.listMcpServers ?? (() => defaultListMcp(command)))()).includes(MCP_NAME);
			const port = await freePort();
			const url = `ws://127.0.0.1:${port}`;
			const args = ["app-server", "--listen", url, ...codexConfigArgs(spec, installed)];
			const env = { ...process.env, ...spec.env };
			const log = join(spec.runDir, "app-server.log");
			server = (options.spawnServer ?? defaultSpawn)(command, args, { cwd: spec.cwd, env, log });
			serverAlive = true;
			server.on("exit", (code) => {
				serverAlive = false;
				gone(`codex app-server exited (code ${code})`);
			});
			const t0 = Date.now();
			rpc = await Rpc.open(url, t0 + timeoutMs, () => serverAlive);
			rpc.onNotification = onNotification;
			rpc.onRequest = onRequest;
			rpc.onClose = () => gone("the app-server connection closed");
			deps.log("codex_app_server", { url, ms: Date.now() - t0, mcp: installed ? "global" : "flag" });
			return { argv: [command, "--remote", url], env: { ...spec.env }, cwd: spec.cwd };
		},

		async connect(pane?: PaneHandle): Promise<void> {
			const r = rpc;
			if (!r) throw new Error("codex adapter: connect() before launch()");
			const deadline = Date.now() + timeoutMs;
			// thread/started reaches every client; thread/loaded/list covers a TUI that started its thread
			// before this connection existed (a root opened with `agent-link open`).
			while (!threadId) {
				if (closed) throw new Error("codex adapter: closed while waiting for the TUI's thread");
				if (Date.now() > deadline) throw new Error("codex adapter: the TUI started no thread");
				if (pane && !(await pane.backend.alive(pane.ref))) throw new Error("codex adapter: the pane closed");
				const loaded = await r.request("thread/loaded/list", {}).catch(() => undefined);
				const first = isRecord(loaded) && Array.isArray(loaded.data) ? str(loaded.data[0]) : undefined;
				if (threadId) break;
				if (first) adopt(first);
				else await Promise.race([sleep(250), new Promise<void>((r) => (wake = r))]);
			}
		},

		async prompt(req: PromptRequest): Promise<PromptResponse> {
			const r = rpc;
			if (!r || !threadId || closed) throw new Error("codex adapter: not connected");
			if (pending) throw new Error("codex adapter: a prompt is already in flight");
			const entry: { turnId?: string; resolve: (r: PromptResponse) => void } = { resolve: () => {} };
			const p = new Promise<PromptResponse>((resolve) => {
				entry.resolve = resolve;
			});
			pending = entry;
			deps.log("prompt", { id: req.id, length: req.text.length });
			try {
				const res = await r.request("turn/start", { threadId, input: [{ type: "text", text: req.text }] });
				const turnId = isRecord(res) && isRecord(res.turn) ? str(res.turn.id) : undefined;
				if (pending === entry && turnId) {
					entry.turnId = turnId;
					currentTurn = turnId;
					const done = early.get(turnId);
					early.clear();
					if (done) settle(done);
				}
				if (!subscribed) await subscribe();
			} catch (e) {
				settle({ stopReason: "error", text: `turn/start failed: ${e instanceof Error ? e.message : String(e)}` });
			}
			return p;
		},

		idle(): boolean {
			return !!threadId && !closed && !pending && state === "idle";
		},

		async cancel(): Promise<void> {
			if (rpc && threadId && currentTurn && !closed) {
				await rpc.request("turn/interrupt", { threadId, turnId: currentTurn }).catch((e) => {
					deps.log("codex_interrupt_failed", { error: String(e) });
				});
			}
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			settle({ stopReason: "cancelled", text: "" });
			rpc?.close();
			const s = server;
			if (s && serverAlive) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						s.kill("SIGKILL");
						resolve();
					}, 3000);
					s.on("exit", () => {
						clearTimeout(timer);
						resolve();
					});
					s.kill("SIGTERM");
				});
			}
		},

		onUpdate(listener) {
			listeners.push(listener);
		},
	};
}
