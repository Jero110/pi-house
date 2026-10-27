# Spec: book-retrieval

**Status:** Approved by the user on 2026-10-27. **Depends on:** book-corpus.
Shared objective, stack, commands, style, testing rules, assumptions, and boundaries: [common.md](common.md).

## Objective

Retrieve compact, source-resolvable evidence from approximately 20 books through local embeddings and a configured Pinecone index. Precision, abstention, and provenance matter more than sophisticated architecture.

## Structure and boundary contract

Implementation belongs in an isolated module under `packages/`, with tests under its `test/` directory. Consume `book-corpus` immutable versions/chunks. Expose bounded search and passage/figure resolution to `books-mcp`. Keep source path and passage content local.

Research Pinecone's current official API documentation and account-independent limits before implementation. Document sources/date, model dimensions, index compatibility, permitted metadata, region/privacy implications, cost assumptions, and non-provisioning setup. Stop on unsupported/free-tier-incompatible requirements; do not silently change providers.

Hosted records contain opaque passage/version IDs, vectors, and minimal filter metadata. No original/normalized text, captions, image bytes, local paths, or secrets. Book title/author metadata can be resolved locally rather than uploaded. Keep a corpus/index manifest so remote IDs cannot resolve into a different local library or incompatible embedding version. Use a dedicated configured namespace; never erase unrelated vectors.

Search input accepts a bounded query and optional book/version filters. Output status is one of `ok`, `insufficient_evidence`, `unavailable`, or `incomplete_corpus`, with explicit diagnostics and coverage information. Define precedence/combinations in the implementation plan so partial results are never silently reported as complete. Hits contain passage ID, source identity/location, a short literal excerpt, heading path, figure availability, and ranking signals labeled as scores rather than confidence probabilities.

Local embeddings use the same pinned model/configuration for documents and queries. A mismatch blocks search until an explicit compatible index is selected or rebuilt. A separate local lexical candidate index may augment dense retrieval if evaluation supports it; do not assume Pinecone hybrid search is enabled or free. Apply hard result caps, de-duplication, filters, and a measured relevance gate rather than always returning k hits.

A nearest-neighbor result alone does not certify that a passage answers a question. Agent semantic assessment is a second gate, documented in `books-mcp`.

## Evaluation and success criteria

- [ ] Fake Pinecone captures prove uploads exclude all text, captions, bytes, paths, and credentials beyond the credential-bearing request header.
- [ ] Incremental indexing resumes after transient failure; only successfully indexed source versions become searchable. Updates/deletes cannot mix stale and current versions.
- [ ] A source-hash/model/dimension/manifest mismatch fails explicitly; stale vector hits are discarded and surfaced diagnostically rather than rendered as fresh evidence.
- [ ] Timeouts, rate limits, malformed responses, missing credentials, missing local embedding runtime, and paid-resource constraints never become `insufficient_evidence`.
- [ ] Inputs, retries, concurrency, and response sizes have finite validated bounds; logs redact credentials and avoid full book text.
- [ ] The labeled synthetic evaluation meets common.md recall@5 and unrelated-query gates, including exact code identifiers and English reformulations of Spanish questions.
- [ ] Compare at least two chunk configurations on the same labeled corpus; report recall@5, result redundancy/unnecessary text, citation integrity, and figure associations. Do not claim real embedding quality from fake-vector tests.
- [ ] Optional real-model evaluation remains separately operator-run and cost-aware; it uses local embeddings and only an already configured allowed Pinecone resource. No real network/API calls in automated tests.
- [ ] Frozen evaluation records model/version, tokenizer, chunk configuration, ranking/relevance thresholds, corpus hash, and test questions for reproducibility.

## Commands and validation

`npm run check` and `npm test`. The implementation plan must define exact synthetic evaluation and optional operator-check commands before coding. No provider SDK or embedding model version is approved yet.

## Boundaries

Always separate local corpus truth from hosted search candidates and record extraction gaps. Stop and report any need for paid resources or materially different privacy/dependency choices. Never auto-upgrade/provision resources, upload book text to simplify retrieval, use cloud embeddings as a fallback, or claim similarity scores prove factual support.
