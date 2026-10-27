import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type DigestIdentity, validateDigest } from "./digest-contract.ts";
import { commitArtifact } from "./documents.ts";

// Digest commit and owned-copy cleanup. Generation is never deletion authority: the only thing that deletes is
// runCleanup, and only for the files a persisted receipt names, after every gate below passes again.

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
// Flat file names only. Example: "../../native.jsonl" or "sub/x.jsonl" must never become a deletion target.
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

interface ManifestFile {
	name: string;
	sha256: string;
}

interface Manifest {
	runId: string;
	revision: string;
	digestPath: string;
	digestHash: string;
	files: ManifestFile[];
	cursors?: unknown;
	lastError?: string;
	attempts: number;
}

export type DigestCommit =
	| { status: "committed"; runId: string; revision: string; path: string; hash: string; files: number }
	| { status: "blocked" | "deferred"; runId: string; revision: string; reason: string };

export type CleanupResult =
	| { status: "cleaned"; id: string; deleted: number }
	| { status: "blocked"; id: string; reason: string };

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Resolve the one directory cleanup may touch: <owned>/runs/<id>/transcripts, with no symlink anywhere on the way. */
function capturedDir(ownedRoot: string, runId: string): string | { error: string } {
	if (!SAFE_ID.test(runId)) return { error: "invalid run id" };
	try {
		const expected = join(realpathSync(ownedRoot), "runs", runId, "transcripts");
		if (lstatSync(expected).isSymbolicLink() || realpathSync(expected) !== expected)
			return { error: "captured directory resolves outside the owned root" };
		return expected;
	} catch {
		return { error: "captured directory is unavailable" };
	}
}

/** Re-check one manifest file: flat name, regular file, not a link, still the bytes the digest was made from. */
function inspectFile(dir: string, file: { name: string; sha256?: string }): "present" | "gone" | { error: string } {
	if (!SAFE_NAME.test(file.name)) return { error: `unsafe manifest name: ${file.name}` };
	const path = join(dir, file.name);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		return Reflect.get(error as object, "code") === "ENOENT" ? "gone" : { error: `unreadable: ${file.name}` };
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return { error: `not a regular file: ${file.name}` };
	if (file.sha256 !== undefined && sha256(readFileSync(path)) !== file.sha256)
		return { error: `captured copy changed: ${file.name}` };
	return "present";
}

function metricsAndLineage(db: DatabaseSync, revision: string): string | undefined {
	const parses = (value: unknown): boolean => {
		try {
			return typeof value === "string" && JSON.parse(value) !== null;
		} catch {
			return false;
		}
	};
	const metrics = db.prepare("SELECT value FROM metrics WHERE revision_id = ?").all(revision);
	if (!metrics.length || !metrics.every((row) => parses(row.value))) return "metrics are missing or invalid";
	const lineage = db.prepare("SELECT payload FROM participants WHERE revision_id = ?").all(revision);
	if (!lineage.length || !lineage.every((row) => parses(row.payload))) return "lineage is missing or invalid";
	return undefined;
}

/**
 * Validate a digest, persist its bytes durably and record the cleanup receipt (manifest) for this revision.
 * Problem: deleting after "the model returned a path" loses evidence when the file, metrics or source are not
 * what was digested. Solution: every gate runs here, and the receipt row is the only authority runCleanup accepts.
 */
export function commitDigest(
	db: DatabaseSync,
	input: {
		ownedRoot: string;
		digestRoot: string;
		identity: DigestIdentity;
		digest: { text: string; finish: string };
		currentFingerprint: string;
		expectedFiles: readonly string[];
		cursors?: unknown;
		maxChars?: number;
	},
): DigestCommit {
	const { runId, revision } = input.identity;
	const stop = (status: "blocked" | "deferred", reason: string): DigestCommit => ({ status, runId, revision, reason });
	if (!SAFE_ID.test(runId) || !SAFE_ID.test(revision)) return stop("blocked", "invalid run or revision id");
	const validation = validateDigest(input.digest.text, input.identity, input.digest.finish, input.maxChars);
	if (!validation.ok) return stop("blocked", validation.reason);
	const row = db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(revision);
	if (!row || row.run_id !== runId) return stop("blocked", "revision is not recorded for this run");
	if (row.source_hash !== input.currentFingerprint) return stop("deferred", "source revision changed");
	const missing = metricsAndLineage(db, revision);
	if (missing) return stop("blocked", missing);

	const existing = db.prepare("SELECT state, payload FROM cleanup_manifests WHERE id = ?").get(revision);
	const digestHash = sha256(input.digest.text);
	if (existing && typeof existing.payload === "string") {
		const manifest = JSON.parse(existing.payload) as Manifest;
		if (manifest.digestHash !== digestHash) return stop("blocked", "a different digest is already committed");
		return {
			status: "committed",
			runId,
			revision,
			path: manifest.digestPath,
			hash: digestHash,
			files: manifest.files.length,
		};
	}

	const dir = capturedDir(input.ownedRoot, runId);
	if (typeof dir !== "string") return stop("blocked", dir.error);
	const entries = readdirSync(dir).sort();
	const expected = [...input.expectedFiles].sort();
	if (!expected.length || new Set(expected).size !== expected.length)
		return stop("blocked", "no expected captured files");
	if (entries.join("\0") !== expected.join("\0"))
		return stop("blocked", "captured files do not match the expected coverage");
	const files: ManifestFile[] = [];
	for (const name of expected) {
		const checked = inspectFile(dir, { name });
		if (typeof checked === "object") return stop("blocked", checked.error);
		if (checked === "gone") return stop("blocked", `captured file is missing: ${name}`);
		files.push({ name, sha256: sha256(readFileSync(join(dir, name))) });
	}

	const committed = commitArtifact({
		root: join(resolve(input.digestRoot), runId),
		id: revision,
		kind: "digest",
		content: input.digest.text,
	});
	if (sha256(readFileSync(committed.path)) !== digestHash || committed.hash !== digestHash)
		return stop("blocked", "persisted digest bytes do not match");
	const manifest: Manifest = {
		runId,
		revision,
		digestPath: committed.path,
		digestHash,
		files,
		cursors: input.cursors,
		attempts: 0,
	};
	db.prepare(
		"INSERT INTO artifact_commits(id,path,hash,state,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, hash=excluded.hash, state=excluded.state",
	).run(`digest-${revision}`, committed.path, digestHash, "committed", new Date().toISOString());
	db.prepare("INSERT OR IGNORE INTO cleanup_manifests(id, payload, state) VALUES (?, ?, 'committed')").run(
		revision,
		JSON.stringify(manifest),
	);
	return { status: "committed", runId, revision, path: committed.path, hash: digestHash, files: files.length };
}

/** Delete exactly the receipt's files after re-verifying digest bytes, metrics, source revision and every path. */
export function runCleanup(
	db: DatabaseSync,
	input: { ownedRoot: string; id: string; currentFingerprint: string },
): CleanupResult {
	const { id } = input;
	const blocked = (reason: string): CleanupResult => {
		const row = db.prepare("SELECT state, payload FROM cleanup_manifests WHERE id = ?").get(id);
		if (row && row.state !== "cleaned" && typeof row.payload === "string") {
			const manifest = JSON.parse(row.payload) as Manifest;
			manifest.lastError = reason;
			manifest.attempts++;
			db.prepare("UPDATE cleanup_manifests SET state = 'cleanup-failed', payload = ? WHERE id = ?").run(
				JSON.stringify(manifest),
				id,
			);
		}
		return { status: "blocked", id, reason };
	};
	const row = db.prepare("SELECT state, payload FROM cleanup_manifests WHERE id = ?").get(id);
	if (!row || typeof row.payload !== "string") return { status: "blocked", id, reason: "no commit receipt" };
	if (row.state === "cleaned") return { status: "cleaned", id, deleted: 0 };
	const manifest = JSON.parse(row.payload) as Manifest;
	const revision = db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(manifest.revision);
	if (!revision || revision.run_id !== manifest.runId || manifest.revision !== id)
		return blocked("receipt does not match a recorded revision");
	if (revision.source_hash !== input.currentFingerprint) return blocked("source revision changed");
	const missing = metricsAndLineage(db, id);
	if (missing) return blocked(missing);
	try {
		if (sha256(readFileSync(manifest.digestPath)) !== manifest.digestHash)
			return blocked("persisted digest does not match its hash");
	} catch {
		return blocked("persisted digest is unreadable");
	}
	const dir = capturedDir(input.ownedRoot, manifest.runId);
	if (typeof dir !== "string") return blocked(dir.error);
	const present: string[] = [];
	for (const file of manifest.files) {
		const checked = inspectFile(dir, file);
		if (typeof checked === "object") return blocked(checked.error);
		if (checked === "present") present.push(file.name);
	}
	for (const name of present) unlinkSync(join(dir, name));
	try {
		rmdirSync(dir);
	} catch {
		// Not empty or already removed: unlisted files are never deleted.
	}
	manifest.lastError = undefined;
	db.prepare("UPDATE cleanup_manifests SET state = 'cleaned', payload = ? WHERE id = ?").run(
		JSON.stringify(manifest),
		id,
	);
	return { status: "cleaned", id, deleted: present.length };
}

/** Adapter for jobs.ts dispatchCleanup: retries run this code only, never the digest model. */
export function cleanupAdapter(
	db: DatabaseSync,
	options: { ownedRoot: string; currentFingerprint: (revision: string) => string | undefined },
): (request: { id: string; artifactPath: string }) => Promise<"success" | "failure"> {
	return async ({ id, artifactPath }) => {
		const job = db.prepare("SELECT revision_id FROM jobs WHERE id = ?").get(id);
		const revision = typeof job?.revision_id === "string" ? job.revision_id : undefined;
		const fingerprint = revision ? options.currentFingerprint(revision) : undefined;
		const row = revision ? db.prepare("SELECT payload FROM cleanup_manifests WHERE id = ?").get(revision) : undefined;
		if (!revision || fingerprint === undefined || typeof row?.payload !== "string") return "failure";
		if ((JSON.parse(row.payload) as Manifest).digestPath !== artifactPath) return "failure";
		return runCleanup(db, { ownedRoot: options.ownedRoot, id: revision, currentFingerprint: fingerprint }).status ===
			"cleaned"
			? "success"
			: "failure";
	};
}

/**
 * Problem: a later sweep of native transcripts would recapture a discarded revision. Example: the run is resumed
 * with no new activity and the same fingerprint. Solution: capture asks here first; a cleaned fingerprint is "discarded".
 */
export function capturedAdmission(db: DatabaseSync, runId: string, sourceHash: string): "admit" | "discarded" {
	const row = db
		.prepare(
			"SELECT 1 AS hit FROM cleanup_manifests m JOIN revisions r ON r.id = m.id WHERE m.state = 'cleaned' AND r.run_id = ? AND r.source_hash = ?",
		)
		.get(runId, sourceHash);
	return row ? "discarded" : "admit";
}

/** Source cursors retained from the latest cleaned revision, so a reopened run captures only later evidence. */
export function cleanedCursors(db: DatabaseSync, runId: string): unknown {
	const row = db
		.prepare(
			"SELECT m.payload FROM cleanup_manifests m JOIN revisions r ON r.id = m.id WHERE m.state = 'cleaned' AND r.run_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1",
		)
		.get(runId);
	return typeof row?.payload === "string" ? (JSON.parse(row.payload) as Manifest).cursors : undefined;
}
