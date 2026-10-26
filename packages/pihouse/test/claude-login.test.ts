import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import registerClaudeLogin, {
	type ClaudeAuth,
	loginClaudeCode,
	PROVIDER_ID,
	RELOAD_COMMAND,
	registerBridgeProvider,
	reloadAfterLogin,
} from "../src/extensions/claude-login.ts";
import { pihousePaths } from "../src/paths.ts";
import { BRIDGE_SOURCE, ensureAgentDir } from "../src/setup.ts";

function setupHome(t: { after: (fn: () => void) => void }, withClaude: boolean) {
	const home = mkdtempSync(join(tmpdir(), "pihouse-login-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const bin = join(home, "bin");
	mkdirSync(bin);
	if (withClaude) writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
	const env = { HOME: home, PATH: bin, AGENT_LINK_HOME: join(home, ".al") };
	ensureAgentDir(pihousePaths(env, home));
	return { home, env };
}

/** The bridge already installed: its folder and its settings entry, as pi install leaves them. */
function bridgeInstalled(home: string, env: NodeJS.ProcessEnv): void {
	const paths = pihousePaths(env, home);
	mkdirSync(join(paths.agentDir, "npm", "node_modules", "pi-claude-bridge"), { recursive: true });
	const file = join(paths.agentDir, "settings.json");
	const s = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...s, packages: [...s.packages, BRIDGE_SOURCE] }));
}

const signedIn: ClaudeAuth = { status: () => ({ email: "me@x.com", plan: "pro" }), signIn: async () => true };

test("Claude sub in /login: without claude on PATH it says so and installs nothing", async (t) => {
	const { env } = setupHome(t, false);
	const runs: string[][] = [];
	await assert.rejects(
		loginClaudeCode(
			{},
			{
				env,
				run: (argv) => {
					runs.push(argv);
					return 0;
				},
			},
		),
		/Claude Code .* is not on PATH/,
	);
	assert.equal(runs.length, 0);
});

test("Claude sub in /login installs the bridge, never makes it the default, and returns a credential", async (t) => {
	const { home, env } = setupHome(t, true);
	const paths = pihousePaths(env, home);
	const settingsFile = join(paths.agentDir, "settings.json");
	const progress: string[] = [];
	const credential = await loginClaudeCode(
		{ onProgress: (m) => progress.push(m) },
		{
			env,
			auth: signedIn,
			// What the real pi install leaves behind: the package folder and the settings entry.
			run: (argv) => {
				assert.deepEqual(argv.slice(2), ["install", BRIDGE_SOURCE]);
				mkdirSync(join(paths.agentDir, "npm", "node_modules", "pi-claude-bridge"), { recursive: true });
				const s = JSON.parse(readFileSync(settingsFile, "utf8"));
				writeFileSync(settingsFile, JSON.stringify({ ...s, packages: [...s.packages, BRIDGE_SOURCE] }));
				return 0;
			},
		},
	);
	assert.equal(credential.access, "claude-code");
	assert.ok(credential.expires > Date.now());
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	assert.deepEqual(settings.packages, [BRIDGE_SOURCE]);
	assert.equal(settings.defaultProvider, undefined, "available, not the default");
	assert.match(progress.join("\n"), /reload/i);
});

test("Claude sub in /login reports a failed install", async (t) => {
	const { env } = setupHome(t, true);
	await assert.rejects(
		loginClaudeCode({}, { env, auth: signedIn, run: () => 1 }),
		/could not install the Claude bridge/i,
	);
});

test("Claude sub in /login opens the browser sign-in when Claude Code is not signed in", async (t) => {
	const { home, env } = setupHome(t, true);
	bridgeInstalled(home, env);
	let account: { email: string } | undefined;
	let signIns = 0;
	const auth: ClaudeAuth = {
		status: () => account,
		signIn: async () => {
			signIns++;
			account = { email: "me@x.com" };
			return true;
		},
	};
	const progress: string[] = [];
	const credential = await loginClaudeCode({ onProgress: (m) => progress.push(m) }, { env, auth });
	assert.equal(signIns, 1, "not signed in: the browser sign-in runs once");
	assert.equal(credential.email, "me@x.com");
	assert.match(progress.join("\n"), /Opening the browser/);
});

test("Claude sub in /login lets a signed-in user keep the account or sign in again", async (t) => {
	const { home, env } = setupHome(t, true);
	bridgeInstalled(home, env);
	let signIns = 0;
	const auth: ClaudeAuth = {
		status: () => ({ email: "me@x.com", plan: "pro" }),
		signIn: async () => {
			signIns++;
			return true;
		},
	};
	const pick = (id: string) => async () => id;
	await loginClaudeCode({ onSelect: pick("keep") }, { env, auth });
	assert.equal(signIns, 0, "keep: no browser");
	await loginClaudeCode({ onSelect: pick("again") }, { env, auth });
	assert.equal(signIns, 1, "again: the browser opens");
	await assert.rejects(loginClaudeCode({ onSelect: async () => undefined }, { env, auth }), /cancelled/i);
});

test("Claude sub has no placeholder apiKey, so /login does not list it as configured before the login", () => {
	const registered: Array<{ id: string; config: Record<string, unknown> }> = [];
	registerClaudeLogin({
		registerProvider: (id: string, config: Record<string, unknown>) => registered.push({ id, config }),
		registerCommand: () => {},
	} as never);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]?.id, PROVIDER_ID);
	assert.equal(registered[0]?.config.apiKey, undefined);
	assert.equal((registered[0]?.config.oauth as { name: string } | undefined)?.name, "Claude sub");
});

test("the login registers the bridge's provider itself, so its models are there without /reload", () => {
	const registered: Array<{ id: string; config: unknown }> = [];
	const calls: string[] = [];
	const pi = {
		registerProvider: (id: string, config: unknown) => registered.push({ id, config }),
		on: () => calls.push("on"),
	};
	const config = { apiKey: "not-used", models: [{ id: "m" }] };
	const ok = registerBridgeProvider(pi as never, (p) => {
		p.on("session_start" as never, (() => {}) as never);
		p.registerProvider("claude-bridge", config as never);
	});
	assert.equal(ok, true);
	assert.deepEqual(registered, [{ id: "claude-bridge", config }], "only the provider is taken");
	assert.deepEqual(calls, [], "its events are not registered late");
	assert.equal(
		registerBridgeProvider(pi as never, () => {}),
		false,
		"a bridge without a provider is not activated",
	);
});

test("Claude sub activates the bridge after the sign-in, and only asks for /reload when that was not possible", async (t) => {
	const { home, env } = setupHome(t, true);
	bridgeInstalled(home, env);
	const progress: string[] = [];
	await loginClaudeCode({ onProgress: (m) => progress.push(m) }, { env, auth: signedIn, activate: async () => true });
	assert.doesNotMatch(progress.join("\n"), /reload/);
	await loginClaudeCode({ onProgress: (m) => progress.push(m) }, { env, auth: signedIn, activate: async () => false });
	assert.match(progress.join("\n"), /reload/);
});

test("after the login pi reloads by itself: a command of ours reloads, and pi.sendUserMessage runs it", async () => {
	const commands: Record<string, { handler: (a: string, ctx: { reload(): Promise<void> }) => Promise<void> }> = {};
	const sent: Array<{ text: string; options: unknown }> = [];
	const pi = {
		registerProvider: () => {},
		registerCommand: (name: string, c: (typeof commands)[string]) => {
			commands[name] = c;
		},
		// Like pi's own: it returns nothing.
		sendUserMessage: (text: string, options: unknown) => {
			sent.push({ text, options });
		},
	};
	await registerClaudeLogin(pi as never);
	let reloads = 0;
	await commands[RELOAD_COMMAND]?.handler("", {
		reload: async () => {
			reloads++;
		},
	});
	assert.equal(reloads, 1, "the command reloads");
	reloadAfterLogin(pi as never, 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(sent, [{ text: `/${RELOAD_COMMAND}`, options: { expandPromptTemplates: true } }]);
});
