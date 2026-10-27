# Specification: memory-store

Status: proposed. Module: `memory-store`; depends on `run-evidence`. Shared engineering contract: `common.md`.

## Objective

Provide a local, concurrency-safe knowledge store with readable canonical documents, durable operational state and a rebuildable FTS5 index. No hosted service, vector DB or embedding provider by default.

## Structure and contracts

Primary integration: current `workflow/memory.ts` and new focused storage/migration modules under `workflow/`; use `node:sqlite` already present in the repository. All clients use a shared library, not arbitrary writes to index files. The hub does not own memory storage.

Proposed logical layout, preserving existing paths where possible:

```text
$PIHOUSE_HOME/memory/
  memory.sqlite                 operational tables + derived FTS tables
  runs/<run-id>/                pending captured evidence only
  digests/<run-id>/<revision>.md canonical compact evidence
  reviews/<batch-id>.md          canonical cross-run reasoning
  proposals/<id>.md              canonical proposed change and evidence
  consulted/                    attributed sources
  ideas/                        unpromoted ideas
  workflow-memory.md            approved compact memory projection
```

Operational tables cover schema version/migrations, run revisions, participant relationships and metric rows, jobs/claims/attempts/errors, batch membership, candidate/proposal states, decisions, application receipts and document commit/cleanup manifests. Search tables contain document ID/path, content hash, kind, project/scope, trust, status, dates, title/summary/body and FTS5 mappings. Exact SQL is an implementation design artifact governed by these contracts; indexes/foreign keys preserve integrity.

Canonical documents carry schema version, stable ID, run/revision/project scope, timestamps, status, provenance, candidate IDs where applicable and structured section boundaries. Operational state is authoritative for scheduling/decisions. Conflicting file metadata must be surfaced and reconciled, not silently override approvals. The compact memory projection is derived from approved records, not independent model-authored authority.

Use transactions for short DB state changes; immutable or hash-checked canonical writes with unique temp names, lock/lease coordination and a recoverable commit manifest for file/DB boundaries. Claims use atomic ownership, expiration/heartbeat and idempotency keys. A deleted/corrupt DB is not treated as an empty store. Rebuilding FTS never drops operational tables. Document hashes repair lagging indexes; DB failure disables unsafe mutation/cleanup and produces actionable diagnostics.

Startup verifies FTS5 availability in the actual runtime. Database and documents remain local/private; paths and IDs are validated and scoped. Document content is untrusted data by default, with separate user/asserted, derived and externally sourced provenance. Search never promotes instructions by itself.

## Operational schema v1 (T3)

`memory.sqlite` uses `schema_migrations(version, applied_at)` as the migration ledger. Version 1 adds `runs`, immutable `revisions`, `participants`, structured `metrics`, `jobs`, `batches` and `batch_members`, `proposals`, `receipts`, `artifact_commits`, and `cleanup_manifests`. Stable text primary keys are caller-generated; foreign keys are enabled for every connection. Migration DDL is additive and the version ledger update uses a short `BEGIN IMMEDIATE` transaction with rollback on failure. SQLite FTS5 is probed independently and reported as a capability; an unavailable runtime must not trigger index rebuild or cleanup.

`backupOperationalState` writes a serialized SQLite snapshot (all operational tables, including claims, metrics, decisions and receipts) and copies the canonical artifact directory into a new private destination. It refuses an existing destination; on failure it reports the incomplete destination and leaves it for inspection rather than deleting possible evidence. This is a local snapshot primitive, not an automated retention policy.

Canonical artifacts use validated stable IDs, private 0700 directories and 0600 unique temporary files. A hash-bearing sidecar manifest is atomically renamed before/after the canonical artifact; recovery verifies bytes and path containment before reconciling the operational commit row. A hash mismatch is an error, not an empty-memory result.

## Legacy migration schema v2 (T5)

`migrateLegacyStore(dir)` (`workflow/migration.ts`) is an explicit entry point; nothing calls it automatically. Order: (1) copy every legacy file (`index.json`, `flags.json`, `workflow-memory.md`, `runs/`, `digests/`, `batches/`, `consulted/`, `ideas/`, `proposals/`, `archive/`) into `migration-backup.incomplete/files/` with a `manifest.json` (path, sha256, bytes; manifest hash), then rename to `migration-backup/`. A leftover `.incomplete` directory is verified against a fresh manifest of the live files: finished if it matches, else removed and restarted. A completed backup is never rewritten; if live bytes drift from it before activation the run stops with a diagnosed error. (2) One `BEGIN IMMEDIATE` transaction imports from the backup bytes, all `INSERT OR IGNORE` by original id, and records `legacy_migrations(manifest_hash, 'imported')`. (3) A separate `'active'` row and the `migration-active.json` marker activate the store.

Schema v2 tables (additive): `index_entries(id, seq, payload)` (live index), `rejected_fingerprints`, `flags`, `legacy_records(id, kind, rel_path, source_sha256, legacy, coverage, deletion_authority, payload)`, `legacy_migrations`. Every imported run is `legacy=1`, `coverage='legacy-unknown'`, `deletion_authority='none'`; a short old digest is never deletion authority and no transcript is reread. Legacy `applied` proposals import as `legacy-applied-unverified` with no receipt. Consulted/idea rows keep the index summary, the file summary and the body sha256.

After activation `openMemory` reads and writes the index through SQLite, one `BEGIN IMMEDIATE` per store call, so concurrent writers lose nothing. A missing or corrupt `memory.sqlite` is an error, never an empty memory or a JSON fallback. `index.json` and the backup remain as export only.

## Success criteria / tests first

- Two independent processes cannot claim the same revision or lose another capture's update.
- Simulated failures before/after document rename, DB commit and cleanup receipt recover without lost digests, duplicate batches or false success.
- A corrupt index produces a diagnostic and reconstruction path, never silent empty memory or deletion.
- FTS reconstruction preserves job attempts, metrics, rejections and application receipts.
- Scoped BM25 search covers bodies, returns bounded extract/provenance and excludes inactive or unauthorized records.
- A late update invalidates a stale hash-based mutation; unique temporary paths prevent cross-writer overwrite.
- Existing JSON-index stores migrate idempotently without deleting source data or accepting unavailable transcripts as verified evidence.

Validation: temporary file/SQLite integration tests and fake failure injection; `npm run check` and `npm test`. Database backups must cover durable operational state, not only Markdown.
