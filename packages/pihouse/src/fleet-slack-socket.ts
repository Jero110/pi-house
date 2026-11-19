import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createSlackBridge } from "./fleet-slack.ts";

export interface SlackConfig {
	team: string;
	owner: string;
	channels: string[];
	project: string;
	tokensFile: string;
}
const id = {
	team: /^T[A-Z0-9]{1,31}$/,
	user: /^[UW][A-Z0-9]{1,31}$/,
	channel: /^[CG][A-Z0-9]{1,31}$/,
	dm: /^D[A-Z0-9]{1,31}$/,
};
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateSlackConfig(value: unknown): SlackConfig {
	if (
		!record(value) ||
		Object.keys(value).some((k) => !["team", "owner", "channels", "project", "tokensFile"].includes(k)) ||
		typeof value.team !== "string" ||
		!id.team.test(value.team) ||
		typeof value.owner !== "string" ||
		!id.user.test(value.owner) ||
		!Array.isArray(value.channels) ||
		value.channels.length > 128 ||
		!value.channels.every((c) => typeof c === "string" && id.channel.test(c)) ||
		typeof value.project !== "string" ||
		!/^[\w-]{1,64}$/.test(value.project) ||
		typeof value.tokensFile !== "string" ||
		!isAbsolute(value.tokensFile) ||
		resolve(value.tokensFile) !== value.tokensFile
	)
		throw new Error("Invalid Slack configuration. See docs/fleet-slack.md.");
	return {
		team: value.team,
		owner: value.owner,
		project: value.project,
		tokensFile: value.tokensFile,
		channels: [...new Set<string>(value.channels)],
	};
}
function readTokens(path: string): { appToken: string; botToken: string } {
	let fd: number | undefined;
	try {
		const parent = statSync(dirname(path)),
			uid = process.getuid?.();
		if (realpathSync(path) !== path || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0)
			throw new Error();
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const f = fstatSync(fd);
		if (!f.isFile() || f.uid !== uid || f.nlink !== 1 || (f.mode & 0o077) !== 0 || f.size > 8192) throw new Error();
		const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (
			!record(v) ||
			typeof v.appToken !== "string" ||
			!/^xapp-[A-Za-z0-9-]+$/.test(v.appToken) ||
			typeof v.botToken !== "string" ||
			!/^xoxb-[A-Za-z0-9-]+$/.test(v.botToken)
		)
			throw new Error();
		return { appToken: v.appToken, botToken: v.botToken };
	} catch {
		throw new Error("Slack needs an owner-only tokens file in a private directory. See docs/fleet-slack.md.");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function socketUrl(value: unknown): string {
	try {
		if (typeof value !== "string") throw new Error();
		const u = new URL(value);
		if (
			u.protocol !== "wss:" ||
			!/^wss(?:-[a-z0-9-]+)?\.slack\.com$/.test(u.hostname) ||
			u.username ||
			u.password ||
			u.port ||
			u.hash ||
			!/^\/link\/?$/.test(u.pathname) ||
			!u.searchParams.get("ticket")
		)
			throw new Error();
		return u.href;
	} catch {
		throw new SlackFailure("Slack returned an invalid Socket Mode URL.", false);
	}
}
class SlackFailure extends Error {
	readonly retry: boolean;
	readonly retryAfter: number;
	constructor(message: string, retry: boolean, retryAfter = 0) {
		super(message);
		this.retry = retry;
		this.retryAfter = retryAfter;
	}
}
type Bridge = Pick<ReturnType<typeof createSlackBridge>, "accept" | "flush" | "close">;
type Context = { stateDir: string; origin: string; host: string; signal?: AbortSignal };
type Jobs = Parameters<typeof createSlackBridge>[1];
type IO = {
	fetch: typeof fetch;
	connect: (url: string) => Pick<WebSocket, "addEventListener" | "send" | "close">;
	bridge: (...args: Parameters<typeof createSlackBridge>) => Bridge;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	log: (message: string) => void;
};
const defaults: IO = {
	fetch: (url, opts) => fetch(url, opts),
	connect: (url) => new WebSocket(url),
	bridge: createSlackBridge,
	sleep: (ms, signal) => wait(ms, undefined, { signal }),
	log: (message) => process.stderr.write(`pih fleet: ${message}\n`),
};
const permanentErrors = new Set([
	"invalid_auth",
	"token_revoked",
	"not_authed",
	"account_inactive",
	"missing_scope",
	"not_allowed_token_type",
	"not_in_channel",
	"channel_not_found",
	"restricted_action",
	"invalid_arguments",
	"app_disabled",
	"org_login_required",
]);
const attempts = 6;
function pause(ms: number, attempt: number): number {
	return Math.max(ms, Math.min(30000, 1000 * 2 ** attempt));
}
function publicFailure(err: unknown): SlackFailure {
	return err instanceof SlackFailure ? err : new SlackFailure("Slack transport is unavailable.", true);
}

export async function startSlackSocket(
	config: SlackConfig,
	context: Context,
	jobs: Jobs,
	overrides: Partial<IO> = {},
): Promise<{ close(): Promise<void> }> {
	const cfg = validateSlackConfig(config);
	const { appToken, botToken } = readTokens(cfg.tokensFile);
	const io = { ...defaults, ...overrides },
		stop = new AbortController();
	const signal = context.signal ? AbortSignal.any([stop.signal, context.signal]) : stop.signal;
	async function api(
		method: "auth.test" | "apps.connections.open" | "chat.postMessage",
		body: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		let res: Response;
		try {
			res = await io.fetch(`https://slack.com/api/${method}`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
				headers: {
					Authorization: `Bearer ${method === "apps.connections.open" ? appToken : botToken}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(body),
			});
		} catch {
			throw new SlackFailure(`Slack ${method} connection failed.`, true);
		}
		if (!res.ok) await res.body?.cancel().catch(() => {});
		if (res.status === 429) {
			const seconds = Number(res.headers.get("retry-after") ?? 1);
			const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1000;
			throw new SlackFailure(`Slack ${method} was rate limited.`, retryAfter <= 900000, retryAfter);
		}
		if (!res.ok) throw new SlackFailure(`Slack ${method} returned HTTP ${res.status}.`, res.status >= 500);
		let data: unknown;
		try {
			data = await res.json();
		} catch {
			throw new SlackFailure(`Slack ${method} returned an invalid response.`, true);
		}
		if (!record(data) || data.ok !== true) {
			const code = record(data) && typeof data.error === "string" ? data.error : "";
			if (permanentErrors.has(code)) throw new SlackFailure(`Slack ${method} rejected the request (${code}).`, false);
			throw new SlackFailure(
				`Slack ${method} rejected the request.`,
				["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(code),
			);
		}
		return data;
	}
	async function identify() {
		for (let n = 0; ; n++) {
			if (signal.aborted) throw new SlackFailure("Slack startup stopped.", false);
			try {
				const auth = await api("auth.test");
				if (
					auth.team_id !== cfg.team ||
					typeof auth.user_id !== "string" ||
					!id.user.test(auth.user_id) ||
					typeof auth.bot_id !== "string" ||
					!auth.bot_id.startsWith("B")
				)
					throw new SlackFailure("The Slack bot token does not identify a bot in the configured workspace.", false);
				return auth.user_id;
			} catch (err) {
				const f = publicFailure(err);
				if (!f.retry || n + 1 >= attempts) throw f;
				await io.sleep(pause(f.retryAfter, n), signal);
			}
		}
	}
	const botId = await identify().catch((err) => {
		if (signal.aborted) throw new SlackFailure("Slack startup stopped.", false);
		throw publicFailure(err);
	});
	const bridge = io.bridge(
		{
			stateDir: context.stateDir,
			origin: context.origin,
			host: context.host,
			teamId: cfg.team,
			ownerId: cfg.owner,
			botId,
			channels: cfg.channels,
			project: cfg.project,
		},
		jobs,
		async (channel, thread, text, deliveryId?: string) => {
			if (
				(!cfg.channels.includes(channel) && !id.dm.test(channel)) ||
				!/^\d{1,16}\.\d{1,10}$/.test(thread) ||
				!text ||
				text.length > 3000
			)
				throw new SlackFailure("Invalid Slack thread delivery.", false);
			// Explicit plain-text blocks keep model-provided markup and mentions literal.
			const fallback = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
			const destination = text.split(/\s+/).at(-1);
			const link =
				destination &&
				(destination === `${context.origin}/` ||
					(destination.startsWith(`${context.origin}/#chat=`) &&
						/^[0-9a-f-]{36}$/.test(destination.slice(`${context.origin}/#chat=`.length))));
			const button = link
				? {
						accessory: {
							type: "button",
							text: { type: "plain_text", text: "Open in pi-house" },
							url: destination,
							action_id: "open_fleet_chat",
						},
					}
				: {};
			await api("chat.postMessage", {
				channel,
				thread_ts: thread,
				text: fallback,
				mrkdwn: false,
				link_names: false,
				parse: "none",
				unfurl_links: false,
				unfurl_media: false,
				blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false }, ...button }],
				...(deliveryId ? { client_msg_id: deliveryId } : {}),
			});
		},
	);
	const ready = Promise.withResolvers<void>();
	let opened = false;
	const abortOpening = () => ready.reject(new SlackFailure("Slack startup stopped.", false));
	signal.addEventListener("abort", abortOpening, { once: true });
	if (signal.aborted) abortOpening();
	function session(url: string): Promise<"refresh" | "lost" | "stopped"> {
		return new Promise((resolve, reject) => {
			const socket = io.connect(url);
			let ended = false,
				hello = false;
			const timer = setTimeout(() => end("lost"), 12000);
			const rotate = setTimeout(() => end("refresh"), 60 * 60 * 1000);
			const onStop = () => end("stopped");
			function end(reason: "refresh" | "lost" | "stopped", error?: SlackFailure) {
				if (ended) return;
				ended = true;
				clearTimeout(timer);
				clearTimeout(rotate);
				signal.removeEventListener("abort", onStop);
				try {
					socket.close();
				} catch {}
				if (error) reject(error);
				else resolve(reason);
			}
			signal.addEventListener("abort", onStop, { once: true });
			socket.addEventListener("error", () => end("lost"));
			socket.addEventListener("close", () => end("lost"));
			socket.addEventListener("message", ({ data }) => {
				if (ended || typeof data !== "string" || data.length > 2 ** 20) return;
				let packet: unknown;
				try {
					packet = JSON.parse(data);
				} catch {
					return;
				}
				if (!record(packet)) return;
				if (packet.type === "hello") {
					hello = true;
					if (!opened) io.log("Slack Socket Mode connected.");
					opened = true;
					clearTimeout(timer);
					ready.resolve();
					return;
				}
				if (packet.type === "disconnect") {
					if (packet.reason === "link_disabled")
						end("lost", new SlackFailure("Slack disabled the Socket Mode connection.", false));
					else end("refresh");
					return;
				}
				if (!hello || typeof packet.envelope_id !== "string" || !packet.envelope_id || packet.envelope_id.length > 256)
					return;
				const payload = packet.payload;
				try {
					if (
						packet.type === "events_api" &&
						record(payload) &&
						payload.type === "event_callback" &&
						payload.team_id === cfg.team &&
						typeof payload.event_id === "string" &&
						Array.isArray(payload.authorizations) &&
						payload.authorizations.some((a) => record(a) && a.is_bot === true && a.user_id === botId)
					)
						bridge.accept(payload.event_id, cfg.team, payload.event);
					socket.send(JSON.stringify({ envelope_id: packet.envelope_id }));
				} catch {
					end("lost");
				}
			});
			if (signal.aborted) onStop();
		});
	}
	async function listen() {
		let last = new SlackFailure("Slack Socket Mode connection failed.", true);
		for (let n = 0; n < attempts && !signal.aborted; n++) {
			const start = Date.now();
			try {
				const openedSocket = await api("apps.connections.open");
				const result = await session(socketUrl(openedSocket.url));
				if (result === "stopped" || signal.aborted) return;
				if (Date.now() - start >= 60000) n = 0;
				last = new SlackFailure("Slack Socket Mode disconnected.", true);
			} catch (err) {
				last = publicFailure(err);
			}
			if (!last.retry || n + 1 >= attempts) break;
			await io.sleep(pause(last.retryAfter, n), signal);
		}
		if (!signal.aborted) {
			if (opened) io.log(`${last.message} Reconnect stopped; restart the service to retry.`);
			else ready.reject(last);
		}
	}
	async function deliver() {
		let failures = 0;
		while (!signal.aborted) {
			let delay = 1500;
			try {
				await bridge.flush();
				failures = 0;
			} catch (err) {
				if (signal.aborted) return;
				const f = publicFailure(err);
				if (!f.retry || ++failures >= attempts) {
					io.log(
						`${f.message} Slack delivery paused; pending replies are retained. Restart after correcting the problem.`,
					);
					return;
				}
				delay = pause(f.retryAfter, failures - 1);
			}
			await io.sleep(delay, signal);
		}
	}
	const connection = listen().catch(() => {
		if (!opened) ready.reject(new SlackFailure("Slack Socket Mode startup failed.", false));
	});
	try {
		await ready.promise;
	} catch (err) {
		stop.abort();
		await connection;
		bridge.close();
		throw publicFailure(err);
	} finally {
		signal.removeEventListener("abort", abortOpening);
	}
	const delivery = deliver().catch(() => {
		if (!signal.aborted) io.log("Slack delivery stopped. Restart the service to retry.");
	});
	let closing: Promise<void> | undefined;
	function close() {
		closing ??= (async () => {
			context.signal?.removeEventListener("abort", onExternalStop);
			stop.abort();
			await Promise.all([connection, delivery]);
			bridge.close();
		})();
		return closing;
	}
	const onExternalStop = () => {
		void close();
	};
	context.signal?.addEventListener("abort", onExternalStop, { once: true });
	if (signal.aborted) onExternalStop();
	return { close };
}
