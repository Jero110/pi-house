import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ScopedTarget } from "./proposals.ts";

function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function safeComponents(root: string, relative: string): string {
	if (
		!relative ||
		relative.startsWith("/") ||
		relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Unsafe target path");
	const absoluteRoot = realpathSync(root);
	let current = absoluteRoot;
	for (const part of relative.split(/[\\/]/)) {
		current = join(current, part);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error("Symlink target refused");
	}
	const real = realpathSync(current);
	if (!inside(absoluteRoot, real)) throw new Error("Target escapes approved root");
	if (!lstatSync(real).isFile()) throw new Error("Target is not a file");
	return real;
}

export interface ProposalTargetOptions {
	repoRoot: string;
	storeRoot: string;
	target: string;
	proposalId: string;
	catalog?: string;
	extraValidate?: (bytes: string) => Promise<boolean>;
}

/** Problem: a generic file path grants repository-wide authority. Solution: resolve only catalog skills or approved memory records. */
export function createProposalTarget(options: ProposalTargetOptions): ScopedTarget {
	const catalogPath = options.catalog ?? join(options.repoRoot, "skills", "catalog.json");
	let relative: string;
	let skillName: string | undefined;
	if (options.target.startsWith("skill:")) {
		skillName = options.target.slice("skill:".length);
		if (!/^[a-z0-9][a-z0-9-]*$/i.test(skillName)) throw new Error("Invalid skill name");
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
		if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog))
			throw new Error("Invalid skills catalog");
		const skills = catalog as { skills?: unknown[]; groups?: unknown[] };
		const entry = skills.skills?.find(
			(item) => typeof item === "object" && item !== null && "name" in item && item.name === skillName,
		);
		if (
			!entry ||
			typeof entry !== "object" ||
			!("group" in entry) ||
			typeof entry.group !== "string" ||
			!skills.groups?.some(
				(group) => typeof group === "object" && group !== null && "id" in group && group.id === entry.group,
			)
		)
			throw new Error("Skill is not in catalog");
		relative = `skills/${entry.group}/${skillName}/SKILL.md`;
	} else if (options.target.startsWith("memory:")) {
		const key = options.target.slice(7);
		if (!/^(preference|fact|procedure)\/[a-z0-9][a-z0-9._-]{0,127}$/i.test(key))
			throw new Error("Unsafe memory target");
		relative = `approved-records/${key}.md`;
	} else throw new Error("Unknown target kind");
	const root = skillName ? options.repoRoot : options.storeRoot;
	const path = safeComponents(root, relative);
	const backupRoot = join(options.storeRoot, "proposals", options.proposalId);
	return {
		read: async () => readFileSync(path, "utf8"),
		compareAndSwap: async (expected, replacement) => {
			const lock = `${path}.pihouse-lock`;
			let fd: number;
			try {
				fd = openSync(lock, "wx", 0o600);
			} catch {
				return false;
			}
			try {
				if (readFileSync(path, "utf8") !== expected) return false;
				mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
				const version = createHash("sha256").update(`${expected}\0${replacement}`).digest("hex");
				const backup = join(backupRoot, `${version}.before`);
				if (!existsSync(backup)) writeFileSync(backup, expected, { flag: "wx", mode: 0o600 });
				const temp = join(dirname(path), `.pihouse-${options.proposalId}-${process.pid}.tmp`);
				const tempFd = openSync(temp, "wx", 0o600);
				try {
					writeFileSync(tempFd, replacement);
					fsyncSync(tempFd);
				} finally {
					closeSync(tempFd);
				}
				renameSync(temp, path);
				return true;
			} finally {
				closeSync(fd);
				unlinkSync(lock);
			}
		},
		validate: async () => {
			const bytes = readFileSync(path, "utf8");
			if (skillName) {
				const match = bytes.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/);
				const name = match?.[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
				if (!match || name !== skillName) return false;
			}
			return (await options.extraValidate?.(bytes)) ?? true;
		},
	};
}

export function targetPathWithin(root: string, path: string): boolean {
	return inside(resolve(root), resolve(path));
}
