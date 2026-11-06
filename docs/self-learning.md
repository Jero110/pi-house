# Workflow self-learning

This is the operational guide to the implemented workflow. The contract for the current loop is the specification [vault-review](specs/self-learning/vault-review.md); decision history is in [ADR-004](decisions/ADR-004-vault-review.md) (the current loop), [ADR-002](decisions/ADR-002-self-learning.md) and [ADR-001](decisions/ADR-001-workflow-memory.md). The older module specifications in [`docs/specs/self-learning/`](specs/self-learning/common.md) remain as history where ADR-004 supersedes them.

## The loop

1. **Capture, by itself.** Planner and executor sessions (named `workflow-...`) are captured after every answer and when the session closes. Any other session is captured only by `/workflow log [reason]`. Capture is code: it writes `report.md` (a code-computed report for the human), `run.json` and a full copy of the conversation. No model runs.
2. **Compact.** Each captured revision gets one compact version: a Facts part computed by code (agents, roles, harnesses, models, tokens, skills, plan, duration) and six sections written by a model (objective, requests, decisions, failures, skills and MCP, workflow). A compact is at most 6,000 characters, is validated by code and is read from the transcripts only, never from `report.md`.
3. **Review.** `/workflow review` counts the saved runs that are waiting, asks for confirmation, compacts those without a valid compact (up to 3 in parallel), then one review agent reads the new compacts and the latest review and writes the next review (at most 12,000 characters) with bounded proposals. The latest review carries the essentials of the previous one forward, so older reviews are never read.
4. **Delete the full conversation.** Only after the review that covered a run was written and its proposals ingested. The compact stays.
5. **Proposals.** You approve or reject each one; an approved proposal is applied literally.

## Commands and boundaries

| Command | Effect |
|---|---|
| `/workflow log [reason]` | Captures the current session, which is otherwise not captured. Renames it `workflow-saved · <title>` if it was not a workflow session. No model call. |
| `/workflow review [--yes]` | Compacts and reviews the saved runs, writes the review, ingests proposals and deletes the covered full conversations. Uses model quota. With a dialog it asks you to confirm the count; without one it prints the count and starts nothing until you run it again with `--yes`. |
| `/workflow ask <question>` | Answers from compacts, reviews, ideas and consulted sources. When saved runs of the current project have no compact, the model asks once whether to compact them. Never deletes anything and never marks a run reviewed. |
| `/workflow proposals [id]` | Without an id, lists proposals. With one, shows it in full with the absolute path and a diff. |
| `/workflow approve <id> [version]` / `reject <id> [reason]` | Approves and applies the version shown by `proposals`, passed as its version prefix (at least 4 hex characters). Without a version, approves only a proposal never revised since creation and names that version; a revised proposal refuses. Re-running approve on an approved proposal needs no version. Records rejection. |

`/workflow report`, `save`, `digest` and `self-learning` are retired, as are `/keeper` and `pih keeper`: each prints replacement guidance, starts nothing and has no alias. Reviewing and compacting need a pihouse session with agent-link available; without the hub they say so and start nothing. They run on `claude-bridge/claude-sonnet-5-5`; `PIHOUSE_LEARNING_MODEL` overrides it.

## Vault layout

Everything is under `~/.pihouse/memory/` (or `$PIHOUSE_HOME/memory/`). One module, `packages/pihouse/src/workflow/vault-paths.ts`, knows these paths.

```
memory/
|-- README.md             written by code; one line per folder, temporary or permanent
|-- conversations/        FROM CONVERSATIONS
|   `-- <run id>/         report.md, run.json, transcripts/ (full copy, temporary)
|-- workflow/             FROM THE WORKFLOW, permanent
|   |-- compact/          <revision id>.md, one per revision
|   |-- reviews/          review-<UTC timestamp>.md
|   |-- proposals/        <proposal id>/ backups of files a proposal changed
|   `-- approved-records/
|-- ask/                  FROM ASK
|   |-- consulted/        sources fetched from links
|   `-- ideas/            ideas written from them
|-- migration-backup/     old backups, never touched
`-- memory.sqlite         numbers, stages, jobs, proposals, receipts; never conversation text
```

## Stages

A revision is `captured` (no stage row), `compacted` (a `run_stages` row, not yet reviewed) or `reviewed`. A compact is valid only while its file still hashes to the recorded SHA-256 and was made from the revision's current evidence fingerprint; otherwise it is stale, is not used or searched, and the next review makes it again. A run captured again gets a new revision, which is pending again; older revisions of a run are never reviewed on their own.

## When the full conversation is deleted

Per run, only when all of these hold: the compact is valid; the review that covered the run was written and its proposals ingested; the run is quiescent; its current evidence fingerprint still equals the compacted one; and a persisted receipt lists the files with their SHA-256. A compact made by `ask` alone never authorizes a deletion. Only pi-house-owned copies in `conversations/<run id>/transcripts/` are removed. Native harness sessions, project files, `run.json`, `report.md`, compacts, reviews and backups are never deleted. If a review fails at any step, every run stays `compacted` with its conversation, and the next review resumes. A cleanup blocked for one run (for example it became active between the mark and the delete) keeps that conversation and is reported. The run is already reviewed, so a later `/workflow review` does not offer it again and no command retries the deletion yet; the leftover copy is under `conversations/<run id>/transcripts/` and is yours to remove.

## Real limits

- **No review lock.** Two `/workflow review` calls started at once are not serialized. Run one at a time.
- **Journal required to be offered.** Whether a run is still active comes from the agent-link journal. A run whose journal records are gone cannot be shown to be quiescent, so it is treated as active: it is not offered for compacting or review and its conversation is not deleted.
- **Review input is bounded to 60,000 characters** (the latest review plus the new compacts). Compacts go in oldest first; once one does not fit, it and every later one are deferred to the next review and stay `compacted`. Only the runs that fit are covered and cleaned. A previous review that leaves no room for any compact makes the review fail.
- **Limits are not truncation.** A compact over 6,000 characters or a review over 12,000 is invalid and nothing is written; the revision stays uncompacted.
- **Ask matches any word.** It searches compacts, reviews, ideas and consulted sources for any of the first 16 distinct words of three or more characters (an OR search), returns at most 6 records and keeps its whole context under 80,000 characters. The question is cut at 2,000 characters. It is a keyword search, not semantic: a record that uses other words is not found. It never reads a transcript.
- **Ask can only compact the current project**, and only runs that are saved, not active and without a valid compact. Saying no compacts nothing.
- **Proposal ids are shown shortened.** `proposals` and the end of a review show `proposal-` plus the first 6 characters of the hash, extended only when two ids would collide. The version is 8 hex characters. `approve` accepts any unique id prefix.
- **A `file:` proposal may change any existing regular file** you can write by absolute path, except a short forbidden list of credentials (`auth.json`, `mcp-auth.json`, `.env` and `.env.*` but not `.env.example`, `*.pem`, `id_rsa*`, `id_ed25519*`, and anything under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pihouse/agent/auth*`, `~/.pi/agent/auth*`). Symlinks are refused. If you approve it, it is applied.
- **Capture at close is best effort.** The capture at session close is synchronous and any failure is swallowed; a missed one is captured by the next per-answer capture of that session, and a session that never answers again keeps what its last successful capture saved. The hub's own event log (`events.sqlite`) is not read by the review.
- **A compact and a review are lossy descriptions**, not a transcript replacement. Once the conversation is deleted, only the compact remains.

## Data and migration

Canonical documents are readable files. SQLite is authoritative for operational jobs, metrics, decisions and receipts; its FTS5 search index is derived and rebuildable without dropping those records. Ordinary agents receive retrieval tools and a short usage instruction, not automatic memory contents. Source material is attributed and treated as untrusted.

Legacy migration is explicit (`migrateLegacyStore` in `packages/pihouse/src/workflow/migration.ts`); it is not a startup action. It first hashes and copies the legacy tree under `migration-backup/`, imports from verified backup bytes, then writes the active marker. Interrupted incomplete copies are checked and resumed/restarted. Drift from a completed backup refuses activation. Legacy short digests do not authorize deletion; imported applied proposals are marked unverified.

For a store snapshot, use the tested `backupOperationalState` API: it serializes SQLite operational state and copies the canonical artifact directory into a new private destination, refusing to overwrite an existing destination. On failure, inspect and retain the incomplete destination; the helper does not delete it. Restore is an operator-managed restore of the database snapshot and matching artifacts as a consistent pair, after stopping writers and preserving the current store separately. This is not automatic rollback for arbitrary concurrent manual edits, does not restore native harness sessions, and does not erase migration backups. Run the migration/search integrity checks after restoration before resuming mutation.

Proposals target a `skill:`, a `memory:` or a `file:` path and are checked against the proposal's observed target version. Coordination locks protect cooperating pi-house writers only; they cannot guarantee CAS against arbitrary editors. Approval pins the version the user listed: `approve <id> <version>` refuses, and applies nothing, when the proposal has changed since it was listed. Exact-change deduplication catches identical changes, not every semantically equivalent recommendation. No proposal is automatically applied.

## Runtime limits

Routing selects only explicitly authorized configured profiles and observable compatibility/quota state; unknown availability pauses rather than silently enabling paid access. In-place model switching depends on adapter support (pi, pihouse, opencode); for Claude Code, Codex and paste workers an ancestor uses agent-link `replace`, which fences and confirms the old worker's exit before one replacement continues the task from a code-built summary (see [architecture](architecture.md)). Optional context monitoring is opt-in and reports a recommendation for manual application; it never switches models automatically. Manual skill expansion and grouped shell display are not supported by pinned pi. The Luna fixture smoke ( [`research/luna-digest-smoke.md`](research/luna-digest-smoke.md) ) is a single synthetic experiment and supports no general cost or quality claim.
