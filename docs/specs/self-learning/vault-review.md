# Specification: vault-review

Status: proposed. Decision record: [ADR-004](../../decisions/ADR-004-vault-review.md). Plan:
`docs/plans/workflow-vault-review.md`. Supersedes the per-run digest, scan and batch-review parts of the other files in
this folder; those files are not edited and remain as history.

## Objective

Replace the digest / self-learning / report / save loop with one that has fewer moving parts and a vault a person can read.

1. A planner or executor session saves its report and its full conversation by itself, after every answer and when the
   session closes. Any other session is saved only when the user runs `/workflow log [reason]`.
2. `/workflow review` takes every saved run that has not been reviewed, makes a compact version of each one that has
   none, reads the new compacts and the previous review, writes one review file and produces bounded proposals. The user
   approves or rejects each proposal; an approved proposal is applied literally.
3. A run's full conversation copy is deleted only after its review is done. Its compact version stays forever.
4. `/workflow ask` answers from compacts, reviews, ideas and consulted sources. When runs of the current project have no
   compact, it asks the user once; "yes" compacts all of them, "no" compacts none.

User: one person running planner and executor sessions locally. Success: the user closes the terminal after a feature,
later runs `/workflow review`, confirms the count, and gets `workflow/reviews/review-<timestamp>.md` plus numbered
proposals; the full conversations of the covered runs are gone and `workflow/compact/<revision id>.md` exists for each.

Assumptions fixed by the plan (the plan's Decisions section is binding and is restated here, never relaxed):
Markdown files plus `memory.sqlite`, no vector store, no new dependency; compacting and reviewing run in isolated child
agents through the agent-link hub, which is required; the default model is `claude-bridge/claude-sonnet-5-5`.

## Commands

User commands (the final set; nothing else is registered or completed):

| Command | Effect | Model turn |
|---|---|---|
| `/workflow log [reason]` | Flags the current session (by `log`), renames it `workflow-saved · <title>` if it was not a workflow session, captures it. Idempotent. | none |
| `/workflow review` | Counts pending runs and how many lack a valid compact, asks for confirmation, compacts, reviews, ingests proposals, marks reviewed, deletes covered full conversations. Prints a numbered proposal list (id, short version, target path, one-line reason). | child agents only |
| `/workflow ask <question>` | Answers from compacts, reviews, ideas and consulted sources through FTS. May offer to compact the project's uncompacted runs. Never deletes, never marks reviewed. | the session's own model |
| `/workflow proposals [id]` | Without id: lists proposals. With id: one proposal in full, with the absolute path and a unified diff of `before` to `after`. | none |
| `/workflow approve <id> [version]` | Applies the proposal literally. The version pins the displayed proposal version. | none |
| `/workflow reject <id> [reason]` | Rejects the proposal; the same change is suppressed later unless new evidence and a `reopen` explanation arrive. | none |

Retired: `report`, `save`, `digest`, `self-learning`. Each returns replacement guidance, starts nothing and has no alias
(the pattern the retired `review` keeper invocation already uses). `/workflow` with no argument prints a usage line that
lists exactly the six commands above.

Confirmation: if pi's command API offers a confirm dialog, `review` uses it. Otherwise the first call only prints the
count and a second call with `--yes` runs. A declined or absent confirmation starts no agent and writes nothing.

Without the hub, `review` and the compacting part of `ask` print the same kind of message the old commands printed
("agent-link hub not available") and start nothing.

Development commands (from `AGENTS.md`): `npm run check`, `npm test`, `node --test packages/pihouse/test/<file>.test.ts`,
`npm run skills` after skill changes, `npm run sync-versions` after a version change.

Model: child agents run on `claude-bridge/claude-sonnet-5-5`. `PIHOUSE_LEARNING_MODEL` still overrides it; the default
of `LEARNING_MODEL_ENV` in `learning-commands.ts` changes to that value.

## Project structure

The vault root is `~/.pihouse/memory/` (honors `PIHOUSE_HOME`). One module, `packages/pihouse/src/workflow/vault-paths.ts`,
knows this layout; no other file under `packages/pihouse/src` builds a vault path with a string literal (a test greps
the source).

```
~/.pihouse/memory/
|-- README.md                 written by code at init; one line per folder: what it holds, temporary or permanent
|-- conversations/            FROM CONVERSATIONS: sessions that were captured
|   `-- <run id>/             report.md (human only), run.json, transcripts/ (full copy, TEMPORARY)
|-- workflow/                 FROM THE WORKFLOW: derived by compact and review, all PERMANENT
|   |-- compact/<revision id>.md
|   |-- reviews/review-<UTC timestamp>.md       timestamp format 20261105T143000Z
|   |-- proposals/<proposal id>/                backups of files a proposal changed
|   `-- approved-records/
|-- ask/                      FROM ASK: what /workflow ask brought in
|   |-- consulted/            sources fetched from links
|   `-- ideas/                ideas written from them
|-- migration-backup/         old backups, never touched
`-- memory.sqlite             numbers, stages, jobs, proposals, receipts: never conversation text
```

Rules of the layout:

- Opening an empty folder creates every folder above except `migration-backup/`, the root `README.md` and an active
  store (FTS available) without a legacy migration. A second open changes nothing, not even the README's bytes.
- Full conversations are files (`transcripts/`), never SQLite rows. `transcripts/` keeps its name.
- `report.md` is code-computed, written for the human, and is never an input of a compact or a review.
- The code that owns each place: capture writes `conversations/`; compact writes `workflow/compact/`; review writes
  `workflow/reviews/`; proposals write `workflow/proposals/` and `workflow/approved-records/`; ask writes `ask/`.

Source files this work touches are listed per task in the plan. New modules: `vault-paths.ts`, `run-stages.ts`,
`compact-contract.ts`, `compact-run.ts`, `review-contract.ts`, `review-run.ts`.

### The `run_stages` table

Additive schema change (a new schema version after `SCHEMA_V2` in `storage.ts`), idempotent, applied in one
`BEGIN IMMEDIATE` transaction. The stage belongs to a revision, not to a run.

```sql
CREATE TABLE IF NOT EXISTS run_stages(
  revision_id         TEXT PRIMARY KEY REFERENCES revisions(id),
  compact_path        TEXT NOT NULL,   -- path relative to the vault root, e.g. workflow/compact/run-a.r2.md
  compact_hash        TEXT NOT NULL,   -- SHA-256 hex of the compact file bytes
  compact_fingerprint TEXT NOT NULL,   -- evidence fingerprint of the revision the compact was made from
  compacted_by        TEXT NOT NULL CHECK (compacted_by IN ('review','ask')),
  compacted_at        TEXT NOT NULL,   -- ISO 8601 UTC
  review_id           TEXT,            -- id of the review that covered it; NULL until reviewed
  reviewed_at         TEXT             -- ISO 8601 UTC; NULL until the review was ingested
);
```

A revision with no row is `captured`. A row with `reviewed_at` NULL is `compacted`. A row with `reviewed_at` set is
`reviewed`. `review_id` and `reviewed_at` are set together by one statement. Module `run-stages.ts` exports:

| Function | Meaning |
|---|---|
| `recordCompact(db, input)` | Inserts the row (or replaces it when the revision has none that is `reviewed`). Never overwrites a reviewed row. |
| `pendingForReview(db, project?)` | Newest revision of each run that is captured, not active and not reviewed. |
| `uncompactedForProject(db, project)` | The pending set restricted to one project, with no valid compact. |
| `markReviewed(db, revisionIds, reviewId)` | Sets `review_id` and `reviewed_at` for exactly those revisions, in one transaction; refuses a revision without a row. |
| `stageOf(db, revisionId)` | `captured`, `compacted` or `reviewed`. |

The revision id is `revisionIdFor(runId, n)` from `evidence-store.ts`: `<run id>.r<N>`. The evidence fingerprint is
`evidenceFingerprint(evidence)` from the same file.

### Search kinds

FTS indexes documents of kind `compact` and `review`, and keeps `idea` and `consulted`. The kinds `digest` and `batch`
stop being produced. Trust: `compact` and `review` are `derived`; `consulted` stays `external`. A compact or review
whose file hash differs from its recorded hash is refused and the last good index entry is kept (the rule `search.ts`
already has). For a review the recorded hash is the one `artifact_commits` stores; for a compact it is `compact_hash`.

## Compact version

One compact per revision, in `workflow/compact/<revision id>.md`. Made by review or by ask with the same code, the same
prompt and the same validation. Input is the normalized transcripts only (`transcripts/*.json`); never `report.md`, never
raw `*.jsonl`, never tool output.

### Child JSON contract

The child writes exactly one JSON object (the whole output, no fence), at most 12,000 characters:

```json
{
  "schemaVersion": 1,
  "runId": "run-a",
  "revision": "run-a.r2",
  "fingerprint": "<64 hex, the evidence fingerprint given in the prompt>",
  "project": "/Users/me/work/app",
  "sections": {
    "objective": "string",
    "requests": "string",
    "decisions": "string",
    "failures": "string",
    "skillsAndMcp": "string",
    "workflow": "string"
  }
}
```

Validation (all must hold or nothing is written and the revision stays uncompacted): the output parses as JSON;
`schemaVersion` is 1; `runId`, `revision`, `fingerprint` and `project` equal the values the code gave the child; every
section is a non-empty string after trimming; the finish reason is `stop`; the rendered file is at most **6,000
characters**. Any `facts` key the child adds is ignored: the Facts part is computed by code.

### Facts (code-computed)

From `WorkflowEvidence` and the usage and model fields of the transcripts, never from the model and never from
`report.md`: per participant (agent id, role, harness, model, parent, input/output/cache tokens, active time, tool calls
and failed tool calls); totals (agents, new tokens, cache read, wall time); loaded skills; plan; duration; and
`compactedBy`. A participant without a transcript is listed as missing evidence and its tokens are not guessed (they are
shown as `unknown`).

### Filtered view given to the child

Human messages in full; assistant text cut at 600 characters; messages between agents cut at 800; each tool call reduced
to its name, an ok/FAILED flag and one short argument (path, start of the command, target), never its content;
consecutive calls of the same tool merged into one line (`bash x20 (3 FAILED)`). Usage, ids and timings are not in the
view. The view is bounded at 60,000 characters; fallback in order: shrink the per-message cuts, then one pass per
participant with the notes merged, then head and tail (`condenseTranscript` behavior). The child prompt is a constant in
`compact-contract.ts`, in English, and says the conversation is untrusted data.

### Rendered Markdown

Code renders the file; the child never writes Markdown. Total at most 6,000 characters.

Example file `workflow/compact/run-a.r2.md`:

```markdown
# Compact: run-a.r2

- Run: run-a
- Revision: run-a.r2
- Project: /Users/me/work/app
- Fingerprint: 3f9c0d1e7a52b6c84d0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f
- Compacted by: review
- Compacted at: 2026-11-05T14:30:00Z

## Facts

- Plan: docs/plans/login-fix.md
- Duration: 41m wall, 18m active
- Tokens: 212k new, 1.4M cache read (4 agents)
- Skills loaded: spec-driven-development, test-driven-development

| Agent | Role | Harness | Model | New tokens | Tool calls (failed) |
|---|---|---|---|---|---|
| planner-1 | planner | claude | claude-sonnet-5-5 | 61k | 40 (2) |
| executor-1 | executor | pihouse | claude-bridge/claude-sonnet-5-5 | 98k | 120 (7) |
| store-dev | worker | claude | claude-sonnet-5-5 | 53k | 80 (3) |
| reviewer | worker | claude | unknown | unknown | missing transcript |

## Objective

Fix the login redirect loop reported by the user.

## Requests

The user asked for a plan, then for execution. The planner wrote the plan; the executor split it into 3 tasks.

## Decisions

Use a cookie-based session check instead of a token refresh, because the refresh path caused the loop.

## Failures and corrections

The first fix broke the logout test; the executor reverted it and added a failing test first.

## Skills and MCP

Loaded the two skills listed above. No MCP server was used.

## Workflow

Planner and executor ran sequentially; the executor used 2 workers in parallel for 11 minutes.
```

Stored in `run_stages`: `compact_path` is `workflow/compact/run-a.r2.md`, `compact_hash` is the SHA-256 of these bytes,
`compact_fingerprint` is the Fingerprint line, `compacted_by` is `review`.

### Writing

Written with `commitArtifact` (two-phase: temp file, manifest, rename), then `recordCompact` and the FTS document. The
spec fixes the file name `<revision id>.md`; `commitArtifact` currently names files `<kind>-<id>.md`, so T4 must give it
a way to set the exact file name (see the plan's Files list for T4; a small additive option in `documents.ts`).
Concurrency: one child per revision, at most 3 at once, leases and attempts reuse `jobs.ts`; a failed child does not stop
the others. A valid compact is not remade (no second model call). A revision that is active (not quiescent) is skipped
and reported.

## Review

### Pending, stale and deleted rules

- **Pending.** The newest revision of a run is pending when: it is captured, its run is not active, and its
  `run_stages` row is missing or has `reviewed_at` NULL. Older revisions of the same run are superseded: they are never
  reviewed on their own, and their compacts (if any) are not used. A run captured again between compact and review gets
  a new revision id, so it appears as a new pending revision without a compact.
- **Valid compact.** The row exists, the file exists, the SHA-256 of its bytes equals `compact_hash`, and
  `compact_fingerprint` equals the revision's evidence fingerprint. Anything else is **stale** (also: file edited,
  removed, or the evidence changed). A stale compact is not used for review input, not indexed by search, and never
  authorizes a deletion. Review compacts the revision again.
- **Deleted.** A run's full conversation is deleted per run, only when ALL hold: the compact is valid; `compacted_by`
  may be `review` or `ask` but `reviewed_at` is set, so a compact made by ask alone never authorizes anything; the review
  that covered it finished and its proposals were ingested; the run is quiescent; its current evidence fingerprint still
  equals `compact_fingerprint`; a persisted receipt lists the files with their SHA-256. It deletes only pi-house-owned
  copies in `conversations/<id>/transcripts/`. It never deletes native harness sessions, project files, `run.json`,
  `report.md`, compacts, reviews or backups. Existing guards of the cleanup stay: safe ids and names, no symlinks, confined
  to the run's `transcripts/`, SHA-256 of each file re-checked, receipt before and after. An interrupted cleanup resumes
  from its receipt.
- **Failure.** If the review fails at any step, compacts stay, every revision stays unreviewed (`compacted`) and every
  full conversation stays; the next review resumes and reports which step failed.

### Flow

1. Count pending revisions and those without a valid compact; ask for confirmation. Nothing pending: say so, start no agent.
2. Compact the missing ones (up to 3 in parallel).
3. Build the review input: the new compacts and the latest review file only, bounded to 60,000 characters. The review
   agent may read `workflow/compact/` and `workflow/reviews/`; it never gets a transcript path nor an older compact than
   the pending ones.
4. One isolated child writes the review JSON.
5. Code validates, commits `workflow/reviews/review-<UTC timestamp>.md`, ingests the proposals with `ingestReview`,
   calls `markReviewed` for exactly the covered revisions, then runs `cleanupReviewed`.

### Child JSON contract

The child writes exactly one JSON object, at most 24,000 characters:

```json
{
  "schemaVersion": 1,
  "reviewId": "review-20261105T143000Z",
  "covered": ["run-a.r2", "run-b.r1"],
  "previousReview": "review-20261029T101500Z",
  "sections": {
    "newRuns": "string",
    "decisions": "string",
    "errors": "string",
    "patterns": "string",
    "carriedForward": "string"
  },
  "proposals": [
    {
      "kind": "edit-file",
      "scope": "project",
      "target": "file:/Users/me/work/app/AGENTS.md",
      "before": "full current text",
      "after": "full new text",
      "supporting": ["run-a.r2"],
      "opposing": [],
      "conditions": ["applies to this repository only"],
      "uncertainty": "string",
      "validation": "string",
      "reopen": "optional string, only to re-propose a rejected change"
    }
  ]
}
```

Validation: parses as JSON; `schemaVersion` 1; `reviewId` equals the id the code chose; `covered` equals exactly the
revision ids the code gave the child; `previousReview` equals the id of the latest review file or is `null` when there is
none; every section is a non-empty string; finish reason `stop`; the rendered file is at most **12,000 characters**
(including the proposals block). `carriedForward` must keep the essentials of the previous review so the latest review
is self-sufficient; a second review never reads older reviews.

### Proposal envelope (what the existing intake parses)

The rendered review contains exactly one fenced `json` block, and `ingestReview` receives the review text. The block is:

````
```json
{ "schemaVersion": 1, "proposals": [ <entries as above> ] }
```
````

Existing intake limits stay: the review text is at most 100,000 characters, at most 50 proposals, each string field at
most 12,000 characters, `supporting`/`opposing`/`conditions` arrays at most 100 entries of at most 500 characters,
`reopen` at most 1,000. `kind` is a string; `scope` is `project` or `global`; `target` is non-empty; `before` must differ
from `after`. **`supporting` and `opposing` hold revision ids** (`<run id>.r<N>`); intake resolves each against the
`revisions` table and fails the whole batch on an unknown id. Intake is all-or-nothing and idempotent per review id.

### Rendered Markdown

Code renders: a header with the review id, UTC time, previous review and covered revisions; the five sections as
`##` headings; then a `## Proposals` section containing the single fenced block. Example head of
`workflow/reviews/review-20261105T143000Z.md`:

```markdown
# Review: review-20261105T143000Z

- Generated: 2026-11-05T14:30:00Z
- Previous review: review-20261029T101500Z
- Covered: run-a.r2, run-b.r1

## New runs
run-a: login redirect fix (planner, executor, 2 workers). run-b: README pass.

## Decisions
Cookie-based session check chosen over token refresh (run-a.r2).

## Errors and failures
First fix broke the logout test; reverted (run-a.r2).

## Repeated patterns
Executors skip the failing-test-first step when the task has no test file listed (run-a.r2, run-b.r1).

## Carried forward
From review-20261029T101500Z: workers on the pihouse harness lose context after 60 minutes; keep tasks short.

## Proposals
(one fenced json block follows)
```

## Proposals and the `file:` target

Kinds cover skill, MCP, context and cleanup changes: the existing `memory-rule`, `edit-skill`, `remove-skill`,
`remove-idea`, plus the new `edit-file`. The old closed allowlist (`skill:` and `memory:` targets only) is replaced.

| Target | Resolves to | Status |
|---|---|---|
| `skill:<name>` | the catalog skill's `SKILL.md` | unchanged |
| `memory:<kind>/<key>` | `approved-records/<kind>/<key>.md` under the vault | unchanged |
| `file:<absolute path>` | any existing regular file | new |

A `file:` target resolves only an existing regular file given by an absolute path. It is refused at intake with a clear
reason and no write when the path is relative, missing, a directory, a symlink or has a symlink in any parent
component, or matches the forbidden list. If the user approves it, it is applied; there is no other gate.

Every apply keeps the existing safety: the full path and the diff are shown, approval pins the version, backup in
`workflow/proposals/<proposal id>/`, compare-and-swap against the `before` text, lock file, atomic rename, validation and
a receipt. After apply, JSON files must parse; `skill:` targets keep the frontmatter check; other files must not become
empty. On a failed validation the original is restored. The proposal record keeps `before` and `after` so the diff can
be shown.

**Forbidden list** (added by the planner to protect credentials from hostile text in conversations; entries are never
removed without a recorded reason): basenames `auth.json`, `mcp-auth.json`, `.env` and `.env.*` (not `.env.example`),
`*.pem`, `id_rsa*`, `id_ed25519*`; and anything under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pihouse/agent/auth*`,
`~/.pi/agent/auth*`. The check runs on the resolved real path and on the given path.

## Ask

`/workflow ask` reads compacts, reviews, ideas and consulted sources through the existing FTS search, scoped to the
current project plus global. Its context is at most **80,000** characters and never includes a transcript. If the current
project has pending runs without a valid compact, its hidden context carries the count and the instruction to ask the
user once with `ask_user_question`; on "yes" the model calls the extension tool `workflow_compact`, which is
project-scoped, compacts all of that project's uncompacted runs with `compactedBy: ask`, and returns counts. On "no" it
runs nothing. Ask never deletes anything and never marks a run reviewed.

## Limits

| What | Limit |
|---|---|
| Compact, rendered | 6,000 characters |
| Compact, child output | 12,000 characters |
| Review, rendered (with proposals block) | 12,000 characters |
| Review, child output | 24,000 characters |
| Filtered view per revision | 60,000 characters |
| Review input (new compacts plus latest review) | 60,000 characters |
| Ask context | 80,000 characters |
| Parallel compact children | 3 |
| Proposal intake | the existing limits listed above |

A value over its limit makes the output invalid; nothing is truncated silently.

## Code style

Repo rules from `AGENTS.md` apply: TypeScript with erasable syntax only, no `any`, top-level imports, no new
dependency, English only, no emojis, non-obvious choices explained as problem, example, solution.

```ts
/**
 * Problem: a compact made before the run was captured again describes old evidence.
 * Example: run-a.r1 is compacted, then the session continues and r2 is captured.
 * Solution: compare the row's fingerprint with the current one before trusting the file.
 */
export function isValidCompact(row: RunStageRow, currentFingerprint: string, fileHash: string): boolean {
	return row.compact_hash === fileHash && row.compact_fingerprint === currentFingerprint;
}
```

## Testing strategy

Node's built-in test runner on `.ts` files under `packages/pihouse/test/`; no real API, no paid token: fake sockets, a
fake worker port for the child agents, fake CLIs. Every code task writes its failing tests first. Every test sets
`PIHOUSE_HOME` and `AGENT_LINK_HOME` to fresh temporary folders. After every change: `npm run check` and `npm test`
with no warnings. Per area:

- Vault: layout creation and idempotence, no path literals in `src` (source grep), ideas and consulted searchable.
- Stages: `recordCompact`, `pendingForReview`, `uncompactedForProject`, `markReviewed`, `stageOf`, scoped by project.
- Compact: each invalid output writes nothing; Facts come from usage even if the child contradicts; the prompt has no tool
  output, no edit/write content and no `report.md` text; at most 3 parallel; active revision skipped; no repeat call.
- Review: nothing pending starts no agent; no transcript path or older compact in the input; a failed step leaves every
  revision unreviewed; a second review reads only the latest review and carries forward.
- Deletion: ask-only compact never deletes; edited, removed or re-fingerprinted compact never deletes; symlinks refused;
  a file changed after the receipt is refused; interrupted cleanup resumes from the receipt.
- Proposals: `file:` happy path with backup, every refusal, compare-and-swap, JSON validation with restore.
- Commands: usage lists exactly six commands; retired commands start no turn; confirm declined starts nothing.

## Boundaries

- Always: write through `vault-paths.ts`; validate model output in code before any write; keep the full conversation
  until a review succeeded; use fakes in tests; stage files by explicit path.
- Ask first: adding a dependency; changing the SQLite schema beyond the additive `run_stages` change; removing an entry
  of the forbidden list; touching the real `~/.pihouse` before the plan's reset task.
- Never: delete native harness sessions, project files, `run.json`, `report.md`, compacts, reviews or backups; let a
  compact made by ask authorize a deletion; read `report.md` or a transcript in the review agent; fall back to another
  provider or a paid route when the Claude quota is exhausted; push to `main`.

## Rollout

The 38 migrated runs are deleted; `ideas/` and `consulted/` are moved (byte-identical) to `ask/ideas/` and
`ask/consulted/`; `migration-backup/` and `~/.pihouse/backup-before-main-*` stay. This is task T10 of the plan, run only
after a full cycle passes on a temporary `PIHOUSE_HOME`. The work is pushed to the branch `feat/workflow-vault-review`,
never to `main`.

## Success criteria

- Opening an empty folder creates the layout, README and active store; a second open changes no byte.
- A flagged session is captured on `session_shutdown` and after every answer without a duplicate revision.
- `review` with a fake worker produces compacts, one review file, proposals and empty `transcripts/` for covered runs; the
  compacts stay.
- A declined confirmation, a failed child, an invalid output or a failed intake leaves all full conversations present.
- A `file:` proposal on a temp file is applied after approval with a backup; forbidden paths are refused.
- `npm run check` and `npm test` pass without warnings.

## Open questions

- `session_shutdown` timing: pi documents the event but not how long a handler may run. T3 proves a capture completes
  inside the handler or keeps the per-answer capture and the existing sweep and says so.
- Whether a confirm dialog is available to a pi command (T8 falls back to the two-call `--yes` form).
- The hub's own `events.sqlite` is not read by the review in this work; reading it is a follow-up.
