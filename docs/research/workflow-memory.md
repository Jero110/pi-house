# Workflow memory research (T1)

Research date: 2026-10-26. Scope: proposals 8 (durable/purging keeper), 10 (storage layout), 13 (transcription), plus the Goal's workflow. Local pi references are from the installed `@earendil-works/pi-coding-agent` package. Node v26.11.1 (Node 22+ fetch API) was used. Dependency-free trials are committed under `docs/research/workflow-memory-trials/`.

## Findings and verdicts

### Proposal 8 — durable keeper and purge: IMPROVE

**Existing ideas.** Pi supports session lifecycle events, extension persistence via `pi.appendEntry()`, session naming via `pi.setSessionName()`, and compaction hooks. Compaction is lossy for active context but does not erase append-only session entries. Pi's extension `handoff.ts` example extracts context and starts another session, directly demonstrating a handoff/rotation pattern. References: local `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (session events, appendEntry), `docs/session-format.md` (append-only entry tree), `docs/compaction.md` (hooks and persisted summaries), `examples/extensions/handoff.ts`, `examples/extensions/session-name.ts`; https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md.

Letta/MemGPT separates bounded working memory from archival memory and uses explicit memory operations; sleep-time agents process experience asynchronously rather than inflating each foreground turn. Sources: https://docs.letta.com/guides/agents/memory/ and https://www.letta.com/blog/sleep-time-compute. Hermes Agent documents persistent MEMORY.md plus topic files and skills, with memory/skill maintenance tools; this is a file-first precedent, though exact token cost varies by loaded file and prompt. Source: https://github.com/NousResearch/hermes-agent. Claude Code uses project/user instruction files and auto-compaction; Codex uses AGENTS.md-style instructions and compacting context; OpenCode supports agents and compaction. Sources: https://docs.anthropic.com/en/docs/claude-code/memory, https://docs.anthropic.com/en/docs/claude-code/costs, https://developers.openai.com/codex/guides/agents-md/, https://opencode.ai/docs/agents/ and https://opencode.ai/docs/config/#compaction. Mem0 describes extracting/updating relevant facts rather than replaying the entire conversation: https://docs.mem0.ai/overview.

**Alternatives and trial.** (1) Keep the session forever and rely on auto-compaction: low engineering effort, but compacted summaries remain in active history and each next turn can still carry a growing summary. (2) rotate at each completed request, hand off only the short workflow-memory/index and pending batch count: fixed starter context, no need to alter pi internals. (3) sleep-time digest: useful as a conceptual consolidation stage, but conflicts with the plan's manual-only processing unless explicitly user-triggered. Pi's native handoff plus external memory is the closest, simplest composition.

**Runnable context-size trial.** `node --experimental-strip-types docs/research/workflow-memory-trials/keeper-context.ts` constructs the bootstrap (instructions + workflow-memory + index slice + pending count) and digest prompt for deterministic fake stores, without model/API calls. Exact output:

| Fake runs | Bootstrap chars | chars/4 | Digest chars | chars/4 |
|---:|---:|---:|---:|---:|
| 1 | 336 | 84.00 | 392 | 98.00 |
| 5 | 460 | 115.00 | 1,264 | 316.00 |
| 20 | 937 | 234.25 | 4,557 | 1,139.25 |

Bootstrap growth comes from index entries and pending count, so it is not constant; use a bounded/project-filtered index slice to enforce the context budget. Digest prompt intentionally scales with batch transcript size and only occurs on explicit summarize. chars/4 is a rough token estimate, not provider tokenization. The trial verifies composition/sizing only; session rotation API evidence follows below.

**Verified pi rotation capability.** The checked API declarations and docs confirm `ctx.newSession()` belongs to `ExtensionCommandContext` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:283-302`); `docs/extensions.md:217-220` says command handlers add session replacement and old context is invalidated. The runnable handoff example calls it from a registered command handler (`examples/extensions/handoff.ts:177-183`). Thus (a) yes from a command handler; no directly from a lifecycle event: extension docs say lifecycle session-control methods are command-only to avoid deadlocks (`docs/extensions.md:214-220`). Events may set a flag/queue work, but rotation should occur through a subsequent command, not from `agent_end`.

(b) `newSession` accepts setup and `withSession`, not prompt text (`dist/core/extensions/types.d.ts:292-302`). `withSession` receives fresh command context and supports `sendUserMessage`/`sendMessage` (`:327-340`); `sendUserMessage` becomes a user prompt, not hidden. For hidden bootstrap, load compact files into an extension-owned cache and inject through `before_agent_start` (documented at `docs/extensions.md:104`) or use a hidden custom message; do not mistake setup/appendEntry for model context. (c) yes, call `pi.setSessionName()` from the replacement context; API declaration `dist/core/extensions/types.d.ts:1274` and example `examples/extensions/session-name.ts` demonstrate naming. Rebind/use the replacement context after newSession; old context is stale (`docs/extensions.md:220`, example lines 174-181).

Agent-link identity is separate from Pi session id: its journal lookup accepts journal id/sessionId first and falls back to name/pane; names can be reused and newest record is returned (`node_modules/agent-link-core/src/journal.ts:102-110`). The process gets `AGENT_LINK_AGENT` from environment (`src/types.ts:221`); pi adapter connection records native session id/transcript separately (`node_modules/agent-link-core/src/pi-extension/index.ts:119-120,170-174` records/rebinds the native session on `session_start`). Therefore switching a Pi session within the same live process does not change its environment identity/name. A hub journal may receive a new native session id while retaining the process agent name. This source-level finding supports stable addressing by name, though address resolution is newest-record semantics, not a guarantee that old session id links remain valid.

**Verdict / build.** Improve proposal 8: one long-lived agent-link process under fixed name; rotate Pi session only via keeper `/reset`/rotate command using `ctx.newSession()`. On each fresh session set a descriptive name and inject a bounded file bootstrap with `before_agent_start`; use `sendUserMessage` only when a visible/user-turn handoff is desired. `agent_end` may record readiness but must not call newSession. Digest manually, persist batch outputs before processed markers, and rely on fresh context for purge; compaction remains a safety net, not the purge mechanism.

### Proposal 10 — layout and format: IMPROVE

**Existing ideas.** File-first memory is common: Hermes topic files, Claude Code `MEMORY.md` and project instructions, Codex `AGENTS.md`, Letta memory blocks/archival store. These distinguish short always-loaded material from retrievable detail. Sources: https://github.com/NousResearch/hermes-agent, https://docs.anthropic.com/en/docs/claude-code/memory, https://developers.openai.com/codex/guides/agents-md/, https://docs.letta.com/guides/agents/memory/.

**Alternatives.** (A) global single Markdown file is simple but mixes projects and grows without bound; (B) global store partitioned by project, Markdown records plus a small machine-maintained JSON index and compact Markdown workflow memory; (C) database/vector store adds dependencies and query complexity without demonstrated need at this scale. mem0's extraction approach is an alternative if semantic retrieval becomes necessary, but external service/dependency tradeoffs are not warranted yet: https://docs.mem0.ai/overview.

**Trial.** Size model for fixed bootstrap/index: 486 chars whether archive contains 1, 5, or 20 runs; 20-run index growth is not actually flat if every title/digest is included, so an index must be paginated/project-filtered and capped. In the proposed prototype, keep the model-facing index to the newest/relevant 20 compact digest summaries (bounded at 4,000 chars); archive metadata and full transcripts remain disk-only. No actual tokenizer was run. Source text and digest content sizes depend on inputs; context is bounded by selection, not magical constant-size storage.

**Verdict / build.** Improve proposal 10: use `~/.pihouse/memory/projects/<project-id>/` with `runs/pending/`, `runs/processed/`, `digests/`, `consulted/`, `ideas/`, `proposals/`, `archive/`; global `workflow-memory.md` for cross-project preferences and `index.json` for ids/status/timestamps/paths/tags. Captured records and index are JSON (stable fields, easy atomic updates); human-authored living memory, digests, consulted summaries, ideas/proposals are Markdown with YAML frontmatter. Keep transcripts copied as immutable files; never place them in the prompt by default. Project id should be normalized repo root identity, not a free-form model-generated label. Atomic writes/claim markers and schema versioning are required. Archive stale/superseded items as plan specifies; preserve rejected proposal fingerprints so they are not repeated.

### Proposal 13 — transcription: IMPROVE

**Existing tools.** `yt-dlp` can fetch subtitles/auto-captions without downloading video when available; it is a separate external Python executable, not an npm dependency. https://github.com/yt-dlp/yt-dlp#subtitle-options. YouTube's captions can also be accessed via third-party transcript APIs (usually hosted API, often key/rate/terms constraints), e.g. https://github.com/jdepoix/youtube-transcript-api. Local Whisper requires model weights and compute plus ffmpeg/audio extraction; https://github.com/openai/whisper. Hosted speech APIs require upload/network/key and incur per-audio cost; https://platform.openai.com/docs/guides/speech-to-text. For videos with no captions, these are the main fallback categories.

**Dependency-free real-link trial.** `node --experimental-strip-types docs/research/workflow-memory-trials/youtube-captions.ts` uses Node fetch to request `https://www.youtube.com/watch?v=jfKfPfyJRdk`, parse `ytInitialPlayerResponse`, select a caption track, then request `baseUrl` as `fmt=json3` and flatten timed segments. Result: failed before player response extraction. The returned 3,235-character HTML is Google's challenge page: `<form id="captcha-form" action="index" method="post">` and `<div id="recaptcha" class="g-recaptcha">`; exact thrown error: `No ytInitialPlayerResponse found; watch response length=3235`. So no title, duration, transcript length or first 200 transcript characters could be obtained. This records a concrete bot/CAPTCHA failure, not a successful transcript. `command -v yt-dlp`, `whisper`, and `ffmpeg` each returned no path. `curl -IL` had returned HTTP/2 200 earlier, demonstrating why HEAD success does not imply a fetchable watch page.

The approach follows the publicly documented page-caption track shape used by `youtube-transcript` (`https://github.com/Kakulukian/youtube-transcript`) and the caption API/library approach in `youtube-transcript-api` (`https://github.com/jdepoix/youtube-transcript-api`); watch-page access is not guaranteed and YouTube may serve CAPTCHA/consent challenges.

**Alternatives.** (A) external `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs ...` when installed: zero model/audio processing cost, subtitle quality/availability variable. (B) an opt-in hosted transcript API: simplest operational UX but API key, privacy, cost and terms dependency. (C) local Whisper: works without captions, no per-minute API charge after setup, but model download, CPU/GPU time, storage and ffmpeg requirements. (D) cheap agent reading video: last resort only, inconsistent and costly. Estimated token cost for subtitle route is zero for transcript acquisition; summarizing the fetched transcript still uses model tokens proportional to selected transcript. Whisper cost is compute, not context tokens. No numeric runtime/token cost is claimed without measurement.

**Verdict / build and ordered choice.** Improve proposal 13. First, try dependency-free Node fetch of YouTube caption tracks and timedtext; it costs no install/API fee, but report/continue on consent, CAPTCHA, missing captions, or network failure. Second, use `yt-dlp` subtitle extraction (`--skip-download --write-subs --write-auto-subs`) when present; it is generally more resilient to page changes but is an optional external executable. Last, use explicitly configured local Whisper + ffmpeg for audio transcription when captions are unavailable; it costs local compute/storage and model setup. For external video that cannot be fetched by those tools, optional configured transcript API or cheap agent is a user-visible fallback, not a silent default. Local video can use Whisper as the practical second path. If nothing works, say: `Could not obtain a transcript: YouTube captions were blocked or unavailable, and yt-dlp/Whisper are not installed. Install yt-dlp or configure local Whisper, or ask me to try an accessible transcript source.` Save URL, title/duration if obtained, timestamp, language, method and transcript. Verify YouTube terms/privacy before production; not assessed here.

## Recommended keeper lifecycle

1. **Start:** resolve fixed agent-link keeper name; report pending count from index. Load only global compact workflow memory, selected project index slice and command rules.
2. **Digest:** only on user request. Claim the batch; read each full package/transcript once; compute metrics mechanically; model sees the batch once; write one digest per package plus proposed memory edits.
3. **Commit:** atomically persist digest/memory/proposals, then mark package processed. On crash, idempotency keys prevent duplicates; never mark done before durable outputs.
4. **Purge/rotate:** return result and terminate job session; next message uses fresh session and compact bootstrap. Never delete canonical session archive merely to purge model context. Pi auto-compaction is fallback only.
5. **Prune:** archive unused/superseded memory per the plan; raw copies archived after digest and deletion only after user approval. Selection/purge decisions are deterministic age/status rules; semantic removal of skills/rules remains a proposal requiring approval.

This borrows bounded working memory + archival retrieval (Letta), explicit file memory (Hermes/Claude), and handoff/append-only session capabilities from pi, rather than inventing an always-growing keeper transcript.

## Claims not verified

- Actual provider token counts: no tokenizer/model call was run; chars/4 is an estimate only.
- Successful YouTube transcript extraction is unverified because this environment receives Google's CAPTCHA page. Trial script records the exact failure; captions may be available from another network/tool.
- Third-party transcript API current availability, pricing, quotas, and terms were not probed.

## Sources

- Local pi docs/examples with line references: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:59,80,104,214-220`; `docs/sdk.md:58-60`; `dist/core/extensions/types.d.ts:283-302,327-340,1274`; `examples/extensions/handoff.ts:177-183`; `examples/extensions/session-name.ts`; `node_modules/agent-link-core/src/journal.ts:102-110`; `src/types.ts:221`; `node_modules/agent-link-core/src/pi-extension/index.ts:119-120,170-174`.
- Reproducible trials: `docs/research/workflow-memory-trials/keeper-context.ts` and `youtube-captions.ts`.
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
- https://docs.letta.com/guides/agents/memory/
- https://www.letta.com/blog/sleep-time-compute
- https://github.com/NousResearch/hermes-agent
- https://docs.anthropic.com/en/docs/claude-code/memory
- https://docs.anthropic.com/en/docs/claude-code/costs
- https://developers.openai.com/codex/guides/agents-md/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/config/#compaction
- https://docs.mem0.ai/overview
- https://github.com/yt-dlp/yt-dlp#subtitle-options
- https://github.com/jdepoix/youtube-transcript-api
- https://github.com/openai/whisper
- https://platform.openai.com/docs/guides/speech-to-text
