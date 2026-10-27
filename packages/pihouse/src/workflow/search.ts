import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { IndexEntry } from "./memory.ts";
import { ACTIVE_MARKER } from "./migration.ts";
import { type OperationalStore, openOperationalStore } from "./storage.ts";

export interface SearchDocument {
	id: string;
	path: string;
	kind: string;
	project: string;
	status: string;
	trust: string;
	title: string;
	summary: string;
	provenance: string;
	date: string;
	hash?: string;
}

export interface SearchScope {
	project: string;
	trusts: string[];
	includeGlobal?: boolean;
}

export interface SearchHit {
	id: string;
	kind: string;
	project: string;
	status: string;
	trust: string;
	date: string;
	provenance: string;
	extract: string;
	reason: string;
}

interface Verified {
	doc: SearchDocument;
	hash: string;
	body: string;
}

const SEARCH_SCHEMA = `CREATE TABLE IF NOT EXISTS search_documents (id TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, trust TEXT NOT NULL, date TEXT NOT NULL, provenance TEXT NOT NULL);
		CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(id UNINDEXED, title, summary, body);`;

/** Read and verify before changing the index: a missing or damaged source must not erase the last good index. */
function verify(documents: SearchDocument[]): Verified[] {
	const seen = new Set<string>();
	return documents
		.filter((doc) => doc.kind !== "transcript")
		.map((doc) => {
			if (!doc.id || seen.has(doc.id)) throw new Error(`Duplicate or invalid document ID: ${doc.id}`);
			seen.add(doc.id);
			let bytes: Buffer;
			try {
				bytes = readFileSync(doc.path);
			} catch (error) {
				throw new Error(`Document ${doc.id} cannot be read at ${doc.path}`, { cause: error });
			}
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (doc.hash !== undefined && doc.hash !== hash) throw new Error(`Document hash mismatch: ${doc.id}`);
			return { doc, hash, body: bytes.toString("utf8") };
		});
}

function insertDocument(store: OperationalStore, { doc, hash, body }: Verified): void {
	store.db
		.prepare("INSERT INTO search_documents VALUES (?,?,?,?,?,?,?,?,?)")
		.run(doc.id, doc.path, hash, doc.kind, doc.project, doc.status, doc.trust, doc.date, doc.provenance);
	store.db
		.prepare("INSERT INTO search_fts (id,title,summary,body) VALUES (?,?,?,?)")
		.run(doc.id, doc.title, doc.summary, body);
}

/** Rebuild only derived search tables from the caller's complete canonical inventory. */
export function reconcileSearch(store: OperationalStore, documents: SearchDocument[]): void {
	if (!store.fts.available) throw new Error(store.fts.diagnostic ?? "SQLite FTS5 unavailable");
	const entries = verify(documents);
	const db = store.db;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(`${SEARCH_SCHEMA} DELETE FROM search_fts; DELETE FROM search_documents;`);
		for (const entry of entries) insertDocument(store, entry);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export interface SyncResult {
	mode: "full" | "incremental";
	indexed: number;
	removed: number;
	unchanged: number;
}

/** Index kinds that are retrievable, and the trust each carries; runs and their transcripts are never listed. */
const KIND_TRUST: Record<string, string> = {
	digest: "derived",
	batch: "derived",
	proposal: "derived",
	idea: "derived",
	consulted: "external",
};

function inside(root: string, rel: string): string {
	const path = resolve(root, rel);
	if (isAbsolute(rel) || !path.startsWith(`${root}${sep}`) || path.split(sep).includes("transcripts"))
		throw new Error(`Index path is outside the memory directory: ${rel}`);
	return path;
}

/** The inventory comes from the activated store's own index, never from a caller-supplied list. */
function inventory(root: string, entries: IndexEntry[]): SearchDocument[] {
	const docs: SearchDocument[] = [];
	for (const e of entries) {
		const trust = KIND_TRUST[e.kind];
		if (!trust) continue;
		let path = inside(root, e.path);
		// A consulted note's .md holds the summary; the fetched text next to it is the body worth searching.
		if (e.kind === "consulted") {
			const text = path.replace(/\.md$/, ".txt");
			if (existsSync(text)) path = text;
		}
		// An approved or applied proposal is a decision; an open or rejected one is not knowledge.
		const decided = e.status === "approved" || e.status === "applied";
		docs.push({
			id: e.id,
			path,
			kind: e.kind,
			project: e.projectSlug || e.project || "global",
			status: e.kind === "proposal" && decided ? "active" : e.status,
			trust,
			title: e.title,
			summary: e.summary,
			provenance: `${e.kind} ${e.id} (${e.createdAt})`,
			date: e.createdAt,
		});
	}
	return docs;
}

function openActivated(root: string): OperationalStore {
	const dbPath = join(root, "memory.sqlite");
	if (!existsSync(join(root, ACTIVE_MARKER)))
		throw new Error(`${root} is not activated; run the legacy migration before searching memory`);
	if (!existsSync(dbPath))
		throw new Error(`${dbPath} is missing but the store was migrated to it; restore it from migration-backup`);
	let store: OperationalStore | undefined;
	try {
		store = openOperationalStore(dbPath, { legacy: true });
		if (store.db.prepare("SELECT 1 FROM legacy_migrations WHERE state = 'active'").get() === undefined)
			throw new Error("no active migration row");
		const check = store.db.prepare("PRAGMA quick_check").get();
		if (Object.values(check ?? {})[0] !== "ok") throw new Error("integrity check failed");
	} catch (error) {
		store?.close();
		throw new Error(`${dbPath} is corrupt or not an activated store; it is not treated as empty`, { cause: error });
	}
	if (!store.fts.available) {
		const diagnostic = store.fts.diagnostic ?? "SQLite FTS5 unavailable";
		store.close();
		throw new Error(diagnostic);
	}
	return store;
}

/**
 * Problem: reindexing every body on each call makes search cost grow with history; example: 5k digests re-read per
 * query. Solution: compare each file's sha256 and metadata with the stored row and touch only what changed.
 * A damaged or missing search structure falls back to a full rebuild; operational tables are never written.
 * Verification happens before any write, so a missing or corrupt document keeps the last good index.
 */
export function syncSearchIndex(memoryDir: string, options: { full?: boolean } = {}): SyncResult {
	const root = resolve(memoryDir);
	const store = openActivated(root);
	try {
		return syncOpen(store, root, options.full === true);
	} finally {
		store.close();
	}
}

interface StoredRow {
	id: string;
	hash: string;
	path: string;
	kind: string;
	project: string;
	status: string;
	trust: string;
	date: string;
	provenance: string;
	title: string;
	summary: string;
}

function unchanged(old: StoredRow | undefined, v: Verified): boolean {
	const d = v.doc;
	return (
		old !== undefined &&
		old.hash === v.hash &&
		old.path === d.path &&
		old.kind === d.kind &&
		old.project === d.project &&
		old.status === d.status &&
		old.trust === d.trust &&
		old.date === d.date &&
		old.provenance === d.provenance &&
		old.title === d.title &&
		old.summary === d.summary
	);
}

function syncOpen(store: OperationalStore, root: string, full: boolean): SyncResult {
	const db = store.db;
	const entries = (db.prepare("SELECT payload FROM index_entries ORDER BY seq").all() as { payload: string }[]).map(
		(r) => JSON.parse(r.payload) as IndexEntry,
	);
	const verified = verify(inventory(root, entries));
	// A hash recorded when a document was committed outranks the bytes found now.
	const committed = new Map(
		(
			db.prepare("SELECT path,hash FROM artifact_commits WHERE state='committed'").all() as {
				path: string;
				hash: string;
			}[]
		).map((r) => [r.path, r.hash]),
	);
	for (const v of verified) {
		const expected = committed.get(v.doc.path);
		if (expected !== undefined && expected !== v.hash) throw new Error(`Document hash mismatch: ${v.doc.id}`);
	}
	let existing: Map<string, StoredRow> | null = null;
	if (!full) {
		try {
			const rows = db
				.prepare("SELECT d.*, f.title, f.summary FROM search_documents d JOIN search_fts f ON f.id = d.id")
				.all() as unknown as StoredRow[];
			const count = Number(db.prepare("SELECT count(*) AS n FROM search_fts").get()?.n);
			if (count === rows.length) existing = new Map(rows.map((r) => [r.id, r]));
		} catch {
			existing = null;
		}
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		if (!existing) {
			db.exec(`DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_documents; ${SEARCH_SCHEMA}`);
			for (const v of verified) insertDocument(store, v);
			db.exec("COMMIT");
			return { mode: "full", indexed: verified.length, removed: 0, unchanged: 0 };
		}
		const keep = new Set(verified.map((v) => v.doc.id));
		let removed = 0;
		for (const id of existing.keys()) {
			if (keep.has(id)) continue;
			db.prepare("DELETE FROM search_fts WHERE id = ?").run(id);
			db.prepare("DELETE FROM search_documents WHERE id = ?").run(id);
			removed++;
		}
		let indexed = 0;
		for (const v of verified) {
			if (unchanged(existing.get(v.doc.id), v)) continue;
			db.prepare("DELETE FROM search_fts WHERE id = ?").run(v.doc.id);
			db.prepare("DELETE FROM search_documents WHERE id = ?").run(v.doc.id);
			insertDocument(store, v);
			indexed++;
		}
		db.exec("COMMIT");
		return { mode: "incremental", indexed, removed, unchanged: verified.length - indexed };
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** Sync (unless told not to) and search an activated store; the scope is the trusted launch scope. */
export function searchMemory(
	memoryDir: string,
	query: string,
	scope: SearchScope,
	limit = 6,
	options: { sync?: boolean } = {},
): SearchHit[] {
	const root = resolve(memoryDir);
	const store = openActivated(root);
	try {
		if (options.sync !== false) syncOpen(store, root, false);
		return searchDocuments(store, query, scope, limit);
	} finally {
		store.close();
	}
}

/** The scope is supplied by a trusted caller, never directly by a model. */
export function searchDocuments(store: OperationalStore, query: string, scope: SearchScope, limit = 6): SearchHit[] {
	if (!store.fts.available) throw new Error(store.fts.diagnostic ?? "SQLite FTS5 unavailable");
	if (!scope.project || scope.trusts.length === 0 || !Number.isFinite(limit)) return [];
	// Treat user input as text, not FTS syntax. An unmatched quote is invalid rather than a database error.
	if (query.length > 512 || (query.match(/"/g)?.length ?? 0) % 2 !== 0) return [];
	const parts = query.match(/"[^"]*"|[\p{L}\p{N}_]+/gu);
	if (!parts || parts.length > 32) return [];
	const terms = parts.map((part) => part.match(/[\p{L}\p{N}_]+/gu)?.join(" ") ?? "");
	if (terms.some((term) => !term)) return [];
	const expression = terms.map((term) => `"${term}"`).join(" AND ");
	const count = Math.max(0, Math.min(6, Math.floor(limit)));
	if (count === 0) return [];
	const placeholders = scope.trusts.map(() => "?").join(",");
	const rows = store.db
		.prepare(`SELECT d.id,d.kind,d.project,d.status,d.trust,d.date,d.provenance,
		snippet(search_fts, -1, '', '', ' … ', 32) AS extract
		FROM search_fts JOIN search_documents d ON d.id = search_fts.id
		WHERE search_fts MATCH ? AND d.status = 'active' AND d.kind != 'transcript'
		AND (d.project = ? OR (? = 1 AND d.project = 'global')) AND d.trust IN (${placeholders})
		ORDER BY bm25(search_fts, 0, 3, 2, 1), d.id LIMIT ?`)
		.all(expression, scope.project, scope.includeGlobal ? 1 : 0, ...scope.trusts, count);
	let remaining = 6000;
	return rows.map((row) => {
		const extract = String(row.extract).slice(0, Math.min(1000, remaining));
		remaining -= extract.length;
		return {
			id: String(row.id),
			kind: String(row.kind),
			project: String(row.project),
			status: String(row.status),
			trust: String(row.trust),
			date: String(row.date),
			provenance: String(row.provenance).slice(0, 512),
			extract,
			reason: "BM25 text match",
		};
	});
}
