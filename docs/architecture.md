# Architecture

pihouse is three things that stay separate: **pi** (the agent, unmodified), **agent-link** (agents launching and talking to
agents) and the **cmux MCP** (finding sessions and arranging cmux). pihouse itself is a launcher and a few pi extensions.

```
 you ─► pihouse (pi + extensions) ── MCP stdio ─► agent-link MCP ── HTTP over a Unix socket ─► hub daemon
                                                                                              ├─ registry, one queue per agent
                                                                                              ├─ adapters: claude, codex, opencode, pi
                                                                                              ├─ pane backends: cmux, tmux
                                                                                              └─ journal: ~/.agent-link/sessions/*.json
        any harness ── MCP stdio ─► cmux MCP ─► cmux CLI, the journal, transcripts on disk
```

## pihouse

`pih` (packages/pihouse) runs pi from its pinned dependency with:

- `PI_CODING_AGENT_DIR=~/.pihouse/agent`: pihouse's own settings, sessions and MCP servers; plain pi stays untouched. The first
  run copies pi's login (auth, model store, the Claude bridge package if you use it) so the same models work.
- `-e` for its extensions: `brand.ts` (header and title), `statusbar.ts` (the footer: folder, model, context and the usage of the account in use; its theme is `packages/pihouse/themes/pihouse.json`), `ask.ts` (`ask_user_question`, and `pick_skills`: the skills picker built from the catalog), `workflow.ts` (`/workflow`), `compact-tools.ts` (tool calls drawn in two lines), `claude-login.ts`, and `keeper.ts`
  (`/keeper`, inert unless `PIHOUSE_KEEPER=1`).
- The four skill group folders as pi skill paths. Only `planner` and `executor` are visible to the model on their own;
  every other skill carries `disable-model-invocation: true` and loads when a plan or the user names it.

A user's `pih` registers with the agent-link hub as a root of harness `pihouse`; the hub answers with the command to run
(the pihouse profile in `~/.agent-link/profiles/pihouse.json`: this CLI, plus agent-link's pi extension and identity env). When
the hub starts a pihouse worker, the same profile opens it in a pane. Without a hub, pihouse runs as plain pi plus its
extensions.

## agent-link

- **Hub daemon**: one per machine, socket `~/.agent-link/hub.sock` (0600), token `~/.agent-link/token`. Started on demand
  by the MCP server or `agent-link open`.
- **MCP server**: seven tools (`spawn`, `send`, `permit`, `reply`, `status`, `cancel`, `inbox`), one entry per backend
  (`agent-link-cmux`, `agent-link-tmux`). The model never sees adapters.
- **Adapters**, one per harness, each by its native path: Claude Code's messaging socket, Codex's app-server, opencode's
  HTTP server, pi's extension socket. A harness without one can use a `paste` profile.
- **Pane backends**: open, close, read, keys, paste, alive. A caller's workers form one column to its right (the
  first split right of it, each next one below the last still open), never stealing focus and never as tabs; after
  every open and close the layout evens out (cmux `workspace.equalize_splits`, tmux `main-vertical` with the main pane
  at half the width). Opens run one at a time, so parallel spawns stack. A worker always stays in the caller's
  workspace (cmux) or window (tmux), however small its pane: a split that does not fit is retried from the other panes
  there, and the open fails clearly when none does. Agents resize and move panes with the cmux MCP (`resize_pane`,
  `move_surface`, `swap_pane`).
- **Handoff**: `spawn` with `handoff: true` (the planner opening the executor) closes the caller once the new agent is
  connected and the caller's turn has ended, with its pane (a root's own terminal too), while the new agent and its
  workers go on.
- **Messages**: one FIFO queue per agent; the hub prompts an agent only when it is idle, so each message gets its own
  turn and result. A worker's first message is its task, as a person would write it, and its parent's messages arrive
  plain; a message from anyone else starts with `[agent-link] <name>:`. A worker's final answer reaches its parent as
  `[agent-link] <name> (...) finished: ...`.
- **Journal**: on every change the hub writes `~/.agent-link/sessions/<id>.json`: name, parent, root, task, harness,
  model, state, pane, and the harness's own session id and transcript path (reported by the adapters). It outlives the
  hub and the agent, which is what makes recovery and `/workflow review` possible.

Identity reaches a spawned harness through `AGENT_LINK_AGENT`, `AGENT_LINK_HUB`, `AGENT_LINK_TOKEN`,
`AGENT_LINK_DEPTH` and `AGENT_LINK_HOME`. `AGENT_LINK_READ_DIRS` lists folders outside its cwd a worker may read
without a prompt (pihouse shares its skills folder); a profile may add env of its own (pihouse's `PIHOUSE_HOME`). A guard lets workers do normal work, blocks the catastrophic, and asks for the rest.

## cmux MCP

A separate server (`packages/cmux-mcp`) with the tools in the README. Sessions come from two sources joined by session
id: cmux's own records (`cmux sessions`, which work without the cmux socket) and the agent-link journal (which adds
names, tasks, parents and sessions cmux does not see). `read_agent_transcript` reads the transcript file through
`agent-transcripts`; it never reads the terminal screen.

## agent-transcripts

One reader for every harness's session format (Claude Code and Codex JSONL, opencode's SQLite database, pi and pihouse
JSONL) into one shape: messages with role, text, model, token usage, time per answer, tool calls and the skills loaded.

## /workflow

- `review` picks the run of the current session, rebuilds its tree from the journal, assigns roles from its shape (the
  root plans, an `executor` or `workflow-executor` child runs the plan, its descendants are workers), reads every
  transcript and writes a report to `~/.pihouse/reports/`. The numbers are computed; the session's model then writes
  the summary and the recommendations from them. `review --last` takes the most recent **flagged** run instead.
- `save [reason]` flags the current session's run and captures it into the workflow memory now.
- `ask` gives the model the architecture, the skills catalog, what is installed here, the workflow memory, a slice of
  the memory's index and the digests that match the question, never a transcript. Links and videos in the question go
  through `workflow/sources.ts` first and are saved to `consulted/`.

## Workflow memory

Design and alternatives: `docs/decisions/ADR-001-workflow-memory.md`; contract: `docs/specs/workflow-memory.md`.

- **Store** (`workflow/memory.ts`): everything reads and writes `~/.pihouse/memory/` (`$PIHOUSE_HOME/memory/`) through
  it, with atomic writes. `index.json` lists every entry (kind, project, status, one-line summary, last use);
  `workflow-memory.md` is the living memory; `runs/<runId>/` holds captured packages (`run.json`, `report.md`,
  normalized and raw transcript copies); `digests/`, `batches/`, `consulted/`, `ideas/`, `proposals/`, `archive/`.
  Models only ever see `indexSlice`, capped by chars. `LIMITS` holds every size cap, and tests assert them.
- **Flags and capture** (`workflow/capture.ts`): a run is flagged by a `workflow-` agent name, an executor in its tree,
  or `flags.json` (written when a session starts the planner or the executor, and by `/workflow save`). Capture is code:
  on save, on `agent_end` of a flagged session, and in a sweep of the journal that the keeper and `review --last` run
  first. A processed run is never captured again.
- **Keeper** (`extensions/keeper.ts`, `workflow/digest.ts`, skill `skills/extras/keeper`): `pih keeper` starts a root
  registered with the fixed agent-link name `keeper` (an optional `name` on the hub's register request). The digest
  runs from a command, in a fresh session (`ctx.newSession`): one nested model call per run
  (`ctx.modelRegistry.complete`, bounded input from the report and a code-condensed transcript), then one
  consolidation call over the digests that rewrites `workflow-memory.md` and writes proposals. Code adds the removal
  proposals (skills unused in the last 10 processed runs, raw copies archived over 90 days ago), marks the batch
  processed, archives the raw copies and prunes. Between jobs the `context` event drops every message before the last
  boundary and `before_agent_start` adds the capped bootstrap, so a turn costs the same however old the keeper is.
- **Sources** (`workflow/sources.ts`): YouTube captions fetched from the player endpoint (no key), then `yt-dlp`, then `whisper` with `ffmpeg`,
  detected on PATH, never installed; web pages are stripped to text by code. When nothing works the result names what
  to install and the cheap-agent fallback.
