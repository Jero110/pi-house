// pihouse's setup: its pi config dir, its agent-link profile, and the MCP servers for the backend the user chose.
//
// pihouse keeps its own pi config dir (~/.pihouse/agent) so plain pi and pihouse never share settings. It reuses pi's
// login: auth.json, the model store and provider packages are copied from ~/.pi/agent the first time, so the
// same models work. Nothing in either folder is ever deleted.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLinkServer, install, mcpCommand, type ServerSpec, uninstall, which } from "agent-link";
import { agentLinkHome, type BackendName, hubPaths, PLACE_ENV, stableNode } from "agent-link-core";
import { BOOKS_MCP, PI_CLI, PIHOUSE_CLI, type PihousePaths, SKILL_GROUP_DIRS, SKILLS_DIR } from "./paths.ts";

/** The mark pihouse puts in settings.json, so it never rewrites settings it did not write. */
export const SETTINGS_VERSION = 1;
/** The pi package that serves Claude models through the Claude Code login, when the user has it. */
export const BRIDGE_PACKAGE = "pi-claude-bridge";

/** The bridge version setup installs when pi does not have it, pinned like every other dependency. */
export const BRIDGE_SOURCE = `npm:${BRIDGE_PACKAGE}@0.9.3`;

const IMPORTED_FILES = ["auth.json", "models-store.json", "claude-bridge.json"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

/** pi's package entry for the Claude bridge, if pi has one. */
export function bridgeEntry(piSettings: unknown): unknown {
	if (!isObj(piSettings) || !Array.isArray(piSettings.packages)) return undefined;
	return piSettings.packages.find((p: unknown) => {
		const source = typeof p === "string" ? p : isObj(p) && typeof p.source === "string" ? p.source : "";
		return source === `npm:${BRIDGE_PACKAGE}` || source.startsWith(`npm:${BRIDGE_PACKAGE}@`);
	});
}

/**
 * The settings pihouse writes once: its mark, the skills of this checkout and the bridge package when pi has it.
 * No default provider or model: pi starts on whichever provider the user is logged in to, and the bridge's Claude
 * models are one /model away.
 * Problem: the bridge was the default provider whenever it was installed. Example: a user who logged in with
 * ChatGPT still started on Sonnet through the Claude Code login. Solution: the bridge is available, never the default.
 * Problem: pi loads every file in <agentDir>/extensions. Solution: "!extensions/**" keeps that folder out;
 * pihouse's own extensions come in with -e.
 */
export function pihouseSettings(piSettings: unknown): Obj {
	const bridge = bridgeEntry(piSettings);
	return {
		pihouse: { version: SETTINGS_VERSION },
		packages: bridge === undefined ? [] : [bridge],
		skills: [...SKILL_GROUP_DIRS],
		// The header stays; the long list of loaded skills and extensions at startup goes.
		quietStartup: "header",
		// The theme file itself is loaded with --theme on every run (see launcher.ts); this only selects it.
		theme: "pihouse",
		extensions: ["!extensions/**"],
	};
}

export interface AgentDirReport {
	wrote: boolean;
	copied: string[];
}

/** Creates ~/.pihouse/agent on first run; afterwards only keeps the skills path pointing at this checkout. */
export function ensureAgentDir(paths: PihousePaths): AgentDirReport {
	const file = join(paths.agentDir, "settings.json");
	const current = readJson(file);
	if (isObj(current) && isObj(current.pihouse) && current.pihouse.version === SETTINGS_VERSION) {
		const skills = Array.isArray(current.skills)
			? current.skills.filter((x): x is string => typeof x === "string")
			: [];
		if (!SKILL_GROUP_DIRS.every((d) => skills.includes(d))) {
			// The checkout moved (or was reinstalled elsewhere): point at this one's skills, keep the user's own.
			const own = skills.filter(
				(x) => !x.startsWith(dirname(SKILLS_DIR)) && !x.endsWith("/skills") && !/\/skills\/[\w-]+$/.test(x),
			);
			current.skills = [...SKILL_GROUP_DIRS, ...own];
			writeJson(file, current);
		}
		return { wrote: false, copied: [] };
	}
	mkdirSync(paths.agentDir, { recursive: true });
	const report: AgentDirReport = { wrote: true, copied: [] };
	if (existsSync(file) && !existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`);
	for (const name of IMPORTED_FILES) {
		const from = join(paths.piAgentDir, name);
		const to = join(paths.agentDir, name);
		if (existsSync(from) && !existsSync(to)) {
			copyFileSync(from, to);
			report.copied.push(name);
		}
	}
	// pi installs packages under <agentDir>/npm; copying pi's saves installing the bridge again.
	const npmFrom = join(paths.piAgentDir, "npm");
	const npmTo = join(paths.agentDir, "npm");
	if (existsSync(npmFrom) && !existsSync(npmTo)) {
		cpSync(npmFrom, npmTo, { recursive: true });
		report.copied.push("npm");
	}
	writeJson(file, pihouseSettings(readJson(join(paths.piAgentDir, "settings.json"))));
	return report;
}

/** Runs a command with the user's terminal (pi install prints npm's progress); returns its exit status. */
export type Run = (argv: string[], env: NodeJS.ProcessEnv) => number;

const runInherit: Run = (argv, env) => spawnSync(argv[0] ?? "", argv.slice(1), { env, stdio: "inherit" }).status ?? 1;

/**
 * Installs the Claude bridge into pihouse's agent dir when Claude Code is there and the bridge is not. It stays an
 * option in /model; it is never made the default provider.
 * Problem: pihouse got the bridge only by copying pi's packages. Example: on a machine where pi never had it, a fresh
 * install had no Claude models, though the user was logged in to Claude Code. Solution: setup runs `pi install` for the pinned bridge with PI_CODING_AGENT_DIR set to pihouse's agent dir.
 */
export function ensureBridge(
	paths: PihousePaths,
	env: NodeJS.ProcessEnv,
	out: (line: string) => void,
	run: Run = runInherit,
): "present" | "installed" | "skipped" | "failed" {
	const file = join(paths.agentDir, "settings.json");
	const installed = () =>
		bridgeEntry(readJson(file)) !== undefined &&
		existsSync(join(paths.agentDir, "npm", "node_modules", BRIDGE_PACKAGE));
	if (installed()) return "present";
	if (!which("claude", env)) {
		out(
			"pih: Claude Code (claude) is not on PATH, so the Claude bridge was skipped. Install Claude Code and run `pih setup` again to use your Claude login.",
		);
		return "skipped";
	}
	out(`pih: installing the Claude bridge (${BRIDGE_SOURCE}), so pihouse uses your Claude Code login`);
	const status = run([process.execPath, PI_CLI, "install", BRIDGE_SOURCE], {
		...env,
		PI_CODING_AGENT_DIR: paths.agentDir,
	});
	if (status !== 0 || !installed()) {
		out(`pih: could not install the Claude bridge (pi install exited ${status}); run \`pih setup\` again later`);
		return "failed";
	}
	return "installed";
}

/**
 * The profile that lets agent-link open pihouse as a worker or a root: pi's adapter, running this checkout's
 * CLI with the node that runs pihouse now (absolute paths, so it works whatever PATH the hub daemon has).
 */
export function writePihouseProfile(env: NodeJS.ProcessEnv): string {
	const dir = join(hubPaths(agentLinkHome(env)).home, "profiles");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "pihouse.json");
	const profile = {
		harness: "pihouse",
		adapter: "pi",
		label: "pihouse",
		defaultModel: null,
		dialogs: [],
		command: [stableNode(env), PIHOUSE_CLI],
		// Problem: a pihouse worker opened by the hub got the default ~/.pihouse. Example: a sandbox planner with
		// PIHOUSE_HOME=/tmp/fe/pihouse handed off to an executor that read and wrote the user's real ~/.pihouse.
		// Solution: a non-default home goes in the profile, so every pihouse the hub opens uses it.
		...(env.PIHOUSE_HOME ? { env: { PIHOUSE_HOME: env.PIHOUSE_HOME } } : {}),
	};
	const text = `${JSON.stringify(profile, null, "\t")}\n`;
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
	return file;
}

export interface PihouseConfig {
	backend: BackendName;
}

export function readConfig(paths: PihousePaths): PihouseConfig | undefined {
	const c = readJson(paths.config);
	return isObj(c) && (c.backend === "cmux" || c.backend === "tmux") ? { backend: c.backend } : undefined;
}

/** How harnesses start the cmux MCP server: this node and the package's CLI. */
export function cmuxMcpCommand(): { command: string; args: string[] } {
	return { command: stableNode(), args: [fileURLToPath(import.meta.resolve("cmux-mcp/cli"))] };
}

export function cmuxServer(paths: PihousePaths): ServerSpec {
	return {
		name: "cmux",
		description: "Find and read agent sessions, arrange cmux, use its browser",
		envVars: [...PLACE_ENV],
		manifest: join(paths.home, "install-cmux.json"),
	};
}

/** pihouse reads MCP servers from <agentDir>/mcp.json; the cmux server is added there with direct exposure. */
export function setPihouseMcp(paths: PihousePaths, name: string, entry: Obj | undefined): void {
	const file = join(paths.agentDir, "mcp.json");
	const config = readJson(file);
	const root: Obj = isObj(config) ? config : {};
	const servers: Obj = isObj(root.mcpServers) ? root.mcpServers : {};
	if (entry) servers[name] = entry;
	else delete servers[name];
	root.mcpServers = servers;
	mkdirSync(paths.agentDir, { recursive: true });
	writeJson(file, root);
}

/** The Node the books MCP server needs (packages/books-rag engines); ordinary pihouse runs on Node >= 24. */
export const BOOKS_MIN_NODE = "26.11.1";
const BOOKS_DESCRIPTION = "Search and read the private PDF library (explicit tool calls only)";

/** True when `version` (like "26.11.1") is at least BOOKS_MIN_NODE. */
export function nodeRunsBooks(version: string): boolean {
	const have = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const need = BOOKS_MIN_NODE.split(".").map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < need.length; i++) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

/**
 * The books MCP entry for pihouse: this node and this checkout's server. Only the PATH of the env file is ever written,
 * never its contents; without one the server still starts and answers each tool with an explicit configuration error.
 */
export function booksMcpEntry(env: NodeJS.ProcessEnv, envFile: string | undefined): Obj {
	return {
		command: stableNode(env),
		args: [BOOKS_MCP],
		...(envFile ? { env: { BOOKS_ENV_FILE: resolve(envFile) } } : {}),
		exposure: "direct",
		description: BOOKS_DESCRIPTION,
	};
}

/** Ownership record: the exact entry pihouse wrote. An entry that differs from it is the operator's and is never touched. */
const booksRecord = (paths: PihousePaths) => join(paths.home, "install-books.json");

function mcpServers(paths: PihousePaths): Obj {
	const config = readJson(join(paths.agentDir, "mcp.json"));
	return isObj(config) && isObj(config.mcpServers) ? config.mcpServers : {};
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Registers the books MCP server in pihouse's mcp.json by default.
 * Problem: a books entry the operator wrote or edited would be overwritten by setup, and deleted by uninstall. Example:
 * a custom books entry with another BOOKS_ENV_FILE. Solution: setup writes only when the entry is absent or still exactly
 * what pihouse recorded in install-books.json, so reruns are idempotent and anything else is kept.
 * Problem: books needs Node >= 26.11.1 but pihouse runs on >= 24. Solution: on an older Node setup warns and changes nothing.
 */
export function registerBooks(
	paths: PihousePaths,
	env: NodeJS.ProcessEnv,
	out: (line: string) => void,
	nodeVersion: string,
	envFile?: string,
): "added" | "unchanged" | "kept" | "unsupported" {
	if (!nodeRunsBooks(nodeVersion)) {
		out(
			`pih: books MCP not registered: it needs Node >= ${BOOKS_MIN_NODE} and this is ${nodeVersion}. Upgrade Node and run \`pih setup\` again.`,
		);
		return "unsupported";
	}
	if (!existsSync(BOOKS_MCP)) {
		out(`pih: books MCP not registered: ${BOOKS_MCP} is missing`);
		return "unsupported";
	}
	const entry = booksMcpEntry(env, envFile ?? env.BOOKS_ENV_FILE);
	const current = mcpServers(paths).books;
	const recorded = readJson(booksRecord(paths));
	if (current !== undefined && !same(current, recorded)) {
		out("pih: kept your own books entry in mcp.json");
		return "kept";
	}
	if (same(current, entry)) return "unchanged";
	setPihouseMcp(paths, "books", entry);
	mkdirSync(paths.home, { recursive: true });
	writeJson(booksRecord(paths), entry);
	out(
		`pih: added the books MCP server to ${join(paths.agentDir, "mcp.json")}${entry.env ? "" : " (set BOOKS_ENV_FILE or run `pih setup --books-env-file <path>` so it can read the library)"}`,
	);
	return "added";
}

/** Removes the books entry only if pihouse wrote it and it is unchanged; always drops the ownership record. */
export function unregisterBooks(paths: PihousePaths): void {
	if (same(mcpServers(paths).books, readJson(booksRecord(paths)))) setPihouseMcp(paths, "books", undefined);
	rmSync(booksRecord(paths), { force: true });
}

export interface SetupOptions {
	paths: PihousePaths;
	backend: BackendName;
	home: string;
	env: NodeJS.ProcessEnv;
	out: (line: string) => void;
	/**
	 * Installs the Claude bridge too. Off by default.
	 * Problem: setup installed the bridge on its own whenever Claude Code was on PATH, so pihouse came up with Claude
	 * models the user never asked for. Solution: the bridge is opt-in (`pih setup --claude-bridge`).
	 */
	claudeBridge?: boolean;
	/** Runs pi install for the Claude bridge (tests pass a fake). */
	run?: Run;
	/** Leaves the books MCP server out (`pih setup --no-books`). On by default. */
	noBooks?: boolean;
	/** Path of the books env file written into the entry as BOOKS_ENV_FILE; default: the BOOKS_ENV_FILE of the environment. */
	booksEnvFile?: string;
	/** Node version that gates the books server (tests pass a fake). */
	nodeVersion?: string;
}

/**
 * Everything one-command install needs after the code is in place: the agent dir, the pihouse profile for
 * agent-link, agent-link's MCP server with every harness found, and for cmux also the cmux MCP server.
 */
export function setup(opts: SetupOptions): void {
	const { paths, backend, home, env, out } = opts;
	const dir = ensureAgentDir(paths);
	out(
		dir.wrote
			? `pih: wrote ${join(paths.agentDir, "settings.json")}${dir.copied.length ? ` (copied from ${paths.piAgentDir}: ${dir.copied.join(", ")})` : ""}`
			: `pih: ${paths.agentDir} already set up`,
	);
	if (opts.claudeBridge) ensureBridge(paths, env, out, opts.run);
	out(`pih: agent-link profile ${writePihouseProfile(env)}`);
	install({ home, env, backend, command: mcpCommand(backend), out });
	if (backend === "cmux") {
		const command = cmuxMcpCommand();
		install({ home, env, backend, command, server: cmuxServer(paths), out });
		setPihouseMcp(paths, "cmux", { ...command, exposure: "direct", description: cmuxServer(paths).description });
		out(`pih: added the cmux MCP server to ${join(paths.agentDir, "mcp.json")}`);
	} else {
		uninstall({ home, env, server: cmuxServer(paths), out: () => {} });
		setPihouseMcp(paths, "cmux", undefined);
	}
	if (!opts.noBooks) registerBooks(paths, env, out, opts.nodeVersion ?? process.versions.node, opts.booksEnvFile);
	mkdirSync(paths.home, { recursive: true });
	writeJson(paths.config, { backend } satisfies PihouseConfig);
	out(`pih: backend ${backend} saved in ${paths.config}`);
}

/** Reverts setup's registrations. pihouse's own folder (sessions, reports) stays. */
export function teardown(opts: Omit<SetupOptions, "backend">): void {
	const { paths, home, env, out } = opts;
	uninstall({ home, env, server: cmuxServer(paths), out });
	uninstall({ home, env, server: agentLinkServer(home, env), out });
	setPihouseMcp(paths, "cmux", undefined);
	unregisterBooks(paths);
	rmSync(join(hubPaths(agentLinkHome(env)).home, "profiles", "pihouse.json"), { force: true });
	out(`pih: kept ${paths.home} (sessions, reports, settings); delete it by hand if you want them gone`);
}
