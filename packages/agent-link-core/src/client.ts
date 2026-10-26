// The hub client: HTTP over the hub's Unix socket. Used by the MCP server and by `agent-link open`.
// ensureHub() starts the daemon detached when the socket does not answer, and waits for it.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import type { InboxEntry, StatusEntry } from "./hub/hub.ts";
import type { SendResult } from "./hub/queue.ts";
import { socketAnswers, TOKEN_HEADER } from "./hub/server.ts";
import { agentLinkHome, hubPaths } from "./paths.ts";
import type { BackendName, Identity, PaneCommand, PlaceHint } from "./types.ts";
import { IDENTITY_ENV, readDirsFromEnv } from "./types.ts";

export interface HubAddress {
	socket: string;
	token: string;
}

export type ErrorOr<T> = T | { error: string };

export interface HubClient {
	register(body: {
		harness: string;
		model?: string | null;
		cwd: string;
		pull: boolean;
		adapter?: boolean;
		pid?: number;
		backend?: BackendName;
		place?: PlaceHint;
	}): Promise<ErrorOr<{ name: string; identity: Identity; command?: PaneCommand }>>;
	spawn(body: {
		from: string;
		harness: string;
		task: string;
		model?: string;
		name?: string;
		cwd?: string;
		backend: BackendName;
		place?: PlaceHint;
		/** Default: the caller's READ_DIRS_ENV. */
		read?: string[];
		handoff?: boolean;
	}): Promise<ErrorOr<{ name: string }>>;
	send(body: { from: string; to: string; message: string; id?: string }): Promise<SendResult>;
	reply(body: { from: string; result: string }): Promise<{ ok: boolean; error?: string }>;
	/** Answers the permission or question a worker waits on (Hub.permit). */
	permit(body: {
		from: string;
		to: string;
		choice: string;
	}): Promise<{ ok: boolean; answered?: string; error?: string }>;
	status(agent: string): Promise<{ agents: StatusEntry[]; error?: string }>;
	/** Every agent of the hub, each root followed by its tree. */
	agents(): Promise<{ agents: Array<StatusEntry & { backend?: BackendName; pane?: string; startedAt: number }> }>;
	cancel(body: { from: string; name: string }): Promise<{ ok?: boolean; error?: string }>;
	inbox(agent: string): Promise<{ messages: InboxEntry[]; error?: string }>;
	event(body: { agent: string; type: string } & Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
	/** Server-sent messages for `agent`, until close(). */
	stream(agent: string, onMessage: (m: InboxEntry) => void): { close(): void; opened: Promise<void> };
}

/** A request the hub refused or could not take; the message says which. */
export class HubError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "HubError";
		this.status = status;
	}
}

export function createHubClient(addr: HubAddress): HubClient {
	const headers = { "content-type": "application/json", [TOKEN_HEADER]: addr.token };

	function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: addr.socket, path, method, headers }, (res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => {
					data += c;
				});
				res.on("end", () => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(data);
					} catch {
						return reject(new HubError(`the hub answered HTTP ${res.statusCode} with no JSON`, res.statusCode));
					}
					// A wrong token does not change by retrying, and the answer has none of the fields callers read.
					if (res.statusCode === 401) return reject(new HubError("the hub refused the token", 401));
					resolve(parsed as T);
				});
			});
			req.on("error", (e) => reject(new HubError(`the hub at ${addr.socket} is not reachable (${e.message})`)));
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	const q = (agent: string) => `?agent=${encodeURIComponent(agent)}`;

	return {
		register: (body) => call("POST", "/agents", { parent: null, ...body }),
		spawn: (body) => call("POST", "/spawn", { read: readDirsFromEnv(), ...body }),
		send: (body) => call("POST", "/send", body),
		reply: (body) => call("POST", "/reply", body),
		permit: (body) => call("POST", "/permit", body),
		status: (agent) => call("GET", `/status${q(agent)}`),
		agents: () => call("GET", "/agents"),
		cancel: (body) => call("POST", "/cancel", body),
		inbox: (agent) => call("GET", `/inbox${q(agent)}`),
		event: (body) => call("POST", "/event", body),
		stream(agent, onMessage) {
			let closed = false;
			let opened: () => void = () => {};
			let failed: (e: Error) => void = () => {};
			const openedP = new Promise<void>((resolve, reject) => {
				opened = () => resolve();
				failed = reject;
			});
			const req = request({ socketPath: addr.socket, path: `/stream${q(agent)}`, headers }, (res) => {
				if (res.statusCode !== 200) {
					res.resume();
					failed(new HubError(`the hub refused the stream of ${agent} (HTTP ${res.statusCode})`, res.statusCode));
					return;
				}
				opened();
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					buf += chunk;
					let idx = buf.indexOf("\n\n");
					while (idx >= 0) {
						const data = buf
							.slice(0, idx)
							.split("\n")
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trimStart())
							.join("\n");
						buf = buf.slice(idx + 2);
						if (data && !closed) onMessage(JSON.parse(data) as InboxEntry);
						idx = buf.indexOf("\n\n");
					}
				});
			});
			req.on("error", (e) => {
				if (!closed) failed(new HubError(`the hub at ${addr.socket} is not reachable (${e.message})`));
			});
			req.end();
			openedP.catch(() => {});
			return {
				opened: openedP,
				close() {
					closed = true;
					req.destroy();
				},
			};
		},
	};
}

/** The identity a spawned agent's MCP server inherits, or undefined for a harness opened without agent-link. */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): Identity | undefined {
	const agent = env[IDENTITY_ENV.agent];
	const hub = env[IDENTITY_ENV.hub];
	const token = env[IDENTITY_ENV.token];
	if (!agent || !hub || !token) return undefined;
	const depth = Number.parseInt(env[IDENTITY_ENV.depth] ?? "0", 10);
	return { agent, hub, token, depth: Number.isFinite(depth) && depth > 0 ? depth : 0 };
}

/**
 * The daemon entry ensureHub starts by default: the agent-link package's hub, which composes every adapter
 * and both pane backends. This package cannot depend on agent-link (agent-link depends on it), so the entry is
 * found by resolving the package name, not by importing it. Without agent-link installed it is this package's
 * own daemon, which has no adapters and no backends (see src/hub/daemon.ts).
 */
export const DEFAULT_HUB_ENTRY = defaultHubEntry();

function defaultHubEntry(): string {
	try {
		return fileURLToPath(import.meta.resolve("agent-link/hub"));
	} catch {
		return fileURLToPath(new URL("./hub/daemon.ts", import.meta.url));
	}
}

export interface EnsureHubOptions {
	home?: string;
	/** The script `node` runs as the daemon; see src/hub/daemon.ts for why it is configurable. */
	entry?: string;
	/** How long to wait for a new daemon's socket. */
	timeoutMs?: number;
	/** Env for a new daemon; AGENT_LINK_HOME is set to home. */
	env?: NodeJS.ProcessEnv;
}

/**
 * The address of a running hub: the socket answers, or a new detached daemon was started and answered
 * within timeoutMs. Two callers racing both start a daemon; the second sees the first one's socket
 * answering and exits, and both callers get the same address.
 */
export async function ensureHub(opts: EnsureHubOptions = {}): Promise<HubAddress> {
	const home = opts.home ?? agentLinkHome();
	const paths = hubPaths(home);
	if (!(await socketAnswers(paths.socket))) {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const out = openSync(paths.daemonLog, "a", 0o600);
		try {
			const child = spawn(process.execPath, [opts.entry ?? DEFAULT_HUB_ENTRY], {
				detached: true,
				stdio: ["ignore", out, out],
				env: { ...(opts.env ?? process.env), AGENT_LINK_HOME: home },
			});
			child.unref();
		} finally {
			closeSync(out);
		}
		const end = Date.now() + (opts.timeoutMs ?? 10_000);
		while (!(await socketAnswers(paths.socket))) {
			if (Date.now() > end)
				throw new HubError(`the hub did not start within ${opts.timeoutMs ?? 10_000} ms; see ${paths.daemonLog}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	return { socket: paths.socket, token: readToken(home) };
}

export function readToken(home: string = agentLinkHome()): string {
	return readFileSync(hubPaths(home).token, "utf8").trim();
}

/** Stops the daemon of `home` (SIGTERM to its pid) and waits until its socket is gone. */
export async function stopHub(home: string = agentLinkHome(), timeoutMs = 10_000): Promise<boolean> {
	const paths = hubPaths(home);
	if (!existsSync(paths.pid)) return false;
	const pid = Number.parseInt(readFileSync(paths.pid, "utf8"), 10);
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	// Problem: the hub removes its socket and pid file before it has closed the journal and the event log. Example: a
	// test that deleted the home right after stopHub failed with ENOTEMPTY, since the hub still wrote files there.
	// Solution: wait until the process itself is gone, too.
	const end = Date.now() + timeoutMs;
	while (existsSync(paths.socket) || existsSync(paths.pid) || alive(pid)) {
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
	return true;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
