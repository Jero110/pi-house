# Contributing to pi-house

Thanks for helping. pi-house is small on purpose, so the best contributions are focused ones.

## Set up

```bash
git clone https://github.com/Jero110/pi-house && cd pi-house
npm install --ignore-scripts
npm run check   # biome, tsc, pinned dependencies
npm test        # no real APIs, no paid tokens
```

Node 24 or newer runs the TypeScript files as they are; there is no build step.

## Rules

They live in [AGENTS.md](AGENTS.md) and CI enforces them:

- Build on pi without forking it: extensions, skills, packages and its SDK. Never patch pi's files.
- TypeScript with erasable syntax only (no `enum`, `namespace` or parameter properties), no `any`, top-level imports only.
- Dependencies pinned to exact versions. Avoid new ones.
- Tests use fake sockets, fake HTTP servers and fake CLIs, never real APIs.
- Everything in English: code, comments, CLI output, docs and commits. No emojis.
- Explain a non-obvious choice as problem, example, solution, in the comment and in the commit message.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we agree on the direction.
2. One change per pull request, with a test that fails without it.
3. `npm run check` and `npm test` pass with no warnings.
4. Describe what changed and why, in a few lines.

## Where things are

| Path | What |
| --- | --- |
| `packages/pihouse` | the `pih` command: launcher, setup, theme, status bar, extensions |
| `packages/agent-link*` | the hub and MCP server that let agents launch and message each other |
| `packages/cmux-mcp` | the cmux MCP server |
| `skills/` | the development skills, listed in `skills/catalog.json` |

See [docs/architecture.md](docs/architecture.md) before changing how the pieces fit.

By contributing you agree that your work is released under the [MIT License](LICENSE).
