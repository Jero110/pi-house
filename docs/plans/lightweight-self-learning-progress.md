# Lightweight self-learning execution progress

## T1 — Execution baseline and ownership

- Recorded before branching: `HEAD` `8db4a17b53b8469662ccb29e131c6fe4a3b2038f`; branch `main`.
- Initial status included pre-existing modifications to `packages/pihouse/src/extensions/statusbar.ts` and `packages/pihouse/test/statusbar.test.ts`, plus untracked `CAPABILITY-MAP-self-learning.md`, `docs/plans/lightweight-self-learning.md`, and `docs/specs/self-learning/`.
- Inspected both statusbar diffs without modifying them. They contain statusbar layout/reasoning support changes and tests; they remain untouched and unstaged.
- Created and now work on `feature/lightweight-self-learning` with `git switch -c`; no checkout/reset/stash or push was used. Current HEAD remains `8db4a17b53b8469662ccb29e131c6fe4a3b2038f`.
- Read repository instructions, architecture, shared contract, plan and all eight referenced module specs. The four selected skills are present and were read: spec-driven-development, incremental-implementation, documentation-and-adrs, git-workflow-and-versioning. The plan also references test-driven-development; its file exists, although it was not a selected T1 skill. No missing referenced skill document found.
- Installed pi documentation path exists at `node_modules/@earendil-works/pi-coding-agent/README.md` and `.../docs/` (including extensions.md, sdk.md and tui.md). T1 makes no pi API changes, so no API document was needed yet.
- Baseline on the preserved dirty tree: `npm run check` passed (Biome checked 157 files, TypeScript and pinned-dependency check passed); `npm test` passed, 365/365 tests, zero failures.
- Ownership/commit policy: retain pre-existing statusbar edits exactly; do not stage them. Treat the capability map, plan and specs as pre-existing user-owned untracked artifacts. This progress log is the deliberate T1 addition and may be committed alone after checking its staged diff. Later work must stage only explicitly owned hunks/files, run checks/tests, and make atomic commits. No push, destructive checkout, reset, or cleanup of unowned files.

Validation snapshot: `git status --short` and `git diff -- packages/pihouse/src/extensions/statusbar.ts packages/pihouse/test/statusbar.test.ts` were inspected; statusbar files remain modified and unchanged by T1. Branch: `feature/lightweight-self-learning`.

## T2 — Code-only reports

- Dispatched to `evidence` (pihouse, `openai-codex/gpt-6-luna`) after T1 verification.
- Result: PASS; added `/workflow report [--last]` with local fallback, explicit partial/missing-usage labels, and no LLM turn or automatic flagging. Commit `d4df594` (`feat: add code-only workflow reports`).
- Executor verification: `node --test packages/pihouse/test/workflow-report.test.ts` passed (2/2); `npm run check` passed; `npm test` passed (367/367). The commit changes only workflow/report implementation and its test. Pre-existing statusbar files and untracked planning/spec documents remain untouched.

## T3 — Durable storage primitives

- Dispatched to `storage` (pihouse, `openai-codex/gpt-6-luna`).
- Initial implementation committed as `699c977` (`feat: add durable workflow storage primitives`): versioned operational schema, artifact commits/recovery, FTS capability diagnosis. Focused storage tests passed 3/3; check passed; suite passed 370/370.
- The first review identified the explicit backup-preservation acceptance was missing. One allowed retry added private SQLite + canonical-artifact backup support in `4f1a124` (`feat: back up workflow database and artifacts`).
- Executor verification after retry: `node --test packages/pihouse/test/storage.test.ts` passed (4/4); `npm run check` passed (Biome checked 161 files; no fixes); `npm test` passed (371/371); `git diff --check` passed. No unrelated files included.

## T4 — Structured evidence revisions

- Dispatched to `evidence-2` (pihouse, `openai-codex/gpt-6-luna`). The initial attempt was blocked: incomplete structured retention/report reconstruction and failing check. One retry was used.
- Retry committed `764c353` (`feat: persist structured workflow evidence revisions`): body-free evidence metadata, fingerprints, revisions, cursors and capture tests. Same snapshots are tested idempotent; report capture labels missing sources.
- Executor verification: `node --test packages/pihouse/test/evidence.test.ts packages/pihouse/test/capture.test.ts` passed (9/9); `npm run check` passed (Biome checked 162 files; no fixes); `npm test` passed (372/372); `git diff --check` passed.
- **BLOCKED against T4 acceptance:** retained `report.md` is only a sanitized capture-time report, not regenerated from retained structured evidence after captured transcript deletion. The worker reports the current report renderer still requires `WorkflowRun`/transcript input. This criterion is unmet, so T4 is not considered done and dependent T5–T23 were not dispatched. No API/contract was weakened to claim success.
