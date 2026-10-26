# ADR-001: Workflow memory and the keeper

## Status

Proposed

## Date

2026-10-26

## Context

The plan `docs/plans/workflow-memory.md` gives pihouse a persistent memory of how the user works, kept by one durable
agent. Most of its design is binding (decisions 1-7, 9, 11, 12, 14-17). Three items were the user's proposals, to be
checked by research: how the keeper stays durable and purges (8), where and in which format the memory lives (10), and
which tool transcribes videos and links (13). The research is `docs/research/workflow-memory.md`, with runnable trials
in `docs/research/workflow-memory-trials/`. This ADR records what replaced or refined each proposal, and the
mechanical choices the spec (`docs/specs/workflow-memory.md`) builds on.

## Decisions

### D1 (proposal 8, refined): the keeper purges with a context boundary, rotates with `newSession`, digests with nested calls

The user proposed a durable keeper that saves to disk after each task and starts again with a clean context, and asked
whether rotation, compaction or a sleep-time pass is best.

Decision:

- Durable = one long-lived pihouse process under the fixed agent-link name `keeper`. The agent-link name comes from the
  process environment (`AGENT_LINK_AGENT`), not from the pi session, so the session can change under it
  (`agent-link-core/src/types.ts:221`, `src/pi-extension/index.ts:119-120,170-174`; research, "Verified pi rotation
  capability").
- Purge after each job: the keeper extension writes a boundary entry and its `context` handler sends the model only
  the messages after it, plus a bounded bootstrap from files (`before_agent_start`). pi documents `context` as the
  event that transforms conversation messages per request (`docs/extensions.md:116`).
- Rotation: `/keeper new`, and the start of every digest, call `ctx.newSession`. pi allows session replacement only
  from command handlers, since lifecycle handlers can deadlock (`docs/extensions.md:214-220`), so rotation cannot be
  the automatic purge after every answer; the boundary is.
- The digest is not a long conversation: code runs one nested model call per run (`ctx.modelRegistry.complete`,
  `docs/extensions.md:215`) and one consolidation call over the digests. The keeper's own session only receives the
  short batch summary.

Alternatives:

- Keep one session and rely on auto-compaction (Claude Code, Codex and opencode do this:
  https://docs.anthropic.com/en/docs/claude-code/costs, https://opencode.ai/docs/config/#compaction). Rejected as the
  purge: every compaction leaves a summary in the context and costs a model call; kept as a safety net.
- Rotate after every answer. Rejected: not possible from an event in pi (above).
- A sleep-time agent that consolidates in the background (Letta, https://www.letta.com/blog/sleep-time-compute).
  Adopted as the idea behind the consolidation step (digests first, then one pass over them), but run only when the
  user asks, because decision 7 forbids automatic jobs.
- The digest as one agent conversation that reads every transcript with tools. Rejected: the context would grow with
  the batch; nested calls keep each input bounded (trial: bootstrap 336 / 460 / 937 chars and digest prompt 392 /
  1,264 / 4,557 chars with 1 / 5 / 20 fake runs, `keeper-context.ts`), which the spec caps with `LIMITS`.

### D2 (proposal 8): the fixed name needs a small agent-link change

agent-link names a root after its harness (`uniqueName(req.harness)` in `agent-link-core/src/hub/hub.ts`), so a
pihouse root is `pihouse-6`, not `keeper`. Decision: an optional `name` on the register request, passed by
`agent-link open` and used by `pih keeper`. agent-link is this repository's code, not pi's, so this does not patch pi.
Alternative: spawn the keeper as a worker named `keeper` from the user's session. Rejected: a worker closes when the
session that launched it exits, so the keeper would not be durable.

### D3 (proposal 10, kept with changes): global `~/.pihouse/memory/`, flat, entries tagged with their project

The user proposed a global memory with each entry tagged by project, Markdown with frontmatter, and a small index the
model reads first. The research suggested per-project subfolders (`projects/<id>/…`).

Decision: keep the user's flat global layout (spec, "Memory location and layout"). The keeper digests batches across
projects and the workflow memory is about the user, not a repository; one `index.json` filtered by project gives the
same separation without a folder per project. Machine records are JSON (atomic, typed); what a person or a model reads
is Markdown with frontmatter. This follows the file-first memories of Claude Code (`CLAUDE.md`, memory files:
https://docs.anthropic.com/en/docs/claude-code/memory), Codex (`AGENTS.md`:
https://developers.openai.com/codex/guides/agents-md/) and Hermes Agent (https://github.com/NousResearch/hermes-agent),
and Letta's split between a small always-loaded block and an archive (https://docs.letta.com/guides/agents/memory/).

Refinement from the research's trial: the index is not constant in size (it grows with entries), so the model only
ever sees `indexSlice` with a char cap, never the whole file.

Alternatives: a vector or database store, or mem0 (https://docs.mem0.ai/overview). Rejected: a dependency or a service
for a memory of hundreds of entries, with no evidence that keyword overlap on the index is not enough.

### D4 (proposal 10): run status lives in the index, not in folder moves

`runs/<id>/` stays in place and `index.json` says `pending` or `processed`; only archiving moves files. Moving folders
between `pending/` and `processed/` would make the move and the index update two writes that can disagree after a
crash.

### D5 (decision 1): no model at capture

Decision 1 allows a small model summary at capture. Decision: capture is code only; the title comes from the plan
slug, the reason or the first request, and the digest writes the summary once. A summary at capture would be a second
reading of the same run (decision 14 says each run is read in full exactly once) and would need a model in sessions
that are ending.

### D6 (decision 2): flags by name prefix plus `flags.json`, and a sweep

The executor is spawned as `workflow-executor`; the planner's session is named `workflow-planner · …` when it starts the
planner; `/workflow save` writes `flags.json` and prefixes `workflow-saved · `. Capture happens on save, on `agent_end`
of a flagged session, and in a sweep of the journal that the keeper and `review --last` run first, so a run whose
session died without an `agent_end` is still captured.

### D7 (proposal 13, improved): captions first, then yt-dlp, then whisper, then a cheap agent

The user proposed transcribing with an existing tool or API and falling back to a cheap agent only when no tool can.

Evidence: on this machine `yt-dlp`, `whisper` and `ffmpeg` are not installed; a dependency-free Node `fetch` of the
watch page of a public video (`youtube-captions.ts`) got Google's CAPTCHA page instead of `ytInitialPlayerResponse`
(3,235 chars, `captcha-form`). The same caption-track method is what `youtube-transcript`
(https://github.com/Kakulukian/youtube-transcript) and `youtube-transcript-api`
(https://github.com/jdepoix/youtube-transcript-api) use, and it works where YouTube serves the page.

Decision: try captions with `fetch` (free, no install), then `yt-dlp` subtitles when on PATH
(https://github.com/yt-dlp/yt-dlp#subtitle-options), then local `whisper` with `ffmpeg` when on PATH
(https://github.com/openai/whisper), then a clear message that names what to install and offers a cheap agent. Nothing
is installed by pihouse. Hosted transcript or speech APIs (https://platform.openai.com/docs/guides/speech-to-text) are
not used: a key, a cost and the user's data sent out, for what the free routes cover.

Unverified: a successful caption fetch from this network; YouTube's terms for the caption endpoint.

### D8 (assumptions confirmed)

- `review` and the digest share the computed report (`renderReport`); a run is read in full once, in the digest.
- The keeper is a pihouse agent with its own skill (`skills/extras/keeper`) and an extension that is inert unless
  `PIHOUSE_KEEPER=1`.
- Size limits are tests (`LIMITS`, chars/4 as the token estimate): `ask` 80,000 chars (about 20k tokens), the keeper's
  bootstrap 24,000, each digest input 60,000.
- "Not used" = not loaded or named in the last 10 processed runs. A batch holds at most 10 runs.
- No new dependency.

## Consequences

- The cost of a keeper turn depends on the bootstrap cap, not on how many runs it has seen; the cost of a digest is
  linear in the batch, once per run.
- `ask` and the keeper never see a transcript outside the digest.
- `agent-link-core` gains an optional root name; nothing else in agent-link changes.
- Videos can be transcribed only where YouTube serves the page or the user has `yt-dlp` or `whisper`; otherwise the user
  gets a clear message and the agent fallback.
- Raw transcript copies take disk space until the user approves deleting them (proposed 90 days after archiving).
