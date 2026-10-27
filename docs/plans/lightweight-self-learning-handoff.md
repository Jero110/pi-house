# Executor handoff: lightweight self-learning

The user explicitly requested a fresh Opus/Sol executor because the prior executor's context is large. Continue the approved initiative, NOT a new planning cycle. Read `skills/build/executor/SKILL.md`, the approved `docs/plans/lightweight-self-learning.md`, its progress ledger and relevant specs. Do not ask the user, pick skills again, or invoke planner. Original plan/spec status headers say proposed, but the user explicitly approved BOTH and execution. Report to the user in Spanish; code/docs/commits English.

## Where we are

- Main checkout: `/Users/jeronimo.deli/Desktop/other/Vs/pi-house` (case-insensitive aliases `/vs/` also exist).
- Branch: `feature/lightweight-self-learning`.
- Last integrated HEAD at handoff: `7c09655`.
- Last executor-verified integrated gates: `npm run check` (198 files, no warnings), `npm test -- --test-timeout=30000` (530/530, no skipped tests), `git diff --check`.
- Root `npm test` is the normal gate. Once it hung at tmux tests with no failures; a bounded diagnostic run passed. We use `npm test -- --test-timeout=30000` to diagnose hangs, not skip anything. Typical full duration ~21s now because interrupt timeout tests intentionally exercise a 20s bound.
- No push/publish/deploy/version bump. Do not release.
- NO real user-store migration/cleanup trial, NO synthetic live model experiment yet. Automated tests are fake sockets/HTTP/CLIs/models only.
- Original user statusbar edits MUST remain exactly untouched/unstaged: `packages/pihouse/src/extensions/statusbar.ts`, `packages/pihouse/test/statusbar.test.ts`.
- Approved planning inputs are still untracked user-provided artifacts: `CAPABILITY-MAP-self-learning.md`, plan and most module specs. Only memory-store.md became tracked through owned appendices. Do not stage unrelated original artifacts blindly. `git status` distinguishes them. Ledger contains all amendments.

## TWO ACTIVE WORKERS: inherit/supervise; DO NOT cancel or duplicate

### 1. `learning-runtime`

- Harness pihouse; model `openai-codex/gpt-6-luna`.
- cwd `/Users/jeronimo.deli/Desktop/other/Vs/pi-house-usage`.
- Branch `pihouse/self-learning-runtime`.
- Its first commit `698cae8` is NOT integrated. It adds new `workflow/learning-runtime.ts`, `worker-adapter.ts`, runtime tests. It did NOT complete commit/cleanup or public commands. Initial worker gates 519 tests on its older base. Do not call it complete.
- It is currently working its ONE allowed corrective increment. I sent these required fixes:
  1. Worker finish must inspect LATEST assistant message and reject length/aborted/error/missing reason, never scan back to an old stop. Require spawned worker/session/parent identity, fresh unique output per attempt, regular bounded output; close owned child on every terminal path.
  2. Spawn digest/scan/review children under a DEDICATED pull coordinator registered with agent-link, not initiating native root. Otherwise automatic result delivery may put generated report text into initiating model context even if code only returns paths. No unrelated inbox consumption. Coordinator gets generated outputs; caller gets code-computed short status/paths. Dedicated coordinator registration is not another model call. Stage-specific prompts must include actual output contract and final shortstatus/path.
  3. Candidates must match immutable DB revision with current run.json fingerprint/evidence hash; cannot digest newer overwritten package for older DB row. Pin/recheck exact input bytes, use lstat/realpath containment, reject symlinks. expectedFiles must include raw JSONL as well as normalized JSON (cleanup requires exact full file coverage). No unused computed hash pretending to pin inputs. Explicit aggregate input budget, no silent truncation.
  4. Implement actual callable digest -> observed finish -> commitDigest -> fenced cleanup integration for verified synthetic captures, freshly recompute fingerprint before cleanup, defer when liveness/source/coverage unknown. Review port connects runSelfLearning. Public workflow commands remain separate.
- Own new runtime/adapter/tests only. Do not overlap its files. No actual live worker/model launch in tests or experiment. If correction fails, report precise BLOCKED, do not loop indefinitely.

### 2. `routing-4`

- Harness pihouse; model `claude-bridge/claude-haiku-5-5`.
- cwd `/Users/jeronimo.deli/Desktop/other/Vs/pi-house-titles`.
- Branch `pihouse/self-learning-routing-profiles`.
- Current branch HEAD observed `d64c0ba`; obtain worker result/inspect log before integrating. NOT integrated yet.
- Task: remaining T14 backend integration, new routing profile module/tests plus minimal existing routing/account-usage changes. Explicit versioned `<home>/routing-profiles.json`: exact provider/model/account/billing/capabilities/ordered alternatives, validate target via injected actual registry find+hasConfiguredAuth, no guessed model equivalence or implicit paid API authorization. Route real account observations through existing route/pollAccount shared state; stale/unknown/auth/network/rate/exhausted distinct. No route -> durable paused checkpoint and injected notice. T16 interactive/plan binding deferred.
- No changes to runtime worker's files, statusbar, core MCP, public workflow.ts, skills or ledger. Focused routing/account tests, check/full bounded tests/diff. One correction allowed if needed. Source quota observations stale, never assume availability from model listing.

Workers may still send results to old parent. Handoff spawn is supposed to preserve them; also message them to direct results/questions to your exact new agent name. Existing agent-link hub can send/cancel/spawn, but its live process/tool schema still has OLD model-tool code (see below). Never restart hub while workers active.

## User amendments / provider authority / concurrency

Original plan was Luna-only and strictly linear. User subsequently explicitly authorized safe parallel work, Terra/Luna, later Sonnet on Codex exhaustion, then free OpenCode for lightweight overflow, then explicitly Luna OR Haiku after OpenCode hit its free limit. Latest implementation authority: Luna/Haiku, and this Opus/Sol handoff explicitly authorized. Original Haiku prohibition is superseded for implementation ONLY. Single live digest smoke remains Luna-only per approved experiment decision; user did not authorize changing it to Haiku/Opus.

Executor skill now requires:
- Seek safe independent parallel work by default; preserve dependencies and disjoint ownership.
- MAX FOUR provider-quota-backed workers TOTAL across descendants, not four per provider. Additional lightweight work only with an explicitly free OpenCode model/account route and proportional fanout. Currently free OpenCode quota is exhausted: no new OpenCode spawns.
- We deliberately keep only TWO quota-backed implementation workers now to conserve usage. Handoff executor is additional active agent; don't proliferate.
- Check `account_usage` before spawn. That tool is registered in new pihouse sessions but not exposed in the prior executor's static tool list. If unavailable, invoke the already implemented collector without credentials/provider calls:
  `node --input-type=module -e 'import {gatherAccountUsage,formatAccountUsage} from "./packages/pihouse/src/account-usage.ts";const now=Date.now();console.log(formatAccountUsage(await gatherAccountUsage({now,providers:["claude-bridge","openai-codex"],headers:{}}),now));'`
  Most recent results: Claude stale (weekly17%, last file ~15h old), OpenAI unknown (no token supplied). Model listing is local config, NOT proof remote quota. Last Luna and Haiku tasks succeeded. Stop on actual limit error, no retry loop.
- Configured exact IDs resolved: `openai-codex/gpt-6-luna` (272K), `claude-bridge/claude-haiku-5-5` (1M), `claude-bridge/claude-sonnet-5-5` (1M), `claude-bridge/claude-opus-5-5` (1M), `openai-codex/gpt-6.1-sol` (500K). Use currently authorized and configured only, never silent paid API accounts.

## Integrated work / real limitations by task

Do not confuse many passing helper tests with the complete user-visible initiative. Final command cutover/end-to-end learning is NOT done.

- T1 baseline: main8db4a17, original365 tests, feature branch and ownership recorded (c3eba17).
- T2 code-only report: d4df594. `/workflow report [--last]` exists, never triggers a model or flags ordinary session. Partial/unknown reporting. Old `/workflow review` still active until T20.
- T3 storage/artifact/backup: 699c977,4f1a124. Versioned SQLite base schema, private durable artifact manifests, FTS capability diagnostic, operational backup. v2 migration opt-in via legacy:true, no deps.
- T4 evidence/cursors: 764c353,c7c3653,dd186f2,7ba0428,8c9a48e,cbb9e91; latter integrated same main history. Reconstruct reports from body-free retained evidence; verifiable pi/pihouse append-only JSONL byte/record/prefix fingerprints, suffix-only normalized captures, same-timestamp append recognized, stable fork lineage if observable; unknown/truncated/rotated sources defer. IMPORTANT GAP: processed run still returns processed instead of reopening; timing/tool correlation across suffix boundary unestablished. Not universal native continuation. Bridge583c504 integrated358136b now activated verified captures persist operational rows; immutable globally unique safe revision IDs, correct evidence SHA, typed nulls. Unactivated stores file-only.
- T5 migration:170a46b. Explicit migrateLegacyStore only, backup manifest/resumable transactions/concurrency test50 simultaneous ideas. migration-active.json marker detects missing/corrupt activated DB; schema v2 tables index_entries/flags/rejected/legacy_records. Every imported run deletion_authority=none. Legacy applied isn't verified receipt. Files written in failing store call are not rolled back, only DB transaction. No startup automatic real migration.
- T6 search: standalone e84def3/c1625a5; activation33d62a8 integratedf2c1e2f. Inventory from activated index, canonical body/hash/scope/status/trust/path filters, no transcripts, derived rebuild preserves operational state. Known small gap: incremental comparison before BEGIN IMMEDIATE (derived index race), orphan metadata without FTS row cleaned by full rebuild; missing canonical file fails closed.
- T7 digest contract/fixture: a519a64/969142d. Synthetic fixture/rubric/hash manifest + technical contract12k UTF16 units, mandatory JSON sections/identity/finish. docs/research/luna-digest-smoke.md documents limitations. LIVE SMOKE STILL UNPERFORMED, authorization unused. One fresh Luna synthetic agent only, no real sessions; no comparative price claims. Generic maxTokens is NOT enforced by installed Codex request builder; no hard spend cap claim. Pihouse loads explicit extensions even with --no-extensions. Must isolate launch so workflow capture cannot sweep real initiating run (a dedicated registered synthetic pull coordinator/root could solve this, but NOT tested or exercised). Do not silently substitute another model for experiment.
- T8 jobs:278e417,454a840. Atomic claims/leases/fencing, attempts2/invocation, cancellation free, failure isolation, injected bounded dispatcher and separate cleanup retry port. Runtime adapter still active-worker correction, not yet complete.
- T9 cleanup:545e747. commitDigest validates artifact/metrics/lineage/fingerprint/full owned file manifest, runCleanup idempotent safe path/hash/deletion gates, capturedAdmission/cleanedCursors helper. Callers must ensure actual liveness/quiescence and fresh fingerprint; these are not enforced magically. Capture does not yet call admission/cursor helpers or reopen processed runs. Digest path mismatch with spec: documents.ts emits digests/<run>/digest-<rev>.md not <rev>.md. Commit receipt is cleanup_manifests, not receipts. Resolve/document honestly before end-to-end acceptance.
- T10 review:e85e8d0. Injected runSelfLearning digest prep->semantic scan->whole retained digest review; max10 independent run lineages, aggregate budgets/no truncation, pinned batch membership/revisions/hash, prior decisions/counterevidence/overflow. Real /workflow invocation not yet wired. Gaps for T23: crash between manifest file and batch-row insertion; optional digest commit callback untested. Review Markdown does NOT yet become actionable proposals automatically.
- T11 proposals:fc71b8e,196cad3,517b650. SQLite version/approval/rejection/reopen primitive; expected changed effect+validation before receipt; injected CAS rollback refuses user changes. Missing REAL scoped filesystem target/CAS executor, catalog validation, file/DB crash recovery, semantic crossproposal merge, list/prefix APIs, review->proposal conversion, mapping legacy proposal payloads. Memory MCP proposals before="" are hypotheses, not directly applicable patches.
- T12 memory MCP:50aaccf,d42a12b,96efc5b. Scoped search/get/propose/feedback stdio server + pih setup fake Claude/Codex/OpenCode/pi installer coverage. Identity AGENT_LINK_AGENT, project launched cwd git top-level, PIHOUSE_MEMORY_HOME/pihouse home; empty scope env falls back to trusted cwd, missing identity/relativeproject/missingstore deny. No model-supplied scope grant. Schemas + short usage rule only, no bootstrap retrieval. User configuration not modified unless pih setup called. Hub token not verified; identity trusted launcher env. Existing setup not run on real user config.
- T13 ask:6308021,192b59d. Activated operational metrics query joins same-revision lineage project, latest snapshot per run to avoid double-counting; participants/skills scoped to same revision IDs; explicit snapshot-not-event-billing and unknowns; post-captured-file-deletion project-isolation test. Selective docs3K, skill paths catalog, nonsecret allowlist, retained search. Legacy/unactivated metrics unknown, no native session fallback. Source/link fake tests pass. Initial bad unscoped draft was corrected BEFORE integration.
- T14 standalone route integrated5cfa400; actual profiles/config/resolution/shared polling/checkpoint port being finished by routing-4. Do not claim done until result and independently verified.
- T15 native switch USER FEATURE implemented but full cross-harness fenced continuation NOT implemented. Core model tool integrated4a1b804/709d26d/d6a8046/772e945: ancestor-only exact id/auth native model change; pi/pihouse and OpenCode supported; Claude/Codex/paste explicit unsupported. Same-writer switch isn't cross-harness handoff.
- Additional retry24a7025: retry:true only after confirmed applied switch of idle failed live worker, original failed message once, no successful/pending/failed replay, actual error forwarded/logged; fake tests.
- Additional interrupt3e83b9c/22834d5: validate/request switch first to avoid cancelling unsupported adapters, native cancel, bounded20s require cancelled+idle+confirmed model then ONE continuation at queue front preserving history, never original-task replay; concurrent interrupts refused, retry+interrupt exclusive, natural finish/timeout/exited explicit outcomes. Native live permissions/races untested; fake adapter coverage. Tool is EIGHTH MCP tool. Live running hub STILL OLD until controlled restart AFTER all workers done. Do not kill/restart now.
- T16 user context-upgrade subset4803cf3/f94942e: explicit JSON route opt-in, source/target metadata context-window/capabilities/auth/headroom, automatic monitoring pending/paused notice, manual /context-upgrade apply with waitForIdle/recheck/native setModel. AUTOMATIC SWITCH NOT IMPLEMENTED (no proven safe automatic boundary), extension NOT registered in paths/launcher and plans don't bind profile yet. Last current manual call isn't available until extension loaded. User wanted Luna272K->Terra500K example only, not guessed equivalents.
- T17 titles:e3c343d,5d8db21. Supported isolated configured Luna call and ownership/manual/selector/stale/rate/worker/resume/fork tests, optout PIHOUSE_AUTO_TITLE=0. Generic maxTokens48 is not hard Codex spend cap; isolated title usage not retained session metrics. cmux card/notification visuals not verified. Never touch user statusbar.
- T18 skill-read UI:94e7ab9. Successful actual SKILL.md reads -> UI-only Read skill label; failed reads/mentions excluded; call-ID dedup, reload visible. Full manual /skill expansion visibility BLOCKED (no reliable successful expansion hook), no inference from mentions.
- T19 command grouping BLOCKED: pinned pi1.3.0 supports per-tool-row renderer, no supported adjacent/sibling transcript grouping API (types.d.ts:347, interactive-mode.js:2852/3264). No patch/pseudogroup done.
- T20 PUBLIC COMMAND CUTOVER NOT STARTED: workflow still report|review|save|ask. Need final report/save/digest/self-learning/ask/proposals/approve/reject; concise rejected old review/keeper, no aliases. Requires runtime backend + proposal integration first.
- T21 keeper retirement NOT DONE: keeper.ts extension, launcher/CLI, skills catalog and keeper skill still active. Preserve historical ADR/captures/migration legacy data.
- T22 initiative docs/diagrams/ADR/changelog NOT DONE. Existing model tool docs fa4efb6 integrated7c09655 updated8tools/model/retry/interrupt/restart; broader keeper/review docs intentionally not rewritten prematurely.
- T23 full fake lifecycle/crash matrix/lightweight context guarantees NOT DONE. 530passing tests do NOT substitute full lifecycle. No live digest experiment yet, no skipped tests/cost claims.

## Critical audited integration gaps / recommended next order

1. Verify active runtime correction and routing profiles worker. Independent focused/full gates in their worktrees, cherry-pick OWN commits in dependency order. Don't cherry-pick unverified 698cae8 alone as full runtime success.
2. Capture->DB bridge now fixed, but consumed captured revisions reopening/cleaned admission still missing. Prevent double source reimport after cleanup; legacy IDs `legacy:<run>` are NOT cleanup-safe and must remain deletion authority none. Never coerce legacy artifact hash into new evidence hash.
3. Connect real agent launch adapter + observed child finish + digest artifact identity/persistence/metrics/fingerprint/quiescence + jobs/cleanup + review. No parent full reports. Dedicated coordinator to contain generated child result messages. Runtime worker is on this.
4. Provide safe real proposal list/prefix/pinnedtarget/CAS/validation/receipt/rollback + review-to-proposal port (not model self-reported applied). Existing injected primitive is NOT production filesystem executor.
5. Cut over workflow commands only when runtime works safely; remove keeper last after migration supported. T20/T21 exact locations audit below.
6. Finish bounded routing/interactive/executor profile bindings and explicitly unsupported cross-harness continuity (don't patch pi for impossibilities).
7. Single authorized isolated synthetic Luna live smoke if safe scope/launch can be proved; otherwise honest BLOCKED, no paid loop. Then full T23 fake lifecycle/fault matrix, docs/diagrams/ADR/changelog matching actual implementation, final gates and statusbar preservation/worktree cleanup.

### Cutover locations from read-only audit (line numbers may drift)

- extensions/workflow.ts USAGE/help/completions/dispatch currently report|review|save|ask; remove old review() and its model-turn instructions; retain code-only report and new ask.
- src/cli.ts runKeeper import/usage/dispatch; launcher.ts KEEPER_NAME/KEEPER_START/liveKeeper/runKeeper; paths.ts keeper.ts registration.
- New test/workflow-commands.test.ts absent. workflow-report.test.ts currently asserts old review triggers model and must be changed to old review rejected without accidental ask triggerTurn match. pihouse.test.ts keeper launcher/catalog/help assertions; keeper.test.ts old pipeline coverage must be migrated/preserved, not silently deleted to get green.
- skills/extras/keeper/SKILL.md + catalog entry + generated skills/README.md retirement, npm run skills. Historical ADR001/captured keeper identities remain.
- setup.ts has no keeper-specific standalone entry; don't invent irrelevant edits.

## Worktrees / ownership and verification hygiene

Main and worktrees share external deps but each has LOCAL node_modules directory of symlinks, with workspace package symlinks overridden to ITS OWN packages. A single symlink of entire node_modules to main caused false hub-path baseline failures and was fixed. Never install dependencies or mutate linked node_modules.

Owned execution worktrees:
- ../pi-house-titles: active routing-4. DO NOT remove/switch until verified and worker closed.
- ../pi-house-usage: active learning-runtime. DO NOT remove/switch until verified and worker closed. Contains local untracked approved plan/spec copies and T13 brief.
- ../pi-house-shell: completed evidence-store branch583c504; copied untracked plan/specs/duplicates, no active worker.
- ../pi-house-routing: old ask branch e85e8d0, no active worker. Copied plan/specs.
- ../pi-house-workflow-memory: PRE-EXISTING unrelated worktree, NEVER remove or reset.

Clean up only worktrees this execution created, and only when workers finished; copied untracked docs must not be deleted by broad force without reviewing provenance. Existing user statusbar edits only main checkout. No git add ., no reset --hard, no stash unknown changes. Parent ledger owned by executor, not workers.

The latest progress ledger additions and this handoff are intentional executor docs; commit them alone after gates, without unrelated statusbar or approved untracked original specs. Use small TDD verified worker commits, one corrective retry not endless acknowledgements. On quota error pause/switch explicitly authorized route, no guessing. Final user report in Spanish with real per-task status, tests, commits, limitations and no claims of completion from helpers alone.
