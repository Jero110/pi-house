// The agent-link MCP server over stdio: the tools, backed by the hub. agent-link-cmux and agent-link-tmux call
// runMcpServer() with their backend; nothing else differs between them.
// Minimal JSON-RPC (initialize, tools/list, tools/call, ping), no SDK on purpose. Ported from xi
// packages/mcp/src/server.ts.
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createHubClient, ensureHub, type HubClient, identityFromEnv } from "../client.ts";
import { errorText } from "../hub/hub.ts";
import { agentLinkHome } from "../paths.ts";
import { harnessNames, loadProfiles, PROFILES_DIR } from "../profiles.ts";
import type { BackendName, PlaceHint } from "../types.ts";
import {
	cancelReply,
	errorReply,
	inboxReply,
	instructions,
	modelReply,
	permitReply,
	replyReply,
	sendReply,
	spawnReply,
	statusReply,
	type ToolReply,
	toolDefs,
	withPullReminder,
} from "./tools.ts";

type Json = Record<string, unknown>;

export interface McpServerOptions {
	backend: BackendName;
	/** Where the harness sits; default: read from the env (cmux or tmux). */
	place?: PlaceHint;
	input?: Readable;
	output?: Writable;
	env?: NodeJS.ProcessEnv;
	/** agent-link home for a server with no identity; default AGENT_LINK_HOME or ~/.agent-link. */
	home?: string;
	/** Daemon entry for ensureHub (see src/hub/daemon.ts). */
	hubEntry?: string;
	/** Harness names spawn offers; default: the native four plus every profile. */
	harnesses?: readonly string[];
	/** Process the hub watches for a pull root; default this server's own pid. */
	pid?: number;
	cwd?: string;
}

/**
 * Problem: Claude Code defers MCP tools behind ToolSearch, so a worker's first send cost a search turn.
 * Example: the latency bench's Claude worker ran ToolSearch "agent-link send executor" 1.7 s before its send.
 * Fix: Claude Code (2.1.305) loads a tool listed with _meta "anthropic/alwaysLoad": true up front, unless
 * the server's own config sets alwaysLoad: false. Other clients ignore _meta.
 */
const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

/** Where the caller's pane is, from the env cmux and tmux give the processes in a pane. */
export function placeFromEnv(backend: BackendName, env: NodeJS.ProcessEnv = process.env): PlaceHint | undefined {
	if (backend === "cmux") {
		const place: PlaceHint = {};
		if (env.CMUX_WORKSPACE_ID) place.workspace = env.CMUX_WORKSPACE_ID;
		if (env.CMUX_SURFACE_ID) place.surface = env.CMUX_SURFACE_ID;
		return place.workspace || place.surface ? place : undefined;
	}
	if (!env.TMUX_PANE) return undefined;
	// $TMUX is "<socket>,<server pid>,<session>": the socket names the caller's tmux server.
	const socket = env.TMUX?.split(",")[0];
	return socket ? { tmuxPane: env.TMUX_PANE, tmuxSocket: socket } : { tmuxPane: env.TMUX_PANE };
}

/** The root name for an MCP client: claude, codex, opencode or pi, from clientInfo.name. */
export function clientHarness(clientName: string): string {
	for (const h of ["claude", "codex", "opencode"]) if (clientName.toLowerCase().includes(h)) return h;
	if (/^pi\b|[^a-z]pi\b/i.test(clientName)) return "pi";
	return (
		clientName
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "agent"
	);
}

interface Session {
	client: HubClient;
	name: string;
	parent: string | null;
	pull: boolean;
}

/** Serves MCP on input/output (stdin/stdout by default) until input ends. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
	const env = opts.env ?? process.env;
	const output = opts.output ?? process.stdout;
	const place = opts.place ?? placeFromEnv(opts.backend, env);
	// The user's own profiles (e.g. pihouse's, written by its setup) count too, as they do for the hub.
	// Problem: spawn's harness enum came from the shipped profiles only. Example: the hub accepted harness "pihouse",
	// but the tool offered claude, codex, opencode and pi, so a planner could not hand off to a pihouse executor.
	const harnesses =
		opts.harnesses ?? harnessNames(loadProfiles([PROFILES_DIR, join(opts.home ?? agentLinkHome(env), "profiles")]));
	const identity = identityFromEnv(env);
	let pull = !identity;
	let session: Promise<Session> | undefined;
	let clientName = "";

	const write = (msg: Json): void => {
		output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
	};

	/** The hub session, made once per process: the inherited identity, or a pull root registered now. */
	const connect = (): Promise<Session> => {
		session ??= (async () => {
			if (identity) {
				const client = createHubClient({ socket: identity.hub, token: identity.token });
				const { agents } = await client.status(identity.agent);
				const names = new Set(agents.map((a) => a.name));
				const parent = agents.find((a) => a.parent !== identity.agent && !(a.parent && names.has(a.parent)));
				return { client, name: identity.agent, parent: parent?.name ?? null, pull: false };
			}
			const addr = await ensureHub({ home: opts.home, entry: opts.hubEntry, env });
			const client = createHubClient(addr);
			const res = await client.register({
				harness: clientHarness(clientName),
				cwd: opts.cwd ?? process.cwd(),
				pull: true,
				pid: opts.pid ?? process.pid,
			});
			if ("error" in res) throw new Error(res.error);
			return { client, name: res.name, parent: null, pull: true };
		})();
		return session;
	};

	const call = async (tool: string, args: Json): Promise<ToolReply> => {
		let s: Session;
		try {
			s = await connect();
		} catch (e) {
			// A later call tries again: the hub may be up by then.
			session = undefined;
			return errorReply(`the agent-link hub is not reachable: ${errorText(e)}. Do not retry in a loop; tell the user.`);
		}
		const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
		try {
			switch (tool) {
				case "spawn":
					return withPullReminder(
						spawnReply(
							await s.client.spawn({
								from: s.name,
								harness: str("harness") ?? "",
								task: str("task") ?? "",
								model: str("model"),
								name: str("name"),
								cwd: str("cwd"),
								backend: opts.backend,
								place,
								handoff: args.handoff === true,
							}),
							s.pull,
							args.handoff === true,
						),
						s.pull,
					);
				case "send": {
					const to = str("to") ?? "";
					return withPullReminder(
						sendReply(await s.client.send({ from: s.name, to, message: str("message") ?? "" }), to),
						s.pull,
					);
				}
				case "permit": {
					const to = str("to") ?? "";
					return withPullReminder(
						permitReply(await s.client.permit({ from: s.name, to, choice: str("choice") ?? "" }), to),
						s.pull,
					);
				}
				case "reply":
					return replyReply(await s.client.reply({ from: s.name, result: str("result") ?? "" }));
				case "status": {
					const res = await s.client.status(s.name);
					if (res.error) return errorReply(res.error);
					return statusReply(s.name, res.agents, s.pull);
				}
				case "cancel": {
					const name = str("name") ?? "";
					return cancelReply(await s.client.cancel({ from: s.name, name }), name);
				}
				case "model": {
					const to = str("to") ?? "";
					const retry = args.retry === true;
					const interrupt = args.interrupt === true;
					return modelReply(
						await s.client.model({ from: s.name, to, model: str("model") ?? "", retry, interrupt }),
						to,
					);
				}
				case "inbox": {
					const res = await s.client.inbox(s.name);
					return res.error ? errorReply(res.error) : inboxReply(res.messages);
				}
				default:
					return errorReply(`unknown tool ${tool}`);
			}
		} catch (e) {
			return errorReply(`the agent-link hub did not answer: ${errorText(e)}. Do not retry in a loop; tell the user.`);
		}
	};

	const handle = async (msg: { id?: number | string; method?: string; params?: Json }) => {
		switch (msg.method) {
			case "initialize": {
				clientName = String((msg.params?.clientInfo as { name?: string } | undefined)?.name ?? "");
				let text: string;
				try {
					const s = await connect();
					pull = s.pull;
					text = instructions({ client: clientName, name: s.name, parent: s.parent, pull: s.pull });
				} catch (e) {
					session = undefined;
					text = `The agent-link hub is not reachable (${errorText(e)}); its tools will say so until it is.`;
				}
				return write({
					id: msg.id,
					result: {
						protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "agent-link", version: "0.1.0" },
						instructions: text,
					},
				});
			}
			case "tools/list":
				return write({
					id: msg.id,
					result: { tools: toolDefs({ harnesses, pull }).map((t) => ({ ...t, _meta: ALWAYS_LOAD })) },
				});
			case "tools/call": {
				const p = (msg.params ?? {}) as { name?: string; arguments?: Json };
				return write({ id: msg.id, result: await call(p.name ?? "", p.arguments ?? {}) });
			}
			case "ping":
				return write({ id: msg.id, result: {} });
			default:
				if (msg.id !== undefined)
					write({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
		}
	};

	const rl = createInterface({ input: opts.input ?? process.stdin });
	const pending = new Set<Promise<void>>();
	rl.on("line", (line) => {
		if (!line.trim()) return;
		let msg: { id?: number | string; method?: string; params?: Json };
		try {
			msg = JSON.parse(line);
		} catch {
			write({ id: null, error: { code: -32700, message: "parse error" } });
			return;
		}
		const p = handle(msg).catch((e) => {
			if (msg.id !== undefined) write({ id: msg.id, error: { code: -32603, message: errorText(e) } });
		});
		pending.add(p);
		void p.finally(() => pending.delete(p));
	});
	await new Promise<void>((resolve) => rl.once("close", resolve));
	await Promise.all(pending);
}
