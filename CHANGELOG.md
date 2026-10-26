# Changelog

## 0.1.0

First release as pi-house, started from Faro.

- Command `pih` (also `pihouse`); configuration in `~/.pihouse`; agent-link harness `pihouse`.
- Flat theme close to Claude Code's: a gray bar for your message, a periwinkle accent and bright syntax colors.
- Status line in Claude Code's layout: `user@host  ~/folder  Model  ctx: 32%  ◷ 5h: 23% (2h15m → 16:00)`. The Claude
  usage is read from what Claude Code leaves in `~/.claude/rate-limits`, the ChatGPT usage from OpenAI's usage endpoint,
  and both are shown side by side when both are logged in (tokens and cost when a login has no windows).
- Plain text header (no logo, no slogan) and a black and white logo in `assets/` for the README.
