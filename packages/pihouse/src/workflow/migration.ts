// Legacy JSON store -> SQLite authority: backup first, one-transaction import from the backup bytes, then activation.
// Spec: docs/specs/self-learning/memory-store.md, "Legacy migration schema (T5)". Nothing calls this automatically.
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { IndexEntry } from "./memory.ts";
import { openOperationalStore } from "./storage.ts";

export const ACTIVE_MARKER = "migration-active.json";
const BACKUP = "migration-backup";
const INCOMPLETE = "migration-backup.incomplete";
const LEGACY_FILES = ["index.json", "flags.json", "workflow-memory.md"];
const LEGACY_DIRS = ["runs", "digests", "batches", "consulted", "ideas", "proposals", "archive"];

interface ManifestFile {
	path: string;
	sha256: string;
	bytes: number;
}
interface Manifest {
	hash: string;
	files: ManifestFile[];
}

export interface MigrationOptions {
	now?: () => Date;
	/** Test hook called at each crash boundary; throwing simulates a crash there. */
	onBoundary?: (name: string) => void;
}
export interface MigrationResult {
	state: "active";
	manifestHash: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function listFiles(root: string, rel: string, out: string[]): void {
	const abs = join(root, rel);
	const st = lstatSync(abs, { throwIfNoEntry: false });
	if (!st) return;
	if (st.isDirectory()) {
		for (const name of readdirSync(abs).sort()) listFiles(root, `${rel}/${name}`, out);
	} else if (st.isFile()) out.push(rel);
}

/** Hash every legacy file under `root` (the live dir, or a backup's files/ dir). */
function buildManifest(root: string): Manifest {
	const paths: string[] = [];
	for (const f of LEGACY_FILES) listFiles(root, f, paths);
	for (const d of LEGACY_DIRS) listFiles(root, d, paths);
	const files = paths.sort().map((path) => {
		const data = readFileSync(join(root, path));
		return { path, sha256: sha256(data), bytes: data.length };
	});
	return { hash: sha256(JSON.stringify(files)), files };
}

function readManifest(dir: string): Manifest | null {
	try {
		const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
		return Array.isArray(m.files) && typeof m.hash === "string" && sha256(JSON.stringify(m.files)) === m.hash
			? m
			: null;
	} catch {
		return null;
	}
}

function sameFiles(a: Manifest, b: Manifest): boolean {
	return a.hash === b.hash;
}

function atomicWrite(file: string, data: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, data);
	renameSync(`${file}.tmp`, file);
}

function copyAll(dir: string, target: string, manifest: Manifest): void {
	for (const f of manifest.files) {
		mkdirSync(dirname(join(target, "files", f.path)), { recursive: true });
		copyFileSync(join(dir, f.path), join(target, "files", f.path));
	}
}

/** A backup is only trusted when its copied bytes still hash to its own manifest. */
function verifyBackup(backupDir: string, manifest: Manifest): boolean {
	try {
		return sameFiles(buildManifest(join(backupDir, "files")), manifest);
	} catch {
		return false;
	}
}

/**
 * Problem: a crash mid-copy leaves a partial backup; treating it as an error would block every later run.
 * Example: power loss after 3 of 40 files. Solution: only the pihouse-owned `.incomplete` directory is verified
 * against a fresh manifest of the live files and either finished or removed and restarted; a completed backup is
 * never touched.
 */
function ensureBackup(dir: string, hook: (n: string) => void): Manifest {
	const done = join(dir, BACKUP);
	const partial = join(dir, INCOMPLETE);
	if (existsSync(done)) {
		const m = readManifest(done);
		if (!m || !verifyBackup(done, m))
			throw new Error(`Migration backup ${done} is corrupt; restore it before migrating`);
		return m;
	}
	const live = buildManifest(dir);
	if (existsSync(partial)) {
		const m = readManifest(partial);
		if (m && sameFiles(m, live) && verifyBackup(partial, m)) {
			renameSync(partial, done);
			return m;
		}
		rmSync(partial, { recursive: true, force: true });
	}
	mkdirSync(join(partial, "files"), { recursive: true, mode: 0o700 });
	copyAll(dir, partial, live);
	hook("backup-copied");
	if (!verifyBackup(partial, live)) throw new Error("Legacy files changed while they were being backed up; run again");
	atomicWrite(join(partial, "manifest.json"), JSON.stringify(live, null, "\t"));
	hook("backup-manifest");
	renameSync(partial, done);
	hook("backup-complete");
	return live;
}

function json<T>(backupDir: string, rel: string): T | null {
	const file = join(backupDir, "files", rel);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		throw new Error(`Legacy ${rel} in the backup is not valid JSON; refusing to import it as empty`, { cause: error });
	}
}

function summaryOf(md: string): string {
	const m = /## Summary\s*\n\s*\n?([\s\S]*)$/.exec(md);
	return (m ? m[1] : md).trim();
}

/** Everything is `INSERT OR IGNORE` by original id: a second pass over the same backup adds nothing. */
function importAll(db: DatabaseSync, backupDir: string, manifest: Manifest, hook: (n: string) => void): void {
	const hashes = new Map(manifest.files.map((f) => [f.path, f.sha256]));
	const text = (rel: string) => {
		const file = join(backupDir, "files", rel);
		return existsSync(file) ? readFileSync(file, "utf8") : null;
	};
	const index = json<{ entries?: IndexEntry[]; rejected?: string[] }>(backupDir, "index.json");
	const entries = index?.entries ?? [];
	const rejected = new Set(index?.rejected ?? []);
	const insEntry = db.prepare("INSERT OR IGNORE INTO index_entries(id, seq, payload) VALUES (?, ?, ?)");
	const insRec = db.prepare(
		"INSERT OR IGNORE INTO legacy_records(id, kind, rel_path, source_sha256, legacy, coverage, deletion_authority, payload) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
	);
	const insRun = db.prepare("INSERT OR IGNORE INTO runs(id, created_at) VALUES (?, ?)");
	const insRev = db.prepare("INSERT OR IGNORE INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)");
	const insProp = db.prepare("INSERT OR IGNORE INTO proposals(id, state, payload) VALUES (?, ?, ?)");
	entries.forEach((e, i) => {
		insEntry.run(e.id, i, JSON.stringify(e));
		const sourceHash = hashes.get(e.path) ?? null;
		const payload: Record<string, unknown> = { status: e.status };
		let deletion: string | null = null;
		if (e.kind === "run") {
			const runId = e.id.slice("run:".length);
			deletion = "none";
			insRun.run(runId, e.createdAt);
			insRev.run(`legacy:${runId}`, runId, sourceHash ?? "legacy-missing", e.createdAt);
			payload.batchId = e.batchId ?? null;
		}
		if (e.kind === "consulted" || e.kind === "idea") {
			const md = text(e.path);
			payload.indexSummary = e.summary;
			payload.fileSummary = md === null ? null : summaryOf(md);
			const body = text(e.path.replace(/\.md$/, ".txt"));
			payload.bodySha256 = body === null ? null : sha256(body);
		}
		if (e.kind === "proposal") {
			if (e.status === "rejected" && e.fingerprint) rejected.add(e.fingerprint);
			// A legacy "applied" was only ever a flag: no receipt proves the change landed.
			const state = e.status === "applied" ? "legacy-applied-unverified" : e.status;
			insProp.run(
				e.id,
				state,
				JSON.stringify({ entry: e, fingerprint: e.fingerprint ?? null, sourceSha256: sourceHash }),
			);
		}
		insRec.run(e.id, e.kind, e.path, sourceHash, "legacy-unknown", deletion, JSON.stringify(payload));
		if (i === Math.floor(entries.length / 2)) hook("import-mid");
	});
	const insRej = db.prepare("INSERT OR IGNORE INTO rejected_fingerprints(fingerprint) VALUES (?)");
	for (const f of [...rejected].sort()) insRej.run(f);
	const flags = text("flags.json");
	if (flags !== null) {
		db.prepare("INSERT OR IGNORE INTO flags(key, source_sha256, payload) VALUES ('flags.json', ?, ?)").run(
			hashes.get("flags.json") ?? sha256(flags),
			flags,
		);
	}
	for (const f of manifest.files.filter((x) => /^batches\/[^/]+\.json$/.test(x.path))) {
		const b = json<{ id: string; runIds: string[]; state: string; claimedAt: string }>(backupDir, f.path);
		if (!b) continue;
		db.prepare("INSERT OR IGNORE INTO batches(id, created_at, state) VALUES (?, ?, ?)").run(b.id, b.claimedAt, b.state);
		for (const r of b.runIds)
			db.prepare("INSERT OR IGNORE INTO batch_members(batch_id, item_id) VALUES (?, ?)").run(b.id, r);
	}
	if (hashes.has("workflow-memory.md"))
		insRec.run(
			"file:workflow-memory.md",
			"workflow-memory",
			"workflow-memory.md",
			hashes.get("workflow-memory.md") ?? null,
			"legacy-unknown",
			null,
			"{}",
		);
}

export function migrateLegacyStore(dir: string, opts: MigrationOptions = {}): MigrationResult {
	const hook = opts.onBoundary ?? (() => {});
	const stamp = () => (opts.now ?? (() => new Date()))().toISOString();
	const done = join(dir, BACKUP);
	const dbPath = join(dir, "memory.sqlite");
	const markerPath = join(dir, ACTIVE_MARKER);
	let manifest: Manifest;
	let store: ReturnType<typeof openOperationalStore>;
	const open = () => {
		try {
			return openOperationalStore(dbPath, { fts: false, legacy: true });
		} catch (error) {
			throw new Error(`Cannot open ${dbPath}; it is corrupt or unreadable and is not treated as empty`, {
				cause: error,
			});
		}
	};
	const hasState = (db: DatabaseSync, hash: string, state: string) =>
		db.prepare("SELECT 1 FROM legacy_migrations WHERE manifest_hash = ? AND state = ?").get(hash, state) !== undefined;
	const activate = (hash: string) => {
		atomicWrite(markerPath, JSON.stringify({ manifestHash: hash, activatedAt: stamp() }));
		return { state: "active", manifestHash: hash } as const;
	};

	const completed = existsSync(done) ? readManifest(done) : null;
	if (completed && existsSync(dbPath)) {
		store = open();
		try {
			// Once active the live dir legitimately changes, so drift is only checked before activation.
			if (hasState(store.db, completed.hash, "active")) return activate(completed.hash);
		} finally {
			store.close();
		}
	}
	manifest = ensureBackup(dir, hook);
	if (!sameFiles(buildManifest(dir), manifest)) {
		throw new Error(
			`Legacy files in ${dir} drifted from ${done} (manifest ${manifest.hash.slice(0, 12)}); nothing was imported. Restore the files or remove the backup deliberately.`,
		);
	}
	store = open();
	try {
		const db = store.db;
		if (!hasState(db, manifest.hash, "imported")) {
			db.exec("BEGIN IMMEDIATE");
			try {
				importAll(db, done, manifest, hook);
				db.prepare("INSERT OR IGNORE INTO legacy_migrations(manifest_hash, state, at) VALUES (?, 'imported', ?)").run(
					manifest.hash,
					stamp(),
				);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		hook("imported");
		db.prepare("INSERT OR IGNORE INTO legacy_migrations(manifest_hash, state, at) VALUES (?, 'active', ?)").run(
			manifest.hash,
			stamp(),
		);
		hook("activating");
		return activate(manifest.hash);
	} finally {
		store.close();
	}
}
