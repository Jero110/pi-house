# Changelog

## Unreleased

### Changed
- Replaced `/workflow review` and keeper-era public commands (`/keeper`, `pih keeper`) with `/workflow report`, `digest`, `self-learning`, and proposal commands. Removed commands return replacement guidance, not compatibility aliases.
- Reports are code-computed and may be partial; digest generation and batch review are manually triggered in separate agents. Only validated, stable evidence can remove pi-house-owned captured conversation copies. Native harness sessions, project files, and migration backups are not deleted.
- Workflow memory now separates readable canonical documents, authoritative SQLite operational state, and rebuildable FTS search. Memory is retrieved on demand rather than injected into ordinary context.
- Proposal approval pins the current displayed version and remains distinct from verified application; see [migration and recovery guidance](docs/self-learning.md).
- Added architecture diagrams and successor decision [ADR-002](docs/decisions/ADR-002-self-learning.md); ADR-001 remains as historical rationale.

## 0.1.0

First release as pi-house, started from Faro.

- Command `pih` (also `pihouse`); configuration in `~/.pihouse`; agent-link harness `pihouse`.
- Flat theme close to Claude Code's: a gray bar for your message, a periwinkle accent and bright syntax colors.
- Tool calls drawn like Claude Code's: a call line and a summary line, with the detail behind ctrl+o; edits keep a short colored diff. The terminal tab is named after the session, from the first request, instead of "pi-house · folder".
- Default model: Sonnet 5.5, through the Claude bridge when it is installed and through an Anthropic API key otherwise; pi falls back to the provider you are logged in to. Settings from earlier versions are migrated without replacing your choices.
- The agent-link hub reads its profiles again when asked for a harness it does not know, so installing a harness no longer needs a hub restart (a hub started by Faro could not open `pihouse`).
- Status line in Claude Code's layout; Claude and ChatGPT usage windows are shown when available.
- Plain text header (no logo, no slogan) and a black and white logo in `assets/` for the README.
