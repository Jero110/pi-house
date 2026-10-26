// agent-link install / uninstall: registers the agent-link MCP server with every harness found, in its user-level
// config, and writes the agent-link skill. Each file it edits gets a backup (<file>.agent-link.bak, kept from the
// first install), edits are idempotent, and every step is recorded in <agent-link home>/install.json so that
// uninstall reverts exactly those steps and nothing the user changed besides.
import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BackendName, PLACE_ENV } from "agent-link-core";
import { defaultBackend, type McpCommand, mcpCommand } from "./commands.ts";
import { SKILL_MD, SKILL_NAME } from "./skill.ts";

export const SERVER_NAME = "agent-link";
export const IDENTITY_VARS = [
	"AGENT_LINK_AGENT",
	"AGENT_LINK_HUB",
	"AGENT_LINK_TOKEN",
	"AGENT_LINK_DEPTH",
	"AGENT_LINK_HOME",
	"AGENT_LINK_READ_DIRS",
] as const;

/**
 * One MCP server to register with every harness found. agent-link registers its own; another package (the
 * cmux MCP, through pihouse's setup) passes its spec and its own manifest, and gets the same backups and undo.
 */
export interface ServerSpec {
	name: string;
	description: string;
	/** Env vars Codex must pass on to the server (Codex filters an MCP server's env). */
	envVars: readonly string[];
	/** A skill written next to the registration, or none. */
	skill?: { name: string; md: string };
	/** Where the steps are recorded for uninstall. */
	manifest: string;
}

export function agentLinkServer(home: string, env: NodeJS.ProcessEnv): ServerSpec {
	return {
		name: SERVER_NAME,
		description: "Launch and message other coding agents",
		envVars: [...IDENTITY_VARS, ...PLACE_ENV],
		skill: { name: SKILL_NAME, md: SKILL_MD },
		manifest: manifestPath(home, env),
	};
}

const beginMark = (name: string) => `# ${name}: begin (written by an installer; its uninstall removes it)`;
const endMark = (name: string) => `# ${name}: end`;

export interface InstallOptions {
	/** The user's home: every config path is under it. Tests pass a temporary one. */
	home: string;
	/** PATH (to find the harness CLIs), XDG_CONFIG_HOME, CODEX_HOME, AGENT_LINK_HOME, CMUX_*. */
	env: NodeJS.ProcessEnv;
	backend?: BackendName;
	/** Default: node and the backend's MCP entry. */
	command?: McpCommand;
	/** Default: the agent-link server. */
	server?: ServerSpec;
	out?: (line: string) => void;
}

/** One thing install did, with what it takes to undo it. */
export type Step =
	| { harness: string; kind: "cli"; undo: string[]; file?: string; backup?: string }
	| { harness: string; kind: "toml-block"; file: string; backup?: string; created: boolean }
	| { harness: string; kind: "json-key"; file: string; backup?: string; created: boolean; createdParent: boolean }
	| { harness: string; kind: "skill"; dir: string; created: boolean };

export interface Manifest {
	backend: BackendName;
	command: McpCommand;
	steps: Step[];
}

export function manifestPath(home: string, env: NodeJS.ProcessEnv): string {
	return join(env.AGENT_LINK_HOME ? resolve(env.AGENT_LINK_HOME) : join(home, ".agent-link"), "install.json");
}

/** The executable `bin` on env.PATH, or undefined. */
export function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
		const file = join(dir, bin);
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {}
	}
	return undefined;
}

const tilde = (home: string, path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** Copies file to <file>.agent-link.bak once: a later install keeps the backup of the state before the first. */
function backup(file: string): string | undefined {
	if (!existsSync(file)) return undefined;
	const bak = `${file}.agent-link.bak`;
	if (!existsSync(bak)) copyFileSync(file, bak);
	return bak;
}

function readManifest(path: string): Manifest | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : undefined;
}

export function install(opts: InstallOptions): Manifest {
	const { home, env } = opts;
	const out = opts.out ?? ((l: string) => process.stdout.write(`${l}\n`));
	const backend = opts.backend ?? defaultBackend(env);
	const command = opts.command ?? mcpCommand(backend);
	const server = opts.server ?? agentLinkServer(home, env);
	const SERVER_NAME = server.name;
	const mpath = server.manifest;
	const previous = readManifest(mpath);
	// A step done by an earlier install keeps what it recorded (created files and folders, first backups).
	const before = (harness: string, kind: Step["kind"]) =>
		previous?.steps.find((s) => s.harness === harness && s.kind === kind);
	const cliEnv = { ...env, HOME: home };
	const run = (argv: string[], allowFail = false) => {
		try {
			execFileSync(argv[0] ?? "", argv.slice(1), { env: cliEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
			return true;
		} catch (e) {
			if (!allowFail) throw new Error(`${argv.join(" ")} failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	};
	// A harness on PATH that does not run (e.g. the pi shim cmux puts in its terminals, with no pi behind it) is
	// skipped, not fatal: the install goes on with the others. Returns why it failed, or undefined.
	const tryRun = (argv: string[]): string | undefined => {
		try {
			run(argv);
			return undefined;
		} catch (e) {
			const lines = (e instanceof Error ? e.message : String(e)).trim().split("\n");
			return lines[lines.length - 1];
		}
	};
	const steps: Step[] = [];
	const cmdline = [command.command, ...command.args];
	out(`${SERVER_NAME} install: backend ${backend}, MCP server "${SERVER_NAME}" = ${cmdline.join(" ")}`);

	// Claude Code: its CLI edits ~/.claude.json. Removing first makes a repeated install replace the entry.
	const claude = which("claude", env);
	if (claude) {
		const file = join(home, ".claude.json");
		const bak = backup(file);
		run([claude, "mcp", "remove", "--scope", "user", SERVER_NAME], true);
		const failed = tryRun([claude, "mcp", "add", "--scope", "user", SERVER_NAME, "--", ...cmdline]);
		if (failed) out(`claude: found at ${claude} but it does not run (${failed}), skipped`);
		else {
			steps.push({
				harness: "claude",
				kind: "cli",
				undo: [claude, "mcp", "remove", "--scope", "user", SERVER_NAME],
				file,
				backup: bak,
			});
			out(
				`claude: added user MCP server ${SERVER_NAME} (claude mcp add --scope user)${bak ? `; backup ${tilde(home, bak)}` : ""}`,
			);
		}
	} else out("claude: not found on PATH, skipped");

	// pi 1.3.0 has native MCP; `add` replaces an entry with the same name. Direct exposure: pi's default
	// (codemode) hides tools from the model until a script searches for them.
	const pi = which("pi", env);
	if (pi) {
		const file = join(home, ".pi", "agent", "mcp.json");
		const bak = backup(file);
		const failed = tryRun([
			pi,
			...["mcp", "add", SERVER_NAME, "--exposure", "direct", "--description", server.description, "--"],
			...cmdline,
		]);
		if (failed) out(`pi: found at ${pi} but it does not run (${failed}), skipped`);
		else {
			steps.push({ harness: "pi", kind: "cli", undo: [pi, "mcp", "remove", SERVER_NAME], file, backup: bak });
			out(
				`pi: added MCP server ${SERVER_NAME} (pi mcp add --exposure direct)${bak ? `; backup ${tilde(home, bak)}` : ""}`,
			);
		}
	} else out("pi: not found on PATH, skipped");

	// Codex: a marked block in config.toml. env_vars lets the identity reach the server; approve mode keeps
	// each tool call from asking.
	const codexDir = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
	if (which("codex", env) || existsSync(codexDir)) {
		const file = join(codexDir, "config.toml");
		const prev = before("codex", "toml-block");
		const created = prev?.kind === "toml-block" ? prev.created : !existsSync(file);
		const bak = backup(file);
		const block = [
			beginMark(SERVER_NAME),
			`[mcp_servers.${SERVER_NAME}]`,
			`command = ${JSON.stringify(command.command)}`,
			`args = ${JSON.stringify(command.args)}`,
			`env_vars = ${JSON.stringify(server.envVars)}`,
			'default_tools_approval_mode = "approve"',
			endMark(SERVER_NAME),
		].join("\n");
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		const without = removeBlock(current, SERVER_NAME);
		if (new RegExp(`^\\s*\\[mcp_servers\\.(${SERVER_NAME}|"${SERVER_NAME}")\\]`, "m").test(without)) {
			out(`codex: ${tilde(home, file)} already has its own [mcp_servers.${SERVER_NAME}], left as it is`);
		} else {
			mkdirSync(codexDir, { recursive: true });
			writeFileSync(file, `${without.replace(/\n*$/, without ? "\n\n" : "")}${block}\n`);
			steps.push({ harness: "codex", kind: "toml-block", file, backup: bak, created });
			out(
				`codex: wrote [mcp_servers.${SERVER_NAME}] in ${tilde(home, file)}${bak ? `; backup ${tilde(home, bak)}` : ""}`,
			);
		}
	} else out("codex: not found, skipped");

	// opencode: mcp.agent-link in its global config.
	const ocDir = join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, ".config"), "opencode");
	if (which("opencode", env) || existsSync(ocDir)) {
		const jsonc = join(ocDir, "opencode.jsonc");
		const file = existsSync(jsonc) && !existsSync(join(ocDir, "opencode.json")) ? jsonc : join(ocDir, "opencode.json");
		const prev = before("opencode", "json-key");
		const created = prev?.kind === "json-key" ? prev.created : !existsSync(file);
		let config: Record<string, unknown> | undefined;
		try {
			config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
		} catch {
			out(
				`opencode: ${tilde(home, file)} is not plain JSON (comments?), left as it is. Add under "mcp": "${SERVER_NAME}": ${JSON.stringify(opencodeEntry(command))}`,
			);
		}
		if (config) {
			const bak = backup(file);
			if (created) config.$schema ??= "https://opencode.ai/config.json";
			const hadMcp = typeof config.mcp === "object" && config.mcp !== null;
			const createdParent = prev?.kind === "json-key" ? prev.createdParent : !hadMcp;
			const mcp = (hadMcp ? config.mcp : {}) as Record<string, unknown>;
			mcp[SERVER_NAME] = opencodeEntry(command);
			config.mcp = mcp;
			mkdirSync(ocDir, { recursive: true });
			writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
			steps.push({ harness: "opencode", kind: "json-key", file, backup: bak, created, createdParent });
			out(`opencode: set mcp.${SERVER_NAME} in ${tilde(home, file)}${bak ? `; backup ${tilde(home, bak)}` : ""}`);
		}
	} else out("opencode: not found, skipped");

	// Skills. ~/.agents/skills is read by pi, Codex and opencode. Their own skills folders are left out on
	// purpose: pi keeps the first of two skills with one name and warns about the second (pi docs/skills.md),
	// so a copy there would warn on every start. Claude Code reads only ~/.claude/skills.
	const skill = server.skill;
	const skillDirs: Array<[string, string]> = skill ? [["agents", join(home, ".agents", "skills", skill.name)]] : [];
	if (skill && existsSync(join(home, ".claude")))
		skillDirs.push(["claude", join(home, ".claude", "skills", skill.name)]);
	for (const [harness, dir] of skillDirs) {
		const prev = before(harness, "skill");
		const created = prev?.kind === "skill" ? prev.created : !existsSync(dir);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "SKILL.md");
		if (existsSync(file) && !prev) backup(file);
		writeFileSync(file, skill?.md ?? "");
		steps.push({ harness, kind: "skill", dir, created });
		out(`skill: wrote ${tilde(home, file)}`);
	}

	const manifest: Manifest = { backend, command, steps };
	mkdirSync(dirname(mpath), { recursive: true, mode: 0o700 });
	writeFileSync(mpath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	out(`recorded in ${tilde(home, mpath)}; uninstall reverts it`);
	return manifest;
}

function opencodeEntry(command: McpCommand) {
	return { type: "local", command: [command.command, ...command.args], enabled: true };
}

/** The TOML text without a server's block (and the blank lines install put before it). */
export function removeBlock(text: string, name: string = SERVER_NAME): string {
	const start = text.indexOf(beginMark(name));
	if (start < 0) return text;
	const END = endMark(name);
	const endAt = text.indexOf(END, start);
	const stop = endAt < 0 ? text.length : endAt + END.length;
	const head = text.slice(0, start).replace(/\n+$/, "");
	const tail = text.slice(stop).replace(/^\n/, "");
	return head && tail ? `${head}\n${tail}` : head ? `${head}\n` : tail;
}

/** Reverts what the last install recorded, newest step first. */
export function uninstall(opts: Pick<InstallOptions, "home" | "env" | "out" | "server">): boolean {
	const { home, env } = opts;
	const out = opts.out ?? ((l: string) => process.stdout.write(`${l}\n`));
	const server = opts.server ?? agentLinkServer(home, env);
	const mpath = server.manifest;
	const manifest = readManifest(mpath);
	if (!manifest) {
		out(`uninstall ${server.name}: nothing to do (no ${tilde(home, mpath)})`);
		return false;
	}
	for (const step of [...manifest.steps].reverse()) {
		try {
			undo(step, home, env, out, server.name);
		} catch (e) {
			out(`${step.harness}: could not revert (${e instanceof Error ? e.message : String(e)})`);
		}
	}
	rmSync(mpath, { force: true });
	const backups = manifest.steps.flatMap((s) => ("backup" in s && s.backup ? [tilde(home, s.backup)] : []));
	if (backups.length) out(`backups from the first install kept: ${backups.join(", ")}`);
	return true;
}

function undo(step: Step, home: string, env: NodeJS.ProcessEnv, out: (l: string) => void, SERVER_NAME: string): void {
	switch (step.kind) {
		case "cli": {
			const [bin, ...args] = step.undo;
			execFileSync(bin ?? "", args, {
				env: { ...env, HOME: home },
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30_000,
			});
			out(`${step.harness}: removed MCP server ${SERVER_NAME} (${[bin?.split("/").at(-1), ...args].join(" ")})`);
			return;
		}
		case "toml-block": {
			if (!existsSync(step.file)) return;
			const left = removeBlock(readFileSync(step.file, "utf8"), SERVER_NAME);
			if (step.created && !left.trim()) rmSync(step.file);
			else writeFileSync(step.file, left);
			out(
				`codex: removed [mcp_servers.${SERVER_NAME}] from ${tilde(home, step.file)}${step.created && !left.trim() ? " (and the file it created)" : ""}`,
			);
			return;
		}
		case "json-key": {
			if (!existsSync(step.file)) return;
			const config = JSON.parse(readFileSync(step.file, "utf8")) as Record<string, unknown>;
			const mcp = config.mcp as Record<string, unknown> | undefined;
			if (mcp) delete mcp[SERVER_NAME];
			if (mcp && step.createdParent && !Object.keys(mcp).length) delete config.mcp;
			const onlySchema = Object.keys(config).every((k) => k === "$schema");
			if (step.created && onlySchema) rmSync(step.file);
			else writeFileSync(step.file, `${JSON.stringify(config, null, 2)}\n`);
			out(
				`opencode: removed mcp.${SERVER_NAME} from ${tilde(home, step.file)}${step.created && onlySchema ? " (and the file it created)" : ""}`,
			);
			return;
		}
		case "skill": {
			if (step.created) {
				rmSync(step.dir, { recursive: true, force: true });
				out(`skill: removed ${tilde(home, step.dir)}`);
				return;
			}
			const bak = join(step.dir, "SKILL.md.agent-link.bak");
			if (existsSync(bak)) copyFileSync(bak, join(step.dir, "SKILL.md"));
			out(
				`skill: ${tilde(home, step.dir)} was there before; ${existsSync(bak) ? "restored its SKILL.md" : "left as it is"}`,
			);
			return;
		}
	}
}
