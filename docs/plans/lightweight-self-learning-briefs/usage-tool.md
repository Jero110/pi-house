User-requested feature (outside the original plan, authorized directly by the user): check account usage before
choosing a model, and switch models when an account cannot be used.

If the plan does not answer a question, ask `workflow-executor` with send, then keep going.
Skills: spec-driven-development, test-driven-development, incremental-implementation, documentation-and-adrs, git-workflow-and-versioning
Read and follow before you start (each fully):
- skills/build/spec-driven-development/SKILL.md
- skills/build/test-driven-development/SKILL.md
- skills/build/incremental-implementation/SKILL.md
- skills/build/documentation-and-adrs/SKILL.md
- skills/build/git-workflow-and-versioning/SKILL.md
Also read: AGENTS.md, docs/architecture.md, docs/specs/self-learning/model-router.md, packages/pihouse/src/usage.ts,
packages/pihouse/src/workflow/routing.ts, and how packages/pihouse/src/extensions/statusbar.ts gathers usage (read only).
Work in: /Users/jeronimo.deli/Desktop/other/Vs/pi-house-usage (branch pihouse/self-learning-usage)

## Why

Today three workers were spawned on openai-codex while its quota was exhausted; they failed with 0 tokens and had to be
cancelled and respawned on Claude Sonnet. The user wants the executor (and any parent) to see, easily and before
spawning, which accounts have usage left, and to switch models when one cannot be used.

## Objective

1. A tool `account_usage` registered by a pihouse extension (pi.registerTool, read the installed pi
   docs/extensions.md fully first), available to every pihouse root and worker. It returns, per logged-in account and
   provider: each window (label, percent used, reset time), how fresh the observation is, and a status from
   routing.ts's classification (available, exhausted, stale, unknown). Reuse usage.ts parsers and the same sources the
   status bar uses (Claude Code's rate-limits folder, the ChatGPT usage endpoint with the login's token, response
   headers already seen). Unknown stays unknown, never 0% or "available". No secrets or tokens in the output.
   Bounded, cheap, no model call; network reads time out quickly and report failure as unknown.
2. Move any shared gathering logic out of statusbar.ts into usage.ts or a new focused module ONLY if needed, and do
   NOT edit statusbar.ts: it has unrelated uncommitted user edits in the main checkout. If reuse requires touching it,
   duplicate minimal logic in a new module instead and say so.
3. Update skills/build/executor/SKILL.md (Step 1 Dispatch) so the executor:
   - calls `account_usage` before each spawn (and before a batch of parallel spawns), and never spawns on an account
     reported exhausted;
   - when the plan's model is unusable (exhausted, or a worker fails with a quota/rate/auth error), picks an
     alternative the plan or the user authorized, records it as ASSUMED/AMENDED in the ledger, and either spawns on it
     or, for a live worker, uses agent-link's `model` tool (being built in parallel; refer to it by name, with
     `retry: true` after a failed turn and `interrupt: true` only when waiting is worse);
   - stale or unknown usage is not proof of exhaustion: it may spawn, but watches the first result.
   Run npm run skills after editing the skill.
4. Short README/architecture mention of the tool.

## Tests (fake data only)

Fake Claude rate-limit files, fake ChatGPT usage HTTP server, fake headers, fake clock: available, exhausted (100%),
stale, unknown/missing source, endpoint timeout reported as unknown, no token text in output, tool registered with a
bounded schema. No live APIs or paid calls.

## Rules

TDD RED first; small atomic commits. Gates: focused tests, npm run skills, npm run check, npm test, git diff --check.
Do not touch statusbar.ts, workflow/capture.ts, memory.ts, storage.ts, agent-link-core or the progress ledger. Copied
untracked plan/spec files are inputs only; never stage them. No dependencies, pi patches, push or child agents.

Your final answer is your report:
STATUS: PASS | ISSUES | BLOCKED
SUMMARY: one line
VALIDATION: the exact commands you ran and their real output
COMMIT: <sha> on <branch> (or "no changes")
CONCERNS: judgment calls outside the brief, or none
