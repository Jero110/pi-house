// A fake `codex app-server --listen ws://...` for tests: a node:http server that accepts the WebSocket upgrade
// and speaks JSON-RPC text frames with a minimal frame codec (RFC 6455: masked client frames, unmasked server
// frames, text, close and ping). No dependency, no real Codex, no tokens.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerProcess } from "../../../src/adapters/codex.ts";

type Json = Record<string, unknown>;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const n = payload.length;
	const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	if (n >= 126 && n < 65536) {
		head[0] = 0x81;
		head[1] = 126;
		head.writeUInt16BE(n, 2);
	} else if (n >= 65536) {
		head[0] = 0x81;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(n), 2);
	}
	return Buffer.concat([head, payload]);
}

/** Splits complete client frames off the buffer; returns [opcode, payload] pairs and what is left. */
function parseFrames(buf: Buffer): { frames: [number, Buffer][]; rest: Buffer } {
	const frames: [number, Buffer][] = [];
	let off = 0;
	for (;;) {
		if (buf.length - off < 2) break;
		const b0 = buf[off] ?? 0;
		const b1 = buf[off + 1] ?? 0;
		let len = b1 & 0x7f;
		let pos = off + 2;
		if (len === 126) {
			if (buf.length - pos < 2) break;
			len = buf.readUInt16BE(pos);
			pos += 2;
		} else if (len === 127) {
			if (buf.length - pos < 8) break;
			len = Number(buf.readBigUInt64BE(pos));
			pos += 8;
		}
		const masked = (b1 & 0x80) !== 0;
		const maskLen = masked ? 4 : 0;
		if (buf.length - pos < maskLen + len) break;
		const mask = buf.subarray(pos, pos + maskLen);
		const payload = Buffer.from(buf.subarray(pos + maskLen, pos + maskLen + len));
		if (masked) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
		frames.push([b0 & 0x0f, payload]);
		off = pos + maskLen + len;
	}
	return { frames, rest: buf.subarray(off) };
}

export class FakeAppServer {
	readonly http: Server;
	readonly port: number;
	sockets = new Set<Duplex>();
	/** Every JSON-RPC message the clients sent. */
	received: Json[] = [];
	/** Thread ids thread/loaded/list answers with. */
	loaded: string[] = [];
	/** How many more thread/resume calls fail as Codex does for a thread with no turns yet. */
	resumeFailures = 0;
	/** The turns thread/resume answers with. */
	resumeTurns: Json[] = [];
	/** turn/start answers with this turn id; null means "start turn-<n>". */
	turnId: string | null = null;
	private turns = 0;
	private nextRequestId = 1000;
	private waiters: (() => void)[] = [];
	/** Optional override: return a result to answer a request yourself, undefined for the default. */
	handle: (method: string, params: Json) => unknown = () => undefined;

	constructor(port: number) {
		this.port = port;
		this.http = createServer((_req, res) => res.writeHead(426).end());
		this.http.on("upgrade", (req, socket) => {
			const key = String(req.headers["sec-websocket-key"] ?? "");
			const accept = createHash("sha1")
				.update(key + GUID)
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			this.sockets.add(socket);
			let buf: Buffer = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				const parsed = parseFrames(Buffer.concat([buf, chunk]));
				buf = parsed.rest;
				for (const [op, payload] of parsed.frames) {
					if (op === 8) socket.end(Buffer.from([0x88, 0]));
					else if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
					else if (op === 1) this.receive(socket, payload.toString("utf8"));
				}
			});
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => this.sockets.delete(socket));
		});
		this.http.listen(port, "127.0.0.1");
	}

	private receive(socket: Duplex, text: string): void {
		const m: unknown = JSON.parse(text);
		if (typeof m !== "object" || m === null) return;
		const msg = m as Json;
		this.received.push(msg);
		for (const w of this.waiters.splice(0)) w();
		if (typeof msg.method !== "string" || msg.id === undefined) return;
		const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;
		if (msg.method === "thread/resume" && this.resumeFailures > 0) {
			this.resumeFailures--;
			const error = { code: -32600, message: `no rollout found for thread id ${String(params.threadId)}` };
			socket.write(frame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error })));
			return;
		}
		const result = this.handle(msg.method, params) ?? this.defaultResult(msg.method, params);
		socket.write(frame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })));
	}

	private defaultResult(method: string, params: Json): unknown {
		switch (method) {
			case "initialize":
				return { userAgent: "fake/0.163.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" };
			case "thread/resume":
				return { thread: { id: params.threadId, turns: this.resumeTurns } };
			case "thread/loaded/list":
				return { data: this.loaded, nextCursor: null };
			case "turn/start": {
				const id = this.turnId ?? `turn-${++this.turns}`;
				return { turn: { id, items: [], itemsView: "notLoaded", status: "inProgress" } };
			}
			default:
				return {};
		}
	}

	/** Sends a notification to every client. */
	notify(method: string, params: Json): void {
		for (const s of this.sockets) s.write(frame(JSON.stringify({ jsonrpc: "2.0", method, params })));
	}

	/** Sends a server request to every client; returns its id. */
	request(method: string, params: Json): number {
		const id = this.nextRequestId++;
		for (const s of this.sockets) s.write(frame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
		return id;
	}

	async waitFor(match: (m: Json) => boolean, timeoutMs = 2000): Promise<Json> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.received.find(match);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(this.received)}`);
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 50);
			});
		}
	}

	close(): void {
		for (const s of this.sockets) s.destroy();
		this.http.close();
	}
}

/** What spawnServer receives: the fake starts a FakeAppServer on the port in `--listen`. */
export class FakeServerProcess implements ServerProcess {
	server: FakeAppServer;
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signals: string[] = [];
	private exitListeners: ((code: number | null) => void)[] = [];
	private exited = false;

	constructor(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
		this.command = command;
		this.args = args;
		this.cwd = opts.cwd;
		this.env = opts.env;
		const url = args[args.indexOf("--listen") + 1] ?? "";
		this.server = new FakeAppServer(Number(new URL(url).port));
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		this.exit(null);
		return true;
	}

	/** The process ends (crash or kill). */
	exit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		this.server.close();
		setImmediate(() => {
			for (const l of this.exitListeners) l(code);
		});
	}

	on(_event: "exit", listener: (code: number | null) => void): this {
		this.exitListeners.push(listener);
		return this;
	}
}
