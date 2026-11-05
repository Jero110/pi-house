// The stage of each run revision: captured, compacted or reviewed. Spec: docs/specs/self-learning/vault-review.md,
// "The run_stages table". The table belongs to the operational store; nothing here reads conversation text.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { IndexEntry } from "./memory.ts";

export type RunStage = "captured" | "compacted" | "reviewed";

export interface CompactRecord {
	revisionId: string;
	/** Relative to the vault root, e.g. workflow/compact/run-a.r2.md. */
	compactPath: string;
	/** SHA-256 hex of the compact file bytes. */
	compactHash: string;
	/** The evidence fingerprint of the revision the compact was made from. */
	compactFingerprint: string;
	compactedBy: "review" | "ask";
	/** ISO 8601 UTC. */
	compactedAt: string;
	/** One line for the index and search; defaults to the revision id. */
	summary?: string;
}

export interface PendingRevision {
	revisionId: string;
	runId: string;
	project: string;
	/** The revision's evidence fingerprint. */
	fingerprint: string;
	stage: "captured" | "compacted";
}

export interface PendingOptions {
	/**
	 * Whether a run still has live agents. The database cannot know; the caller passes the same check the digest flow
	 * used (`operationalState` + `isQuiescent`). Without it no run is treated as active.
	 */
	isActive?: (runId: string) => boolean;
}

export interface UncompactedOptions extends PendingOptions {
	/** The vault root. With it a compact file must also hash to `compact_hash`; without it only the row is checked. */
	root?: string;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Runs `work` in one BEGIN IMMEDIATE transaction, or joins the caller's. */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
	if (db.isTransaction) return work();
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

interface StageRow {
	compact_path: string;
	compact_hash: string;
	compact_fingerprint: string;
	reviewed_at: string | null;
}

const rowOf = (db: DatabaseSync, revisionId: string): StageRow | undefined =>
	db
		.prepare(
			"SELECT compact_path, compact_hash, compact_fingerprint, reviewed_at FROM run_stages WHERE revision_id = ?",
		)
		.get(revisionId) as StageRow | undefined;

export function stageOf(db: DatabaseSync, revisionId: string): RunStage {
	const row = rowOf(db, revisionId);
	if (!row) return "captured";
	return row.reviewed_at === null ? "compacted" : "reviewed";
}

/** The project a revision belongs to, from the evidence persisted at capture. Empty when unknown. */
function projectOf(db: DatabaseSync, revisionId: string): string {
	const row = db.prepare("SELECT value FROM metrics WHERE revision_id = ? AND kind = 'run.lineage'").get(revisionId);
	if (typeof row?.value !== "string") return "";
	try {
		const value: unknown = JSON.parse(row.value);
		const project = typeof value === "object" && value !== null ? Reflect.get(value, "project") : undefined;
		return typeof project === "string" ? project : "";
	} catch {
		return "";
	}
}

/**
 * Inserts the row, or replaces it while the revision is not reviewed; a reviewed row is never overwritten.
 * Problem: a second compact (made by ask after review made one, or a redo of a stale one) must not undo a review.
 * Example: revision run-a.r2 is reviewed; ask compacts the project again and would reset `reviewed_at`.
 * Solution: refuse. Also upserts the index entry that makes the compact searchable.
 */
export function recordCompact(db: DatabaseSync, input: CompactRecord): void {
	inTransaction(db, () => {
		const existing = rowOf(db, input.revisionId);
		if (existing && existing.reviewed_at !== null)
			throw new Error(`Revision ${input.revisionId} is reviewed; its compact is not replaced`);
		if (!db.prepare("SELECT 1 FROM revisions WHERE id = ?").get(input.revisionId))
			throw new Error(`Unknown revision ${input.revisionId}`);
		db.prepare(
			`INSERT INTO run_stages(revision_id, compact_path, compact_hash, compact_fingerprint, compacted_by, compacted_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(revision_id) DO UPDATE SET compact_path = excluded.compact_path, compact_hash = excluded.compact_hash,
			compact_fingerprint = excluded.compact_fingerprint, compacted_by = excluded.compacted_by,
			compacted_at = excluded.compacted_at, review_id = NULL, reviewed_at = NULL`,
		).run(
			input.revisionId,
			input.compactPath,
			input.compactHash,
			input.compactFingerprint,
			input.compactedBy,
			input.compactedAt,
		);
		const project = projectOf(db, input.revisionId);
		const entry: IndexEntry = {
			id: `compact:${input.revisionId}`,
			kind: "compact",
			project,
			projectSlug: basename(project),
			title: `Compact: ${input.revisionId}`,
			summary: (input.summary ?? `Compact version of ${input.revisionId}`).slice(0, 200),
			status: "active",
			path: input.compactPath,
			createdAt: input.compactedAt,
			lastUsedAt: input.compactedAt,
		};
		db.prepare(
			`INSERT INTO index_entries(id, seq, payload) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM index_entries), ?)
			ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
		).run(entry.id, JSON.stringify(entry));
	});
}

/**
 * A compact is valid when its row exists, it was made from the revision's current evidence and, given the vault root,
 * the file still hashes to the recorded hash. Anything else is stale: not used, not indexed, never a deletion gate.
 */
export function isValidCompact(db: DatabaseSync, revisionId: string, root?: string): boolean {
	const row = rowOf(db, revisionId);
	if (!row) return false;
	const revision = db.prepare("SELECT source_hash FROM revisions WHERE id = ?").get(revisionId);
	if (revision?.source_hash !== row.compact_fingerprint) return false;
	if (root === undefined) return true;
	try {
		return sha256(readFileSync(join(root, ...row.compact_path.split("/")))) === row.compact_hash;
	} catch {
		return false;
	}
}

/**
 * The newest revision of each run that is captured, not active and not reviewed. Older revisions of a run are
 * superseded and never listed; a run captured again after its review comes back as its new revision.
 */
export function pendingForReview(db: DatabaseSync, project?: string, options: PendingOptions = {}): PendingRevision[] {
	const rows = db
		.prepare(
			`SELECT r.id, r.run_id, r.source_hash, s.reviewed_at, s.revision_id AS staged FROM revisions r
			LEFT JOIN run_stages s ON s.revision_id = r.id
			WHERE r.rowid = (SELECT r2.rowid FROM revisions r2 WHERE r2.run_id = r.run_id ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)
			ORDER BY r.created_at, r.rowid`,
		)
		.all();
	const out: PendingRevision[] = [];
	for (const row of rows) {
		if (row.reviewed_at !== null) continue;
		const revisionId = String(row.id);
		const runId = String(row.run_id);
		const owner = projectOf(db, revisionId);
		if (project !== undefined && owner !== project) continue;
		if (options.isActive?.(runId)) continue;
		out.push({
			revisionId,
			runId,
			project: owner,
			fingerprint: String(row.source_hash),
			stage: row.staged === null ? "captured" : "compacted",
		});
	}
	return out;
}

/** The pending revisions of one project that have no valid compact. */
export function uncompactedForProject(
	db: DatabaseSync,
	project: string,
	options: UncompactedOptions = {},
): PendingRevision[] {
	return pendingForReview(db, project, options).filter((p) => !isValidCompact(db, p.revisionId, options.root));
}

/**
 * Sets `review_id` and `reviewed_at` together for exactly these revisions, in one transaction. A revision without a
 * row was never compacted, so no review can have covered it: the whole call is refused and nothing changes.
 */
export function markReviewed(db: DatabaseSync, revisionIds: readonly string[], reviewId: string, at?: Date): void {
	const stamp = (at ?? new Date()).toISOString();
	inTransaction(db, () => {
		const update = db.prepare("UPDATE run_stages SET review_id = ?, reviewed_at = ? WHERE revision_id = ?");
		for (const revisionId of revisionIds) {
			if (update.run(reviewId, stamp, revisionId).changes !== 1)
				throw new Error(`Revision ${revisionId} has no run_stages row; it was not compacted`);
		}
	});
}
