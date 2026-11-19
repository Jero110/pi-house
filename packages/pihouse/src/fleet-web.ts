import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { type createFleetJobs, FleetJobError } from "./fleet-jobs.ts";

import { type FleetPlanner, validatePlanner } from "./fleet-planner.ts";

type Jobs = ReturnType<typeof createFleetJobs>;
export interface FleetConfig {
	origin: string;
	login: string;
	host: string;
	stateDir: string;
	turnTimeoutMs?: number;
	planner?: FleetPlanner;
	projects: Record<string, string>;
	peers: { label: string; url: string }[];
}

function tailnetOrigin(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value && url.hostname.endsWith(".ts.net");
	} catch {
		return false;
	}
}

export function readFleetConfig(path: string): FleetConfig {
	const c = JSON.parse(readFileSync(path, "utf8"));
	if (
		!c ||
		typeof c.login !== "string" ||
		!/^[^\s@]+@[^\s@]+$/.test(c.login) ||
		!tailnetOrigin(c.origin) ||
		typeof c.host !== "string" ||
		!c.host.trim() ||
		typeof c.stateDir !== "string" ||
		!isAbsolute(c.stateDir) ||
		!c.projects ||
		typeof c.projects !== "object" ||
		Array.isArray(c.projects) ||
		!Object.keys(c.projects).length ||
		!Object.entries(c.projects).every(([k, v]) => /^[\w-]{1,64}$/.test(k) && typeof v === "string" && isAbsolute(v)) ||
		(c.planner !== undefined && !validatePlanner(c.planner)) ||
		!Array.isArray(c.peers) ||
		!c.peers.every(
			(v: { label?: unknown; url?: unknown } | null) => v && typeof v.label === "string" && tailnetOrigin(v.url),
		)
	) {
		throw new Error("Invalid fleet configuration. See docs/fleet.md.");
	}
	ensurePrivateDir(c.stateDir);
	return c;
}

function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (!st.isDirectory() || realpathSync(path) !== resolve(path) || st.uid !== process.getuid?.() || st.mode & 0o077) {
		throw new Error("Fleet state requires a private, owner-only directory at its canonical path.");
	}
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const codeFile = (dir: string) => join(dir, "web-pair.json");
export function issuePairCode(stateDir: string): string {
	ensurePrivateDir(stateDir);
	const code = randomBytes(24).toString("base64url");
	const temp = join(stateDir, `.pair-${randomBytes(12).toString("hex")}`);
	writeFileSync(temp, JSON.stringify({ hash: digest(code), expires: Date.now() + 300_000 }), {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temp, codeFile(stateDir));
	return code;
}

function consumeCode(dir: string, code: string): boolean {
	if (!/^[a-zA-Z0-9_-]{32}$/.test(code)) return false;
	try {
		const path = codeFile(dir);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		if (!(saved.expires > Date.now()) || !timingSafeEqual(Buffer.from(saved.hash), Buffer.from(digest(code))))
			return false;
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

const pairingPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair browser · pi-house</title><link rel="stylesheet" href="/pair.css"><script defer src="/pair.js"></script><main><p>PI-HOUSE / DEVICE ACCESS</p><h1>Pair this browser</h1><div>Your Tailscale account is verified. Enter the code from <code>pih fleet pair &lt;config.json&gt;</code> on this Mac. It expires after five minutes.</div><form method="post" action="/pair"><label for="code">Pairing code</label><input id="code" name="code" type="password" autocomplete="off" required maxlength="32" spellcheck="false"><button>Open workspace</button></form></main></html>`;
// A launcher code arrives in the fragment so it never reaches HTTP access logs. Consume it once.
const pairScript = `const code = new URLSearchParams(location.hash.slice(1)).get("pair");
if (code && /^[a-zA-Z0-9_-]{32}$/.test(code)) {
 history.replaceState(null, "", "/");
 document.getElementById("code").value = code;
 document.querySelector("form").requestSubmit();
}`;
const pairCss = `html{color-scheme:dark;background:#121513;color:#f4f3ec;font:16px system-ui}main{max-width:28rem;margin:16vh auto;padding:2rem}p{color:#a3c8a6;font:12px ui-monospace,monospace;letter-spacing:.1em}h1{font-size:2.4rem}div{line-height:1.65;color:#b6bcb5}form{display:grid;gap:.8rem;margin-top:2rem}input,button{font:inherit;padding:.9rem;border:1px solid #657267;border-radius:.45rem}button{cursor:pointer;background:#b7d9b1;color:#182218}`;
const assets = new Map([
	["/", ["index.html", "text/html"]],
	["/app.js", ["app.js", "text/javascript"]],
	["/style.css", ["style.css", "text/css"]],
]);
const agents = ["pi", "codex", "claude"] as const;

class WebError extends Error {
	readonly statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

async function body(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > 48_000) throw new WebError(413, "Message is too large");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, type: string, content: string | Buffer): void {
	res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` }).end(content);
}

export function fleetHandler(c: FleetConfig, jobs: () => Jobs, authorized: (req: IncomingMessage) => Promise<boolean>) {
	const sessions = new Map<string, number>();
	const host = new URL(c.origin).host;
	async function handle(req: IncomingMessage, res: ServerResponse) {
		// Authentication uses the actual TLS peer address; browser headers never assert identity.
		for (const [k, v] of Object.entries({
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "same-origin",
			"X-Frame-Options": "DENY",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Strict-Transport-Security": "max-age=31536000",
		}))
			res.setHeader(k, v);
		const h = req.headers;
		if (h.host !== host || !(await authorized(req))) throw new WebError(403, "Access denied");
		const method = req.method;
		const path = req.url ?? "";
		const get = method === "GET";
		if (!get && method !== "POST") throw new WebError(405, "Method not allowed");
		if (!get && (h.origin !== c.origin || (h["sec-fetch-site"] && h["sec-fetch-site"] !== "same-origin")))
			throw new WebError(403, "Origin denied");
		if (get && path === "/pair.js") return send(res, 200, "text/javascript", pairScript);
		if (get && path === "/pair.css") return send(res, 200, "text/css", pairCss);
		if (!get && path === "/pair") {
			if (h["content-type"] !== "application/x-www-form-urlencoded") throw new WebError(415, "Expected a form");
			if (!consumeCode(c.stateDir, new URLSearchParams(await body(req)).get("code") ?? ""))
				throw new WebError(403, "Invalid or expired pairing code. Generate a new code on the host.");
			const token = randomBytes(32).toString("base64url");
			for (const [k, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(k);
			if (sessions.size >= 32) sessions.delete(sessions.keys().next().value ?? "");
			sessions.set(digest(token), Date.now() + 8 * 3600_000);
			res
				.writeHead(303, {
					Location: "/",
					"Set-Cookie": `__Host-pih=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
				})
				.end();
			return;
		}
		const token = h.cookie?.match(/(?:^|; *)__Host-pih=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
		if (!token || (sessions.get(digest(token)) ?? 0) <= Date.now()) {
			if (get && path === "/") return send(res, 200, "text/html", pairingPage);
			throw new WebError(401, "Pair this browser on the host");
		}
		const asset = assets.get(path);
		if (get && asset)
			return send(res, 200, asset[1], readFileSync(new URL(`../fleet-ui/${asset[0]}`, import.meta.url)));
		const json = (status: number, value: unknown) => send(res, status, "application/json", JSON.stringify(value));
		if (get && path === "/api/config")
			return json(200, { host: c.host, projects: Object.keys(c.projects), agents, peers: c.peers });
		if (get && path === "/api/chats") return json(200, jobs().list());
		const attachment = path.match(/^\/api\/chats\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})(\?preview=1)?$/);
		if (get && attachment) {
			const file = jobs().artifact(attachment[1], attachment[2]);
			if (!file) throw new WebError(404, "Artifact not found");
			const preview = !!attachment[3];
			if (preview && file.type === "file") throw new WebError(415, "Download this file to open it");
			const mime = preview
				? file.type === "text"
					? "text/plain; charset=utf-8"
					: file.mime
				: "application/octet-stream";
			res
				.writeHead(200, {
					"Content-Type": mime,
					"Content-Length": file.bytes.length,
					"Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`,
					"Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
				})
				.end(file.bytes);
			return;
		}
		const match = path.match(/^\/api\/chats\/([a-f0-9-]{36})(\/messages)?$/);
		if (get && match && !match[2]) {
			const chat = jobs().get(match[1]);
			if (!chat) throw new WebError(404, "Chat not found");
			return json(200, chat);
		}
		if (!get && (path === "/api/chats" || match?.[2])) {
			if (h["x-pih-request"] !== "chat" || h["content-type"]?.split(";")[0] !== "application/json")
				throw new WebError(415, "Expected a same-origin chat request");
			let payload: { message?: unknown; project?: unknown; agent?: unknown } | null;
			try {
				payload = JSON.parse(await body(req));
			} catch (e) {
				if (e instanceof WebError) throw e;
				throw new WebError(400, "Invalid JSON");
			}
			if (!payload || typeof payload.message !== "string" || !payload.message.trim() || payload.message.length > 16000)
				throw new WebError(400, "Message must be between 1 and 16000 characters");
			if (match) return json(202, jobs().reply(match[1], payload.message));
			if (
				typeof payload.project !== "string" ||
				!Object.hasOwn(c.projects, payload.project) ||
				!agents.some((agent) => agent === payload.agent)
			)
				throw new WebError(400, "Unknown project or agent");
			return json(202, jobs().create(payload.project, payload.agent as (typeof agents)[number], payload.message));
		}
		throw new WebError(404, "Not found");
	}
	return (req: IncomingMessage, res: ServerResponse) => {
		handle(req, res).catch((e: unknown) => {
			const known = e instanceof WebError || e instanceof FleetJobError;
			send(
				res,
				known ? Number(e.statusCode) : 500,
				"application/json",
				JSON.stringify({ error: known ? e.message : "The host could not complete this request" }),
			);
		});
	};
}
