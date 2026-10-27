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
