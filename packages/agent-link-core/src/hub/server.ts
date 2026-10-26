// The hub daemon: HTTP over a Unix socket in a private folder, every request checked against the token.
// Endpoints as the table in docs/design.md ("Hub API").
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { Journal } from "../journal.ts";
import { EventLog } from "../log.ts";
import { hubPaths } from "../paths.ts";
import { loadProfiles } from "../profiles.ts";
import type { AdapterFactory, BackendName, GuardVerdict, PaneBackend, Profile } from "../types.ts";
import { errorText, type HarnessEvent, Hub, type RegisterRequest } from "./hub.ts";
import type { McpCommands, SpawnRequest } from "./spawn.ts";

export interface StartHubOptions {
	/** The agent-link home; the socket, token, log and run folders live in it. */
	home: string;
	adapters: Record<string, AdapterFactory>;
	backends: Partial<Record<BackendName, PaneBackend>>;
	profiles?: ReadonlyMap<string, Profile>;
	mcp?: McpCommands;
	guard?: (command: string, depth: number) => GuardVerdict;
	startup?: { timeoutMs?: number; pollMs?: number };
	idlePollMs?: number;
	pidPollMs?: number;
}

export interface RunningHub {
	hub: Hub;
	socket: string;
	token: string;
	/** Closes every agent, the server and the log, and removes the socket. Idempotent. */
	close(): Promise<void>;
}

export const TOKEN_HEADER = "x-agent-link-token";

/** sun_path holds 104 bytes on macOS (108 on Linux), the terminating NUL included. */
const MAX_SOCKET_PATH = 103;

/** Starts the hub on <home>/hub.sock. Fails if another hub already answers there. */
export async function startHub(opts: StartHubOptions): Promise<RunningHub> {
	const paths = hubPaths(opts.home);
	// Problem: listen() on a Unix socket path longer than sun_path fails with a bare EINVAL.
	// Example: an AGENT_LINK_HOME deep inside a temp folder. Solution: say which path and the limit.
	if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH)
		throw new Error(
			`the hub socket path ${paths.socket} is longer than ${MAX_SOCKET_PATH} bytes; set a shorter AGENT_LINK_HOME`,
		);
	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	// mkdir leaves an existing folder's mode alone.
	chmodSync(paths.home, 0o700);
	mkdirSync(paths.run, { recursive: true, mode: 0o700 });
	const token = readOrCreateToken(paths.token);
	if (existsSync(paths.socket)) {
		if (await socketAnswers(paths.socket)) throw new Error(`a hub already runs on ${paths.socket}`);
		// Left by a hub that died without cleaning up.
		unlinkSync(paths.socket);
	}
	const log = new EventLog(paths.events);
	const hub = new Hub({
		socket: paths.socket,
		home: paths.home,
		token,
		runRoot: paths.run,
		log,
		journal: new Journal(paths.sessions),
		adapters: opts.adapters,
		backends: opts.backends,
		profiles: opts.profiles ?? loadProfiles(),
		mcp: opts.mcp,
		guard: opts.guard,
		startup: opts.startup,
		idlePollMs: opts.idlePollMs,
		pidPollMs: opts.pidPollMs,
	});
	const server = createServer((req, res) => {
		handle(hub, token, req, res).catch((e) => json(res, 500, { error: errorText(e) }));
	});
	// The socket is created with the process umask; 0177 makes it 0600 from the first moment.
	const umask = process.umask(0o177);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(paths.socket, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} finally {
		process.umask(umask);
	}
	chmodSync(paths.socket, 0o600);
	log.event(null, "hub-started", { pid: process.pid });
	let closing: Promise<void> | undefined;
	return {
		hub,
		socket: paths.socket,
		token,
		close: () => {
			closing ??= (async () => {
				await hub.close();
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
				log.event(null, "hub-stopped");
				log.close();
				rmSync(paths.socket, { force: true });
			})();
			return closing;
		},
	};
}

/** Keeps the token across restarts, so agents that still hold it keep working with a new hub. */
function readOrCreateToken(path: string): string {
	if (existsSync(path)) {
		const token = readFileSync(path, "utf8").trim();
		if (token && (statSync(path).mode & 0o077) === 0) return token;
		// A token others could read is no secret anymore.
	}
	const token = randomBytes(24).toString("hex");
	writeFileSync(path, `${token}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return token;
}

export function socketAnswers(path: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect(path);
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

type Body = Record<string, unknown>;

async function handle(hub: Hub, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.headers[TOKEN_HEADER] !== token) return json(res, 401, { error: "bad token" });
	const url = new URL(req.url ?? "/", "http://hub");
	const agent = url.searchParams.get("agent") ?? "";
	const route = `${req.method} ${url.pathname}`;
	if (req.method === "GET") {
		if (url.pathname === "/status") return json(res, 200, hub.status(agent));
		// Not scoped to an agent: for `agent-link status`, which runs outside the tree.
		if (url.pathname === "/agents") return json(res, 200, { agents: hub.allAgents() });
		if (url.pathname === "/inbox") return json(res, 200, hub.inbox(agent));
		if (url.pathname === "/stream") return stream(hub, agent, res);
		return json(res, 404, { error: `not found: ${route}` });
	}
	if (req.method !== "POST") return json(res, 404, { error: `not found: ${route}` });
	let body: Body;
	try {
		const parsed: unknown = JSON.parse(await readBody(req));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		body = parsed as Body;
	} catch (e) {
		return json(res, 400, { error: `the body must be a JSON object: ${errorText(e)}` });
	}
	const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
	const opt = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : undefined);
	switch (url.pathname) {
		case "/agents":
			return json(
				res,
				200,
				await hub.register({
					harness: str("harness"),
					model: opt("model") ?? null,
					cwd: str("cwd") || process.cwd(),
					parent: body.parent as RegisterRequest["parent"],
					pull: body.pull === true,
					adapter: body.adapter === true,
					pid: typeof body.pid === "number" ? body.pid : undefined,
					backend: body.backend === "cmux" || body.backend === "tmux" ? body.backend : undefined,
					place: body.place && typeof body.place === "object" ? (body.place as RegisterRequest["place"]) : undefined,
				}),
			);
		case "/spawn": {
			const backend = str("backend");
			if (backend !== "cmux" && backend !== "tmux") return json(res, 200, { error: `backend must be cmux or tmux` });
			const place = body.place && typeof body.place === "object" ? (body.place as SpawnRequest["place"]) : undefined;
			return json(
				res,
				200,
				await hub.spawn({
					from: str("from"),
					harness: str("harness"),
					task: str("task"),
					model: opt("model"),
					name: opt("name"),
					cwd: opt("cwd"),
					backend,
					place,
					read: Array.isArray(body.read) ? body.read.filter((d): d is string => typeof d === "string") : undefined,
					handoff: body.handoff === true,
				}),
			);
		}
		case "/send":
			return json(
				res,
				200,
				await hub.send({ from: str("from"), to: str("to"), message: str("message"), id: opt("id") }),
			);
		case "/reply":
			return json(res, 200, hub.reply({ from: str("from"), result: str("result") }));
		case "/permit":
			return json(res, 200, await hub.permit({ from: str("from"), to: str("to"), choice: str("choice") }));
		case "/cancel": {
			const r = await hub.cancel({ from: str("from"), name: str("name") });
			return json(res, 200, r.ok ? { ok: true } : { error: r.error });
		}
		case "/event":
			return json(res, 200, hub.event(body as HarnessEvent));
		default:
			return json(res, 404, { error: `not found: ${route}` });
	}
}

/** Server-sent events: one `data:` frame per message the hub hands to the agent. */
function stream(hub: Hub, agent: string, res: ServerResponse): void {
	if (!hub.registry.get(agent)) {
		json(res, 404, { error: `unknown agent "${agent}"` });
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.write(": connected\n\n");
	const stop = hub.subscribe(agent, (m) => res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`));
	res.on("close", stop);
}

function json(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (c: string) => {
			data += c;
		});
		req.on("end", () => resolve(data || "{}"));
		req.on("error", reject);
	});
}
