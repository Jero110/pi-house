# Workflow memory research (T1)

Research date: 2026-10-26. Scope: proposals 8 (durable/purging keeper), 10 (storage layout), 13 (transcription), plus the Goal's workflow. Local pi references are from the installed `@earendil-works/pi-coding-agent` package; paths below are relative to that package. Network was available for YouTube HTTP metadata, but no subtitle/downloader or speech-to-text CLI was installed, so a real transcript extraction could not be completed. This limitation is explicit rather than presenting an unrun trial as evidence.

## Findings and verdicts

### Proposal 8 — durable keeper and purge: IMPROVE

**Existing ideas.** Pi supports session lifecycle events, extension persistence via `pi.appendEntry()`, session naming via `pi.setSessionName()`, and compaction hooks. Compaction is lossy for active context but does not erase append-only session entries. Pi's extension `handoff.ts` example extracts context and starts another session, directly demonstrating a handoff/rotation pattern. References: local `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (session events, appendEntry), `docs/session-format.md` (append-only entry tree), `docs/compaction.md` (hooks and persisted summaries), `examples/extensions/handoff.ts`, `examples/extensions/session-name.ts`; https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md.

Letta/MemGPT separates bounded working memory from archival memory and uses explicit memory operations; sleep-time agents process experience asynchronously rather than inflating each foreground turn. Sources: https://docs.letta.com/guides/agents/memory/ and https://www.letta.com/blog/sleep-time-compute. Hermes Agent documents persistent MEMORY.md plus topic files and skills, with memory/skill maintenance tools; this is a file-first precedent, though exact token cost varies by loaded file and prompt. Source: https://github.com/NousResearch/hermes-agent. Claude Code uses project/user instruction files and auto-compaction; Codex uses AGENTS.md-style instructions and compacting context; OpenCode supports agents and compaction. Sources: https://docs.anthropic.com/en/docs/claude-code/memory, https://docs.anthropic.com/en/docs/claude-code/costs, https://developers.openai.com/codex/guides/agents-md/, https://opencode.ai/docs/agents/ and https://opencode.ai/docs/config/#compaction. Mem0 describes extracting/updating relevant facts rather than replaying the entire conversation: https://docs.mem0.ai/overview.

**Alternatives and trial.** (1) Keep the session forever and rely on auto-compaction: low engineering effort, but compacted summaries remain in active history and each next turn can still carry a growing summary. (2) rotate at each completed request, hand off only the short workflow-memory/index and pending batch count: fixed starter context, no need to alter pi internals. (3) sleep-time digest: useful as a conceptual consolidation stage, but conflicts with the plan's manual-only processing unless explicitly user-triggered. Pi's native handoff plus external memory is the closest, simplest composition.

Cheap measurement (deterministic, no model/API): estimated context chars for a constant keeper bootstrap containing instructions + index + pending count are independent of run count. Across simulated 1, 5, 20 archived runs, the keeper reads only the fixed bootstrap (same characters each: 486 in the prototype calculation); pending package transcript characters are 0 until an explicit digest. Digest context is deliberately variable and reads raw text exactly once per pending run. This is a sizing model, not measured provider tokens; chars/4 is only a rough estimate. No scratch file was retained because no executable prototype could validate actual Pi session rotation in this research-only environment.

**Verdict / build.** Improve proposal 8: retain a stable agent-link identity, but implement each keeper job as a fresh Pi session, passing a fixed compact bootstrap and durable task state via files. Use `setSessionName` for discoverability and `appendEntry` only for session-local metadata, not canonical memory. On explicit summarize: claim batch atomically; read each raw package once; write per-run digest and updated memory/index; mark processed only after writes succeed; hand summary back; end session. Resume/retry from idempotent batch state on failure. Do not use compaction as the purge mechanism: it only shrinks model context, not disk history. Keep compaction as safety net. A truly always-live agent-link process/session rotation behavior was not verified from this repository's journal alone; the extension can persist data, but spawning a fresh session under same fixed name requires agent-link/harness support and must be confirmed in T2 implementation research.

### Proposal 10 — layout and format: IMPROVE

**Existing ideas.** File-first memory is common: Hermes topic files, Claude Code `MEMORY.md` and project instructions, Codex `AGENTS.md`, Letta memory blocks/archival store. These distinguish short always-loaded material from retrievable detail. Sources: https://github.com/NousResearch/hermes-agent, https://docs.anthropic.com/en/docs/claude-code/memory, https://developers.openai.com/codex/guides/agents-md/, https://docs.letta.com/guides/agents/memory/.

**Alternatives.** (A) global single Markdown file is simple but mixes projects and grows without bound; (B) global store partitioned by project, Markdown records plus a small machine-maintained JSON index and compact Markdown workflow memory; (C) database/vector store adds dependencies and query complexity without demonstrated need at this scale. mem0's extraction approach is an alternative if semantic retrieval becomes necessary, but external service/dependency tradeoffs are not warranted yet: https://docs.mem0.ai/overview.

**Trial.** Size model for fixed bootstrap/index: 486 chars whether archive contains 1, 5, or 20 runs; 20-run index growth is not actually flat if every title/digest is included, so an index must be paginated/project-filtered and capped. In the proposed prototype, keep the model-facing index to the newest/relevant 20 compact digest summaries (bounded at 4,000 chars); archive metadata and full transcripts remain disk-only. No actual tokenizer was run. Source text and digest content sizes depend on inputs; context is bounded by selection, not magical constant-size storage.

**Verdict / build.** Improve proposal 10: use `~/.pihouse/memory/projects/<project-id>/` with `runs/pending/`, `runs/processed/`, `digests/`, `consulted/`, `ideas/`, `proposals/`, `archive/`; global `workflow-memory.md` for cross-project preferences and `index.json` for ids/status/timestamps/paths/tags. Captured records and index are JSON (stable fields, easy atomic updates); human-authored living memory, digests, consulted summaries, ideas/proposals are Markdown with YAML frontmatter. Keep transcripts copied as immutable files; never place them in the prompt by default. Project id should be normalized repo root identity, not a free-form model-generated label. Atomic writes/claim markers and schema versioning are required. Archive stale/superseded items as plan specifies; preserve rejected proposal fingerprints so they are not repeated.

### Proposal 13 — transcription: IMPROVE

**Existing tools.** `yt-dlp` can fetch subtitles/auto-captions without downloading video when available; it is a separate external Python executable, not an npm dependency. https://github.com/yt-dlp/yt-dlp#subtitle-options. YouTube's captions can also be accessed via third-party transcript APIs (usually hosted API, often key/rate/terms constraints), e.g. https://github.com/jdepoix/youtube-transcript-api. Local Whisper requires model weights and compute plus ffmpeg/audio extraction; https://github.com/openai/whisper. Hosted speech APIs require upload/network/key and incur per-audio cost; https://platform.openai.com/docs/guides/speech-to-text. For videos with no captions, these are the main fallback categories.

**Trial and environment.** `command -v yt-dlp`, `command -v whisper`, and `command -v ffmpeg` returned no paths. `curl -IL` against public YouTube video `https://www.youtube.com/watch?v=jfKfPfyJRdk` returned HTTP/2 200, proving page reachability only, not caption availability. No downloader/transcript API dependency or global install was used; a real transcript trial was therefore blocked by missing tools. Browser/page scraping was not treated as a reliable transcript method. The exact public-link transcript acceptance item remains unverified.

**Alternatives.** (A) external `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs ...` when installed: zero model/audio processing cost, subtitle quality/availability variable. (B) an opt-in hosted transcript API: simplest operational UX but API key, privacy, cost and terms dependency. (C) local Whisper: works without captions, no per-minute API charge after setup, but model download, CPU/GPU time, storage and ffmpeg requirements. (D) cheap agent reading video: last resort only, inconsistent and costly. Estimated token cost for subtitle route is zero for transcript acquisition; summarizing the fetched transcript still uses model tokens proportional to selected transcript. Whisper cost is compute, not context tokens. No numeric runtime/token cost is claimed without measurement.

**Verdict / build.** Improve proposal 13: prefer `yt-dlp` subtitle extraction if executable exists; detect missing tool and clearly report it. Fallback order: optional configured hosted transcript endpoint if user explicitly configures credentials, else cheap agent only where source can be accessed; for local video, configured local Whisper/ffmpeg if installed. Since the plan says no new dependency and no silent install, implement a capability-detected CLI with tests using fake executables; absent tools should produce actionable fallback, not attempt network scraping. Save source URL, title when known, retrieval timestamp, language, method and transcript. Verify YouTube terms and API privacy before production deployment; not assessed here.

## Recommended keeper lifecycle

1. **Start:** resolve fixed agent-link keeper name; report pending count from index. Load only global compact workflow memory, selected project index slice and command rules.
2. **Digest:** only on user request. Claim the batch; read each full package/transcript once; compute metrics mechanically; model sees the batch once; write one digest per package plus proposed memory edits.
3. **Commit:** atomically persist digest/memory/proposals, then mark package processed. On crash, idempotency keys prevent duplicates; never mark done before durable outputs.
4. **Purge/rotate:** return result and terminate job session; next message uses fresh session and compact bootstrap. Never delete canonical session archive merely to purge model context. Pi auto-compaction is fallback only.
5. **Prune:** archive unused/superseded memory per the plan; raw copies archived after digest and deletion only after user approval. Selection/purge decisions are deterministic age/status rules; semantic removal of skills/rules remains a proposal requiring approval.

This borrows bounded working memory + archival retrieval (Letta), explicit file memory (Hermes/Claude), and handoff/append-only session capabilities from pi, rather than inventing an always-growing keeper transcript.

## Claims not verified

- Whether current agent-link can relaunch a stopped worker under the exact same fixed name while preserving user addressability; requires implementation/API confirmation.
- Actual provider token counts: no tokenizer/model call was run; chars/4 is an estimate only.
- Real subtitle extraction of the cited YouTube URL and caption language/availability: unavailable tools prevented it.
- Third-party transcript API current availability, pricing, quotas, and terms were not probed.

## Sources

- Local pi docs/examples: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/session-format.md`, `docs/sdk.md`, `docs/compaction.md`, `examples/extensions/handoff.ts`, `examples/extensions/session-name.ts`.
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
