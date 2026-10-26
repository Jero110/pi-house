// Test doubles for the pi side: a fake pi ExtensionAPI that records what the extension registers and lets a
// test fire pi's events, and a JSON-lines client for the extension's socket.
import { mkdtempSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readLines } from "../../../src/pi-extension/protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export interface SentMessage {
	message: { customType: string; content: unknown; display: boolean };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

export class FakePi {
	handlers = new Map<string, Handler[]>();
	sent: SentMessage[] = [];
	mcp: { name: string; config: unknown }[] = [];
	aborts = 0;
	/** What ctx.ui.confirm answers; the titles it was asked with are kept in confirms. */
	confirmAnswer = true;
	confirms: string[] = [];
	hasUI = true;

	ctx = {
		hasUI: true,
		abort: () => {
			this.aborts++;
		},
		ui: {
			confirm: async (title: string, message: string) => {
				this.confirms.push(`${title}\n${message}`);
				return this.confirmAnswer;
			},
		},
	};

	/** The object the extension receives as `pi`. Only the members the extension uses exist. */
	get api(): ExtensionAPI {
		const self = this;
		const api = {
			on(event: string, handler: Handler) {
				const list = self.handlers.get(event) ?? [];
				list.push(handler);
				self.handlers.set(event, list);
				return () => {};
			},
			sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
				self.sent.push({ message, options });
			},
			registerMcpServer(name: string, config: unknown) {
				self.mcp.push({ name, config });
			},
		};
		return api as unknown as ExtensionAPI;
	}

	/** Fires a pi event at every handler and returns the last non-undefined result. */
	async emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		this.ctx.hasUI = this.hasUI;
		let result: unknown;
		for (const h of this.handlers.get(event) ?? []) {
			const r = await h({ type: event, ...payload }, this.ctx);
			if (r !== undefined) result = r;
		}
		return result;
	}
}

export function tempSocketPath(): string {
	return join(mkdtempSync(join(tmpdir(), "xl-pi-")), "pi.sock");
}

/** A client of the extension's socket that keeps every line it receives. */
export class LineClient {
	lines: Record<string, unknown>[] = [];
	socket: Socket;
	private waiters: (() => void)[] = [];

	private constructor(socket: Socket) {
		this.socket = socket;
		readLines(socket, (v) => {
			this.lines.push(v);
			for (const w of this.waiters.splice(0)) w();
		});
	}

	static open(path: string): Promise<LineClient> {
		return new Promise((resolve, reject) => {
			const s = connect(path);
			s.once("connect", () => resolve(new LineClient(s)));
			s.once("error", reject);
		});
	}

	send(value: Record<string, unknown>): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	/** Waits until a received line matches, and returns it. */
	async waitFor(match: (v: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.lines.find(match);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`no matching line; got ${JSON.stringify(this.lines)}`);
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 50);
			});
		}
	}

	close(): void {
		this.socket.destroy();
	}
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
