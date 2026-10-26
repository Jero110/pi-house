// "Claude sub" in /login: the Claude bridge, for Claude subscriptions, as one more way to connect next to pi's own Anthropic login.
//
// Problem: the bridge was either installed for everyone (and became what /model and /login led to) or not
// reachable at all. Solution: it stays out until the user picks "Claude sub" in /login; that installs
// the bridge into pihouse's agent dir, and /reload then loads its Claude models. Pi's native Anthropic login is untouched.
//
// Problem: picking it only checked the files, so the user never got to sign in. Solution: the sign-in is Claude
// Code's own: when `claude` is not logged in (or the user asks to sign in again) it opens the browser with
// `claude auth login --claudeai` and waits for it.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pihousePaths } from "../paths.ts";
import { BRIDGE_PACKAGE, ensureBridge, type Run } from "../setup.ts";

export const PROVIDER_ID = "claude-code-login";
/** The bridge has no token of its own; this marks the login as done. */
const MARKER = "claude-code";
const A_YEAR = 365 * 24 * 60 * 60 * 1000;

/** pi install prints npm's progress; inside the TUI that would tear the screen, so its output is collected instead. */
const runQuiet: Run = (argv, env) => spawnSync(argv[0] ?? "", argv.slice(1), { env, stdio: "pipe" }).status ?? 1;

/** Who Claude Code is logged in as, when it is. */
export interface ClaudeAccount {
	email?: string;
	plan?: string;
}

/** What the login needs from Claude Code: who is signed in, and a browser sign-in. */
export interface ClaudeAuth {
	status(env: NodeJS.ProcessEnv): ClaudeAccount | undefined;
	/** Opens the browser and resolves when the sign-in ends; false when it did not succeed. */
	signIn(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean>;
}

export const claudeAuth: ClaudeAuth = {
	status(env) {
		const r = spawnSync("claude", ["auth", "status", "--json"], { env, stdio: "pipe", encoding: "utf8" });
		if (r.status !== 0) return undefined;
		try {
			const s = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
			return s.loggedIn ? { email: s.email, plan: s.subscriptionType } : undefined;
		} catch {
			return undefined;
		}
	},
	signIn(env, signal) {
		return new Promise((resolve) => {
			// `claude auth login` opens the browser itself; its output is dropped so it cannot tear the TUI.
			const child = spawn("claude", ["auth", "login", "--claudeai"], { env, stdio: "ignore", signal });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
	},
};

export interface LoginCallbacks {
	onProgress?(message: string): void;
	onSelect?(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface LoginDeps {
	env?: NodeJS.ProcessEnv;
	run?: Run;
	auth?: ClaudeAuth;
	/** Makes the bridge's models available now; false when that could not be done here (then /reload does it). */
	activate?: () => Promise<boolean>;
}

const describe = (a: ClaudeAccount) => [a.email, a.plan && `Claude ${a.plan}`].filter(Boolean).join(" · ");

/** Installs the bridge when it is missing and signs in to Claude Code; throws a readable reason when it cannot. */
export async function loginClaudeCode(callbacks: LoginCallbacks, deps: LoginDeps = {}) {
	const env = deps.env ?? process.env;
	const auth = deps.auth ?? claudeAuth;
	const lines: string[] = [];
	callbacks.onProgress?.("Checking Claude Code and the Claude bridge");
	const result = ensureBridge(pihousePaths(env), env, (l) => lines.push(l), deps.run ?? runQuiet);
	if (result === "skipped") {
		throw new Error("Claude Code (`claude`) is not on PATH. Install it, then pick Claude sub again.");
	}
	if (result === "failed") throw new Error(lines.join(" ") || "Could not install the Claude bridge.");

	let account = auth.status(env);
	let signIn = account === undefined;
	if (account && callbacks.onSelect) {
		const choice = await callbacks.onSelect({
			message: `Claude Code is signed in as ${describe(account)}`,
			options: [
				{ id: "keep", label: "Use this account" },
				{ id: "again", label: "Sign in again in the browser" },
			],
		});
		if (choice === undefined) throw new Error("Login cancelled.");
		signIn = choice === "again";
	}
	if (signIn) {
		callbacks.onProgress?.("Opening the browser to sign in to Claude. Finish there, then come back.");
		if (!(await auth.signIn(env, callbacks.signal))) throw new Error("The Claude sign-in did not finish. Try again.");
		account = auth.status(env);
		if (!account) throw new Error("Claude Code is still not signed in. Try again.");
	}
	if (!(await deps.activate?.())) callbacks.onProgress?.("Claude sub ready: reloading, then pick a model in /model");
	return { refresh: "", access: MARKER, expires: Date.now() + A_YEAR, email: account?.email };
}

// No `apiKey` here, on purpose.
// Problem: a placeholder apiKey made pi list "Claude sub" as "API key configured" before anyone logged in.
// Solution: the provider has only its OAuth login, so it reads as not configured until the login is done.
/**
 * Runs the bridge's factory only to take its provider (models and stream) and registers that provider on `pi`.
 * Problem: the bridge's models appeared only after /reload, so right after the login /model had nothing to pick
 * and a message failed with "No API key found for the selected model". Solution: the login registers the
 * provider itself. The bridge's tools and events are left to /reload and the next start, when pi loads it whole.
 */
export function registerBridgeProvider(pi: ExtensionAPI, factory: (pi: ExtensionAPI) => void): boolean {
	let found: { id: string; config: unknown } | undefined;
	const recorder = new Proxy({} as ExtensionAPI, {
		get: (_target, prop) =>
			prop === "registerProvider"
				? (id: string, config: unknown) => {
						found = { id, config };
					}
				: () => undefined,
	});
	factory(recorder);
	if (!found) return false;
	pi.registerProvider(found.id, found.config as never);
	return true;
}

/** The bridge's factory, loaded from its files in pihouse's agent dir. */
async function loadBridge(env: NodeJS.ProcessEnv): Promise<(pi: ExtensionAPI) => void> {
	const file = join(pihousePaths(env).agentDir, "npm", "node_modules", BRIDGE_PACKAGE, "src", "index.ts");
	return ((await import(file)) as { default: (pi: ExtensionAPI) => void }).default;
}

/** The command the login runs to reload pi: only a command's context can reload. */
export const RELOAD_COMMAND = "claude-sub-reload";

/**
 * Reloads pi a moment after the login, so the bridge loads whole (tools and events too) with no /reload typed.
 * Problem: pi gives an extension no way to reload, and the login had to ask the user to type /reload. Example: pi's
 * own message after the login said to use /model, which had nothing to pick yet. Solution: a command of ours does
 * `ctx.reload()`, and pi.sendUserMessage runs it when `expandPromptTemplates` is true. The wait lets pi save the
 * credential and print its message first, as a reload during the login would drop it.
 */
export function reloadAfterLogin(pi: ExtensionAPI, delayMs = 1500): void {
	setTimeout(() => {
		// pi's own sendUserMessage returns nothing, so there is no promise to catch; a failure only skips the reload.
		try {
			pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
		} catch {}
	}, delayMs);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(RELOAD_COMMAND, {
		description: "Reload pi (run by the Claude sub login)",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
	const activate = async (): Promise<boolean> => {
		try {
			return registerBridgeProvider(pi, await loadBridge(process.env));
		} catch {
			return false;
		}
	};
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-login",
		api: "anthropic-messages",
		models: [],
		oauth: {
			name: "Claude sub",
			login: async (callbacks) => {
				const credential = await loginClaudeCode(callbacks, { activate });
				reloadAfterLogin(pi);
				return credential;
			},
			refreshToken: async (credentials) => ({ ...credentials, expires: Date.now() + A_YEAR }),
			getApiKey: (credentials) => credentials.access,
		},
	});
}
