// What the pi adapter (in the hub) and the agent-link pi extension (inside pi) say to each other over the Unix
// socket AGENT_LINK_PI_SOCKET: one JSON object per line, in both directions.
import type { Socket } from "node:net";
import type { StopReason } from "../types.ts";

/** Env var with the socket path the extension listens on. Set by the pi adapter. */
export const PI_SOCKET_ENV = "AGENT_LINK_PI_SOCKET";
/** Env var with the agent-link MCP server as JSON `{ command, args }`, registered by the extension for this run. */
export const PI_MCP_ENV = "AGENT_LINK_PI_MCP";

/** Adapter -> extension. */
export type ToExtension = { type: "prompt"; id: string; text: string } | { type: "cancel" };

/** Extension -> adapter. A turn_end with id null is a turn the adapter did not start (typed in the pane). */
export type FromExtension =
	| { type: "state"; state: "idle" | "busy" | "asking"; detail?: string }
	| { type: "tool_call"; title: string }
	| { type: "agent_message"; text: string }
	| { type: "turn_end"; id: string | null; stopReason: StopReason; text: string }
	| { type: "session"; sessionId: string; file?: string };

export function writeLine(socket: Socket, message: ToExtension | FromExtension): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** Calls onLine with each parsed JSON line. Lines that are not JSON objects are dropped. */
export function readLines(socket: Socket, onLine: (value: Record<string, unknown>) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
			if (!line) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			if (isRecord(value)) onLine(value);
		}
	});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STOP_REASONS: readonly unknown[] = ["end_turn", "max_tokens", "refusal", "cancelled", "error"];
const isStopReason = (s: unknown): s is StopReason => STOP_REASONS.includes(s);

/** The extension's messages, checked field by field; undefined for anything else. */
export function parseFromExtension(v: Record<string, unknown>): FromExtension | undefined {
	switch (v.type) {
		case "state":
			if (v.state !== "idle" && v.state !== "busy" && v.state !== "asking") return undefined;
			return typeof v.detail === "string"
				? { type: "state", state: v.state, detail: v.detail }
				: { type: "state", state: v.state };
		case "tool_call":
			return typeof v.title === "string" ? { type: "tool_call", title: v.title } : undefined;
		case "agent_message":
			return typeof v.text === "string" ? { type: "agent_message", text: v.text } : undefined;
		case "session":
			if (typeof v.sessionId !== "string") return undefined;
			return typeof v.file === "string"
				? { type: "session", sessionId: v.sessionId, file: v.file }
				: { type: "session", sessionId: v.sessionId };
		case "turn_end": {
			const id = typeof v.id === "string" ? v.id : null;
			const stopReason = isStopReason(v.stopReason) ? v.stopReason : "error";
			return { type: "turn_end", id, stopReason, text: typeof v.text === "string" ? v.text : "" };
		}
		default:
			return undefined;
	}
}

/** The adapter's messages, checked field by field; undefined for anything else. */
export function parseToExtension(v: Record<string, unknown>): ToExtension | undefined {
	if (v.type === "cancel") return { type: "cancel" };
	if (v.type === "prompt" && typeof v.id === "string" && typeof v.text === "string") {
		return { type: "prompt", id: v.id, text: v.text };
	}
	return undefined;
}
