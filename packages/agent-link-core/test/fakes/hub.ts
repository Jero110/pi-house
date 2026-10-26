// A hub on a temp home with fake adapters and a fake cmux backend, and a client for it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubClient, type HubClient } from "../../src/client.ts";
import { type RunningHub, type StartHubOptions, startHub } from "../../src/hub/server.ts";
import { loadProfiles } from "../../src/profiles.ts";
import type { Profile } from "../../src/types.ts";
import { type FakeKit, fakeAdapters, type Responder } from "./adapter.ts";
import { FakeBackend } from "./backend.ts";

export interface TestHub {
	home: string;
	running: RunningHub;
	client: HubClient;
	kit: FakeKit;
	backend: FakeBackend;
	/** Stops the hub; `keepHome` leaves the folder for a restart. */
	stop(opts?: { keepHome?: boolean }): Promise<void>;
}

/** Profiles with every adapter set to "fake", so one fake factory serves every harness. */
export function fakeProfiles(extra: Profile[] = []): Map<string, Profile> {
	const profiles = new Map<string, Profile>();
	for (const p of [...loadProfiles().values(), ...extra]) profiles.set(p.harness, { ...p, adapter: "fake" });
	return profiles;
}

export function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "xl-test-"));
}

export async function testHub(
	opts: { respond?: Responder; home?: string; profiles?: Map<string, Profile> } & Partial<StartHubOptions> = {},
): Promise<TestHub> {
	const home = opts.home ?? tempHome();
	const kit = fakeAdapters(opts.respond);
	const backend = new FakeBackend("cmux");
	const running = await startHub({
		adapters: { fake: kit.factory },
		backends: { cmux: backend },
		profiles: opts.profiles ?? fakeProfiles(),
		startup: { pollMs: 5, timeoutMs: 100 },
		idlePollMs: 10,
		pidPollMs: 20,
		...opts,
		home,
	});
	const client = createHubClient({ socket: running.socket, token: running.token });
	return {
		home,
		running,
		client,
		kit,
		backend,
		async stop({ keepHome = false } = {}) {
			await running.close();
			if (!keepHome) rmSync(home, { recursive: true, force: true });
		},
	};
}

/** Waits until cond() is true, or fails with `what` after timeoutMs. */
export async function waitFor<T>(cond: () => T | undefined | false, what: string, timeoutMs = 2000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = cond();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Registers a pull root, the way an MCP server with no identity does. */
export async function pullRoot(client: HubClient, harness = "codex"): Promise<string> {
	const res = await client.register({ harness, cwd: tmpdir(), pull: true });
	if ("error" in res) throw new Error(res.error);
	return res.name;
}

/** Spawns a worker and waits until its brief turn runs; returns its name. */
export async function spawned(t: TestHub, from: string, harness = "claude", name?: string): Promise<string> {
	const res = await t.client.spawn({ from, harness, task: `task of ${name ?? harness}`, name, backend: "cmux" });
	if ("error" in res) throw new Error(res.error);
	return res.name;
}
