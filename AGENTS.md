# pihouse: development rules

- Read `docs/architecture.md` before changing how pieces fit.
- Build on pi without forking it: extensions, skills, packages and its SDK. Never patch pi's files.
- TypeScript with erasable syntax only (no `enum`, `namespace` or parameter properties), no `any`, top-level imports
  only. Node runs the `.ts` files directly; there is no build step.
- After every change: `npm run check` and `npm test`, with no warnings.
- Dependencies pinned to exact versions, installed with `npm install --ignore-scripts`. Avoid new ones.
- Tests use no real APIs and no paid tokens: fake sockets, fake HTTP servers, fake CLIs.
- One version for every package: change the root `package.json` and run `npm run sync-versions`.
- Skills: `skills/catalog.json` is the source of truth; run `npm run skills` after adding or updating one.
- Everything in English: code, comments, CLI output, docs, commits. No emojis.
- Explain non-obvious choices as problem, example, solution (in comments and commit messages).
