import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ErrorCode, Sha256, SourceVersion } from "./contracts.ts";

export class CorpusError extends Error {
	readonly code: ErrorCode | "invalid_id" | "store_corrupt" | "store_busy" | "immutable_conflict";
	constructor(code: CorpusError["code"], message: string) {
		super(message);
		this.name = "CorpusError";
		this.code = code;
	}
}

export function sha256(bytes: string | Uint8Array): Sha256 {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertId(value: string, kind: string): void {
	if (!new RegExp(`^${kind}_[a-f0-9]{32}$`).test(value)) throw new CorpusError("invalid_id", "Invalid corpus ID");
}

// Reject rather than normalize traversal or symlinks, including ancestor links.
// A verified descriptor is read below, never a path returned for a later reopen.
export function safePath(path: string, allowMissingLeaf = false): string {
	if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) {
		throw new CorpusError("unsafe_path", "Expected an absolute path without traversal");
	}
	const normalized = resolve(path);
	let current = parse(normalized).root;
	const parts = normalized.slice(current.length).split(sep).filter(Boolean);
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
				throw new CorpusError("unsafe_path", "Symlinks and non-directory ancestors are forbidden");
			}
		} catch (error) {
			if (allowMissingLeaf && index === parts.length - 1 && isMissing(error)) return normalized;
			throw error;
		}
	}
	return normalized;
}

export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function assertOutsideCheckout(path: string, checkoutRoot: string): void {
	const rel = relative(resolve(checkoutRoot), resolve(path));
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
		throw new CorpusError("unsafe_path", "Corpus data must be outside the checkout");
	}
	// Also reject another checkout, not just this worktree.
	let ancestor = resolve(path);
	while (true) {
		try {
			lstatSync(join(ancestor, ".git"));
			throw new CorpusError("unsafe_path", "Corpus data must be outside all checkouts");
		} catch (error) {
			if (!isMissing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTDIR")) throw error;
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
}

export function readLocalPdf(path: string, maximumBytes = 256 * 1024 * 1024): Uint8Array {
	try {
		const checked = safePath(path);
		if (!checked.toLowerCase().endsWith(".pdf")) throw new CorpusError("unsupported_format", "Only PDF is supported");
		const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = fstatSync(fd);
			if (!before.isFile()) throw new CorpusError("unsafe_path", "Original must be a regular file");
			if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || before.size > maximumBytes) {
				throw new CorpusError("resource_limit", "Original exceeds the local read budget");
			}
			// A growing file must not turn a bounded import into an unbounded allocation.
			const buffer = Buffer.alloc(before.size + 1);
			let length = 0;
			while (length < buffer.length) {
				const count = readSync(fd, buffer, length, buffer.length - length, null);
				if (count === 0) break;
				length += count;
			}
			const bytes = buffer.subarray(0, length);
			const after = fstatSync(fd);
			if (
				length !== before.size ||
				bytes.length > maximumBytes ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			) {
				throw new CorpusError("source_changed", "Original changed during read");
			}
			return bytes;
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (isMissing(error)) throw new CorpusError("source_missing", "Original is missing");
		throw error;
	}
}

export function verifiedSourceBytes(source: SourceVersion): Uint8Array {
	const bytes = readLocalPdf(source.originalPath);
	if (sha256(bytes) !== source.sourceHash)
		throw new CorpusError("source_changed", "Original hash differs from the recorded version");
	return bytes;
}
