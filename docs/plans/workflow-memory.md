# Workflow memory and the keeper

**Plan:** docs/plans/workflow-memory.md · **Planned:** 2026-10-26 · **Branch:** main (work happens on `feat/workflow-memory` in a worktree)

## Goal

pihouse gets a persistent, lightweight memory of how the user works, kept by one durable agent, the **keeper**.

- Every planner or executor run, and every conversation the user flags with `/workflow save [reason]`, is captured
  cheaply: the whole agent tree (every agent-link worker included) as one package, with its
  computed metrics, the reason, and a copy of each transcript.
- The keeper is always reachable under a fixed name. It tells the user how many runs are pending. When the user says
  "summarize them", it digests the whole batch in a fresh conversation (1 or N runs), writes what it learned, gives
  the user the summary and its proposals, marks the batch as processed so nobody reads it again, and purges its own
  context. Its cost per turn does not grow over time.
- `/workflow ask` (answered from the memory) accepts questions, links and YouTube videos: it transcribes them with an
  existing tool, keeps the source and a summary, relates it to the user's past runs, and saves any ideas.
- The system improves itself only with the user's approval: it writes proposals that the user approves or rejects,
  archives memory nobody uses, and proposes removing skills, rules or ideas that are no longer used.

Example: the user runs the planner and then the executor on a feature. When the executor finishes, it asks "Run
/workflow review?"; the user says no. A week later, after a chat without the planner that went well, the user types
`/workflow save I liked how this went`. The keeper says "3 runs pending". The user tells it "summarize them". In a new
conversation it reads the three packages, writes a digest of each, adds a rule to the workflow memory ("short briefs
with an explicit Files list avoided rework in 3/3 runs"), and proposes dropping a skill that no run loaded. The user
approves the rule and rejects the drop. The three packages are archived and never read again.

## Decisions (binding)

These are the user's. Items marked **[proposal, research decides]** are the user's proposals: the research (T1) must
check whether something like it already exists or a better idea does, try the alternatives where it is cheap, and the
executor may replace the proposal **only with evidence**, recorded in the ADR (T2). Everything else is binding.

1. **Lightweight by architecture, not by prohibition.** The design does most of the work with code (metrics, copies,
   indexes, counts, marking runs as processed), so a model is called only where it adds value: a short summary, a
   digest, an answer, a proposal. There is no hard "0 tokens" rule; a model may be used at capture time when it is
   worth it (for example a few-line summary of a saved chat), as long as it reads little and its cost stays small and
   flat as the memory grows.
2. **Planner and executor runs are flagged and captured by default.** Their sessions are named with a `workflow-`
   prefix (`workflow-planner`, `workflow-executor`). Runs without a flag never enter the memory, `--last` or the
   batch digest.
3. **`/workflow save [reason]`** flags any conversation, even one with no planner or executor (a plain chat that
   went well), and captures it with the reason.
4. **A capture is the whole tree as one package**: the session, every agent it launched with agent-link and theirs,
   with the computed metrics (tokens, time, skills per agent, as `/workflow review` computes them today), the reason,
   and a **copy** of every transcript, so nothing is lost if the originals are deleted.
5. **`/workflow review`** with no flag reviews the current session (flagged or not). **`/workflow review --last`**
   reviews the most recent **flagged** run.
6. **When the executor finishes**, it offers the user a `/workflow review`; it never runs one by itself.
7. **Everything else is manual for now**: no automatic reviews and no scheduled jobs. The keeper processes a batch only
   when the user tells it to, and always says how many runs are pending.
8. **The keeper is durable**: one pihouse agent under a fixed agent-link name that the user can always talk to. After
   each task it saves what matters to disk and starts again with a clean context, which costs nothing while idle and
   keeps the cost of each turn flat. It works on batches so it generalizes across runs. A run it has processed is
   marked done and never read again. **[proposal, research decides: how it stays durable and how it purges
   (rotating the session, compaction, a sleep-time consolidation pass)]**
9. **The batch digest happens in a new conversation**: the user asks the keeper, and the keeper opens a fresh session
   for it and hands back the summary.
10. **The memory** holds: captured runs (pending, then processed), digests, `consulted/` (sources the user sent, with a
    summary), `ideas/`, `proposals/`, `archive/`, and a living **workflow memory** file (how the user works, what works
    and what does not) that the keeper updates and `ask` always reads. **[proposal, research decides: location
    (proposed global `~/.pihouse/memory/`, each entry tagged with its project), file format (proposed Markdown with
    frontmatter plus a small index the model reads first), layout]**
11. **Self-improvement is supervised.** The keeper writes concrete proposals (edit a skill, remove something, add a
    rule to the workflow memory). The user approves or rejects each one, and only approved ones are applied. Rejected
    ones are remembered and never proposed again.
12. **Pruning.** Memory nobody consulted in 90 days, or memory that was superseded, moves to `archive/` without
    asking, and is never deleted. Skills, rules and ideas not used in the last N runs come up as proposals to remove
    them. Raw transcript copies are archived once digested, and after 90 days the keeper proposes deleting them;
    nothing is deleted without the user's OK.
13. **ask + video and links.** A YouTube link or video is transcribed by an **existing tool or API**, not by an agent
    reading it. Only when no tool can handle the source does a cheap agent do it. The transcript goes to `consulted/`
    as the source, with a summary, related to the user's past runs. Ideas go to `ideas/`. Everything is saved
    automatically; the user decides later what to delete. **[proposal, research decides: which tool]**
14. **Lightweight is the goal of the whole design.** The two places that read a lot are the review and `ask`. The
    model sees indexes, digests and short summaries, never full transcripts outside the one digest pass. Each run is
    read in full exactly once. Anywhere else, a model call is fine when it is small and needed.
15. **Models and harnesses:** the researcher is pihouse on `openai-codex/gpt-6-luna`, the executor is pihouse on
    `claude-bridge/claude-opus-5-5`, and the builders are pihouse on `claude-bridge/claude-sonnet-5-5`.
16. **Git:** the work happens in a separate worktree `../pi-house-workflow-memory` on the new branch
    `feat/workflow-memory`, created from `HEAD`. The user's uncommitted changes in the main checkout (`working.ts`,
    `identity.ts`, `statusbar.ts`, `compact-tools.ts`, `paths.ts`, the theme, tests, `docs/architecture.md`) are not
    touched, copied or committed. One commit per task, no push, no PR. The user merges.
17. **Build, then report**: the user chose "research and build", so there is no human gate between the research and
    the build. The executor decides from the research and documents it.

## Assumptions (the executor may change these)

- `review` and the batch digest share one engine: a run is digested once (full read), and later batches only read
  digests. This follows from decision 14.
- The keeper is a pihouse agent with a skill of its own (`keeper`, group `extras` or a new one; registered in
  `skills/catalog.json`) plus a pi extension for its commands, so the workflow stays in skills and extensions, without
  patching pi.
- The size of the context the review and `ask` build is checked by a test with a fixed limit (about 20k tokens,
  estimated as chars/4), so a later change cannot inflate it silently.
- "Not used" for pruning means never loaded or never named in the last 10 processed runs (N = 10).
- A new dependency is avoided. A transcription tool that is an external CLI (for example `yt-dlp` for subtitles, or a
  local whisper) is detected on PATH and reported as missing, never installed by pihouse. An npm dependency is added
  only if the ADR justifies it, pinned exactly.
- The worktree needs its own `npm install --ignore-scripts` (the lockfile pins everything).
- ADRs go in `docs/decisions/` (there is no existing convention), the spec in `docs/specs/workflow-memory.md`, and the
  research in `docs/research/workflow-memory.md`.

## Skills

| Skill | Author | Path | What it changes in this work |
| --- | --- | --- | --- |
| spec-driven-development | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/spec-driven-development/SKILL.md | A spec (objective, commands, layout, testing, boundaries) is written from the research before any code; each build task implements a section of it. |
| documentation-and-adrs | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/documentation-and-adrs/SKILL.md | ADR-001 records the memory architecture against the alternatives the research tried; docs/architecture.md, README and CHANGELOG are updated. |
| git-workflow-and-versioning | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/git-workflow-and-versioning/SKILL.md | Worktree on feat/workflow-memory, one atomic commit per task with type prefixes, no push. |

## Agents

| Agent | Harness | Model | Does |
| --- | --- | --- | --- |
| executor | pihouse | claude-bridge/claude-opus-5-5 | Sets up the worktree, writes the spec and ADR from the research, reviews and integrates every task, writes the docs and the final report. |
| researcher | pihouse | openai-codex/gpt-6-luna | Researches memory architectures and transcription tools, checks the user's proposals, tries the alternatives, writes the research report. |
| store | pihouse | claude-bridge/claude-sonnet-5-5 | Builds the memory store module. |
| capture | pihouse | claude-bridge/claude-sonnet-5-5 | Builds flags, capture, `/workflow save` and the review changes. |
| sources | pihouse | claude-bridge/claude-sonnet-5-5 | Builds the source-transcription module (YouTube and links). |
| keeper | pihouse | claude-bridge/claude-sonnet-5-5 | Builds the durable keeper: its skill, extension, batch digest, purge, proposals and pruning. |
| ask | pihouse | claude-bridge/claude-sonnet-5-5 | Moves `/workflow ask` onto the memory and the keeper, with sources and ideas. |

## Execution

The research has to finish before anything is specified: the user's proposals are only defaults until it confirms
them. After the spec, the store comes first, because everything writes through it. Capture and the sources module
touch different files and run in parallel. The keeper needs both the store and capture. `ask` needs the keeper and the
sources module.

```
T0 ─► T1 ─► T2 ─► T3 ─┬─► T4 ─┐
                └─► T5 ───────┼─► T6 ─► T7 ─► T8
                       (T5 also feeds T7)
```

- T5 (sources) depends only on T2 and runs in parallel with T3 and T4. It gets its own worktree
  (`../pi-house-wm-sources`, branch `pihouse/wm-sources`) and is merged into `feat/workflow-memory` after T4 is
  merged.
- Merge order: T3, T4, T5, T6, T7, T8. Every merge is followed by `npm run check && npm test` in the main worktree.

## Tasks

### T0: Worktree and branch
**Agent:** executor · **Harness:** pihouse · **Model:** claude-bridge/claude-opus-5-5 · **Blocked by:** none · **Parallel with:** none
**Skills:** git-workflow-and-versioning
**Files:** none in the main checkout
Objective: an isolated checkout for the whole plan.
Acceptance:
- [ ] `git worktree add ../pi-house-workflow-memory -b feat/workflow-memory HEAD` from `/Users/jeronimo.deli/Desktop/other/Vs/pi-house`
- [ ] `npm install --ignore-scripts` in the worktree; `npm run check && npm test` pass on the untouched branch (or the pre-existing failures are recorded in the ledger as the baseline)
- [ ] `git status` in the main checkout shows exactly the same files as before
Validation: `cd ../pi-house-workflow-memory && npm run check && npm test; cd - && git status --short`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T1: Research the memory architecture and the transcription tools
**Agent:** researcher · **Harness:** pihouse · **Model:** openai-codex/gpt-6-luna · **Blocked by:** T0 · **Parallel with:** none
**Skills:** spec-driven-development
**Files:** `docs/research/workflow-memory.md` (in the worktree `/Users/jeronimo.deli/Desktop/other/Vs/pi-house-workflow-memory`), scratch prototypes under `docs/research/workflow-memory-trials/` (not committed unless cited)
Objective: an evidence-based report that says, for each of the user's proposals, whether something like it already
exists, whether there is a better idea, and what to build. The user explicitly asked not to invent the architecture:
it has to come from what others built.
Context to give the researcher (it never saw the conversation): pihouse is pi (the `@earendil-works/pi-coding-agent`
package, unmodified) plus extensions and skills. It reviews workflow runs from the agent-link journal
(`~/.agent-link/sessions/*.json`) and transcripts (see `packages/pihouse/src/workflow/run.ts`, `report.ts`,
`packages/pihouse/src/extensions/workflow.ts`, `docs/architecture.md`). The user's proposals are the bracketed items
8, 10 and 13 in this plan's Decisions, and the whole design in the Goal.
Research:
- The pi ecosystem: the local pi package (`node_modules/@earendil-works/pi-coding-agent`: README, `docs/` (above all
  extensions, session-format, sdk, compaction), `examples/`), pi packages and extensions for memory, forums and
  discussions. How can an extension keep an agent durable but rotate its session (new session, `appendEntry`,
  `setSessionName`, compaction hooks)?
- How other agents keep long-term memory and stay lightweight: Letta/MemGPT (sleep-time agents, memory blocks), Nous
  Hermes Agent (memory and skills that improve themselves), "prime"-style context priming, Claude Code
  (CLAUDE.md, memory, auto-compact), Codex, opencode, mem0, and others found on the way. How each one purges or
  consolidates, how it decides what to forget, and what it costs in tokens.
- Tools that transcribe a YouTube link or video without a model reading it (subtitle extraction, transcript APIs,
  local speech to text), what each needs installed, and which fits a Node project with no new dependencies.
Try: build the cheapest prototype of the 2-3 strongest options for the keeper's purge and for transcription, and
measure them (tokens or chars per turn after 1, 5 and 20 runs; transcription of one real public YouTube link).
Acceptance:
- [ ] The report has, for proposals 8, 10 and 13: what exists, alternatives, a verdict (keep / improve / replace) with links and the trial results
- [ ] A recommended memory layout and file format, a keeper lifecycle (start, digest, purge, rotate), and a transcription tool with a fallback
- [ ] Every claim cites a source (URL or file path); anything the researcher could not verify is marked as unverified
Validation: `test -s docs/research/workflow-memory.md && grep -c "http" docs/research/workflow-memory.md` (at least 10 sources)
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T2: Spec and ADR
**Agent:** executor · **Harness:** pihouse · **Model:** claude-bridge/claude-opus-5-5 · **Blocked by:** T1 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `docs/specs/workflow-memory.md`, `docs/decisions/ADR-001-workflow-memory.md`
Objective: one spec that the build tasks implement, with this plan's Decisions as the fixed frame and the research
choosing among the proposals.
Acceptance:
- [ ] The spec covers objective, commands (`/workflow save`, `review`, `review --last`, `ask`, the keeper's commands and how it is started), the memory layout and formats, the capture package, the keeper lifecycle, proposals and pruning, the token limits, the testing strategy (fakes only, no real APIs) and boundaries
- [ ] Each section names the task that builds it (T3-T7) and lists its acceptance criteria as tests
- [ ] ADR-001 records each decision that replaced or refined a user proposal, with the alternatives and the evidence from the research
- [ ] Committed as `docs: spec and ADR for workflow memory`
Validation: `test -s docs/specs/workflow-memory.md && test -s docs/decisions/ADR-001-workflow-memory.md && git log -1 --oneline`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T3: Memory store
**Agent:** store · **Harness:** pihouse · **Model:** claude-bridge/claude-sonnet-5-5 · **Blocked by:** T2 · **Parallel with:** T5
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/pihouse/src/paths.ts` (memory path), `packages/pihouse/src/workflow/memory.ts` (new), `packages/pihouse/test/memory.test.ts` (new)
Objective: one module through which everything reads and writes the memory, as the spec's layout section describes:
write a captured run package, list pending runs and count them, mark runs processed, write digests, consulted
entries, ideas and proposals, record approve or reject (rejected ones are remembered), update the workflow memory
file, keep the index, and archive (never delete) what is older than 90 days without use or superseded.
Acceptance:
- [ ] The tests (temp dirs, no real home) cover every operation above, including that a processed run is never listed as pending again and that a rejected proposal cannot be proposed again
- [ ] Reading the index for `ask` never loads full transcripts
- [ ] `npm run check` and `npm test` pass with no warnings; committed as `feat: memory store`
Validation: `npm run check && npm test`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T4: Flags, capture, /workflow save and review
**Agent:** capture · **Harness:** pihouse · **Model:** claude-bridge/claude-sonnet-5-5 · **Blocked by:** T3 · **Parallel with:** T5
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/pihouse/src/extensions/workflow.ts`, `packages/pihouse/src/workflow/run.ts`, `packages/pihouse/src/workflow/capture.ts` (new), `packages/pihouse/test/capture.test.ts` (new), `packages/pihouse/test/pihouse.test.ts`, `skills/build/executor/SKILL.md` (offer a review at the end), `skills/pre-build/planner/SKILL.md` only if the spec needs the planner to flag itself
Objective: planner and executor sessions are flagged with the `workflow-` prefix and captured by default. `/workflow save
[reason]` flags and captures any session. A capture is the whole agent tree (from the agent-link journal) as one
package with metrics, the reason and a copy of every transcript, written through the T3 store. The mechanical part is
code; a model is used only where the spec says it is worth it (for example a short summary), and never reads the full
transcripts here.
`/workflow review` keeps reviewing the current session. `--last` picks the newest flagged run. When the executor
finishes, it offers `/workflow review` and never runs it.
Acceptance:
- [ ] Tests with a fake journal and fake transcripts: a three-level tree is captured as one package with every transcript copied; an unflagged run is ignored by `--last` and by the pending list; save on a plain chat with no workers works
- [ ] The mechanical capture (tree, metrics, copies) works with no model; any model step the spec adds receives only a short input, never the full transcripts (a test checks its size)
- [ ] `npm run check` and `npm test` pass; committed as `feat: flag and capture workflow runs`
Validation: `npm run check && npm test`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T5: Source transcription (YouTube, video, links)
**Agent:** sources · **Harness:** pihouse · **Model:** claude-bridge/claude-sonnet-5-5 · **Blocked by:** T2 · **Parallel with:** T3, T4
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/pihouse/src/workflow/sources.ts` (new), `packages/pihouse/test/sources.test.ts` (new), a fake CLI under `packages/pihouse/test/` if needed. Work in its own worktree `../pi-house-wm-sources` (branch `pihouse/wm-sources`, from `feat/workflow-memory` after T2).
Objective: given a YouTube link, a video file or a web link, produce a text transcript with the tool the spec picked.
If the tool is missing, say so and name the fallback (a cheap agent). Return the source metadata (title, URL,
duration, when it was fetched). No model reads the source in this module.
Acceptance:
- [ ] Tests with a fake CLI or fake HTTP server: a YouTube link with subtitles, one without (fallback path), a missing tool (clear message), a plain web link
- [ ] No real network and no real API in tests
- [ ] `npm run check` and `npm test` pass; committed as `feat: transcribe sources for workflow ask`
Validation: `npm run check && npm test`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T6: The keeper
**Agent:** keeper · **Harness:** pihouse · **Model:** claude-bridge/claude-sonnet-5-5 · **Blocked by:** T3, T4 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/pihouse/src/extensions/keeper.ts` (new), `packages/pihouse/src/paths.ts` (EXTENSIONS), `packages/pihouse/src/workflow/digest.ts` (new), `skills/<group>/keeper/SKILL.md` (new), `skills/catalog.json`, `packages/pihouse/test/keeper.test.ts` (new)
Objective: the durable keeper the spec describes. It is started under a fixed agent-link name and always says how many
runs are pending. On "summarize", it digests the pending batch in a fresh session: it reads each run in full exactly
once, writes a digest per run, updates the workflow memory, and writes proposals (with removal proposals for skills,
rules and ideas unused in the last N runs, and the 90-day raw-copy deletions). It marks the batch as processed,
archives the raw copies, hands the summary back to the user, and purges or rotates its context the way the spec says.
Proposals are listed and approved or rejected by the user, and only approved ones are applied. A test checks that the
digest prompt for a batch and the steady context of the keeper stay under the spec's token limit.
Acceptance:
- [ ] Tests with fake runs: pending count; a batch of 3 is digested once and then counted as 0 pending; a second batch reads only digests of the first, never its transcripts; approve applies, reject is remembered; pruning archives an entry unused for 90 days and never deletes
- [ ] Size test: the digest context and the keeper's starting context stay under the limit with 1, 5 and 20 runs in memory
- [ ] `npm run skills` run after adding the skill; `npm run check` and `npm test` pass; committed as `feat: keeper agent for workflow memory`
Validation: `npm run skills && npm run check && npm test`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T7: /workflow ask on the memory, with sources and ideas
**Agent:** ask · **Harness:** pihouse · **Model:** claude-bridge/claude-sonnet-5-5 · **Blocked by:** T5, T6 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/pihouse/src/extensions/workflow.ts` (`askContext`), `packages/pihouse/src/extensions/keeper.ts` if ask is routed there, `packages/pihouse/test/pihouse.test.ts`, `packages/pihouse/test/keeper.test.ts`
Objective: `/workflow ask` answers from the workflow memory, the index and the relevant digests instead of only the
last report. When the question has a link or a video, it transcribes it with T5, saves the source and a summary to
`consulted/`, relates it to past runs, asks the user what it needs, and saves ideas to `ideas/`, all automatically.
Acceptance:
- [ ] Tests: the ask context includes the workflow memory and the index but no transcript; a YouTube link in the question goes through the fake transcription and produces a `consulted/` entry; the context stays under the spec's limit with 20 runs in memory
- [ ] `npm run check` and `npm test` pass; committed as `feat: workflow ask reads the memory and sources`
Validation: `npm run check && npm test`
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T8: Docs, final validation and report
**Agent:** executor · **Harness:** pihouse · **Model:** claude-bridge/claude-opus-5-5 · **Blocked by:** T7 · **Parallel with:** none
**Skills:** documentation-and-adrs, git-workflow-and-versioning
**Files:** `docs/architecture.md` (the `/workflow` section and a memory section), `README.md`, `CHANGELOG.md`, `docs/decisions/ADR-001-workflow-memory.md` (status Accepted)
Objective: the docs describe the memory, the keeper and the commands as built, and the whole branch passes.
Acceptance:
- [ ] The docs name every new command and where the memory lives
- [ ] `npm run check` and `npm test` pass with no warnings on `feat/workflow-memory`
- [ ] The main checkout's `git status` is unchanged since T0; nothing pushed
- [ ] The final report lists what was built, which proposals the research kept or replaced (and why), every ASSUMED, and how the user tries it (start the keeper, `/workflow save`, ask it to summarize)
Validation: `npm run check && npm test && git log --oneline main..feat/workflow-memory`
Stop when: validation passes, or report BLOCKED after two failed attempts.

## Validation

In `/Users/jeronimo.deli/Desktop/other/Vs/pi-house-workflow-memory`:

- `npm run skills && npm run check && npm test` with no warnings.
- The size tests from T6 and T7 pass (review and ask stay under the limit with 20 runs).
- The flow from the Goal's example, run against fakes in the tests: capture by default and by save, pending count,
  batch digest, processed runs never read again, approve and reject, pruning to archive.

## Out of scope

- Automatic or scheduled reviews and digests (decision 7).
- A separate code-review step after the executor (the user mentioned it as future work).
- Pushing, opening a PR, or merging into `main`.
- Touching the user's uncommitted changes in the main checkout.
- Deleting anything without the user's approval.
