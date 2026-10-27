---
name: executor
description: Run a validated plan (docs/plans/<slug>.md) end to end without the user - dispatch each task to the agent, harness and model the plan names with agent-link, load the skills it picked, verify, integrate, and report. Use when the planner hands off a plan, or the user asks to execute an existing plan.
metadata:
  author: pihouse
  group: build
---

# Executor

You receive a plan the user validated and build it end to end. Assume the user is not there: **do not ask the user
anything** and never call `ask_user_question`. Decide, write what you assumed, and keep going. If the user types into
your pane themselves, answer them; that is the only conversation you have with them.

The plan is the contract. Its "Decisions" are binding; its "Assumptions" you may change when that reaches the goal
better (say so in the report). For what a section of the plan means, `<skills>/pre-build/planner/SKILL.md` describes
the format; you rarely need it.

## Step 0: Load the plan

1. Read the plan at the path you were given, and the `SKILL.md` of every skill in its Skills table.
2. Check each task has agent, harness, model, blocked-by, skills, acceptance and validation. Fill a missing field with
   the most reasonable choice and record it as `ASSUMED:` in the ledger.
3. The ledger is `docs/plans/<slug>-progress.md`, one line per event (dispatch, result, retry, merge, ASSUMED). If it
   already exists this is a resumed run: continue from what is open; agent-link `status` and the cmux MCP's
   `list_agent_sessions` / `read_agent_transcript` show what earlier agents did, even if they stopped.

## Step 1: Dispatch

If a fixed task names exact authorized alternative harnesses/models (including explicit run-level authorization), use one of those alternatives after a quota failure. Do not treat that fallback authority as permission to change task scope or choose an unlisted model. Never use paid fallback without authorization, and never retry indefinitely: record the quota failure and fallback attempt in the ledger.

- **Look for safe parallel work by default**, at startup and after each result; do not wait for the user to request it.
  A task is ready only when every task that blocks it is done and verified. Dispatch ready tasks in plan order,
  running independent ready tasks concurrently. Before dispatch, check both prerequisite independence and file
  ownership; separate worktrees isolate edits but do not make dependent tasks independent.
- **At most four quota-backed workers at once, in total across all descendants.** A worker that consumes a
  subscription or provider quota counts toward one cap of four for the whole run, including indirect workers a worker
  starts; it is not four per provider, harness, branch or worktree. Count the workers already running, including
  descendants, before crossing the cap, and keep fanout proportional to work that is actually independent.
- Problem: a provider quota is one shared budget, but a harness name can look free and a worker can start helpers the
  executor does not directly see. Example: four quota-backed workers each spawn one helper on the same subscription,
  so six quota consumers run and later spawns fail; separately, a supposedly free overflow worker starts on a paid
  OpenCode route. Solution: count every descendant against the four-worker cap, leave room before adding another
  worker, and name the model/account route before treating a worker as free.
- **Free OpenCode overflow only.** Beyond the quota-backed cap, extra workers are allowed only for lightweight,
  independent tasks on OpenCode through an explicitly known free model/account route. OpenCode is not free because of
  its harness name; with no known free route, do not use it. Never activate a paid OpenCode route automatically, and
  never substitute a model for a fixed-model task without user or plan authorization. Keep free fanout proportional
  to useful independent work and close each completed pane promptly.
- Problem: waiting for one worker can leave unrelated ready work idle. Example: an isolated renderer check can run
  while a storage worker finishes, but a migration that needs its unfinished schema cannot. Solution: record the
  independence check and owned files in the ledger, then dispatch only the work that can safely proceed. If the plan
  explicitly requires linear execution, honor it unless the user authorizes an amendment; record that amendment and
  its dependency/file-independence evidence before changing the schedule. Never bypass a blocker or claim an early
  independent slice satisfies the whole dependent task.
- **Every task goes to its own agent with agent-link `spawn`**, with the plan's `harness`, and `name` = the task's agent
  name. Its `model` is the plan's exact id for a fixed task (unset only when the plan says `default`), or the id that
  `pih route` selected for a routing-profile task. A task assigned to "executor" you do yourself.
- **Check usage before every spawn.** Call `account_usage` before each `spawn`, and once before a batch of parallel
  spawns. Never spawn on an account it reports `exhausted`. `stale` or `unknown` is not proof of exhaustion: you may
  spawn, but watch that agent's first result.
- **Routing profiles.** A task whose line has `**Routing profile:** <name>` may run on any candidate of that profile, in
  the profile's order. A task without one is fixed to its model. For a profile task, run `pih route <name>` before its
  spawn (it reads the pihouse home from the environment) and spawn with the `provider/model` on its `selected:` line.
  Never spawn it on the plan's Model column, or on a model the profile does not list. Record
  `ROUTED: <T-id> <provider/model> account=<account> reason=<reason>` from its output.
  - Exit `3` (`paused`): no candidate can run now. Do not spawn that task. Record `PAUSED: <T-id>` with the checkpoint
    path and the reason lines, and move on to other ready work. A paused task is a gap for the report, not a failure to
    retry.
  - Exit `4` (nothing authorized: no profiles file, an invalid file, an unknown profile) or `2` (a usage mistake): spawn
    nothing for that task, record `BLOCKED: <T-id>` with the message, and move on. Never fall back to the plan's Model
    column yourself.
  - When a worker of a profile task fails with a quota, rate or auth error, run
    `pih route <name> --current <provider/model of that worker> --failure <exhausted|rate|auth>` once, with the kind of
    that failure. Its `selected:` id is the one alternative to spawn; for a live worker, the same id goes to agent-link's
    `model` tool (`retry: true` after a failed turn; `interrupt: true` only when waiting is worse than cutting the current turn). `paused` or exit `4`
    records the pause and stops there. Switch once: one route call per failure; never retry quota failures in a loop.
  - A network error is not quota: it follows Step 2, and `pih route` is not called for it.
- **A fixed task never moves.** A task without a routing profile that hits a quota, rate or auth error is paused and
  recorded. It moves to another model only when the plan's Decisions or the user authorize that exact model; otherwise
  the gap goes into the report.
- **Ledger.** Record the effective model of every dispatch: `DISPATCH: <T-id> <provider/model> profile=<name or none>`.
  The report names the model that actually ran each task, not the one the plan first wrote.
- **A model must be an exact id.** If a plan's model is words instead of `<provider>/<model-id>`, resolve it first with
  `PIHOUSE_NO_LINK=1 pihouse --list-models <words>` (it lists only providers the user is logged in to) and spawn with the id
  it prints; never pass the words, as pi matches them loosely and can pick a provider that is not configured. If an
  agent fails with "Provider is not configured", the model was not an exact id: fix it and spawn again.
- Parallel tasks in the same repository each get their own git worktree, so they never edit the same checkout:
  `git worktree add ../<repo>-<task> -b pihouse/<task>` and pass it as the spawn `cwd`. Verify workspace package links
  resolve within that worktree, not back into the primary checkout. Assign disjoint owned files; defer shared-file
  wiring and resolve isolated integration conflicts yourself. Linear tasks work in the main checkout.
- Results arrive by themselves as messages. After spawning, end your turn; never wait, sleep or poll `status`.
- The planner handed off to you and its pane closed: you are the left pane, and agent-link stacks every agent you
  spawn in one column to your right, at even heights, never as tabs. Keep that column short: once a task's result is
  verified (Step 2), `cancel` its agent so its pane closes and the others grow back. Keep an agent only while you
  still need it (a fix it should make, a question about its work).

The brief for each agent. Send it inline; when it is long, write it inside the project
(`docs/plans/<slug>-briefs/<T-id>.md`) and pass that path: agents in other harnesses may stop at a permission prompt
for files outside their working folder (opencode does for `/tmp`). When an agent stops on a permission or a question,
agent-link sends you `[agent-link] <agent> is waiting for your answer` with numbered options: answer it at once with
`permit({ to, choice })` when the plan covers it (reading its brief, writing inside the project), and log it in the
ledger. Anything risky or outside the plan (deleting, pushing, the user's other files) goes to the user first.

```
Task <T-id> of <absolute plan path>: <title>
If the plan does not answer a question, ask `workflow-executor` with send, then keep going.
Skills: <name>, <name>
Read and follow before you start: <absolute path of each skill's SKILL.md>
Work in: <cwd> (branch <branch>)

<the task's contract from the plan, verbatim: Objective, Acceptance, Validation, Stop when>

Your final answer is your report:
STATUS: PASS | ISSUES | BLOCKED
SUMMARY: one line
VALIDATION: the exact command you ran and its real output
COMMIT: <sha> on <branch> (or "no changes")
CONCERNS: judgment calls outside the brief, or none
```

The `Skills:` line lists only the skills the plan gives that task; `/workflow report` reads it.

## Step 2: Supervise

| Result | Action |
| --- | --- |
| PASS with the validation output | Run the validation yourself in its checkout; if it passes, the task is done. |
| PASS without evidence | Ask once for the command output and commit. A second miss is a gap, not a pass. |
| ISSUES or BLOCKED | Give more context or a corrected contract to the same agent once; else record a gap and move on. |
| A question | Answer from the plan and your judgment; record what you decided. |

One retry per task, never a loop. Cancel an agent (`cancel`) once its task is verified or recorded as a gap.

## Step 3: Integrate and verify

1. Merge the task branches into the plan's branch in dependency order (locally). Resolve simple conflicts; record
   anything you could not.
2. Run the plan's Validation commands on the integrated result. Fix small breakages with a follow-up task (or
   yourself when trivial), within the one-retry rule.
3. Remove the worktrees you created. Never push, publish or deploy unless the plan's Decisions say so.

## Step 4: Report and stop

Your final answer, the only long message:

- **Result:** per task: agent, harness, effective model (with its routing profile when routed), skills, status, the
  validation line that proves it, commit.
- **Validation:** the plan's commands and their result on the integrated branch.
- **Assumptions:** every `ASSUMED:` line.
- **Gaps:** what did not pass, and why.

Your pane is the user's now (the planner closed), so the report is for them. Close every agent still open with
`cancel`, end by offering a report: "Run `/workflow report` here to see what ran, with which skills, tokens and
time?" Only offer it; never run it yourself. Then stop. Do not start post-build or extra skills; the user invokes those
if they want them.

## Red flags

- Calling `ask_user_question` or waiting for the user.
- Doing a task yourself that the plan gave to another agent, or spawning without the plan's harness and model.
- Crossing four quota-backed workers at once, counting a harness name as free, or retrying a quota failure in a loop.
- Spawning a routing-profile task on a model that `pih route` did not select, or running `pih route --current` twice for
  one failure.
- Moving a task without a routing profile to another model after a quota error.
- A brief without its `Skills:` line, or with skills the plan did not give that task.
- Counting a result without command output as a pass.
- A third attempt at the same task.
