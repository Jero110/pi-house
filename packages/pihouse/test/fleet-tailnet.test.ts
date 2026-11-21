import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { allowPeer, tailAddress } from "../src/fleet-tailnet.ts";

test("identity comes from the remote TLS socket and WhoIs, independent of caller-supplied identity headers", async () => {
	const req = {
		socket: { remoteAddress: "100.100.2.3", remotePort: 19123 },
		headers: { "tailscale-user-login": "owner@example.org" },
	} as unknown as IncomingMessage;
	const identity =
		(login: string, tags: string[] = []) =>
		async (addr: string) => {
			assert.equal(addr, "100.100.2.3:19123");
			return JSON.stringify({ Node: { Tags: tags }, UserProfile: { LoginName: login } });
		};
	assert.equal(await allowPeer("owner@example.org", identity("owner@example.org"))(req), true);
	assert.equal(await allowPeer("owner@example.org", identity("other@example.org"))(req), false);
	assert.equal(await allowPeer("owner@example.org", identity("owner@example.org", ["tag:server"]))(req), false);
	assert.equal(
		await allowPeer("owner@example.org", async () => {
			throw new Error("daemon offline");
		})(req),
		false,
	);
	for (const addr of ["127.0.0.1", "0.0.0.0", "192.168.1.1", "100.128.1.2", "::1", "100.64.256.1"])
		assert.equal(tailAddress(addr), false);
	assert.equal(tailAddress("fd7a:115c:a1e0::5"), true);
});
