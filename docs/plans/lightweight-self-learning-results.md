# Lightweight self-learning: execution result

Branch: `feature/lightweight-self-learning`. Feature integration through `ed03241` (follow-up after the first results, same day).
Status: **implemented core workflow, with explicit partial/blocked requirements below**. Not a claim that every
approved acceptance criterion passed. The approved plan remains an intentional untracked input.

## Final independently verified gates

- `npm run skills`: exit 0; 23 catalog skills, generated output unchanged.
- `npm run check`: exit 0; 219 files, no warnings.
- `npm test -- --test-timeout=30000`: 675 passed, 0 failed/cancelled/skipped/todo.
- `git diff --check`: exit 0.
- Mermaid: all 8 diagrams (README 4, architecture 4) rendered without error with mermaid@11 in the cmux browser (temporary page outside the repo, no dependency added); screenshot reviewed.
- Original statusbar patch SHA-1 remains `8068e23a4f3c7a9487d21cb912421f2a912eade8`, unchanged and unstaged.
- No push, publish, deployment, version bump, real-store migration or destructive user-store trial.

The timeout is a diagnostic bound, not a test exclusion. Connected tests use fake child workers, fake HTTP/sockets,
synthetic pi JSONL and temporary stores/targets. The two authorized live model calls are recorded separately in
[the smoke report](../research/luna-digest-smoke.md).

## Task outcomes

Earlier execution provenance and model amendments are retained in the progress ledger and handoff. Unless noted,
implementation workers used pihouse with `openai-codex/gpt-6-luna` or `claude-bridge/claude-haiku-5-5` under the
user's amended authorization. The successor executor used `claude-bridge/claude-opus-5-5`. SDD/TDD/INC/DOC/GIT
below refer to the five approved skill paths in the plan, not extra selected skills.

| Task | Outcome and evidence | Integration / remaining boundary |
|---|---|---|
| T1 | PASS, baseline recorded | `c3eba17`; original dirty edits retained |
| T2 | PASS, code-only reporting | `d4df594`; no model turn/enrollment |
| T3 | PASS, SQLite/artifact primitives | `699c977`, `4f1a124`; operational backup API |
| T4 | PARTIAL, immutable evidence, suffix cursors, retained reports and cleaned-run reopening tested | capture bridge `358136b`; reopening `0b4dae9`, `ea0f83a`; unverifiable/non-pi continuations defer |
| T5 | PASS for explicit fake migration/backup/restart contracts | `170a46b`; no real-store trial, legacy deletion authority none |
| T6 | PASS | `f2c1e2f`, `e651565`; reconciliation reads and writes inside one `BEGIN IMMEDIATE`, orphan rows repaired incrementally |
| T7 | PASS for the amended two-model synthetic smoke | `97b5ea0`, `09b0bb1`; both pass code contract/manual rubric, one sample per model, money cost unknown |
| T8 | PASS for supported production job path | runtime `961152a`, `76a75c0`, commands `079451e`; only provable quiescence accepted |
| T9 | PASS for supported cleanup/retry/reopen path | `482caf1`, `be786ae`, `800304b`, `86b52bc`; only owned copies, never native sessions |
| T10 | PASS for connected fake command orchestration | `c16d299`, `75a766c`; scan/review isolated behind pull coordinator |
| T11 | PARTIAL, proposals/intake/application/receipt/recovery tested | `59485d4`, `4a6bf50`, `b0c86ff`, `1883d86`; approve pins the listed version (`approve <id> <version>`, at least 4 hex); remaining: exact-change rather than semantic dedup, locks coordinate cooperating writers only |
| T12 | PASS for fake harness registration/scoped MCP contracts | `50aaccf`, `d42a12b`, `96efc5b`; trusted launcher identity, not multi-tenant authentication |
| T13 | PASS for scoped retained metrics/docs/ask | `6308021`, `192b59d`; snapshots not event-time billing, legacy unknowns stay unknown |
| T14 | PASS for configured profile backend and account observations | `b92ab16..954c831`; capability declarations are user claims, not independent model capability verification |
| T15 | PASS with fake adapters | native model/retry/interrupt/self-switch; agent-link `replace` (fence, confirmed exit, code-built continuation, child adoption, late output dropped) ending `7a9018a`, docs `ed03241`; live permission races untested |
| T16 | PASS for explicit routing | `5986d81..2ab8897`, lineage ending `894f13e`: decisions journal, report and evidence lineage, fake routed replacement; interactive automatic switching intentionally not implemented (manual `/context-upgrade apply`) |
| T17 | PASS for supported title path | `e3c343d`, `5d8db21`; title model usage not in retained session metrics, cmux visuals not manually verified |
| T18 | PARTIAL, user accepted | `94e7ab9`; successful SKILL.md reads visible; manual expansion blocked by pinned pi, no further work per user |
| T19 | BLOCKED, user accepted | pinned pi has no adjacent-row grouping API; no patch; no further work per user |
| T20 | PASS for final public command wiring and connected fake path | `40d453d`, `84e8b6b`, `079451e`, `c16d299`; report/save/digest/self-learning/ask/proposals/approve/reject |
| T21 | PASS | `d3a0661`, `9de5229`; keeper retired, legacy readers/history retained, skills regenerated |
| T22 | PASS | `6e251c9`, `ed03241`; diagrams rendered and reviewed |
| T23 | PARTIAL | `800304b`, `75a766c`, `86b52bc`; connected public-command lifecycle and recovery pass; crash tests additionally distributed across modules, no unsupported cross-harness continuity simulated |

## Successor executor worker results

Every listed integration was independently checked, not accepted solely on a worker's PASS report.

| Worker | Model | Approved skills | Result / worktree full tests | Integrated commits |
|---|---|---|---|---|
| learning-runtime (inherited) | Luna | SDD TDD INC GIT | corrected runtime slice; 522 pass | `961152a`, `76a75c0` |
| routing-4 (inherited) | Haiku | SDD TDD INC GIT | backend; 549 pass | `b92ab16..954c831` |
| proposals-apply | Luna | SDD TDD INC GIT | one corrective coverage increment; 568 pass | `59485d4`, `4a6bf50` |
| handoff-adopt | Haiku | SDD TDD INC GIT | worker adoption; 559 pass | `f76acd2`, `dfac454`, `374d198` |
| runtime-reopen | Luna | SDD TDD INC GIT | ISSUES, two increments only; 569 pass | first increment `482caf1`; second repaired by next worker |
| runtime-ports | Haiku | SDD TDD INC GIT | corrected quiescence; 592 pass | `d510be5..be786ae` |
| cutover | Haiku | SDD TDD INC DOC GIT | final interfaces part A, retirement; 576 pass | `40d453d..9de5229` |
| routing-bind | Haiku | SDD TDD INC DOC GIT | ISSUES against full T16; 599 pass | `5986d81..2ab8897` |
| commands | Haiku | SDD TDD INC DOC GIT | quota exhausted, partial commit and dirty work preserved | continued by commands-luna |
| commands-luna | Luna | SDD TDD INC DOC GIT | corrected missing commit report; 607 pass | `079451e`, `c16d299` |
| learning-docs | Luna | SDD INC DOC GIT | docs, rendering unverified; 629 pass | `6e251c9` |
| self-model | Luna | SDD TDD INC DOC GIT | corrected busy-self coverage; 600 pass | `af14a68`, `aadf14b` |
| lifecycle | Luna | SDD TDD INC DOC GIT | corrected connected test/public cleanup path; 631 pass | `800304b`, `75a766c`, `86b52bc` |

A worker's test total differs from main when its base predates independently integrated work or does not contain
the user's two additional statusbar tests. Final main has 634, no skips.

## Additional user requests implemented

- Handoff adoption transfers a predecessor's live direct workers to the successor's literal agent name, moves
  queued worker results/questions, and allows successor send/cancel/permit/model. Journal parent/root update too.
- MCP `model` accepts self-targets where the native adapter supports them; busy self requests apply at a safe idle
  boundary, without cancelling or replaying themselves. Self retry/interrupt refused. Registered pull roots with
  no adapter-side `setModel` remain explicitly unsupported.
- Executor policy uses an already user/plan-authorized exact alternative after quota exhaustion. Fixed tasks never
  gain unapproved alternatives or implicit paid API billing. In this execution a live switch failed because the old
  daemon lacked `/model`; the exhausted worker was closed and Luna continued in the same worktree, preserving edits.

## Follow-up (same day, after the first results)

User asked to drop the pi limitations, render the diagrams, finish what was missing, restart the hub when nothing
else uses it, and publish to npm if not hard. Workers: search-pins (Haiku), routing-lineage (Luna, stopped without
implementing twice) then routing-lineage-2 (Haiku), continuation (Luna, stopped without implementing) then
continuation-2 (Haiku, hit the Claude session limit after committing complete work; verified after the reset).
Every result was rechecked in its worktree and on main.

npm publish was not done: npm is not logged in (401); `agent-link`, `agent-transcripts` and `cmux-mcp` are taken on
the registry by other owners; and Node refuses to type-strip `.ts` under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so publishing needs a scope rename and a build step, against the
repository's no-build rule. Installation stays `install.sh` from GitHub.

## Activation and outstanding operational work

**The currently running hub still uses old code.** At the last check it was running another project's executor and
its worker (`workflow-executor-3`, `books-builder-11`, books-rag plan). `agent-link stop` explicitly closes all agents. Restarting would terminate that unrelated
session and this executor; therefore no live restart was performed. After preserving sessions and stopping work,
restart the hub and reopen sessions to load the new daemon/tools. Tests of new daemon/model/adoption code used fakes;
no claim that the current daemon exposes the new endpoint.

All executor-owned workers are closed. Execution worktrees are retained because they contain intentional untracked
copies of approved inputs/briefs; no force deletion of these files was performed. The pre-existing
`pi-house-workflow-memory` worktree is untouched. There is no release or push.

The approved plan's global completion criterion is not fully met: the PARTIAL/BLOCKED rows above remain gaps, not
passes hidden by green unit tests.
