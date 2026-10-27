// pi adapter: the pane runs base pi with the agent-link extension (`pi -e src/pi-extension/index.ts`), and the
// adapter talks to that extension over the Unix socket <runDir>/pi.sock (JSON lines, pi-extension/protocol.ts).
// pi keeps its own TUI in the pane; messages from agent-link show there as custom messages.
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_MCP_ENV, PI_SOCKET_ENV, parseFromExtension, readLines, writeLine } from "../pi-extension/protocol.ts";
import type {
	AdapterDeps,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
	SetModelResult,
} from "../types.ts";

/** Absolute path of the extension pi loads. */
export const PI_EXTENSION_PATH = fileURLToPath(new URL("../pi-extension/index.ts", import.meta.url));

export interface PiAdapterOptions {
	/** The pi executable (default "pi", from PATH). */
	command?: string;
	/** How long connect() waits for the extension's socket (default 60 s: pi loads extensions and MCP first). */
	connectTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryConnect(path: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = netConnect(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", () => resolve(undefined));
	});
}

export function createPiAdapter(deps: AdapterDeps, options: PiAdapterOptions = {}): AgentAdapter {
	const listeners: ((u: SessionUpdate) => void)[] = [];
	let socketPath: string | undefined;
	let socket: Socket | undefined;
	let state: "idle" | "busy" | "asking" | undefined;
	let pending: { id: string; resolve: (r: PromptResponse) => void } | undefined;
	let closed = false;
	/** set_model requests waiting for their model_result. */
	const modelWaits = new Map<string, (r: SetModelResult) => void>();
	let modelSeq = 0;

	const emit = (u: SessionUpdate) => {
		for (const l of listeners) l(u);
	};
	const settle = (r: PromptResponse) => {
		const p = pending;
		pending = undefined;
		p?.resolve(r);
	};

	const onSocketGone = () => {
		if (closed) return;
		closed = true;
		deps.log("pi_socket_closed");
		settle({ stopReason: "error", text: "pi exited before the turn ended" });
		for (const resolve of modelWaits.values()) resolve({ error: "pi exited before it answered the model switch" });
		modelWaits.clear();
		emit({ kind: "exited", detail: "the pi extension's socket closed" });
	};

	return {
		async launch(spec: LaunchSpec): Promise<PaneCommand> {
			socketPath = join(spec.runDir, "pi.sock");
			const model = spec.model ?? spec.profile.defaultModel;
			return {
				// A profile may name another pi-based harness (pihouse is pi with its own config and extensions).
				argv: [
					...(spec.profile.command ?? [options.command ?? "pi"]),
					"-e",
					PI_EXTENSION_PATH,
					...(model ? ["--model", model] : []),
				],
				env: { ...spec.env, [PI_SOCKET_ENV]: socketPath, [PI_MCP_ENV]: JSON.stringify(spec.mcp) },
				cwd: spec.cwd,
			};
		},

		async connect(pane?: PaneHandle): Promise<void> {
			if (!socketPath) throw new Error("pi adapter: connect() before launch()");
			const started = Date.now();
			const deadline = started + (options.connectTimeoutMs ?? 60_000);
			let s: Socket | undefined;
			while (!s) {
				s = await tryConnect(socketPath);
				if (s) break;
				if (closed) throw new Error("pi adapter: closed while connecting");
				if (Date.now() > deadline) throw new Error(`pi adapter: no extension socket at ${socketPath}`);
				if (pane && !(await pane.backend.alive(pane.ref)))
					throw new Error("pi adapter: the pane closed before pi started");
				await sleep(150);
			}
			socket = s;
			// The extension sends its state as soon as a client connects; prompt() may be called after that.
			const first = new Promise<void>((resolve) => {
				readLines(s, (raw) => {
					const m = parseFromExtension(raw);
					if (!m) return;
					if (m.type === "state") {
						state = m.state;
						resolve();
						emit(m.detail ? { kind: "state", state: m.state, detail: m.detail } : { kind: "state", state: m.state });
					} else if (m.type === "agent_message") {
						emit({ kind: "agent_message", text: m.text });
					} else if (m.type === "tool_call") {
						emit({ kind: "tool_call", title: m.title });
					} else if (m.type === "model_result") {
						const wait = modelWaits.get(m.id);
						modelWaits.delete(m.id);
						wait?.("error" in m ? { error: m.error } : { status: m.status, model: m.model });
					} else if (m.type === "model") {
						emit({ kind: "model", model: m.model });
					} else if (m.type === "model_error") {
						emit({ kind: "model_error", model: m.model, error: m.error });
					} else if (m.type === "session") {
						emit({ kind: "session", sessionId: m.sessionId, transcript: m.file });
					} else if (pending && m.id === pending.id) {
						deps.log("turn_end", { id: m.id, stopReason: m.stopReason });
						settle({ stopReason: m.stopReason, text: m.text });
					} else {
						deps.log("turn_end_unprompted", { id: m.id, stopReason: m.stopReason });
						emit({ kind: "turn_end", stopReason: m.stopReason, text: m.text });
					}
				});
			});
			s.on("close", onSocketGone);
			s.on("error", () => s.destroy());
			await first;
			deps.log("pi_connected", { ms: Date.now() - started });
		},

		prompt(req: PromptRequest): Promise<PromptResponse> {
			if (!socket || closed) return Promise.reject(new Error("pi adapter: not connected"));
			if (pending) return Promise.reject(new Error("pi adapter: a prompt is already in flight"));
			const s = socket;
			return new Promise((resolve) => {
				pending = { id: req.id, resolve };
				deps.log("prompt", { id: req.id, length: req.text.length });
				writeLine(s, { type: "prompt", id: req.id, text: req.text });
			});
		},

		idle(): boolean {
			return !!socket && !closed && !pending && state === "idle";
		},

		/** pi's documented pi.setModel runs inside the extension; it resolves the model, checks auth and defers a busy turn. */
		setModel(model: string): Promise<SetModelResult> {
			if (!socket || closed) return Promise.resolve({ error: "pi adapter: not connected" });
			const s = socket;
			const id = `model-${++modelSeq}`;
			return new Promise((resolve) => {
				modelWaits.set(id, resolve);
				deps.log("set_model", { id, model });
				writeLine(s, { type: "set_model", id, model });
			});
		},

		async cancel(): Promise<void> {
			if (socket && !closed) writeLine(socket, { type: "cancel" });
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			settle({ stopReason: "cancelled", text: "" });
			for (const resolve of modelWaits.values()) resolve({ error: "the agent was closed" });
			modelWaits.clear();
			socket?.destroy();
		},

		onUpdate(listener) {
			listeners.push(listener);
		},
	};
}
