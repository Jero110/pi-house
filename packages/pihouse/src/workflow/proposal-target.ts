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
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ScopedTarget } from "./proposals.ts";
import { vaultPaths, vaultRel } from "./vault-paths.ts";

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

const FORBIDDEN_BASENAMES = [
	/^auth\.json$/,
	/^mcp-auth\.json$/,
	/^\.env$/,
	/^\.env\./,
	/\.pem$/,
	/^id_rsa/,
	/^id_ed25519/,
];
const FORBIDDEN_EXCEPTIONS = new Set([".env.example"]);
const FORBIDDEN_HOME_DIRS = [".ssh", ".aws", ".gnupg"];
const FORBIDDEN_HOME_PREFIXES = [".pihouse/agent/auth", ".pi/agent/auth"];

/**
 * Problem: a `file:` proposal comes from a model that read conversations, so its path can be hostile. Example:
 * `file:/Users/me/.ssh/config`, or `file:/tmp/ok/../../etc/hosts`, or a folder symlink that points at credentials.
 * Solution: accept only an absolute, already-normalized path whose every component is a real entry (no symlink), that
 * ends in an existing regular file, and that is not on the credential list. Returns the path; throws with the reason.
 */
export function checkFileTarget(path: string, home: string = homedir()): string {
	if (!path.startsWith("/") || resolve(path) !== path)
		throw new Error("File target must be an absolute, normalized path");
	let current = "/";
	for (const part of path.split("/").filter(Boolean)) {
		current = join(current, part);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			throw new Error("File target does not exist");
		}
		if (stat.isSymbolicLink()) throw new Error("Symlink target refused");
	}
	if (!lstatSync(path).isFile()) throw new Error("Target is not a regular file");
	const name = basename(path);
	if (!FORBIDDEN_EXCEPTIONS.has(name) && FORBIDDEN_BASENAMES.some((pattern) => pattern.test(name)))
		throw new Error("File target is a credential file and is refused");
	const rel = path.startsWith(`${home}${sep}`) ? path.slice(home.length + 1) : undefined;
	if (
		rel !== undefined &&
		(FORBIDDEN_HOME_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`)) ||
			FORBIDDEN_HOME_PREFIXES.some((prefix) => rel.startsWith(prefix)))
	)
		throw new Error("File target is in a credential folder and is refused");
	return path;
}

export interface ProposalTargetOptions {
	/** Home folder used for the credential list of `file:` targets; defaults to the user's home. */
	home?: string;
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
	let filePath: string | undefined;
	if (options.target.startsWith("file:")) {
		filePath = checkFileTarget(options.target.slice(5), options.home);
		relative = "";
	} else if (options.target.startsWith("skill:")) {
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
		relative = vaultRel.approvedRecord(key);
	} else throw new Error("Unknown target kind");
	const root = skillName ? options.repoRoot : options.storeRoot;
	const path = filePath ?? safeComponents(root, relative);
	const jsonFile = filePath?.toLowerCase().endsWith(".json") === true;
	let lastBefore: string | undefined;
	const backupRoot = vaultPaths(options.storeRoot).proposalBackups(options.proposalId);
	let failure: string | undefined;
	return {
		failureReason: () => failure,
		read: async () => readFileSync(path, "utf8"),
		compareAndSwap: async (expected, replacement) => {
			const lock = `${path}.pihouse-lock`;
			let fd: number;
			failure = undefined;
			try {
				fd = openSync(lock, "wx", 0o600);
			} catch {
				// Problem: a crash can leave a lock, but age alone cannot prove its owner is dead. Example: deleting a slow live writer's lock can permit concurrent writes. Solution: fail closed and tell an operator to inspect before removing it.
				failure = `Proposal target lock file exists at ${lock}; verify no application is active, then remove it manually`;
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
				lastBefore = expected;
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
			if (filePath !== undefined) {
				let valid = bytes.trim().length > 0;
				if (valid && jsonFile) {
					try {
						JSON.parse(bytes);
					} catch {
						valid = false;
					}
				}
				// Problem: a rejected edit would stay on disk. Example: a model turns settings.json into text that
				// does not parse and the tool reading it breaks. Solution: put the old bytes back, same atomic path.
				if (!valid && lastBefore !== undefined) {
					const temp = join(dirname(path), `.pihouse-${options.proposalId}-${process.pid}.restore`);
					writeFileSync(temp, lastBefore, { flag: "wx", mode: 0o600 });
					renameSync(temp, path);
				}
				if (!valid) return false;
			}
			return (await options.extraValidate?.(bytes)) ?? true;
		},
	};
}

export function targetPathWithin(root: string, path: string): boolean {
	return inside(resolve(root), resolve(path));
}
