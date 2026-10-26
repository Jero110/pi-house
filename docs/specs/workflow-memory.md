# Spec: workflow memory and the keeper

Plan: `docs/plans/workflow-memory.md` (in the main checkout). Research: `docs/research/workflow-memory.md`. Decisions:
`docs/decisions/ADR-001-workflow-memory.md`. The plan's Decisions are the fixed frame; this spec chooses among the
proposals with the research and says what each build task (T3-T7) delivers and how it is tested.

## Objective

pihouse keeps a persistent, lightweight memory of how the user works:

- Planner and executor runs, and any conversation the user flags with `/workflow save [reason]`, are captured as one
  package per agent tree: metrics, reason and a copy of every transcript. Capture is code only.
- One durable agent, the **keeper**, under the fixed agent-link name `keeper`, says how many runs are pending and, when
  the user asks, digests the batch: each run is read once, a digest is written per run, the workflow memory is
  updated, proposals are written, the batch is marked processed and never read again. Its cost per turn stays flat.
- `/workflow ask` answers from the workflow memory, the index and the relevant digests, and turns links and videos in
  the question into `consulted/` entries with a transcript from an existing tool.
- The system changes itself only through proposals the user approves; rejected proposals are never made again; unused
  memory is archived, never deleted.

Success: the Goal's example in the plan runs end to end against fakes in the tests (see Success criteria).

## Tech stack

TypeScript run directly by Node 24+ (erasable syntax only, no `any`, no build step), pi
(`@earendil-works/pi-coding-agent`, unmodified) extensions, `agent-link-core` (journal, tree), `agent-transcripts`
(transcript reader). No new dependency. External CLIs (`yt-dlp`, `whisper`, `ffmpeg`) are detected on PATH and never
installed.

## Commands

| Command | Where | What it does | Task |
| --- | --- | --- | --- |
| `/workflow save [reason]` | any pihouse session | Flags the current session's run and captures it now, with the reason. Works with no workers and with no hub. | T4 |
| `/workflow review` | any pihouse session | Reviews the current session's run (flagged or not), as today. | T4 |
| `/workflow review --last` | any pihouse session | Reviews the most recent **flagged** run. | T4 |
| `/workflow ask <question>` | any pihouse session | Answers from the memory; links and videos in the question become `consulted/` entries. | T7 |
| `pih keeper` | a terminal | Starts the keeper as an agent-link root named `keeper` (or says where it already runs). | T6 |
| `/keeper` | the keeper | Shows the pending count and the open proposals. Code only. | T6 |
| `/keeper summarize` (also the plain words "summarize", "summarize them", "digest") | the keeper | Digests the pending batch and shows the summary and the proposals. | T6 |
| `/keeper proposals` | the keeper | Lists open proposals with ids. | T6 |
| `/keeper approve <id>` / `/keeper reject <id> [why]` | the keeper | Applies or rejects one proposal. | T6 |
| `/keeper prune` | the keeper | Runs the pruning rules now (they also run after every digest). | T6 |
| `/keeper new` | the keeper | Rotates the keeper to a fresh pi session (`ctx.newSession`). | T6 |

Project commands: `npm run check`, `npm test`, `npm run skills` (after adding the keeper skill).

## Memory location and layout (T3)

Global, under pihouse's home, each entry tagged with its project:

```
<PIHOUSE_HOME or ~/.pihouse>/memory/
  index.json                 every entry, small: the only list a model is ever shown (sliced)
  workflow-memory.md         the living memory: how the user works, what works, what does not (<= 8,000 chars)
  flags.json                 flagged runs: { [runId]: { reason?, by: "planner"|"executor"|"save", at } }
  runs/<runId>/run.json      the captured package (see Capture package)
  runs/<runId>/report.md     the computed report (renderReport), no model text
  runs/<runId>/transcripts/<agentId>.json    normalized transcript (agent-transcripts shape), always
  runs/<runId>/transcripts/<agentId>.jsonl   raw copy of the harness file, when it is a file (pi, pihouse, claude, codex)
  digests/<runId>.md         one digest per processed run (<= 2,000 chars)
  batches/<batchId>.json     a digest batch: run ids, state (claimed | done), summary path
  batches/<batchId>.md       the batch summary shown to the user
  consulted/<id>.md          a source the user sent: frontmatter metadata + summary
  consulted/<id>.txt         the source's transcript or text
  ideas/<id>.md
  proposals/<id>.md          frontmatter: kind, target, status, fingerprint; body: change and evidence
  archive/<same relative path as before>   archived entries; nothing here is ever deleted without approval
```

- `runId` is the agent-link root record id (`20261026T212210Z-pihouse-6`); a session with no hub uses
  `local-<pi session id>`.
- `projectOf(cwd)`: the git top-level of the cwd (`git rev-parse --show-toplevel`, fallback the cwd), stored as an
  absolute path plus a slug (`pi-house`). Not chosen by a model.
- Formats: machine records (`index.json`, `flags.json`, `run.json`, `batches/*.json`) are JSON with
  `"schema": 1`. What a person or a model reads (workflow memory, digests, consulted, ideas, proposals, batch summary)
  is Markdown with a small YAML-style frontmatter block (`key: value` lines only, parsed by code, no YAML library).
- Every write is atomic (write `<file>.tmp`, then `rename`).

`index.json`:

```json
{ "schema": 1, "entries": [ {
  "id": "run:20261026T212210Z-pihouse-6", "kind": "run|digest|consulted|idea|proposal|batch",
  "project": "/abs/path", "projectSlug": "pi-house", "title": "short", "summary": "one line, <= 200 chars",
  "status": "pending|processed|open|approved|rejected|applied|active|archived",
  "path": "runs/…/run.json", "createdAt": "ISO", "lastUsedAt": "ISO", "supersededBy": "id?",
  "fingerprint": "proposals only"
} ] }
```

### Store API (`packages/pihouse/src/workflow/memory.ts`)

A `MemoryStore` built with `openMemory(dir, { now? })` (dir from `pihousePaths(env).memory`, injectable `now` for
tests). Operations, each with a test:

- `writeRun(pkg, transcripts)`: writes `runs/<id>/` and its index entry as `pending`. Re-capturing a **pending** run
  replaces it; re-capturing a **processed** run is a no-op that returns `"processed"`.
- `pending()`: pending run entries, oldest first; `pendingCount()`.
- `markProcessed(runIds, batchId)`: sets `processed`; a processed run is never listed as pending again.
- `writeDigest(runId, markdown)`, `readDigest(runId)`.
- `claimBatch(runIds)` / `finishBatch(batchId, summaryMarkdown)`: claim is idempotent; a run in a claimed batch is
  not claimed twice.
- `writeConsulted(meta, text, summary)`, `writeIdea(...)`.
- `propose(p)`: computes `fingerprint = sha256(kind + "\n" + target + "\n" + normalized change)` (lowercased,
  whitespace collapsed). Returns `"rejected-before"` without writing when that fingerprint was rejected, and
  `"duplicate"` when it is already open.
- `decide(id, "approved" | "rejected", why?)`, `markApplied(id)`.
- `readWorkflowMemory()`, `writeWorkflowMemory(md)` (rejects text over the cap).
- `indexSlice({ project?, kinds?, limit, maxChars })`: compact lines (`id · kind · project · title · summary`),
  newest first, never above `maxChars`. Reads only `index.json`.
- `touch(ids)`: sets `lastUsedAt` (ask and the digest call it for what they read).
- `archive(id)`: moves the files to `archive/` and sets `archived`; `archiveStale({ days: 90 })` archives entries
  not used (by `lastUsedAt`, else `createdAt`) in 90 days, and every superseded entry. Pending runs, open proposals and
  `workflow-memory.md` are never archived by age. Nothing is deleted.
- `deleteArchived(ids)`: the only delete; called only when an approved `delete-raw` proposal is applied.
- `skillUse(lastN)`: for the last `N` processed runs, how many runs loaded or named each skill (from `run.json`).

Acceptance (tests in `packages/pihouse/test/memory.test.ts`, temp dirs, `HOME`/`PIHOUSE_HOME` pointed at them):
every operation above; a processed run never comes back as pending; a rejected proposal cannot be proposed again; an
entry unused for 91 days is archived and still on disk; `indexSlice` never reads a transcript file (the test makes the
transcript files unreadable and still gets the slice) and never exceeds `maxChars`.

## Flags and capture (T4)

### Flags

A run is **flagged** when any of these holds:

1. An agent in its tree has an agent-link name or pi session name starting with `workflow-`.
2. Its tree has an executor (`isExecutor`, which now also matches `workflow-executor`).
3. `flags.json` has its run id (written by `/workflow save` and by the auto-flagging below).

Naming, per decision 2:

- The planner skill spawns the executor with `name: "workflow-executor"` (Step 6 of `skills/pre-build/planner/SKILL.md`).
- The workflow extension watches `input`: when the user starts the planner (`/skill:planner`, or the text names the
  planner skill) or the session's task is the executor skill, it sets the pi session name to
  `workflow-planner · <title>` / `workflow-executor · <title>` (the title the brand extension would use) and writes
  the flag. The brand extension keeps the tab title working: it shows the session name as it is.
- `/workflow save [reason]` writes the flag with the reason and prefixes the session name with `workflow-saved · `.

Unflagged runs never enter the memory, the pending count, `--last` or a digest.

### Capture

`packages/pihouse/src/workflow/capture.ts`, pure code, no model:

- `captureRun(records, root, store, { reason?, by, roots? })`: builds the run with `buildRun`, renders
  `report.md`, copies every transcript (normalized JSON always, raw file when there is one), computes the metrics and
  writes the package through the store.
- When: on `/workflow save` (immediately); on `agent_end` of a flagged session (the root's tree is re-captured while
  pending, cheap: copies and JSON); and as a **sweep** (`sweepFlagged(records, store)`) that captures every flagged
  root not yet in the index, which the keeper runs before it counts and `review --last` runs before it picks. The
  sweep makes default capture robust when a session ended without an `agent_end`.
- With no hub (`PIHOUSE_NO_LINK=1`, no journal record), `/workflow save` captures the current session alone as
  `local-<sessionId>` from its own transcript.

### Capture package (`run.json`)

```json
{ "schema": 1, "id": "…", "project": "/abs", "projectSlug": "…", "flaggedBy": "planner|executor|save",
  "reason": "I liked how this went", "capturedAt": "ISO", "plan": "docs/plans/x.md",
  "title": "plan slug, else the reason, else the root's first request (<= 80 chars)",
  "metrics": { "newTokens": 0, "cacheRead": 0, "activeMs": 0, "wallMs": 0, "agents": 0, "messages": 0 },
  "agents": [ { "id": "…", "name": "…", "parent": "…|null", "role": "planner|executor|worker|helper|root",
    "harness": "…", "model": "…", "taskId": "T3", "taskTitle": "…", "assignedSkills": [], "loadedSkills": [],
    "usage": {}, "activeMs": 0, "messages": 0, "transcript": "transcripts/<id>.json", "raw": "transcripts/<id>.jsonl|null",
    "missing": "why there is no transcript|null" } ] }
```

The metrics are the ones `/workflow review` computes today (the same `summarize` and `newTokens`). No model runs at
capture: the decision allows a short model summary, but the title above is enough for the index and the digest writes
the summary once, so capture stays free (ADR-001, D5).

### Review

- `/workflow review` (no flag) is unchanged: the current session's tree.
- `/workflow review --last`: sweep, then the newest flagged run (by root start time); "No flagged run yet" otherwise.
- When the reviewed run is captured, `run.json` gets `"review": "<report path>"`.
- The executor skill ends by **offering** a review ("Run `/workflow review` here to see what ran, with which skills,
  tokens and time?") and never runs one.

Acceptance (`packages/pihouse/test/capture.test.ts`, fake journal and fake transcripts):
a three-level tree (planner -> workflow-executor -> two workers, one with its own worker) becomes one package with every
transcript copied; an unflagged tree is ignored by `--last`, the sweep and the pending count; `/workflow save` on a
plain chat with no workers captures it with its reason; capture runs with no model (the test passes no model
function); the package's `title` is at most 80 chars and nothing in `run.json` holds transcript text.

## Sources (T5)

`packages/pihouse/src/workflow/sources.ts`, no model reads a source here.

`fetchSource(input, deps)`, where `deps` injects `fetch`, a `which(bin)` lookup and an `exec(bin, args)` runner (tests
pass fakes; production uses `globalThis.fetch`, PATH and `execFile`). It returns
`{ ok: true, meta: { kind, url|path, title?, author?, durationSec?, language?, method, fetchedAt }, text }` or
`{ ok: false, tried: Method[], message, fallback }`.

Order, from the research's trials (ADR-001, D7):

- **YouTube link** (`youtube.com/watch`, `youtu.be`, `/shorts/`):
  1. `captions-fetch`: a POST to the YouTube app's player endpoint
     (`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, Android client `20.10.38`, no key). Anything but
     `playabilityStatus.status == "OK"` (a live stream is `UNPLAYABLE`), no tracks, a non-JSON answer or a network
     error moves on, with the reason in `tried`. Track choice: the first audio track's `defaultCaptionTrackIndex`;
     else the audio track whose `audioTrackId` ends in `.4` (the original audio; dubbed ones end in `.10`), its
     first caption track; else the first audio track's first caption track; else a non-`asr` track, else the first
     track (the first track in the list is often wrong). Then GET the track's `baseUrl` with `fmt=json3`; the text is
     each event's segments joined, events joined by a space, whitespace collapsed. The watch page is not parsed (it
     answers a CAPTCHA to servers).
  2. `yt-dlp` when on PATH: `yt-dlp --skip-download --write-subs --write-auto-subs --sub-format vtt --sub-langs
     "<lang>.*,en.*" -o <tmp>/%(id)s <url>` plus `--print title --print duration`, VTT stripped to text.
  3. `whisper` when `whisper` and `ffmpeg` and `yt-dlp` are on PATH: audio with `yt-dlp -x`, then
     `whisper <file> --output_format txt`.
- **Video or audio file**: `whisper` (with `ffmpeg`) when on PATH.
- **Web link**: `fetch`, HTML stripped to text by code (scripts, styles and tags removed, entities decoded, title
  from `<title>`), capped at 200,000 chars.
- **Nothing worked**: `ok: false` with every method tried and why, and
  `fallback: "agent"`: the message says "Could not get a transcript of <url>: <reasons>. Install yt-dlp (or whisper and
  ffmpeg) to transcribe it here, or I can ask a cheap agent to read it." The `ask` instructions then let the session
  spawn one cheap agent (opencode) with agent-link only if the user's question needs the source.

Acceptance (`packages/pihouse/test/sources.test.ts`, fake HTTP server or fake fetch, fake CLIs): a YouTube link with
captions (captions-fetch); the default track and the original-audio (`.4`) track picked; a live stream (`UNPLAYABLE`) falling through to `yt-dlp` (fake, on a temp PATH) subtitles; json3 flattening; one
with no captions and no tools (clear message naming yt-dlp and the agent fallback); a missing tool reported by name; a
plain web link stripped to text with its title; no real network in any test.

## The keeper (T6)

### Start and identity

- `pih keeper` runs pihouse as an agent-link root registered under the fixed name `keeper` (an optional `name` on the
  hub's register request, `agent-link-core` and `agent-link` open; the hub keeps `uniqueName`, so a second keeper
  would be `keeper-2`: `pih keeper` first reads the journal and, when a live `keeper` exists, prints where it runs and
  exits 0). It sets `PIHOUSE_KEEPER=1` and opens with the `keeper` skill.
- Without a hub, `pih keeper` still runs (plain pi plus the extensions), as every pihouse run does.
- `packages/pihouse/src/extensions/keeper.ts` is in `EXTENSIONS` and does nothing unless `PIHOUSE_KEEPER=1`.
- The skill: `skills/extras/keeper/SKILL.md` (group `extras`: invoked by hand, never by itself), registered in
  `skills/catalog.json`, then `npm run skills`.

### Lifecycle

1. **Start** (`session_start`): sweep, then show "N runs pending" in the status bar (`ctx.ui.setStatus`) and as a
   notice. Code only.
2. **Steady context**: every model request of the keeper sees, through `before_agent_start`, a bootstrap of the
   keeper instructions + `workflow-memory.md` + `indexSlice({ limit: 30, maxChars: 6000 })` + the pending count; and
   through the `context` event, only the messages after the last **boundary** (an `appendEntry("keeper-boundary")`
   written after every job). Older messages stay in the session file but never reach the model, so the cost of a
   turn does not grow with the keeper's age. `/keeper new` additionally rotates to a fresh pi session
   (`ctx.newSession`, command-only per pi's docs) and names it `keeper · <date>`. Compaction is only a safety net.
3. **Digest** (`/keeper summarize` or the plain words): command handler, so it first rotates to a fresh session
   (decision 9), then runs the digest engine there:
   - sweep; `claimBatch` of the pending runs, at most 10 per batch (more are left pending and the summary says how
     many remain);
   - per run, one nested model call (`ctx.modelRegistry.complete` with the keeper's model, injected as
     `complete(prompt) => Promise<string>` so tests pass a fake): input = the run's `report.md` + a condensed view of
     each normalized transcript built by code (user and assistant text per message cut to 400 chars, tool names and
     failures, skills), the whole input capped at 60,000 chars (about 15k tokens). Output: the run's digest (what
     ran, what worked, what did not, evidence by agent and message #), written with `writeDigest`. This is the one
     full read of the run;
   - one consolidation call: input = the batch's digests + `workflow-memory.md` + `skillUse(10)` + the open and
     rejected proposal fingerprints' titles, capped at 60,000 chars. Output (JSON in a fenced block, parsed by code):
     the new `workflow-memory.md`, the batch summary, and proposals `{ kind, target, change, evidence }`;
   - code adds the mechanical proposals: `remove-skill` for every catalog skill (builds and extras) loaded or named by
     none of the last 10 processed runs, once at least 10 runs are processed; `delete-raw` for raw transcript copies
     archived more than 90 days ago;
   - only when every write succeeded: `markProcessed`, move the batch's `runs/<id>/transcripts/` to `archive/`,
     `archiveStale`, `finishBatch`, `touch` what was read;
   - show the batch summary and the new proposals in the session (`sendMessage` with `display: true`, no turn), then
     write a boundary.
   A failed model call leaves the batch claimed but not processed; the next `summarize` resumes it.
4. **Later batches** read only digests of earlier ones (through `workflow-memory.md` and the index slice), never
   their transcripts: the engine reads `runs/<id>/transcripts/` only for runs in the current batch.

### Proposals

Kinds: `memory-rule` (add, change or drop a line in `workflow-memory.md`), `edit-skill` (a change to a SKILL.md),
`remove-skill`, `remove-idea`, `delete-raw`. `/keeper approve <id>`:

- `memory-rule`, `remove-idea`, `delete-raw`: applied by code (`writeWorkflowMemory`, `archive`, `deleteArchived`).
- `edit-skill`, `remove-skill`: the keeper's model applies it in its session (a turn with the proposal text and the
  path), then code marks it applied. `npm run skills` is named in the instruction when the catalog changes.

`/keeper reject <id> [why]` records the rejection; its fingerprint blocks the same proposal forever.

### Token limits

`LIMITS` in `packages/pihouse/src/workflow/memory.ts`, one place:

| Context | Limit (chars, about chars/4 tokens) |
| --- | --- |
| keeper steady bootstrap | 24,000 (6k tokens) |
| per-run digest input | 60,000 (15k tokens) |
| consolidation input | 60,000 |
| `ask` context | 80,000 (20k tokens) |
| `workflow-memory.md` | 8,000 |
| a digest | 2,000 |

Acceptance (`packages/pihouse/test/keeper.test.ts`, fake runs, fake `complete`): pending count; a batch of 3 is
digested once (the fake `complete` is called 3 + 1 times) and then 0 are pending; a second batch's inputs contain no
text of the first batch's transcripts; approve applies a `memory-rule`, reject is remembered and the same proposal is
dropped next time; `remove-skill` comes up for a skill unused in 10 runs; pruning archives an entry unused for 90 days
and deletes nothing; size test: the bootstrap and every digest and consolidation input stay under `LIMITS` with 1, 5
and 20 runs in memory (20 runs each with a 2 MB fake transcript); the `context` handler drops messages before the last
boundary.

## /workflow ask (T7)

`askContext(question, env, deps)` keeps the architecture, the machine facts and the catalog, and adds:

- `workflow-memory.md`;
- `indexSlice({ limit: 40, maxChars: 8000 })`;
- the relevant digests: index entries scored by word overlap of the question with title and summary, top 3,
  their digest files (each at most 2,000 chars); `touch` on what was included;
- the last review's first lines, as today.

Never a transcript. With links or a video path in the question, `ask` first runs `fetchSource` for each (at most 3),
writes `consulted/<id>.md` (meta + an empty `## Summary`) and `consulted/<id>.txt` through the store, and adds to the
context the entry paths, the first 4,000 chars of each text and the instruction to: write the summary into the entry
(<= 1,500 chars), relate it to the user's past runs (from the digests above), write each idea worth keeping to
`ideas/` with the store's format (the path and frontmatter are given), and ask the user what it needs to go on. A
failed `fetchSource` adds its message and the cheap-agent fallback instead.

`ask` runs in the session that asked (it does not need the keeper), so it costs one turn there.

Acceptance (tests in `pihouse.test.ts` / `keeper.test.ts`): the ask context includes the workflow memory and the index
but no transcript text; a YouTube link goes through a fake `fetchSource` and produces a `consulted/` entry; the context
stays under `LIMITS.ask` with 20 runs in memory.

## Project structure

```
packages/pihouse/src/paths.ts                 + memory dir; EXTENSIONS + keeper.ts
packages/pihouse/src/workflow/memory.ts       T3 store and LIMITS
packages/pihouse/src/workflow/capture.ts      T4 capture, flags, sweep
packages/pihouse/src/workflow/run.ts          T4 isExecutor matches workflow-executor
packages/pihouse/src/workflow/sources.ts      T5
packages/pihouse/src/workflow/digest.ts       T6 digest engine (pure, injected complete)
packages/pihouse/src/extensions/workflow.ts   T4 save/review, T7 ask
packages/pihouse/src/extensions/keeper.ts     T6
packages/pihouse/src/cli.ts, launcher.ts      T6 `pih keeper`
packages/agent-link-core/src/hub/hub.ts       T6 optional root name
packages/agent-link/src/open.ts               T6 pass the name
skills/extras/keeper/SKILL.md, skills/catalog.json   T6
skills/pre-build/planner/SKILL.md             T4 executor named workflow-executor
skills/build/executor/SKILL.md                T4 offer the review
packages/pihouse/test/{memory,capture,sources,keeper}.test.ts
```

## Code style

Match the existing modules: a header comment saying what the file is for, small exported pure functions that take
their I/O as parameters, comments as problem / example / solution when a choice is not obvious:

```ts
/**
 * The pending runs, oldest first.
 * Problem: a run digested in one batch came back in the next when its package was captured again.
 * Solution: a processed run is never rewritten; writeRun returns "processed" for it.
 */
export function pending(index: MemoryIndex): IndexEntry[] {
	return index.entries.filter((e) => e.kind === "run" && e.status === "pending").sort(byCreated);
}
```

## Testing strategy

`node --test` (the existing runner), tests next to the others in `packages/pihouse/test/`. Every test uses temp dirs
for `HOME`, `PIHOUSE_HOME` and `AGENT_LINK_HOME`; a fake journal (JSON records), fake transcripts (pi JSONL written by
the test); a fake `complete` for every model call; a fake `fetch` or local HTTP server and fake CLIs on a temp `PATH`
for sources. No real network, no real API, no paid tokens. Size limits are asserted by tests, so a later change cannot
inflate a context silently.

## Boundaries

- Always: write through the store; atomic writes; `npm run check && npm test` with no warnings before each commit; one
  commit per task.
- Ask first (the user, through a proposal): any delete; any change to a skill or rule; removing anything.
- Never: delete memory without an approved proposal; send a transcript to a model outside the digest; install a tool;
  add a dependency; patch pi's files; touch the user's main checkout.

## Success criteria

- The Goal's flow passes against fakes: capture by default (executor) and by save; pending count 3; summarize digests
  each once and leaves 0 pending; processed runs are never read again; approve applies, reject is remembered;
  pruning archives and never deletes.
- The size tests hold with 20 runs for the keeper bootstrap, the digest inputs and `ask`.
- `npm run skills && npm run check && npm test` pass with no warnings.

## Open questions

None blocking. Recorded as assumptions in ADR-001: batch size 10, N = 10 runs for unused skills, the limits table.
