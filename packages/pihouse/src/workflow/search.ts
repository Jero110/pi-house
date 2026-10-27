import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OperationalStore } from "./storage.ts";

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

/** Rebuild only derived search tables from the caller's complete canonical inventory. */
export function reconcileSearch(store: OperationalStore, documents: SearchDocument[]): void {
	if (!store.fts.available) throw new Error(store.fts.diagnostic ?? "SQLite FTS5 unavailable");
	// Read and verify before changing the index: a missing or damaged source must not erase the last good index.
	const seen = new Set<string>();
	const entries = documents
		.filter((doc) => doc.kind !== "transcript")
		.map((doc) => {
			if (!doc.id || seen.has(doc.id)) throw new Error(`Duplicate or invalid document ID: ${doc.id}`);
			seen.add(doc.id);
			const bytes = readFileSync(doc.path);
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (doc.hash !== undefined && doc.hash !== hash) throw new Error(`Document hash mismatch: ${doc.id}`);
			return { doc, hash, body: bytes.toString("utf8") };
		});
	const db = store.db;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(`CREATE TABLE IF NOT EXISTS search_documents (id TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, trust TEXT NOT NULL, date TEXT NOT NULL, provenance TEXT NOT NULL);
		CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(id UNINDEXED, title, summary, body);
		DELETE FROM search_fts; DELETE FROM search_documents;`);
		const metadata = db.prepare("INSERT INTO search_documents VALUES (?,?,?,?,?,?,?,?,?)");
		const fts = db.prepare("INSERT INTO search_fts (id,title,summary,body) VALUES (?,?,?,?)");
		for (const { doc, hash, body } of entries) {
			metadata.run(doc.id, doc.path, hash, doc.kind, doc.project, doc.status, doc.trust, doc.date, doc.provenance);
			fts.run(doc.id, doc.title, doc.summary, body);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
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
