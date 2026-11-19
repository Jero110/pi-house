import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { fleetHandler, issuePairCode } from "../src/fleet-web.ts";

test("only the paired browser on the configured HTTPS tailnet identity can reach chat routes", async (t) => {
	const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pih-web-")));
	const origin = "https://mini.tail-example.ts.net";
	const login = "owner@example.org";
	const config = { host: "Mini", origin, login, stateDir, projects: { demo: "/unused" }, peers: [] };
	const archived: FleetJob = {
		id: "1a166b70-31b3-4780-9a21-bdfc24d708ce",
		project: "demo",
		agent: "codex",
		status: "completed",
		title: "Canary",
		updatedAt: 1,
		messages: [],
	};
	const unsupported = (): never => {
		throw Error("unexpected request");
	};
	const jobs = {
		list: () => [],
		get: () => undefined,
		artifact: unsupported,
		create: unsupported,
		reply: unsupported,
		memorySource: () => ({ list: () => [archived], get: (id: string) => (id === archived.id ? archived : undefined) }),
		memoryProfile: () => "balanced" as const,
		memoryFacts: () => [],
		memoryRelations: () => [],
	};
	const server = createServer(
		fleetHandler(
			config,
			() => jobs,
			async (req) => req.headers["x-test-peer"] === login,
		),
	);
	const socketPath = join(stateDir, "web.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(stateDir, { recursive: true, force: true });
	});
	const headers = { host: new URL(origin).host, "x-test-peer": login };
	function send(path: string, extra: Record<string, string> = {}, body?: string) {
		return new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
			const req = request(
				{ socketPath, path, method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra } },
				(res) => {
					let text = "";
					res
						.setEncoding("utf8")
						.on("data", (s) => {
							text += s;
						})
						.on("end", () =>
							resolve({ status: res.statusCode ?? 0, cookie: res.headers["set-cookie"]?.[0] ?? "", body: text }),
						);
				},
			);
			req.on("error", reject).end(body);
		});
	}
	assert.equal((await send("/", { "x-test-peer": "else@example.org" })).status, 403);
	assert.equal((await send("/", { "x-test-peer": "", "tailscale-user-login": login })).status, 403);
	assert.equal((await send("/", { "x-test-peer": "tagged" })).status, 403);
	assert.equal((await send("/", { host: "elsewhere.invalid" })).status, 403);
	assert.equal((await send("/api/config")).status, 401);
	assert.equal((await send("/api/graph?project=demo")).status, 401);
	const pair = new URLSearchParams({ code: issuePairCode(stateDir) }).toString();
	const form = { origin, "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await send("/pair", { ...form, origin: "https://elsewhere.invalid" }, pair)).status, 403);
	const paired = await send("/pair", form, pair);
	assert.equal(paired.status, 303);
	assert.match(paired.cookie, /HttpOnly/);
	assert.match(paired.cookie, /Secure/);
	assert.match(paired.cookie, /SameSite=Strict/);
	assert.equal((await send("/pair", form, pair)).status, 403);
	const cookie = paired.cookie.split(";")[0];
	assert.equal((await send("/api/config", { cookie })).status, 200);
	assert.equal((await send("/api/memory?project=another&q=canary", { cookie })).status, 404);
	assert.equal(
		JSON.parse((await send("/api/memory?project=demo&q=canary", { cookie })).body).hits[0].chatId,
		archived.id,
	);
	assert.equal(JSON.parse((await send("/api/graph?project=demo", { cookie })).body).threads[0].id, archived.id);
	assert.equal(JSON.parse((await send(`/api/chats/${archived.id}`, { cookie })).body).archived, true);
	assert.equal((await send("/api/config", { cookie, "x-test-peer": "else@example.org" })).status, 403);
	assert.equal(
		(
			await send(
				"/api/chats",
				{ cookie, origin: "https://elsewhere.invalid", "content-type": "application/json" },
				"{}",
			)
		).status,
		403,
	);
});
