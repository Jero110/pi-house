import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OperationalStore {
	db: DatabaseSync;
	version: number;
	fts: { available: boolean; diagnostic?: string };
	close(): void;
}

export function backupOperationalState(db: DatabaseSync, artifactRoot: string, destination: string): void {
	if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(`${destination}/memory.sqlite`, db.serialize(), { flag: "wx", mode: 0o600 });
		if (existsSync(artifactRoot))
			cpSync(artifactRoot, `${destination}/documents`, { recursive: true, errorOnExist: true, force: false });
	} catch (error) {
		throw new Error(`Operational backup is incomplete at ${destination}; preserve it for inspection`, { cause: error });
	}
}

/**
 * Schema v2 (T5), additive: the live index after a legacy migration, rejected fingerprints, per-item legacy
 * records (coverage and deletion authority) and the migration ledger.
 * Problem: a JSON index read and written in two steps loses one of two concurrent updates; example: two panes add an
 * idea at once. Solution: after activation the index lives in these tables and each mutation is one BEGIN IMMEDIATE.
 */
const SCHEMA_V2 = `CREATE TABLE IF NOT EXISTS index_entries(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS rejected_fingerprints(fingerprint TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS flags(key TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS legacy_records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, rel_path TEXT, source_sha256 TEXT, legacy INTEGER NOT NULL DEFAULT 1, coverage TEXT NOT NULL, deletion_authority TEXT, payload TEXT NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS legacy_migrations(manifest_hash TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(manifest_hash, state));`;

export function openOperationalStore(
	path: string,
	options: { fts?: boolean; legacy?: boolean } = {},
): OperationalStore {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), source_hash TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(id), role TEXT NOT NULL, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metrics(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(id), kind TEXT NOT NULL, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, revision_id TEXT REFERENCES revisions(id), state TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS batch_members(batch_id TEXT NOT NULL REFERENCES batches(id), item_id TEXT NOT NULL, PRIMARY KEY(batch_id,item_id));
 CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS artifact_commits(id TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cleanup_manifests(id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);`);
	const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
	if (!applied) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}
	let version = 1;
	if (options.legacy) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(SCHEMA_V2);
			db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(
				new Date().toISOString(),
			);
			db.exec("COMMIT");
			version = 2;
		} catch (error) {
			db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}
	let fts: OperationalStore["fts"] = { available: false, diagnostic: "FTS5 capability check was not completed" };
	if (options.fts !== false) {
		try {
			db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(content)");
			db.exec("DROP TABLE capability_fts");
			fts = { available: true };
		} catch (error) {
			fts = { available: false, diagnostic: `SQLite FTS5 is unavailable: ${String(error)}` };
		}
	}
	return { db, version, fts, close: () => db.close() };
}
