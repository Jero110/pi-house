// opencode adapter: the native TUI runs in a pane with its HTTP server on (`opencode --port N`); agent-link creates
// a session over the API, shows it in the TUI, sends messages with prompt_async and watches /event.
//
// Evidence (lab experiments/README.md, Experiment 5 and 7 V1, V2, V7): prompt_async answers 204 at once,
// session.status goes busy and session.idle marks the turn end; a message sent while busy is folded into the
// running turn (one session.idle), so the hub sends only while idle. The TUI shows the turns the API starts.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { pickChoices, pickedText } from "../ask.ts";
import type {
	AdapterDeps,
	AdapterFactory,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PendingAsk,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
	StopReason,
} from "../types.ts";

/**
 * file: URL of the guard plugin (opencode-guard.ts) next to this module. opencode (Bun) loads .ts plugins and
 * accepts file: URLs in its `plugin` list.
 */
export const OPENCODE_GUARD_PLUGIN = new URL("./opencode-guard.ts", import.meta.url).href;

export interface OpencodeOptions {
	/** Whether agent-link is in opencode's global MCP config. Default: asks `opencode mcp list`. */
	mcpInstalled?: () => Promise<boolean>;
	/** The server port. Default: a free one. Tests point it at a fake server. */
	port?: number;
	connectTimeoutMs?: number;
	/** Delays between the TUI session selects (ms); later ones repeat the last delay. */
	selectDelays?: readonly number[];
	/** How long connect keeps selecting before it gives up on seeing the session in the pane. */
	selectTimeoutMs?: number;
	/** After cancel, how long to wait for session.idle before prompt() resolves as cancelled anyway. */
	cancelGraceMs?: number;
}

/** The OPENCODE_CONFIG_CONTENT for one agent: the guard plugin, and the agent-link MCP unless installed. */
export function opencodeConfig(spec: LaunchSpec, mcpInstalled: boolean): Record<string, unknown> {
	return {
		...(mcpInstalled
			? {}
			: {
					mcp: {
						"agent-link": {
							type: "local",
							command: [spec.mcp.command, ...spec.mcp.args],
							environment: spec.env,
							enabled: true,
						},
					},
				}),
		// Blocks risky bash commands for workers (AGENT_LINK_DEPTH >= 1).
		plugin: [OPENCODE_GUARD_PLUGIN],
		// Problem: opencode asks before it touches a path outside its cwd. Example: a worker told to read
		// <skills>/build/source-driven-development/SKILL.md stopped at that prompt, and only a person in its pane
		// could answer. Solution: the folders its caller may share are allowed up front.
		...(spec.readDirs?.length
			? {
					permission: {
						external_directory: Object.fromEntries(spec.readDirs.map((d) => [`${d}/**`, "allow"])),
					},
				}
			: {}),
	};
}

async function opencodeMcpInstalled(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("opencode", ["mcp", "list"], { timeout: 20_000 }, (err, stdout) => {
			resolve(!err && /\bagent-link\b/.test(String(stdout)));
		});
	});
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

function splitModel(model: string): { providerID: string; modelID: string } {
	const i = model.indexOf("/");
	return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** One event from opencode's /event stream, the fields the adapter reads. */
export interface OpencodeEvent {
	type: string;
	properties?: {
		sessionID?: string;
		status?: { type?: string };
		error?: { name?: string; data?: { message?: string } };
		/** permission.asked / question.asked: the request's id; *.replied: requestID. */
		id?: string;
		requestID?: string;
		permission?: string;
		action?: string;
		patterns?: string[];
		resources?: string[];
		metadata?: { filepath?: string };
		questions?: Array<{
			question?: string;
			header?: string;
			options?: Array<{ label?: string; description?: string }>;
			multiple?: boolean;
		}>;
		info?: { id?: string; role?: string; sessionID?: string };
		part?: {
			type?: string;
			sessionID?: string;
			tool?: string;
			text?: string;
			time?: { end?: number };
			state?: { status?: string; title?: string };
		};
	};
}

interface OcMessage {
	info: { role: string };
	parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
}

const TOOL_STATUS: Record<string, "pending" | "in_progress" | "completed" | "failed"> = {
	pending: "pending",
	running: "in_progress",
	completed: "completed",
	error: "failed",
};

/** Text without spaces or line breaks, for finding a title a pane may have wrapped anywhere. */
const compact = (s: string) => s.replace(/[│┃║╭╮╰╯┌┐└┘├┤─━═]/g, "").replace(/\s+/g, "");

interface Pending {
	req: PromptRequest;
	sentAt: number;
	busy: boolean;
	first: boolean;
	cancelledAt: number;
	error?: string;
	resolve: (r: PromptResponse) => void;
}

export function createOpencodeAdapter(deps: AdapterDeps, opts: OpencodeOptions = {}): AgentAdapter {
	const listeners: Array<(u: SessionUpdate) => void> = [];
	const emit = (u: SessionUpdate) => {
		for (const l of listeners) l(u);
	};
	let port = 0;
	let model = "";
	let title = "";
	let session = "";
	let pane: PaneHandle | undefined;
	let busy = false;
	let asking = false;
	/**
	 * Permissions and questions opencode waits on, oldest first; the first is the one reported to the hub.
	 * v2 permissions reply on another route. Labels are what a question's reply sends back.
	 */
	const asks: Array<{
		id: string;
		route: "permission" | "permission-v2" | "question";
		ask: PendingAsk;
		labels: string[][];
	}> = [];
	let paneTurn = false;
	const userMessages = new Set<string>();
	let lastScreen = "";
	let pending: Pending | undefined;
	let gone = false;
	let closing = false;
	const events = new AbortController();

	async function api(path: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			// Problem: a request to a server that is still starting can hang with no answer. Example: in a real
			// run the first GET /session never returned and the 60 s connect deadline became 5 minutes.
			// Solution: every API call has its own timeout (the /event stream does not use api()).
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`opencode ${path}: HTTP ${res.status}`);
		const text = await res.text();
		return text ? JSON.parse(text) : undefined;
	}

	async function lastAssistantText(): Promise<string> {
		const messages = (await api(`/session/${session}/message`)) as OcMessage[];
		const last = messages.filter((m) => m.info.role === "assistant").at(-1);
		return (last?.parts ?? [])
			.filter((p) => p.type === "text" && p.text && !p.synthetic)
			.map((p) => p.text)
			.join("\n")
			.trim();
	}

	async function finish(stopReason: StopReason): Promise<void> {
		const p = pending;
		if (!p) return;
		pending = undefined;
		const text = await lastAssistantText().catch(() => "");
		deps.log("turn_end", { id: p.req.id, stopReason, ms: Date.now() - p.sentAt });
		p.resolve({ stopReason, text: p.error && !text ? p.error : text });
	}

	function exit(detail: string): void {
		if (gone) return;
		gone = true;
		if (pending) {
			const p = pending;
			pending = undefined;
			p.resolve({ stopReason: "error", text: `opencode exited: ${detail}` });
		}
		deps.log("exited", { detail });
		emit({ kind: "exited", detail });
	}

	function setBusy(next: boolean): void {
		// A busy or idle status while a permission or question is open does not end the wait.
		if (asks.length) {
			busy = next;
			return;
		}
		if (next === busy && !asking) return;
		busy = next;
		asking = false;
		emit({ kind: "state", state: next ? "busy" : "idle" });
	}

	/** Reports the oldest open ask, or leaves asking when none is left. */
	function reportAsk(): void {
		const first = asks[0];
		if (first) {
			asking = true;
			emit({ kind: "state", state: "asking", detail: first.ask.questions[0]?.question, ask: first.ask });
		} else if (asking) {
			asking = false;
			emit({ kind: "state", state: busy ? "busy" : "idle" });
		}
	}

	const PERMISSION_OPTIONS = ["Allow once", "Allow always", "Reject"];
	const PERMISSION_REPLIES = ["once", "always", "reject"] as const;

	async function onEvent(ev: OpencodeEvent): Promise<void> {
		const p = ev.properties ?? {};
		const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
		if (sid !== session) return;
		const cur = pending;
		// Delivery: the first sign that our message started a turn. Not just any event: the turn before sends a
		// session.status idle right after its session.idle, and late part updates (an aborted tool), both of
		// which can arrive right after the send.
		// opencode also re-sends message.updated for the previous user message after its turn, so only a user
		// message id not seen before counts.
		const newUser = ev.type === "message.updated" && p.info?.role === "user" && !userMessages.has(p.info.id ?? "");
		if (ev.type === "message.updated" && p.info?.role === "user") userMessages.add(p.info.id ?? "");
		const started = (ev.type === "session.status" && p.status?.type === "busy") || newUser;
		if (cur && !cur.first && started) {
			cur.first = true;
			deps.log("delivered", { id: cur.req.id, ms: Date.now() - cur.sentAt, event: ev.type });
		}
		switch (ev.type) {
			case "session.status": {
				const s = p.status?.type;
				if (s === "busy" || s === "retry") {
					if (cur) cur.busy = true;
					else paneTurn = true;
					setBusy(true);
				}
				return;
			}
			case "session.idle": {
				setBusy(false);
				if (cur) {
					// A late idle from before our message starts nothing: only an idle after busy ends our turn.
					if (cur.busy) await finish(cur.cancelledAt ? "cancelled" : cur.error ? "error" : "end_turn");
				} else if (paneTurn) {
					paneTurn = false;
					emit({ kind: "turn_end", stopReason: "end_turn", text: await lastAssistantText().catch(() => "") });
				}
				return;
			}
			case "session.error": {
				const name = p.error?.name ?? "error";
				if (cur && name !== "MessageAbortedError") cur.error = p.error?.data?.message ?? name;
				deps.log("session_error", { name });
				return;
			}
			case "permission.asked":
			case "permission.v2.asked": {
				const what = p.permission ?? p.action ?? "permission";
				const on = (p.patterns ?? p.resources ?? []).join(", ") || p.metadata?.filepath || "";
				const question = on ? `${what}: ${on}` : what;
				if (p.id && !asks.some((a) => a.id === p.id))
					asks.push({
						id: p.id,
						route: ev.type === "permission.asked" ? "permission" : "permission-v2",
						ask: { kind: "permission", questions: [{ question, options: PERMISSION_OPTIONS }] },
						labels: [],
					});
				if (p.id) reportAsk();
				else {
					// No id: nothing to answer through the API; the parent hears it as a wait in the pane.
					asking = true;
					emit({ kind: "state", state: "asking", detail: question });
				}
				return;
			}
			case "question.asked": {
				const qs = (p.questions ?? []).map((q) => ({
					question: q.question ?? q.header ?? "question",
					options: (q.options ?? []).map((o) =>
						o.description ? `${o.label ?? ""} — ${o.description}` : (o.label ?? ""),
					),
					labels: (q.options ?? []).map((o) => o.label ?? ""),
					multiple: q.multiple === true,
				}));
				if (p.id && qs.length && !asks.some((a) => a.id === p.id))
					asks.push({
						id: p.id,
						route: "question",
						ask: {
							kind: "question",
							questions: qs.map((q) => ({
								question: q.question,
								options: q.options,
								multiple: q.multiple || undefined,
							})),
						},
						labels: qs.map((q) => q.labels),
					});
				if (p.id && qs.length) reportAsk();
				else {
					asking = true;
					emit({ kind: "state", state: "asking", detail: "question" });
				}
				return;
			}
			case "permission.replied":
			case "permission.v2.replied":
			case "question.replied":
			case "question.rejected": {
				const id = p.requestID ?? p.id;
				const i = id ? asks.findIndex((a) => a.id === id) : -1;
				if (i >= 0) asks.splice(i, 1);
				else if (!id) asks.length = 0;
				if (asks.length) reportAsk();
				else if (asking) {
					asking = false;
					emit({ kind: "state", state: busy ? "busy" : "idle" });
				}
				return;
			}
			case "message.part.updated": {
				const part = p.part;
				if (part?.type === "text" && part.text && part.time?.end) {
					emit({ kind: "agent_message", text: part.text });
				} else if (part?.type === "tool" && part.tool) {
					const status = TOOL_STATUS[part.state?.status ?? ""];
					emit({ kind: "tool_call", title: part.state?.title || part.tool, ...(status ? { status } : {}) });
				}
				return;
			}
		}
	}

	async function watch(): Promise<void> {
		const res = await fetch(`http://127.0.0.1:${port}/event`, { signal: events.signal });
		if (!res.ok || !res.body) throw new Error(`opencode /event: HTTP ${res.status}`);
		const body = res.body;
		void (async () => {
			const decoder = new TextDecoder();
			let buf = "";
			try {
				for await (const chunk of body) {
					buf += decoder.decode(chunk, { stream: true });
					for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
						const line = buf.slice(0, i).trim();
						buf = buf.slice(i + 1);
						if (!line.startsWith("data:")) continue;
						let ev: OpencodeEvent;
						try {
							ev = JSON.parse(line.slice(5)) as OpencodeEvent;
						} catch {
							continue;
						}
						await onEvent(ev);
					}
				}
			} catch {
				// Aborted by close(), or the connection broke: both end the loop.
			}
			if (!closing) exit("event stream ended");
		})();
	}

	/**
	 * Problem: the HTTP server answers before the TUI has mounted, so a select sent too early is lost, and a
	 * message the user types then goes to a new session. Example: in C0 a typed message opened a session of
	 * its own. Solution: select repeatedly (0, 0.8, 2, 4 s, then every 4 s) until the pane shows our session's
	 * title (shown in the TUI's sidebar), for up to 10 s; with no pane to read, the fixed schedule runs and
	 * connect does not wait for it.
	 */
	async function selectInTui(): Promise<boolean> {
		const delays = opts.selectDelays ?? [0, 800, 2000, 4000];
		const end = Date.now() + (opts.selectTimeoutMs ?? 10_000);
		for (let i = 0; !closing && !gone; i++) {
			await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
			await api("/tui/select-session", { sessionID: session }).catch(() => undefined);
			if (!pane) {
				if (i >= delays.length - 1) return false;
				continue;
			}
			await new Promise((r) => setTimeout(r, 300));
			const screen = await pane.backend.read(pane.ref, 60).catch(() => "");
			lastScreen = screen;
			if (compact(screen).includes(compact(title))) {
				deps.log("tui_selected", { attempt: i + 1 });
				return true;
			}
			if (Date.now() > end) return false;
		}
		return false;
	}

	return {
		async launch(spec: LaunchSpec): Promise<PaneCommand> {
			port = opts.port ?? (await freePort());
			model = spec.model ?? spec.profile.defaultModel ?? "opencode/glm-5.3-flash-free";
			title = `agent-link ${spec.name}`;
			const installed = await (opts.mcpInstalled ?? opencodeMcpInstalled)();
			const env = { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec, installed)) };
			deps.log("launch", { port, mcp: installed ? "installed" : "config" });
			return { argv: ["opencode", "--port", String(port), "-m", model], env, cwd: spec.cwd };
		},

		async connect(handle?: PaneHandle): Promise<void> {
			pane = handle;
			const deadline = Date.now() + (opts.connectTimeoutMs ?? 60_000);
			for (;;) {
				try {
					await api("/session");
					break;
				} catch {
					if (Date.now() > deadline) throw new Error(`opencode on port ${port} did not start`);
					await new Promise((r) => setTimeout(r, 250));
				}
			}
			session = ((await api("/session", { title })) as { id: string }).id;
			emit({ kind: "session", sessionId: session });
			await watch();
			if (!pane) void selectInTui();
			else if (!(await selectInTui()) && !gone) {
				const tail = lastScreen
					.split("\n")
					.filter((l) => l.trim())
					.slice(-6)
					.join("\n");
				deps.log("tui_select_unverified", { session, screen: tail });
			}
			// Problem: opencode can die right after its server answers, and connect still reported success.
			// Example: opencode 1.19.3's TUI segfaults (Bun panic) in a 22x7 pane, 2.6 s after start; connect
			// kept selecting for 30 s and then said "connected". Solution: an exit during connect fails it.
			if (gone) throw new Error("opencode exited while connecting");
			deps.log("connected", { port, session });
		},

		async prompt(req: PromptRequest): Promise<PromptResponse> {
			if (gone) return { stopReason: "error", text: "opencode exited" };
			if (pending) throw new Error("opencode: a prompt is already in flight");
			// A pane turn that had not ended is folded into this one.
			paneTurn = false;
			const result = new Promise<PromptResponse>((resolve) => {
				pending = { req, sentAt: Date.now(), busy: false, first: false, cancelledAt: 0, resolve };
			});
			try {
				await api(`/session/${session}/prompt_async`, {
					model: splitModel(model),
					parts: [{ type: "text", text: req.text }],
				});
			} catch (e) {
				pending = undefined;
				throw e;
			}
			deps.log("sent", { id: req.id });
			return result;
		},

		idle: () => !gone && !!session && !pending && !busy && !asking,

		async cancel(): Promise<void> {
			const p = pending;
			if (p) p.cancelledAt = Date.now();
			await api(`/session/${session}/abort`, {}).catch((e: Error) => deps.log("abort_failed", { error: e.message }));
			if (!p) return;
			// opencode emits session.idle after an abort; if it never comes, the prompt still ends.
			setTimeout(() => {
				if (pending === p) void finish("cancelled");
			}, opts.cancelGraceMs ?? 5000).unref();
		},

		async close(): Promise<void> {
			closing = true;
			events.abort();
			if (pending) {
				const p = pending;
				pending = undefined;
				p.resolve({ stopReason: "cancelled", text: "" });
			}
		},

		onUpdate(listener) {
			listeners.push(listener);
		},

		async answer(choice: string): Promise<{ answered: string } | { error: string }> {
			const open = asks[0];
			if (!open) return { error: "opencode is not waiting on a permission or question" };
			const picked = pickChoices(open.ask, choice);
			if ("error" in picked) return picked;
			try {
				if (open.route === "question") {
					const answers = picked.picks.map((p, i) => p.map((j) => open.labels[i]?.[j] ?? ""));
					await api(`/question/${open.id}/reply`, { answers });
				} else {
					const reply = PERMISSION_REPLIES[picked.picks[0]?.[0] ?? 0] ?? "once";
					await api(
						open.route === "permission"
							? `/permission/${open.id}/reply`
							: `/api/session/${session}/permission/${open.id}/reply`,
						{ reply },
					);
				}
			} catch (e) {
				return { error: `opencode did not take the answer: ${e instanceof Error ? e.message : String(e)}` };
			}
			deps.log("answered", { id: open.id, route: open.route, choice });
			// opencode confirms with *.replied, which drops the ask; until then it stays reported.
			return { answered: pickedText(open.ask, picked.picks) };
		},
	};
}

export const opencodeAdapter: AdapterFactory = (deps) => createOpencodeAdapter(deps);
