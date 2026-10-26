# Changelog

## Unreleased

- Workflow memory in `~/.pihouse/memory/`: planner and executor runs are flagged and captured by default (the executor
  runs as `workflow-executor`), and `/workflow save [reason]` flags any conversation. A capture is the whole agent tree
  with its metrics, the reason and a copy of every transcript, written by code.
- `/workflow review --last` reviews the most recent flagged run; `/workflow review` still reviews the current session.
  The executor offers a review when it finishes and never runs one itself.
- The keeper (`pih keeper`, skill `keeper`): one agent under the fixed agent-link name `keeper` that says how many runs
  are pending and, when you say "summarize them", digests the batch in a fresh session (each run read once), updates the
  workflow memory and writes proposals you approve or reject (`/keeper approve|reject <id>`). Unused memory is archived
  after 90 days, never deleted; rejected proposals are never made again. Its context per turn stays capped.
- `/workflow ask` answers from the workflow memory, its index and the matching digests. Links and YouTube videos in the
  question are transcribed by a tool (captions, `yt-dlp` or `whisper` when installed), saved to `consulted/` with a
  summary, and ideas go to `ideas/`.
- agent-link: a root can ask for a fixed name (`agent-link open` and the hub's register request take an optional `name`).

## 0.1.0

First release as pi-house, started from Faro.

- Command `pih` (also `pihouse`); configuration in `~/.pihouse`; agent-link harness `pihouse`.
- Flat theme close to Claude Code's: a gray bar for your message, a periwinkle accent and bright syntax colors.
- Tool calls drawn like Claude Code's: a call line and a summary line, with the detail behind ctrl+o; edits keep a short
  colored diff. The terminal tab is named after the session, from the first request, instead of "pi-house · folder".
- Default model: Sonnet 5.5, through the Claude bridge when it is installed and through an Anthropic API key otherwise; pi
  falls back to the provider you are logged in to. Settings from earlier versions are migrated without replacing your choices.
- The agent-link hub reads its profiles again when asked for a harness it does not know, so installing a harness no
  longer needs a hub restart (a hub started by Faro could not open `pihouse`).
- Status line in Claude Code's layout: `user@host  ~/folder  Model  ctx: 32%  ◷ 5h: 23% (2h15m → 16:00)`. The Claude
  usage is read from what Claude Code leaves in `~/.claude/rate-limits`, the ChatGPT usage from OpenAI's usage endpoint,
  and both are shown side by side when both are logged in (tokens and cost when a login has no windows).
- Plain text header (no logo, no slogan) and a black and white logo in `assets/` for the README.
