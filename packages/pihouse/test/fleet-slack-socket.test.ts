import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { createSlackBridge } from "../src/fleet-slack.ts";
import { type SlackConfig, startSlackSocket, validateSlackConfig } from "../src/fleet-slack-socket.ts";

const bot = "U123BOT",
	team = "T123",
	channel = "C123",
	thread = "1234.000001";
const ticket = "wss://wss-primary.slack.com/link/?ticket=private-example";
const auth = { ok: true, user_id: bot, team_id: team, bot_id: "B123" };
const jobs = {
	list: () => [],
	get: () => undefined,
	submitExternalTurn: (): never => {
		throw new Error("Test expected an injected bridge.");
	},
};
class Socket extends EventTarget {
	sent: string[] = [];
	closed = false;
	send(text: string) {
		this.sent.push(text);
	}
	close() {
		this.closed = true;
	}
	packet(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}
type IO = NonNullable<Parameters<typeof startSlackSocket>[3]>;
function fixture(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-slack-socket-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config: SlackConfig = {
		team,
		owner: "U123OWNER",
		channels: [channel],
		project: "demo",
		tokensFile: join(dir, "tokens.json"),
	};
	writeFileSync(config.tokensFile, JSON.stringify({ appToken: "xapp-private-test", botToken: "xoxb-private-test" }), {
		mode: 0o600,
	});
	const context = { host: "Mini", origin: "https://mini.example.test", stateDir: dir };
	return { dir, config, context };
}
const reply = (data: unknown, status = 200, headers?: HeadersInit) =>
	new Response(JSON.stringify(data), { status, headers });
const packet = (envelope_id: string, workspace = team, user = bot) => ({
	envelope_id,
	type: "events_api",
	payload: {
		type: "event_callback",
		team_id: workspace,
		event_id: "Ev123",
		authorizations: [{ is_bot: true, user_id: user }],
		event: { type: "message", text: "hi" },
	},
});

test("accepts on the verified bot connection before ACK, and posts one literal reply to its own thread", async (t) => {
	const { config, context } = fixture(t);
	const s = new Socket(),
		receipts: string[] = [],
		calls: { url: string; token: string | null; body: Record<string, unknown> }[] = [];
	let post: Parameters<typeof createSlackBridge>[2] | undefined,
		closeCount = 0;
	const wire = await startSlackSocket(config, context, jobs, {
		fetch: async (url, opts) => {
			assert.equal(opts?.redirect, "error");
			calls.push({
				url: String(url),
				token: new Headers(opts?.headers).get("Authorization"),
				body: JSON.parse(String(opts?.body)),
			});
			return reply(
				String(url).endsWith("auth.test")
					? auth
					: String(url).endsWith("apps.connections.open")
						? { ok: true, url: ticket }
						: { ok: true },
			);
		},
		connect: (url) => {
			assert.equal(url, ticket);
			queueMicrotask(() => s.packet({ type: "hello" }));
			return s;
		},
		bridge: (_cfg, _jobs, send) => {
			post = send;
			return {
				accept: (eventId, workspace, event) => {
					assert.equal(workspace, team);
					assert.ok(event);
					assert.equal(s.sent.length, 0);
					receipts.push(eventId);
					return true;
				},
				flush: async () => {},
				close: () => {
					closeCount++;
				},
			};
		},
	});
	try {
		s.packet(packet("first"));
		s.packet(packet("other-team", "TOTHER"));
		s.packet(packet("other-bot", team, "UOTHER"));
		s.packet({ type: "interactive", envelope_id: "ignored" });
		assert.deepEqual(receipts, ["Ev123"]);
		assert.deepEqual(
			s.sent.map((s) => JSON.parse(s).envelope_id),
			["first", "other-team", "other-bot", "ignored"],
		);
		assert.ok(post);
		const text = "line <@UOTHER> <!channel> & `a * b`",
			delivery = "a4b9de59-f7b4-49b6-9763-f086bfce4562";
		await post(channel, thread, text, delivery);
		assert.deepEqual(
			calls.map((x) => x.token),
			["Bearer xoxb-private-test", "Bearer xapp-private-test", "Bearer xoxb-private-test"],
		);
		assert.deepEqual(calls.at(-1)?.body, {
			channel,
			thread_ts: thread,
			text: "line &lt;@UOTHER&gt; &lt;!channel&gt; &amp; `a * b`",
			mrkdwn: false,
			link_names: false,
			parse: "none",
			unfurl_links: false,
			unfurl_media: false,
			blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false } }],
			client_msg_id: delivery,
		});
		await post(channel, thread, `Chat opened. ${context.origin}/#chat=${delivery}`, delivery);
		assert.match(JSON.stringify(calls.at(-1)?.body.blocks), /Open in pi-house/);
		await post(channel, thread, `Private result ready. https://example.invalid/#chat=${delivery}`, delivery);
		assert.doesNotMatch(JSON.stringify(calls.at(-1)?.body.blocks), /accessory/);
		await assert.rejects(post("COTHER", thread, text, delivery), /Invalid Slack thread/);
	} finally {
		await wire.close();
		await wire.close();
	}
	assert.ok(s.closed);
	assert.equal(closeCount, 1);
});
test("refuses unsafe credentials, mismatched workspaces and external socket URLs without logging secrets", async (t) => {
	const { config, context, dir } = fixture(t);
	assert.throws(() => validateSlackConfig({ ...config, botToken: "xoxb-do-not-log" }), /Invalid Slack/);
	assert.deepEqual(validateSlackConfig({ ...config, channels: [] }).channels, []);
	const noNet: IO["fetch"] = async () => {
		assert.fail("No network call expected");
	};
	chmodSync(config.tokensFile, 0o644);
	await assert.rejects(startSlackSocket(config, context, jobs, { fetch: noNet }), /owner-only/);
	chmodSync(config.tokensFile, 0o600);
	const link = join(dir, "link");
	symlinkSync(config.tokensFile, link);
	await assert.rejects(
		startSlackSocket({ ...config, tokensFile: link }, context, jobs, { fetch: noNet }),
		/owner-only/,
	);
	await assert.rejects(
		startSlackSocket(config, context, jobs, { fetch: async () => reply({ ...auth, team_id: "TWRONG" }) }),
		/configured workspace/,
	);
	for (const url of [
		"ws://wss.slack.com/link/?ticket=SECRET",
		"wss://wss.slack.com.example.org/link/?ticket=SECRET",
		"wss://user@wss.slack.com/link/?ticket=SECRET",
		"wss://wss.slack.com/link/",
	]) {
		await assert.rejects(
			startSlackSocket(config, context, jobs, {
				fetch: async (u) => reply(String(u).endsWith("auth.test") ? auth : { ok: true, url }),
				connect: () => {
					throw new Error("Socket must not be opened");
				},
			}),
			{ message: "Slack returned an invalid Socket Mode URL." },
		);
	}
});
test("honors Retry-After, reconnects after uncommitted input, and redelivers before acknowledging", async (t) => {
	const { config, context } = fixture(t);
	const sockets: Socket[] = [],
		pauses: number[] = [];
	let openCount = 0,
		failed = false;
	const wire = await startSlackSocket(config, context, jobs, {
		fetch: async (url) => {
			if (String(url).endsWith("auth.test")) return reply(auth);
			if (++openCount === 1) return reply({}, 429, { "Retry-After": "8" });
			return reply({ ok: true, url: ticket });
		},
		sleep: async (ms, signal) => {
			if (ms === 1500) await wait(60000, undefined, { signal });
			else pauses.push(ms);
		},
		connect: () => {
			const s = new Socket();
			sockets.push(s);
			queueMicrotask(() => s.packet({ type: "hello" }));
			return s;
		},
		bridge: () => ({
			accept: () => {
				if (!failed) {
					failed = true;
					throw new Error("synthetic disk failure");
				}
				return true;
			},
			flush: async () => {},
			close: () => {},
		}),
	});
	try {
		sockets[0].packet(packet("redeliver"));
		await wait(0);
		assert.ok(sockets[0].closed);
		assert.deepEqual(sockets[0].sent, []);
		assert.equal(sockets.length, 2);
		sockets[1].packet(packet("redeliver"));
		assert.deepEqual(sockets[1].sent, [JSON.stringify({ envelope_id: "redeliver" })]);
		assert.equal(pauses[0], 8000);
	} finally {
		await wire.close();
	}
});
test("stops after a bounded number of transient startup failures with a sanitized error", async (t) => {
	const { config, context } = fixture(t);
	let count = 0;
	await assert.rejects(
		startSlackSocket(config, context, jobs, {
			fetch: async () => {
				count++;
				throw new Error("xoxb-private-test SECRET");
			},
			sleep: async () => {},
		}),
		{ message: "Slack auth.test connection failed." },
	);
	assert.equal(count, 6);
});

test("a host shutdown while waiting for hello closes the socket and bridge", async (t) => {
	const { config, context } = fixture(t);
	const starting = Promise.withResolvers<void>(),
		abort = new AbortController(),
		s = new Socket();
	let closed = 0;
	const startingTransport = startSlackSocket(config, { ...context, signal: abort.signal }, jobs, {
		fetch: async (url) => reply(String(url).endsWith("auth.test") ? auth : { ok: true, url: ticket }),
		connect: () => {
			starting.resolve();
			return s;
		},
		bridge: () => ({
			accept: () => false,
			flush: async () => {},
			close: () => {
				closed++;
			},
		}),
	});
	await starting.promise;
	abort.abort();
	await assert.rejects(startingTransport, /startup stopped/);
	assert.ok(s.closed);
	assert.equal(closed, 1);
});
