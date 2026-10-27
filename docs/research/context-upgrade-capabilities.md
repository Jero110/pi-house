# Context-pressure model switching: capability research

This is research, not an implemented or registered extension. Existing and already-running workers do not automatically upgrade. No new provider, account or route is enabled by this document.

## Observed model metadata

With `PIHOUSE_NO_LINK=1 pihouse --list-models luna` and `PIHOUSE_NO_LINK=1 pihouse --list-models terra`, the installed configuration listed `openai-codex/gpt-6-luna` with a 272K context and 128K maximum output and `openai-codex/gpt-6.1-terra` with a 500K context and 128K maximum output. This is local configuration metadata, not a guarantee of remote availability or a general equivalence between model families. Both were listed with thinking and image support. No model requests were made.

## Native operations and constraints

The installed pi extension documentation describes `pi.setModel(model)` and `ctx.getContextUsage()`. The registry exposes model lookup and configured-auth availability; configured auth is not a guarantee that quota or a remote request will succeed. The native model setter records a model change in the session and checks auth. The usage count is an estimate, and is unknown after compaction until a subsequent assistant response. `pi.appendEntry()` stores non-model-context session data, suitable for observations and switch reasons.

A run can still have compaction, retries, or queued work after `agent_end`. The documented `agent_before_settle` boundary is actionable; `agent_settled` is notification-only. A safe integration must establish that a switch does not race active or queued work, including automatic continuations, and must provide a visible pause if this cannot be established. Switching an external busy worker by pasting a command is not a supported substitute. Cross-harness replacement and fencing are out of scope for this slice.

A routing profile must be explicitly selected for the session or approved plan; merely configuring a profile, enabling an extension, or naming a model does not authorize paid fallback. Fixed-model assignments stay fixed without that authority. Candidate validation must use current metadata, history/tool compatibility, exact provider/model and account/billing authorization, availability, and a strictly larger context window. Unknown usage must not be treated as zero. Headroom and thresholds need explicit configuration; failure, cooldown and retry limits must be bounded and observable. Do not conflate context pressure with quota exhaustion.

No automatic switch, route profile interface, monitoring loop, pause mechanism, retry policy, or UI metadata has been implemented or tested here. Executor integration and extension registration remain necessary; registration alone must not authorize a route. Non-pi harnesses need an explicit pause until a supported native boundary exists.

## Codex output limits

The installed `@earendil-works/pi-ai/dist/api/openai-codex-responses.js` passes simple options into the Codex stream, but its `buildRequestBody` does not add `max_output_tokens` or otherwise consume `maxTokens`. Therefore an isolated Codex call's `maxTokens` option is not evidence of a hard provider-enforced output limit in this installed implementation. No hard spending cap should be promised from that option. This is a source inspection, not a live provider test; future versions may differ.

## Implemented conservative subset (same agent, no handoff)

`packages/pihouse/src/workflow/context-upgrade.ts` (pure policy) and `packages/pihouse/src/extensions/context-upgrade.ts` (extension) change the model of the one running pi agent. They never replace a writer, move a queue or call a provider.

Authority: nothing happens without the `--context-upgrade-profile` flag, a JSON profile naming exact provider, source model, target model, account, billing, `threshold` (0-1) and `headroom` (tokens). Registering the extension alone authorizes nothing, and a fixed-model plan task gets no upgrade unless its launch passes such a profile. The user's grant for this run is not a standing authority.

Policy (`assess`): the current model must be the profile's source; usage must be known (a null estimate pauses, it is never zero) and match the source window; usage at or above the threshold; the target must use the same API, accept every input kind of the source, have a strictly larger window, leave at least `headroom` tokens, and be in `modelRegistry.getAvailable()` (local credentials only, not remote quota). One attempt per session, also read back from `context-upgrade` entries.

Automatic, supported: monitoring on `turn_end` and `session_before_compact`. At the threshold it appends a UI-only `context-upgrade` entry (`pending` or `paused` with reason, tokens, window, threshold, headroom, target) and notifies once per session.

Manual, by design: `/context-upgrade apply` awaits `ctx.waitForIdle()`, then rechecks idle, queued messages, model, usage and availability, persists an `attempt` entry, calls `pi.setModel` and records the actual model (`switched`, or `paused` when the native result is not confirmed). It does not interrupt a busy run.

Pending, not implemented: a fully automatic switch. Pi documents no boundary where an extension may change the model before the next request without racing queued work; `turn_end` and `agent_before_settle` can append entries and continue but have no model-change result. Default is therefore notice plus manual apply. Also pending: parent-owned registration in `paths.ts`/`launcher.ts`, passing the flag from the executor or plan, remote quota checks, and reload: already-running workers do not have this until the extension loads at launch or reload. The Luna (272K) to Terra (500K) route is only an example profile built from the current local metadata.
