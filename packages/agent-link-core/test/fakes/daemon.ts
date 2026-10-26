// A daemon entry for ensureHub tests and dev/try-hub.ts: the real daemon with fake adapters that answer
// every message by themselves and fake cmux and tmux backends. Run with node; AGENT_LINK_HOME says where.
import { runDaemon } from "../../src/hub/daemon.ts";
import { echoResponder, fakeAdapters, type Responder } from "./adapter.ts";
import { FakeBackend } from "./backend.ts";
import { fakeProfiles } from "./hub.ts";

/** Answers after a short delay, so a run shows queueing and turns as a real harness would. */
const slowEcho: Responder = async (req, adapter) => {
	await new Promise((r) => setTimeout(r, 30));
	return echoResponder(req, adapter);
};

await runDaemon({
	adapters: { fake: fakeAdapters(slowEcho).factory },
	backends: { cmux: new FakeBackend("cmux"), tmux: new FakeBackend("tmux") },
	profiles: fakeProfiles(),
	startup: { pollMs: 5, timeoutMs: 50 },
	idlePollMs: 10,
	pidPollMs: 100,
});
