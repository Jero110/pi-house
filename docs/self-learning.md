# Workflow self-learning

This is the operational guide to the implemented workflow. Module contracts live in [`docs/specs/self-learning/`](specs/self-learning/common.md); decision history is in [ADR-001](decisions/ADR-001-workflow-memory.md) and [ADR-002](decisions/ADR-002-self-learning.md).

## Commands and boundaries

| Command | Effect |
|---|---|
| `/workflow report [--last]` | Code-computed Markdown report and path. Active work is labeled partial; no model call and no enrollment. |
| `/workflow save [reason]` | Explicitly captures an otherwise unselected conversation. |
| `/workflow digest` | Manually digests eligible captured revisions in separate workers. |
| `/workflow self-learning` | Prepares missing digests, scans and reviews a batch in separate workers. Does not apply proposals. |
| `/workflow ask <question>` | Selectively consults retained metrics, digests, proposals, architecture and skills. |
| `/workflow proposals` | Lists proposal status, scope, short version (first 8 hex) and next action. |
| `/workflow approve <id> [version]` / `reject <id> [reason]` | Approves and applies the version shown by `proposals`, passed as its version prefix. Without a version, approves only a proposal never revised since creation and names that version; a revised proposal refuses. Re-running approve on an approved proposal needs no version. Records rejection. |

`/workflow review`, `/keeper`, and `pih keeper` are retired; they return replacement guidance and do not start old jobs. Digest/review work requires a pihouse session with agent-link available. The caller receives concise status and artifact paths, not generated full reports. A run is eligible for cleanup only when participants and delivery state are verifiably quiescent and the evidence fingerprint remains stable. Unknown or live runs stay queued. A digest is a lossy description, not a transcript replacement.

## Data and migration

Canonical documents are readable files. SQLite is authoritative for operational jobs, metrics, decisions and receipts; its FTS5 search index is derived and rebuildable without dropping those records. Ordinary agents receive retrieval tools and a short usage instruction, not automatic memory contents. Source material is attributed and treated as untrusted.

Legacy migration is explicit (`migrateLegacyStore` in `packages/pihouse/src/workflow/migration.ts`); it is not a startup action. It first hashes and copies the legacy tree under `migration-backup/`, imports from verified backup bytes, then writes the active marker. Interrupted incomplete copies are checked and resumed/restarted. Drift from a completed backup refuses activation. Legacy short digests do not authorize deletion; imported applied proposals are marked unverified.

For a store snapshot, use the tested `backupOperationalState` API: it serializes SQLite operational state and copies the canonical artifact directory into a new private destination, refusing to overwrite an existing destination. On failure, inspect and retain the incomplete destination; the helper does not delete it. Restore is an operator-managed restore of the database snapshot and matching artifacts as a consistent pair, after stopping writers and preserving the current store separately. This is not automatic rollback for arbitrary concurrent manual edits, does not restore native harness sessions, and does not erase migration backups. Run the migration/search integrity checks after restoration before resuming mutation.

Proposals are constrained to allowlisted skill and memory targets and checked against the proposal's observed target version. Coordination locks protect cooperating pi-house writers only; they cannot guarantee CAS against arbitrary editors. Approval pins the version the user listed: `approve <id> <version>` refuses, and applies nothing, when the proposal has changed since it was listed. Exact-change deduplication catches identical changes, not every semantically equivalent recommendation. No proposal is automatically applied.

## Runtime limits

Routing selects only explicitly authorized configured profiles and observable compatibility/quota state; unknown availability pauses rather than silently enabling paid access. Native same-harness switching depends on adapter support. Do not infer cross-harness fenced continuation. Optional context monitoring is opt-in and reports a recommendation for manual application; it never switches models automatically. Manual skill expansion and grouped shell display are not supported by pinned pi. The Luna fixture smoke ( [`research/luna-digest-smoke.md`](research/luna-digest-smoke.md) ) is a single synthetic experiment and supports no general cost or quality claim.
