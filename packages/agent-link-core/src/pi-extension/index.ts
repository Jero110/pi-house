// The agent-link extension for base pi, loaded with `pi -e <this file>` by the pi adapter. It listens on the Unix
// socket AGENT_LINK_PI_SOCKET, takes prompts from the adapter and reports pi's state and turn ends back
// (protocol.ts). It also applies the agent-link guard to bash calls and registers the agent-link MCP server for this
// run. Without AGENT_LINK_PI_SOCKET it does nothing, so a normal pi session is unaffected.
//
// Problem: pi has no flag or env var that adds an MCP server for one run; `pi mcp add` writes the user's
// ~/.pi/agent/mcp.json for every session. Example: two agents with different identities would share one
// entry. Solution: pi 1.3.0 lets an extension call pi.registerMcpServer(), which lasts for the session only;
// the adapter passes the server as AGENT_LINK_PI_MCP and the MCP process inherits pi's env (AGENT_LINK_*).
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { checkCommand } from "../guard.ts";
import type { StopReason } from "../types.ts";
import {
	type FromExtension,
	isRecord,
	PI_MCP_ENV,
	PI_SOCKET_ENV,
	parseToExtension,
	readLines,
	writeLine,
} from "./protocol.ts";

/** The custom message type agent-link messages carry in pi's session. */
export const MESSAGE_TYPE = "agent-link";

/** The assistant text of one message, its text blocks joined; "" for other roles. */
function assistantText(message: unknown): { text: string; stop?: string } | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.map((c: unknown) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
		.join("");
	return { text, stop: typeof message.stopReason === "string" ? message.stopReason : undefined };
}

/** pi-ai stop reasons to ACP ones. */
function stopReason(piStop: string | undefined, aborted: boolean): StopReason {
	if (aborted || piStop === "aborted") return "cancelled";
	if (piStop === "error") return "error";
	if (piStop === "length") return "max_tokens";
	return "end_turn";
}

/** A short line for a tool call, as the hub shows it. */
function toolTitle(event: ToolCallEvent): string {
	const input: unknown = event.input;
	if (isRecord(input)) {
		for (const key of ["command", "path", "file_path", "pattern"]) {
			const v = input[key];
			if (typeof v === "string") return `${event.toolName}: ${v}`;
		}
	}
	return event.toolName;
}

/**
 * Problem: /reload (and /new, /resume, /fork) tears this extension down and loads it again in the same process.
 * Closing the socket on that shutdown made the adapter see pi as gone, the hub closed the agent and removed its run
 * folder, and the new instance's listen() then failed with EACCES and crashed pi. Solution: only a quit closes the
 * socket; any other shutdown leaves the server and its clients here, process-wide, for the next instance to take.
 */
interface Handover {
	server: Server;
	clients: Set<Socket>;
	promptId: string | null;
}
const HANDOVER_KEY = Symbol.for("agent-link.pi-extension.handover");
function handovers(): Map<string, Handover> {
	const g = globalThis as { [HANDOVER_KEY]?: Map<string, Handover> };
	g[HANDOVER_KEY] ??= new Map();
	return g[HANDOVER_KEY];
}

function depthOf(env: NodeJS.ProcessEnv): number {
	const depth = Number.parseInt(env.AGENT_LINK_DEPTH ?? "0", 10);
	return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/** The extension with its env given, for tests. pi loads the default export. */
export function createAgentLinkExtension(env: NodeJS.ProcessEnv = process.env) {
	return (pi: ExtensionAPI): void => {
		const socketPath = env[PI_SOCKET_ENV];
		if (!socketPath) return;
		const depth = depthOf(env);
		registerMcp(pi, env[PI_MCP_ENV]);

		const clients = new Set<Socket>();
		let server: Server | undefined;
		let ctx: ExtensionContext | undefined;
		let running = false;
		let asking = false;
		/** The adapter's prompt the running (or next) turn answers; null for turns typed in the pane. */
		let promptId: string | null = null;
		let lastText = "";
		let lastStop: string | undefined;

		const send = (message: FromExtension) => {
			for (const c of clients) writeLine(c, message);
		};
		const sendState = (detail?: string) => {
			const state = asking ? "asking" : running ? "busy" : "idle";
			send(detail ? { type: "state", state, detail } : { type: "state", state });
		};

		/** The pi session this run writes, so the hub can journal where its transcript is. */
		const sendSession = (socket: Socket) => {
			const sm = ctx?.sessionManager;
			if (!sm) return;
			const file = sm.getSessionFile();
			writeLine(
				socket,
				file
					? { type: "session", sessionId: sm.getSessionId(), file }
					: { type: "session", sessionId: sm.getSessionId() },
			);
		};

		const onClient = (socket: Socket) => {
			clients.add(socket);
			socket.on("close", () => clients.delete(socket));
			socket.on("error", () => clients.delete(socket));
			sendState();
			sendSession(socket);
			readLines(socket, (raw) => {
				const message = parseToExtension(raw);
				if (message?.type === "prompt") {
					promptId = message.id;
					// Idle: steer + triggerTurn starts a turn. Busy (the hub waits for idle, so only in a race
					// with a turn typed in the pane): followUp folds it into the running turn before agent_end,
					// and that turn's end answers this prompt.
					pi.sendMessage(
						{ customType: MESSAGE_TYPE, content: message.text, display: true },
						running ? { deliverAs: "followUp" } : { triggerTurn: true, deliverAs: "steer" },
					);
				} else if (message?.type === "cancel") {
					if (running) ctx?.abort();
				}
			});
		};

		const close = () => {
			for (const c of clients) c.destroy();
			clients.clear();
			server?.close();
			server = undefined;
			rmSync(socketPath, { force: true });
		};

		/** Leaves the server and clients for the next instance of this extension, without this one's listeners. */
		const handOver = () => {
			if (!server) return;
			server.removeAllListeners("connection");
			for (const c of clients) {
				c.removeAllListeners("data");
				c.removeAllListeners("close");
				c.removeAllListeners("error");
				c.on("error", () => {});
			}
			handovers().set(socketPath, { server, clients: new Set(clients), promptId });
			clients.clear();
			server = undefined;
		};

		pi.on("session_start", (_event, c) => {
			ctx = c;
			if (server) return;
			const kept = handovers().get(socketPath);
			if (kept) {
				handovers().delete(socketPath);
				server = kept.server;
				promptId = kept.promptId;
				server.on("connection", onClient);
				for (const socket of kept.clients) onClient(socket);
				return;
			}
			rmSync(socketPath, { force: true });
			const s = createServer(onClient);
			server = s;
			// A failed listen (e.g. the hub already closed this agent and removed its folder) must not crash pi.
			s.on("error", () => {
				if (server === s) server = undefined;
			});
			s.listen(socketPath, () => {
				try {
					chmodSync(socketPath, 0o600);
				} catch {}
			});
		});
		pi.on("session_shutdown", (event) => {
			const reason = (event as { reason?: string } | undefined)?.reason;
			if (reason && reason !== "quit") handOver();
			else close();
		});

		pi.on("agent_start", (_event, c) => {
			ctx = c;
			running = true;
			lastText = "";
			lastStop = undefined;
			sendState();
		});
		pi.on("message_end", (event) => {
			const a = assistantText(event.message);
			if (!a) return;
			lastStop = a.stop;
			if (a.text) {
				lastText = a.text;
				send({ type: "agent_message", text: a.text });
			}
		});
		pi.on("agent_end", (event) => {
			// agent_end carries the run's messages; message_end already saw them, this covers a missed one.
			const last = [...event.messages]
				.reverse()
				.map(assistantText)
				.find((a) => a?.text);
			if (last && !lastText) lastText = last.text;
		});
		// agent_end can be followed by a retry, a compaction or a queued follow-up; agent_settled is the end.
		pi.on("agent_settled", (event) => {
			if (!running) return;
			running = false;
			asking = false;
			sendState();
			send({ type: "turn_end", id: promptId, stopReason: stopReason(lastStop, event.aborted), text: lastText });
			promptId = null;
		});

		pi.on("ui_prompt_start", (event) => {
			if (asking) return;
			asking = true;
			sendState(event.title);
		});
		pi.on("ui_prompt_end", () => {
			if (!asking) return;
			asking = false;
			sendState();
		});

		pi.on("tool_call", async (event, c): Promise<ToolCallEventResult | undefined> => {
			ctx = c;
			if (event.toolName === "bash" && typeof event.input.command === "string") {
				const command = event.input.command;
				const verdict = checkCommand(command, depth);
				if (verdict.action === "block") return { block: true, reason: verdict.reason };
				if (verdict.action === "ask") {
					if (!c.hasUI)
						return { block: true, reason: `agent-link guard: "${verdict.reason}" needs the user, and pi has no UI` };
					asking = true;
					sendState(command);
					const ok = await c.ui.confirm(`agent-link guard: ${verdict.reason}`, `Allow this command?\n\n${command}`);
					asking = false;
					sendState();
					if (!ok) return { block: true, reason: `agent-link guard: the user declined "${verdict.reason}"` };
				}
			}
			send({ type: "tool_call", title: toolTitle(event) });
			return undefined;
		});
	};
}

function registerMcp(pi: ExtensionAPI, json: string | undefined): void {
	if (!json) return;
	let spec: unknown;
	try {
		spec = JSON.parse(json);
	} catch {
		return;
	}
	if (!isRecord(spec) || typeof spec.command !== "string") return;
	const args = Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === "string") : [];
	// direct: the model sees spawn, send, reply... as tools, without tool_search or codemode.
	pi.registerMcpServer("agent-link", { command: spec.command, args, exposure: "direct" });
}

export default createAgentLinkExtension();
