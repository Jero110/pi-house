// Profiles (profiles/<harness>.json): which adapter runs a harness, its label, default model and the
// startup dialogs the hub answers in its pane. A harness without a native path is one JSON with
// adapter "paste" and its command, so adding one needs no code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DialogSpec, Profile } from "./types.ts";

/** The profiles shipped with agent-link-core. */
export const PROFILES_DIR = fileURLToPath(new URL("../profiles", import.meta.url));

/** The harnesses with a native adapter, always offered by spawn. */
export const NATIVE_HARNESSES = ["claude", "codex", "opencode", "pi"] as const;

/** Reads every `<name>.json` in each folder; a later folder overrides an earlier one with the same name. */
export function loadProfiles(dirs: readonly string[] = [PROFILES_DIR]): Map<string, Profile> {
	const profiles = new Map<string, Profile>();
	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			continue;
		}
		for (const file of files.sort()) {
			const path = join(dir, file);
			const profile = parseProfile(JSON.parse(readFileSync(path, "utf8")), path);
			profiles.set(profile.harness, profile);
		}
	}
	return profiles;
}

/** Validates a profile, so a wrong JSON fails when the hub starts and not in the middle of a spawn. */
export function parseProfile(raw: unknown, source = "profile"): Profile {
	const fail = (why: string): never => {
		throw new Error(`${source}: ${why}`);
	};
	if (!raw || typeof raw !== "object") return fail("not an object");
	const p = raw as Record<string, unknown>;
	const text = (key: string) => (typeof p[key] === "string" && p[key] ? (p[key] as string) : fail(`"${key}" missing`));
	const harness = text("harness");
	const adapter = text("adapter");
	const label = text("label");
	const defaultModel = p.defaultModel === null || p.defaultModel === undefined ? null : text("defaultModel");
	const dialogs = Array.isArray(p.dialogs) ? (p.dialogs as DialogSpec[]) : fail(`"dialogs" must be an array`);
	for (const d of dialogs) {
		if (typeof d?.name !== "string" || !Array.isArray(d.match))
			fail(`dialog ${JSON.stringify(d)} needs name and match`);
	}
	let command: string[] | undefined;
	if (p.command !== undefined) {
		if (!Array.isArray(p.command) || !p.command.every((a) => typeof a === "string")) fail(`"command" must be strings`);
		command = p.command as string[];
	}
	if (adapter === "paste" && !command) fail(`a paste profile needs "command"`);
	let env: Record<string, string> | undefined;
	if (p.env !== undefined) {
		const ok =
			p.env !== null &&
			typeof p.env === "object" &&
			!Array.isArray(p.env) &&
			Object.values(p.env).every((v) => typeof v === "string");
		if (!ok) fail(`"env" must map names to strings`);
		env = p.env as Record<string, string>;
	}
	return {
		harness,
		adapter,
		label,
		defaultModel,
		dialogs,
		...(command ? { command } : {}),
		...(env ? { env } : {}),
	};
}

/** The names spawn accepts: the native harnesses first, then every other profile. */
export function harnessNames(profiles: ReadonlyMap<string, Profile>): string[] {
	const native: string[] = [...NATIVE_HARNESSES];
	return [...native, ...[...profiles.keys()].filter((n) => !native.includes(n)).sort()];
}
