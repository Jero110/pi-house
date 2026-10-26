// The parts of spawn that need no running agent: checking the request and building the launch spec.
// The hub (hub.ts) runs the rest of the flow: launch, pane, startup dialogs, connect, brief.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdapterFactory, BackendName, LaunchSpec, PaneBackend, Profile } from "../types.ts";
import { IDENTITY_ENV, READ_DIRS_ENV } from "../types.ts";
import type { Agent } from "./registry.ts";

export interface SpawnRequest {
	from: string;
	harness: string;
	task: string;
	model?: string;
	name?: string;
	cwd?: string;
	backend: BackendName;
	place?: { workspace?: string; surface?: string; tmuxPane?: string };
	/** Folders outside cwd the worker may read (READ_DIRS_ENV). */
	read?: string[];
	/** The new agent takes over: once it runs and the caller's turn has ended, the caller's pane closes. */
	handoff?: boolean;
}

/** How the agent-link MCP server starts, per backend. */
export type McpCommands = Partial<Record<BackendName, { command: string; args: string[] }>>;

export const DEFAULT_MCP: Required<McpCommands> = {
	cmux: { command: "agent-link-cmux", args: ["mcp"] },
	tmux: { command: "agent-link-tmux", args: ["mcp"] },
};

export interface SpawnContext {
	caller: Agent;
	profiles: ReadonlyMap<string, Profile>;
	adapters: Record<string, AdapterFactory>;
	backends: Partial<Record<BackendName, PaneBackend>>;
}

export type Checked =
	| { ok: true; profile: Profile; factory: AdapterFactory; backend: PaneBackend }
	| { ok: false; error: string };

/** Finds the profile, adapter and backend for a spawn, or says what is missing and what exists. */
export function checkSpawn(req: SpawnRequest, ctx: SpawnContext): Checked {
	if (!req.task?.trim()) return { ok: false, error: "spawn needs a task" };
	const profile = ctx.profiles.get(req.harness);
	if (!profile)
		return {
			ok: false,
			error: `unknown harness "${req.harness}". Harnesses: ${[...ctx.profiles.keys()].join(", ")}.`,
		};
	const factory = ctx.adapters[profile.adapter];
	if (!factory)
		return {
			ok: false,
			error: `this hub has no "${profile.adapter}" adapter for ${req.harness}. Adapters: ${Object.keys(ctx.adapters).join(", ") || "none"}.`,
		};
	const backend = ctx.backends[req.backend];
	if (!backend)
		return {
			ok: false,
			error: `this hub has no "${req.backend}" pane backend. Backends: ${Object.keys(ctx.backends).join(", ") || "none"}.`,
		};
	return { ok: true, profile, factory, backend };
}

/** The identity env an agent's harness process (and its MCP server) gets. */
export function identityEnv(
	identity: { agent: string; hub: string; token: string; depth: number },
	home?: string,
): Record<string, string> {
	return {
		[IDENTITY_ENV.agent]: identity.agent,
		[IDENTITY_ENV.hub]: identity.hub,
		[IDENTITY_ENV.token]: identity.token,
		[IDENTITY_ENV.depth]: String(identity.depth),
		...(home ? { [IDENTITY_ENV.home]: home } : {}),
	};
}

/** The env a harness launches with: its profile's env, then the identity, which always wins. */
export function agentEnv(
	profile: Profile,
	identity: Record<string, string>,
	readDirs: readonly string[] = [],
): Record<string, string> {
	return { ...profile.env, ...(readDirs.length ? { [READ_DIRS_ENV]: readDirs.join(":") } : {}), ...identity };
}

/** Creates the agent's private run folder (0700) and the spec the adapter launches it with. */
export function launchSpec(input: {
	name: string;
	parent: string | null;
	model: string | null;
	cwd: string;
	runRoot: string;
	env: Record<string, string>;
	mcp: { command: string; args: string[] };
	profile: Profile;
	readDirs?: string[];
}): LaunchSpec {
	const runDir = join(input.runRoot, input.name);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	return {
		name: input.name,
		parent: input.parent,
		model: input.model,
		cwd: input.cwd,
		runDir,
		env: input.env,
		mcp: input.mcp,
		profile: input.profile,
		...(input.readDirs?.length ? { readDirs: input.readDirs } : {}),
	};
}

/** The worker's folder: absolute as given, else relative to its parent's folder. */
export function spawnCwd(parentCwd: string, cwd: string | undefined): string {
	return resolve(parentCwd, cwd ?? ".");
}
