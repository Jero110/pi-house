import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelFleetProcessTree } from "./fleet-jobs.ts";
import { providerTunnel, seatbeltArgs } from "./fleet-seatbelt.ts";

type Agent = "pi" | "codex" | "claude";
const bootstrap = fileURLToPath(new URL("./fleet-sandbox-child.ts", import.meta.url));
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piCli = join(piRoot, "dist", "bundle", "cli.js");
const maxOutput = 256 * 1024;
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
class OperatorError extends Error {}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
function binary(name: "claude" | "codex", task: string): string {
	const dirs = [
		...(process.env.PATH ?? "").split(":"),
		join(homedir(), ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
	if (name === "codex") dirs.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS");
	for (const dir of dirs.filter(isAbsolute)) {
		try {
			const candidate = realpathSync(join(dir, name));
			if (within(candidate, task)) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new OperatorError(`Install the native ${name} CLI on this Mac.`);
}
function envFor(home: string, temp: string): NodeJS.ProcessEnv {
	return {
		HOME: home,
		TMPDIR: temp,
		PATH: systemPath,
		SHELL: "/bin/sh",
		LANG: "en_US.UTF-8",
		TERM: "dumb",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		NODE_DISABLE_COMPILE_CACHE: "1",
		OPENSSL_CONF: "/dev/null",
		NODE_USE_ENV_PROXY: "1",
	};
}

export function codexPermissions(task: string, scratch: string, reads: string[] = []): string[] {
	const fs = Object.fromEntries([
		[":minimal", "read"],
		...reads.map((path) => [path, "read"]),
		[task, "write"],
		[scratch, "write"],
	]);
	const table = (entries: Record<string, string>) =>
		`{${Object.entries(entries)
			.map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
			.join(",")}}`;
	return [
		"-c",
		'default_permissions="fleet"',
		"-c",
		`permissions.fleet.filesystem=${table(fs)}`,
		"-c",
		"permissions.fleet.network.enabled=false",
		"-c",
		"permissions.fleet.network.allow_local_binding=false",
		"-c",
		"permissions.fleet.network.allow_upstream_proxy=false",
		"-c",
		"permissions.fleet.network.dangerously_allow_all_unix_sockets=false",
	];
}
function capture(
	command: string,
	args: string[],
	home: string,
	temp: string,
	cwd: string,
	additional: NodeJS.ProcessEnv = {},
	timeout = 20000,
) {
	return spawnSync(command, args, {
		cwd,
		env: { ...envFor(home, temp), ...additional },
		encoding: "utf8",
		timeout,
		maxBuffer: maxOutput,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function checkedProfile(agent: Agent, create = false) {
	const dir = join(homedir(), ".pihouse", "fleet-profiles", agent);
	if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!existsSync(dir)) throw new OperatorError(`Sign in first with fleet-sandbox.ts login ${agent} on this Mac.`);
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || realpathSync(dir) !== dir || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
		throw new OperatorError("The dedicated profile must be a private owner-only directory.");
	return dir;
}
function interactive(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.status !== 0) throw new OperatorError("Subscription sign-in did not finish.");
}
async function login(agent: Agent, task: string) {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new OperatorError("Run login in a local interactive terminal.");
	if (agent === "codex") {
		interactive(binary("codex", task), ["login", "--device-auth", "-c", 'forced_login_method="chatgpt"'], homedir(), {
			...envFor(homedir(), tmpdir()),
			CODEX_HOME: join(homedir(), ".codex"),
		});
		return;
	}
	const profile = checkedProfile(agent, true);
	if (agent === "pi") {
		interactive(process.execPath, [piCli, "auth", "login", "openai-codex", "--no-browser"], profile, {
			...envFor(profile, tmpdir()),
			PI_CODING_AGENT_DIR: profile,
		});
		return;
	}
	process.stdout.write(
		"Generate a subscription token with claude setup-token. Paste it here (hidden), then press Return: ",
	);
	const previous = spawnSync("/bin/stty", ["-g"], {
		stdio: ["inherit", "pipe", "ignore"],
		encoding: "utf8",
	}).stdout.trim();
	if (!previous || spawnSync("/bin/stty", ["-echo"], { stdio: "inherit" }).status !== 0)
		throw new OperatorError("Cannot hide terminal input.");
	try {
		const token = await new Promise<string>((done, fail) => {
			process.stdin.setEncoding("utf8");
			const abort = () => {
				clean();
				fail(new OperatorError("Sign-in canceled."));
			};
			const onData = (value: string) => {
				clean();
				done(value.trim());
			};
			const clean = () => {
				process.removeListener("SIGINT", abort);
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
			};
			process.once("SIGINT", abort);
			process.stdin.once("data", onData);
		});
		if (!/^sk-ant-oat[0-9]+-[a-zA-Z0-9_-]+$/.test(token))
			throw new OperatorError("Expected a Claude subscription setup token.");
		const output = join(profile, "oauth-token");
		if (existsSync(output) && (lstatSync(output).nlink !== 1 || !lstatSync(output).isFile()))
			throw new OperatorError("Unsafe credential file.");
		const fd = openSync(
			output,
			constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(fd, token);
		} finally {
			closeSync(fd);
		}
	} finally {
		spawnSync("/bin/stty", [previous], { stdio: "inherit" });
		process.stdout.write("\n");
	}
}
async function readPrompt() {
	const parts: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const b = Buffer.from(chunk);
		size += b.length;
		if (size > maxOutput) throw new OperatorError("Prompt exceeds 256 KiB.");
		parts.push(b);
	}
	const prompt = Buffer.concat(parts).toString("utf8");
	if (!prompt.trim()) throw new OperatorError("The task prompt is empty.");
	return prompt;
}
function turn(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
		const parent = process.ppid;
		const abort = () => {
			cancelFleetProcessTree(child);
		};
		const guard = setInterval(() => {
			if (parent === 1 || process.ppid !== parent) abort();
		}, 750);
		guard.unref();
		process.once("SIGTERM", abort);
		process.once("SIGINT", abort);
		child.once("close", () => {
			clearInterval(guard);
			process.removeListener("SIGTERM", abort);
			process.removeListener("SIGINT", abort);
		});
		const parts: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutput) {
				cancelFleetProcessTree(child);
			} else parts.push(chunk);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
		child.once("error", () => fail(new OperatorError("The installed CLI could not start.")));
		child.once("close", (code) => {
			if (code !== 0 || size > maxOutput) {
				const reasons: Record<number, string> = {
					21: "The subscription does not offer the selected pi model.",
					22: "The pi subscription reported a quota or rate limit.",
					23: "The pi subscription requires a new OAuth sign-in.",
					24: "The pi subscription connection failed.",
					25: "The pi provider did not return a final answer.",
				};
				fail(
					new OperatorError(
						reasons[code ?? 0] ??
							"The native CLI turn failed. Check subscription availability and the sandbox doctor on this Mac.",
					),
				);
			} else done(Buffer.concat(parts).toString("utf8").trim());
		});
	});
}
export async function main(args: string[]) {
	if (process.platform !== "darwin") throw new OperatorError("This worker requires native macOS Seatbelt.");
	const operation = args.length === 1 ? "run" : args[0];
	const agent = args.at(-1);
	if (
		!["run", "login", "doctor"].includes(operation) ||
		args.length > 2 ||
		!(agent === "pi" || agent === "codex" || agent === "claude")
	)
		throw new OperatorError("Usage: fleet-sandbox.ts [doctor|login] pi|codex|claude");
	const task = realpathSync(process.cwd());
	const owner = realpathSync(homedir());
	if (operation === "login") {
		await login(agent, task);
		return;
	}
	const launcher = agent === "codex" ? binary("codex", task) : "/usr/bin/sandbox-exec";
	const agentCli = agent === "pi" ? piCli : agent === "codex" ? launcher : binary("claude", task);
	const base = realpathSync(tmpdir());
	const control = mkdtempSync(join(base, "pih-fleet-"));
	let tunnel: Awaited<ReturnType<typeof providerTunnel>> | undefined;
	try {
		const scratch = join(control, "scratch");
		mkdirSync(scratch, { mode: 0o700 });
		const empty = join(control, "empty");
		mkdirSync(empty, { mode: 0o700 });
		const work = operation === "doctor" ? empty : task;
		if (
			within(owner, work) ||
			within(control, work) ||
			within(bootstrap, work) ||
			[".codex", ".claude", ".pi", ".ssh", ".aws", ".gnupg", ".pihouse/fleet-profiles", "Library/Keychains"].some(
				(name) => {
					const reserved = join(owner, name);
					return within(work, reserved) || within(reserved, work);
				},
			)
		)
			throw new OperatorError("The task must use a separate project checkout.");
		const sentinel = join(control, "private-canary");
		writeFileSync(sentinel, "outside", { mode: 0o600 });
		const helper = join(control, "bootstrap.mts");
		copyFileSync(bootstrap, helper);
		const reads =
			agent === "codex" ? [] : [realpathSync(process.execPath), helper, ...(agent === "pi" ? [piRoot] : [agentCli])];
		const policy = codexPermissions(work, scratch);
		if (agent !== "codex") tunnel = await providerTunnel(agent === "pi" ? "chatgpt.com" : "api.anthropic.com");
		const sandbox = tunnel
			? seatbeltArgs(work, scratch, reads, tunnel.port)
			: ["sandbox", ...policy, "-P", "fleet", "-C", work];
		const probe = capture(
			launcher,
			[
				...sandbox,
				"/bin/sh",
				"-c",
				'if ( : < "$1" ) 2>/dev/null; then exit 1; fi; test -r "$2" && test -w "$2"',
				"sh",
				sentinel,
				work,
			],
			scratch,
			scratch,
			empty,
		);
		if (probe.status !== 0)
			throw new OperatorError("The native macOS permission profile failed its containment probe.");
		if (operation === "doctor") {
			const check =
				agent === "codex"
					? capture(launcher, ["--version"], scratch, scratch, empty)
					: capture(
							launcher,
							[...sandbox, ...(agent === "pi" ? [process.execPath, agentCli] : [agentCli]), "--version"],
							scratch,
							scratch,
							empty,
						);
			if (check.status !== 0) throw new OperatorError(`The installed ${agent} CLI failed its sandbox startup check.`);
			process.stdout.write(`${agent}: ${check.stdout.trim()}; native Seatbelt containment probe passed.\n`);
			return;
		}
		const prompt = await readPrompt();
		if (agent === "codex") {
			const codexHome = join(owner, ".codex");
			const status = capture(launcher, ["login", "status"], scratch, scratch, empty, { CODEX_HOME: codexHome });
			if (status.status !== 0 || !/logged in using chatgpt/i.test(status.stdout + status.stderr))
				throw new OperatorError("Codex requires a native ChatGPT subscription sign-in.");
			const final = join(control, "last-message");
			const config = [
				"-a",
				"never",
				...policy,
				"-c",
				'forced_login_method="chatgpt"',
				"-c",
				'web_search="disabled"',
				"-c",
				'shell_environment_policy.inherit="none"',
				"-c",
				`shell_environment_policy.set={HOME=${JSON.stringify(scratch)},PATH=${JSON.stringify(systemPath)},TMPDIR=${JSON.stringify(scratch)}}`,
				"--disable",
				"apps",
				"--disable",
				"plugins",
				"--disable",
				"hooks",
				"--disable",
				"multi_agent",
				"--enable",
				"skip_host_skill_discovery",
			];
			await turn(
				launcher,
				[
					...config,
					"exec",
					"--ignore-user-config",
					"--ignore-rules",
					"--ephemeral",
					"--skip-git-repo-check",
					"-o",
					final,
					"-",
				],
				empty,
				{ ...envFor(scratch, scratch), CODEX_HOME: codexHome },
				`The only assigned project checkout is ${JSON.stringify(work)}. Run project commands in that directory.\n\n${prompt}`,
			);
			const message = readFileSync(final, "utf8").trim();
			if (!message || Buffer.byteLength(message) > maxOutput)
				throw new OperatorError("Codex returned no usable final message.");
			process.stdout.write(`${message}\n`);
			return;
		}
		if (agent === "claude" && !existsSync(join(owner, ".pihouse", "fleet-profiles", "claude", "oauth-token"))) {
			const username = userInfo().username;
			const identity = { USER: username, LOGNAME: username };
			const flags = ["--restricted", "--safe-mode", "--strict-mcp-config", "--tools", "", "--disable-slash-commands"];
			const auth = capture(agentCli, [...flags, "auth", "status", "--json"], owner, scratch, empty, identity);
			let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {};
			try {
				status = JSON.parse(auth.stdout);
			} catch {}
			if (
				auth.status !== 0 ||
				!status.loggedIn ||
				status.authMethod !== "claude.ai" ||
				status.apiProvider !== "firstParty"
			)
				throw new OperatorError(
					"Claude chat requires a native claude.ai subscription sign-in. Run claude auth login --claudeai.",
				);
			const answer = await turn(
				agentCli,
				[...flags, "--no-session-persistence", "--print", "--output-format", "text"],
				empty,
				{ ...envFor(owner, scratch), ...identity },
				`Chat-only session. You have no file or command tools or access to the project.\n\n${prompt}`,
			);
			if (!answer) throw new OperatorError("Claude returned no final message.");
			process.stdout.write(`[Claude chat only · no project tools]\n${answer}\n`);
			return;
		}
		const profile = checkedProfile(agent);
		let credential: string;
		if (agent === "pi") {
			const auth = capture(
				process.execPath,
				[piCli, "auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "10m"],
				profile,
				scratch,
				empty,
				{ PI_CODING_AGENT_DIR: profile },
			);
			if (auth.status !== 0 || !auth.stdout.trim())
				throw new OperatorError("Pi needs its dedicated ChatGPT OAuth sign-in.");
			credential = auth.stdout.trim();
		} else {
			const tokenPath = join(profile, "oauth-token");
			if (!existsSync(tokenPath)) throw new OperatorError("Claude needs a dedicated subscription setup token.");
			const info = lstatSync(tokenPath);
			if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
				throw new OperatorError("Unsafe Claude subscription credential file.");
			credential = readFileSync(tokenPath, "utf8").trim();
			if (!/^sk-ant-oat[0-9]+-[a-zA-Z0-9_-]+$/.test(credential))
				throw new OperatorError("Invalid Claude subscription setup token.");
		}
		const proxy = tunnel?.url;
		if (!proxy) throw new OperatorError("No provider tunnel.");
		const output = await turn(
			launcher,
			[...sandbox, process.execPath, helper, agent, agentCli],
			work,
			{
				...envFor(scratch, scratch),
				HTTP_PROXY: proxy,
				HTTPS_PROXY: proxy,
				http_proxy: proxy,
				https_proxy: proxy,
				CODEX_HOME: join(scratch, "codex"),
				PI_CODING_AGENT_DIR: join(scratch, "pi"),
				CLAUDE_CONFIG_DIR: join(scratch, "claude"),
			},
			JSON.stringify({ credential, prompt }),
		);
		if (!output || output.includes(credential)) throw new OperatorError("The CLI returned an unusable response.");
		process.stdout.write(`${output}\n`);
	} finally {
		tunnel?.close();
		rmSync(control, { recursive: true, force: true });
	}
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(
			`Fleet sandbox: ${error instanceof OperatorError ? error.message : "Native worker setup or execution failed."}\n`,
		);
		process.exitCode = 1;
	});
}
