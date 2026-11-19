// This trusted bootstrap runs inside the native sandbox. A consumed stdin pipe keeps
// model credentials out of task files, the OS argument list and the tool environment.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

const [agent, cli] = process.argv.slice(2);
const input: { credential: string; prompt: string } = JSON.parse(readFileSync(0, "utf8"));
if (agent === "pi") {
	const sdk: typeof import("@earendil-works/pi-coding-agent") = createRequire(import.meta.url)(
		join(dirname(cli), "index.js"),
	);
	const provider = "openai-codex";
	const claims: { exp?: number } = JSON.parse(
		Buffer.from(input.credential.split(".")[1] ?? "", "base64url").toString("utf8"),
	);
	if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("Expired subscription token");
	const credential = { type: "oauth" as const, access: input.credential, refresh: "", expires: claims.exp * 1000 };
	const modelRuntime = await sdk.ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		credentials: {
			read: async (id) => (id === provider ? credential : undefined),
			list: async () => [{ providerId: provider, type: "oauth" }],
			modify: async () => {
				throw new Error("Reauthenticate outside the task");
			},
			delete: async () => {
				throw new Error("Read-only task credential");
			},
		},
	});
	const model = modelRuntime.getModel(provider, "gpt-6-luna");
	if (!model) throw new Error("Subscription model unavailable");
	const cwd = process.cwd(),
		agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("Missing private pi directory");
	const settingsManager = sdk.SettingsManager.inMemory({ transport: "sse", retry: { enabled: false } });
	settingsManager.setProjectTrusted(false);
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		disabledBuiltinExtensions: ["mcp"],
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		resourceLoader,
		settingsManager,
		sessionManager: sdk.SessionManager.inMemory(cwd),
		tools: ["read", "edit", "write", "bash"],
	});
	try {
		await session.prompt(input.prompt);
		const last = session.messages.at(-1);
		const answer = session.getLastAssistantText();
		if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted" || !answer) {
			const detail = last?.role === "assistant" ? (last.errorMessage ?? "") : "";
			if (/model.*(unsupported|available|supported|exist)|model_not_found/i.test(detail)) process.exitCode = 21;
			else if (/quota|usage.limit|too many requests|rate.limit|429/i.test(detail)) process.exitCode = 22;
			else if (/authenticat|unauthoriz|expired|401|invalid.token/i.test(detail)) process.exitCode = 23;
			else if (/network|fetch failed|timed out|proxy|socket/i.test(detail)) process.exitCode = 24;
			else process.exitCode = 25;
		} else process.stdout.write(`${answer}\n`);
	} finally {
		session.dispose();
	}
} else if (agent === "claude") {
	// Only built-in workspace file tools are enabled. No customizations or command tools
	// can inherit authentication even on a future version that changes fd handling.
	const child = spawn(
		cli,
		[
			"--restricted",
			"--safe-mode",
			"--strict-mcp-config",
			"--tools",
			"Read,Edit,Write,Glob,Grep",
			"--permission-mode",
			"acceptEdits",
			"--no-session-persistence",
			"--print",
			"--output-format",
			"text",
		],
		{
			env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
			stdio: ["pipe", "inherit", "inherit", "pipe"],
		},
	);
	const auth = child.stdio[3];
	if (!(auth instanceof Writable) || !child.stdin) throw new Error("Credential pipe unavailable");
	auth.on("error", () => {});
	auth.end(input.credential);
	child.stdin.on("error", () => {});
	child.stdin.end(input.prompt);
	child.once("error", () => {
		process.exitCode = 1;
	});
	child.once("exit", (code) => {
		process.exitCode = code ?? 1;
	});
} else {
	throw new Error("Unknown fleet harness");
}
