# Published-library follow-up: acceptance and execution contract

Approved scope: the operator's follow-up request to the existing Books RAG plan.
No new architecture or dependencies. Execution order and atomic commits:

| Capability | Responsibility | Depends on |
|---|---|---|
| live-calibration | Read-only labeled real-model gate measurement; private env override | Published root |
| ask-cli | Read-only CLI over existing search/configuration | live-calibration |
| agent-skills | Verbatim portable instructions and README discovery | ask-cli |

## Acceptance

- Calibration: at least 30 English answerable questions across at least 12 books,
  plus five Spanish-to-English reformulations and 15 unrelated questions. Freeze
  expected books and a deterministic two-thirds training/one-third held-out split
  before observing scores. Record verified PDF ranges when available, top scores,
  top-two margins, raw and gated expected-book recall@5 and unrelated accepts.
  Optimize one floor/drop pair on training only; report held-out unchanged.
  Measure and cap Pinecone response accounting at 150,000,000 B. Use an empty
  reader directory, `searchBooks` and `readHostedPassage`; never index or mutate
  hosted services. Preserve source defaults. Back up the private env with mode
  600 and replace/append only its two relevance lines; validate with doctor.
- `books-rag ask "<question>" [--book <bookId>] [--json]` shares configuration,
  local embeddings and configured search gate, with no LLM calls or local store.
  Human output includes status, titles, physical PDF pages, headings, scores,
  excerpts at most 400 characters and linked figure labels/IDs. Insufficient
  evidence has one clear absence line plus diagnostics; outages/incompleteness
  are explicitly distinct states. JSON preserves structured search metadata.
  Test all four states with existing loopback fake services; document usage.
- Copy the two supplied skills byte-for-byte, document discovery in pihouse,
  Claude Code and Codex, and mention the CLI alternative.

## Implementation and verification

Existing TypeScript ES modules in `src/`, Node test runner in `test/`, Biome and
TypeScript checks; follow existing tab indentation and typed contracts. No new
service, model, dependency, provider provisioning, or default gate change.

Commands: `npm run check`, `npm test`,
`node packages/books-rag/src/cli.ts evaluate --synthetic`, `git diff --check`.
Inspect staged changes before each atomic commit. Never commit secrets or book
prose; metadata headings, labels, page numbers and scores are permitted. Private
operational inputs/results belong in mode-600 `/tmp` files, not the repository.
Live smoke reports contain citations/scores only, not excerpts. No push/release.

Limitations to preserve: small labeled sample, one embedding model, extraction
gaps, nearest-neighbor scores not proof of support, reader must assess text.
