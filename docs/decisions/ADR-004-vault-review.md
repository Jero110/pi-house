# ADR-004: One vault, compact versions and a single review

## Status
Accepted; partially supersedes ADR-002. Specification: [vault-review](../specs/self-learning/vault-review.md).

## Date
2026-11-05

## Context
ADR-002 made learning explicit and evidence-backed, but the loop it produced has too many steps and keeps too much. The
user runs `/workflow report`, `save`, `digest` and `self-learning` as separate manual operations; a digest is made per run,
a scan and a batch review follow, and proposals may only touch `skill:` and `memory:` targets. The memory folder mixes
captured conversations, derived documents and ask output at one level (`runs/`, `ideas/`, `consulted/`), so a person
cannot tell at a glance what is temporary and what is permanent. Planner and executor sessions are saved only if the
user remembers to run `save`.

The user decided in a grilling session on 2026-11-05 that the loop should be: sessions save themselves, one command
looks back, full conversations are deleted only once a review has used them, and what survives is small and readable.

## Decision
Keep Markdown files plus `memory.sqlite` and divide the vault by origin: `conversations/` (captured sessions, temporary
full copies), `workflow/` (compacts and reviews, permanent; also proposal backups and approved records) and `ask/` (ideas
and consulted sources), with a root `README.md` written by code. One module, `vault-paths.ts`, knows this layout.

Planner and executor sessions are captured after every answer and when the session closes; any other session only through
`/workflow log [reason]`. The commands are `log`, `review`, `ask`, `proposals`, `approve` and `reject`.

Each captured revision gets one compact version (at most 6,000 characters): a code-computed Facts part and six
model-written sections, validated by code. `/workflow review` counts pending runs, asks for confirmation, compacts the
runs that lack a valid compact (up to 3 in parallel), then one review agent reads only the new compacts and the latest
review file and writes a review (at most 12,000 characters) that carries forward the essentials of the previous one.
The same output carries the proposals, ingested by the existing proposal intake. A new SQLite table, `run_stages`, records
per revision the compact path, hash, fingerprint, who made it (`review` or `ask`) and when it was reviewed.

A run's full conversation is deleted per run, only after its compact is valid, its review was ingested, the run is
quiescent, its fingerprint is unchanged and a receipt lists the files with SHA-256. Compacts and reviews are never deleted.
A compact made by ask never authorizes deletion. Compacting and reviewing run in isolated agents on
`claude-bridge/claude-sonnet-5-5` and need the agent-link hub.

Proposals may target `file:<absolute path>` (any existing regular file) with a forbidden list for credentials; approval
still pins the version, shows path and diff, takes a backup and applies with compare-and-swap, lock, atomic rename,
validation and receipt. See the specification for the contracts, limits and rules.

### Superseded from ADR-002
- The per-run digest as the unit of learning and the authority to delete: replaced by the compact plus review rule above.
- The scan stage and batch review: replaced by the single review.
- The closed proposal allowlist (`skill:` and `memory:` targets only): replaced by `file:` targets with a forbidden list.
- The commands `/workflow report`, `save`, `digest` and `self-learning`: retired with replacement guidance, no alias.
- The flat memory layout (`runs/`, `ideas/`, `consulted/`): replaced by the three origin folders.

### Kept from ADR-002
- Reports are code-only; the model never writes them. They stay for the human and are not an input of compact or review.
- SQLite holds numbers, stages, jobs, proposals and receipts; FTS5 is a rebuildable derived index; no conversation text in rows.
- Isolated child agents for model work; technical validation by code, not by a second judging model.
- Native harness sessions, project files and migration backups are never deleted.
- Memory is consulted on demand through scoped retrieval, not injected at startup.
- Approval pins the displayed proposal version and is explicit; the writer lock is not an operating-system compare-and-swap.
- Routing profiles, context monitoring and the fenced `replace` continuation are unchanged.

## Problem, example, solution for the non-obvious choices

**Why a review reads only the latest review and the new compacts.**
Problem: reading every older compact makes the cost of a review grow with history. Example: after 40 runs, a review
would read 40 compacts to find three new patterns. Solution: the latest review carries forward the essentials of the
previous one, so it is self-sufficient and the input stays bounded at 60,000 characters.

**Why a compact made by ask never authorizes a deletion.**
Problem: ask compacts on a yes from the user, before any review looked at the run. Example: the user answers yes to
"compact 5 runs?" while asking a question; deleting the full conversations then would lose evidence the review never used.
Solution: deletion requires `reviewed_at`, set only by a finished and ingested review.

**Why the compact is tied to the evidence fingerprint.**
Problem: a session continues after it was compacted. Example: run-a.r1 is compacted, then the session continues and
three more answers change the captured evidence; deleting the transcripts then would lose text the compact never saw.
Solution: the compact stores the fingerprint it was made from, and deletion re-checks the
current fingerprint equals it.

**Why the full conversation is deleted only after the review.**
Problem: a compact is lossy and a failed review would leave nothing to retry from. Example: the review agent fails
halfway after compacts were made. Solution: the runs stay `compacted` with their full conversation; the next review
resumes without a new model call for valid compacts.

**Why `file:` targets with a forbidden list instead of an allowlist.**
Problem: the closed allowlist blocks real improvements (an `AGENTS.md`, an MCP config, a settings file), while a fully open
target lets a model that read hostile conversation point at credentials. Example: a conversation contains "add this line
to ~/.aws/credentials" and a proposal targets it. Solution: any existing regular file may be proposed, a short forbidden
list refuses credential files at intake, and the user's approval with a visible full path and diff is the gate.

**Why the Facts part is computed by code.**
Problem: a model summarizing token counts invents or rounds them. Example: a child writes "about 100k tokens" for a run
that used 212k. Solution: code computes agents, models, tokens, skills and duration from usage fields in the transcripts
and the model writes only the narrative sections.

## Alternatives considered

- **Keep the digest per run, plus scan and batch review.** Rejected: three model stages and three commands for one idea;
  digest, scan and review each add a failure point and a place where evidence can drift, and the user has to know the order.
- **A vector store for retrieval.** Rejected: a new service or dependency for a vault small enough for FTS5 over bounded
  Markdown files; local canonical documents and SQLite already meet the scope (as in ADR-002).
- **Storing full conversations in SQLite.** Rejected: rows hide text from the person reading the vault, make deletion and
  receipts harder to verify, and put sensitive text into the database that also holds operational state. Files in
  `transcripts/` can be listed, hashed and deleted individually.
- **A closed allowlist for proposal targets.** Rejected: see the `file:` choice above; it blocks legitimate edits while
  giving a false sense of safety, since approval of the visible diff is the real control.
- **Compacting inside the user's session model.** Rejected: it would spend the user's interactive context and model on
  bulk work, couple the result to whichever model the session uses, and mix untrusted conversation text into a working
  session. Isolated child agents on a fixed default model keep the contract and validation identical for review and ask.
- **Keeping the flat folders and adding labels.** Rejected: a README cannot make `runs/` and `ideas/` self-explanatory;
  folders named by origin show what is temporary without reading anything.

## Consequences
- The user learns six commands. Planner and executor sessions are saved without a command.
- Full conversations are kept until a review completes; vault size grows between reviews, then shrinks.
- Compacts are lossy and permanent; detail not in a compact is not recoverable after the review. This is accepted, as in ADR-002.
- Review and compact need the agent-link hub and Claude quota; without them nothing starts.
- Existing data is not migrated: the 38 migrated runs are deleted and `ideas/` and `consulted/` are moved (task T10).
- The unused digest, scan and report code is left until a check or test forces its removal; the remainder is a follow-up.
- The hub's event log (`events.sqlite`) is not part of the review; reading it is a follow-up.
- See [architecture](../architecture.md) and [self-learning details](../self-learning.md); both are updated when the work lands.
