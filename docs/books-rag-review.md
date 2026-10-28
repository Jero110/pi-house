# Books RAG: independent review (T11)

**Date:** 2026-10-27. **Reviewer:** books-reviewer (did not write this code). **Reviewed:** branch `feature/books-rag`, HEAD `607bcfd`, range `825bb1f..HEAD` (24 commits, 53 files, `packages/books-rag` plus docs, README, `.gitignore`, root `package.json`/lock).
**Scope of this file:** the only file this review adds. No source or test file was modified; findings go to a builder task.

## Verdict

**ISSUES: 0 critical, 3 major, 6 minor.** The synthetic pipeline, privacy boundary, output budgets and the hosted-record checks hold up. Three defects block calling the feature complete: changed originals become separate books (stale edition stays searchable and can block `index`), the live relevance gate is an unrecalibratable constant with no operator step, and the schema-1 failure is misreported. Nothing here says retrieval works with the real model, Pinecone, Supabase or a client; none of that was run.

## Validation (re-run by the reviewer)

| Command | Result |
|---|---|
| `node packages/books-rag/src/cli.ts evaluate --synthetic` | exit 0, `passed: true`; bounds 180 and 320: recall@5 1.0 (24 answerable), 10/10 unrelated abstentions, 0 citation failures, 0 figure failures, 25 and 12 chunks, 48 and 24 provenance checks; `liveEvaluation: NOT RUN` |
| `npm run check` | biome "Checked 254 files, no fixes", `tsc --noEmit`, pinned-deps check: pass, no warnings |
| `npm test` | 737 tests, 737 pass, 0 fail, 0 skipped; no Node warnings (the only "warning" string is a pre-existing test title) |
| `git diff --check` | clean |
| `node scripts/check-pinned-deps.mjs` | pass; `pdfjs-dist@6.4.299`, `@napi-rs/canvas@1.0.13`, `cmux-mcp@0.1.0` exact |
| `node packages/books-rag/dev/inspect-pdf.ts --input <Desktop/books PDF> --pages 169-174` | 694 pages, 13 top-level / 252 outline entries; p169-170 code-like fonts, Figure 3-4/3-5; p171 heading "Semantic chunking", Figure 3-6 ref; p172 Figure 3-6 caption; p173 "Handling images and videos", Figure 3-7 ref; p174 Figure 3-7 caption; Table 2-1 caption on p50 with 0 candidate rows ("tableFidelity: unverified"); full-page fallback renders of p50/172/174 at 1224x1584, 332-407 KB, not persisted; decoder diagnostics 0. This matches the plan's observations; it is extraction diagnostics only, not ingestion or retrieval on the real book. |

Repository hygiene: commits are authored by one local author, touch only `packages/books-rag`, docs, `README.md`, `.gitignore`, `package.json`, `package-lock.json`, `CAPABILITY-MAP-books-rag.md`. No `.env`, PDF, image or key pattern (`pcsk_`, `sbp_<token>`, `AKIA`, JWT) appears in the diff. `git grep` of book-specific strings finds only headings/identifiers (`embedding_vectors`, "Semantic chunking", figure labels) and the author names already in the approved spec; no extracted book prose. Tests use loopback fakes only (`127.0.0.1`); `https://example.test` appears only in constructor-validation cases. The untracked ledger `docs/plans/books-rag-progress.md` was read, not touched.

## Findings

### Major

**M1. A changed original re-ingests as a separate book; the old edition stays "current", searchable, and can block `index` forever.**
`packages/books-rag/src/cli.ts:247-252` reuses `bookId` only when `sourceHash` is identical; any other file gets `store.newBookId()`. The store models "current version per book" (`store.ts:292-294`, `currentVersion`), but the CLI never makes a new file a version of an existing book, so `indexCorpus` (`indexing.ts:212`) selects both as current and the catalog (`validateCatalog` allows one version per `bookId`) lists two books, same title. This contradicts book-corpus.md ("changed files ... create new versions, and old versions cannot be mistaken for current ones"). Worse, when the new edition is saved at the same path, the old version's `verifiedSourceBytes` fails (`store.ts:373-380` tolerates a missing original, not a changed one), so `index` throws `source_changed` for the whole library and no CLI command retires the old version. `docs/books-rag.md:198-199` tells the operator to "ingest the new file as its own version", which does not exist.
Reproduction (run by the reviewer): `/tmp` script calling `runCli(["ingest","--input",P])` with `evaluationPdf()` at `P`, overwriting `P` with `structuralPdf()`, ingesting again. Result: `versions 2`, `current books 2`, and `store.readPassage(oldVersion, ...)` throws `source_changed: Original hash differs from the recorded version`. Test idea: CLI integration test that ingests A, replaces the file, ingests, runs `index` against the fakes, and asserts exactly one book per title, the old one retired (or an explicit `--replace <bookId>`/title match) and `index` succeeds.
Fix: give ingest an explicit way to supersede (e.g. `--book <bookId>` or `--replaces`, or same-path/title match with confirmation) so the new file becomes a new version of the same `bookId`; make `index` skip or name versions whose original changed instead of failing the library; correct the doc.

**M2. The relevance gate (0.78 floor, 0.08 drop) is calibrated on fake hashed term-frequency vectors only, is a hard-coded constant, and the operator guide has no recalibration step.**
`search.ts:26` freezes the numbers. The code comment and `books-rag-evaluation.md:64-87` do say it is synthetic and that live calibration is pending, which is honest. But `docs/books-rag.md` (the operator guide) never mentions the threshold, and the operator cannot change it without editing source. Cosine scores of real `nomic-embed-text` for genuinely relevant passages are commonly well below 0.78, so a live install may answer `insufficient_evidence` to everything. That would look like a working system that "finds nothing", the exact failure the specs warn about. This is not a violation of the frozen-not-tuned rule (it was not tuned per question); it is a missing, user-visible pending step plus no safe path to act on it.
Reproduction: `grep -n "0.78\|threshold\|calibrat" docs/books-rag.md` returns nothing; `grep -n "relevanceGate" packages/books-rag/src/*.ts` shows no configuration path.
Fix: add a "Live recalibration (pending)" step to the operator guide (run a labeled held-out query set, record scores, then change the gate in code with a versioned `relevanceGate.version` and re-run `evaluate --synthetic`), and have `books_search` diagnostics carry `gate.version` so a live over-abstention is attributable. Optionally allow an operator override, versioned, that can only be set deliberately.

**M3. Schema-1 (and any non-allowlisted) hosted record fails with a misleading error and no reindex hint.**
`pinecone.ts:53-64` (`hostedMetadata`) runs on every `query`/`fetch` result before `expandPassageEvidence` (`pinecone.ts:163-164`, which has the "incompatible with this reader" message that the unit test exercises, `pinecone.test.ts:~442`). So a schema-1 record raises `configuration: Only allowlisted hosted passage metadata is permitted`. In `searchBooks` that error lands in the `pinecone` stage and is reported as `backend_unavailable: Pinecone unavailable or incompatible` (`search.ts:162-172`); one old record turns the whole query into `unavailable`, and `books_read` returns a generic configuration error. The operator guide (`books-rag.md:201-203`) describes "readers refuse them" and a re-ingest/re-index path that the product never tells the user.
Reproduction (reviewer, fake HTTP): `Pinecone.fetch` against a response with `metadata.schema = 1` throws `configuration Only allowlisted hosted passage metadata is permitted`. Test idea: a `searchBooks` test with a schema-1 match asserting a distinct diagnostic code (`stale_index`/`schema_incompatible`) whose message names `index` as the remedy, and that valid schema-2 candidates are still returned.
Fix: check `schema` first with an explicit `identity_mismatch` ("hosted record schema 1; re-run `index` on the writer"), and treat it per-candidate like other stale candidates.

### Minor

**m1. Passage-size dead end.** `pinecone.ts:146-150` tells the operator to "use a smaller chunk bound", but `cli.ts:62` hard-codes `productionTargetBound` and there is no option. The failure is explicit and truncation-free (good), yet a pathological page (very many tiny text items, heavy normalization runs) would make the whole book unindexable. Measured: 5,252 B dense, 9,940 B adversarial ad hoc, versus the 32,768 B budget; real books are unmeasured (the evaluation doc says so). Fix: expose a documented, versioned `--chunk-bound` that changes `ingestConfigurationHash`, or name the offending page in the error.

**m2. `pruneSuperseded` is library-only.** `indexing.ts:329` is exercised by `indexing.test.ts:287,315` but no CLI command calls it, while `books-rag.md:206-207` says superseded records are "pruned only through an explicit operation". Operators cannot invoke it, so superseded vectors accumulate in Pinecone and superseded figure objects in S3 (no caller of `Objects.delete`, `objects.ts:257`). Safety of the function itself is good: ids come only from the previous committed catalog minus the current one, batched at 50, always scoped to the configured namespace, no filter/deleteAll. Fix: add an explicit `prune` command (dry-run default) or reword the doc.

**m3. Doc inaccuracy on model rebuild.** `books-rag.md:204-205` says changing the model "changes version identity: re-ingest". `embeddingIdentity` is a code constant and is not in `versionId` (`store.ts:229`); it is in the catalog and `generation` (`indexing.ts:218`). A model change keeps passage ids and overwrites them in place under a new `generation`; old readers fail closed (digest/generation mismatch) in the window before the catalog commit, which is acceptable but not "mixed results avoided because versions differ". Reword; no code change needed.

**m4. Search latency scales with book count.** `search.ts:104-109` runs one Pinecone query per book sequentially with a 500 ms minimum interval (`pinecone.ts:295-302`, 20 books means about 10 s) plus up to four catalog/claim GETs per search. Within bounds, but slow for ~20 books; consider one namespace-wide query with `generation $in` once per-book generations are batched. Unmeasured live.

**m5. No final response-budget guard in `books_search`/`books_list`/`books_figure`.** Only `books_read` returns an error if citation metadata alone exceeds the budget (`mcp.ts:374-376`). Search shrinks excerpts, then hits, then coverage, then stops (`mcp.ts:298-309`); remaining fields (heading path, diagnostics up to one per stale candidate) are not re-checked. Not reachable with fixture shapes, and `responseBudget` can only lower the 16,000 cap (`mcp.ts:139-140`), but a defensive final check would make the "total <= 16,000" claim unconditional.

**m6. Env file permissions are not checked; `Objects.discover` is generic prefix-scoped GET.** The ledger shows the user's key file was mode 644; `doctor` does not warn about group/world-readable env files (`cli.ts:98-111`). Separately, `Objects.discover` (`objects.ts:134-141`) validates only the key regex and library prefix, not "catalog/writer/figure keys only", and accepts the object's self-attested `x-amz-meta-sha256`. It is internal (not reachable from any MCP argument; figure reads use manifest-pinned hashes via `get`), and anyone who can write the bucket can already forge the catalog, so this is an accepted trust boundary, but it should be documented as such. Fix: warn in `doctor` for mode &077 on the env file; add a note to the privacy section.

## Checks requested by the executor

| Item | Result |
|---|---|
| (a) `Objects.discover` scope | Not restricted to catalog keys; restricted to `S3_LIBRARY_PREFIX`, safe-character regex, no `.`/`..`, and requires a matching `x-amz-meta-sha256`, after the private-probe check. Callers: `catalog.json`, `writer.json`, figure keys. Not reachable from MCP input. See m6. |
| (b) Pinecone fetch | `GET /vectors/fetch?namespace=...&ids=...` with API version `2025-10`; no `includeValues` parameter is sent (it is a query option; `includeValues:false` is sent only on `/query`, `pinecone.ts:436`). Fetch responses do contain `values`; the code discards them (`pinecone.ts:487`), checks namespace, unrequested ids and id equality. Vectors are never exposed in tool output (confirmed in `mcp.ts`, `search.ts`). |
| (c) Changed original / stale versions | **Fails the spec: see M1.** Same-hash re-ingest and config-change re-ingest do reuse the `bookId` and are idempotent / new-version as specified. |
| (d) Schema-1 hint | **Confirmed: see M3.** |
| (e) Writer, resume, pruning | Local `wx` lock plus persistent `writer.json` claim, `guard()` before every upload and before commit, post-commit re-check; the claim is a detector, not a mutex, and the docs say so. Generation is deterministic (library, version, config, embedding identity), so resume is the same generation, confirmed ids are re-verified by Pinecone fetch plus record hash, never trusted from the receipt alone. Figures upload before vectors; the catalog commits last. Deletes use explicit ids inside the configured namespace only. No path deletes outside the namespace/prefix. Caveats: M1 (current-version selection), m2 (pruning unreachable), m3. |
| (f) Privacy | Pass. Hosted catalog strips `originalPath` and `validateCatalog` rejects it; the allowlist (`pinecone.ts:32-52`) blocks extra keys; `integration.test.ts:308-330` scans Pinecone, catalog and bucket for the temp path, file name, secrets and image-byte markers; the upsert refuses a payload containing the API key. S3 canary PUT is fixed non-sensitive bytes and precedes the unauthenticated-GET privacy proof; every other call verifies first (`objects.ts:176`). `sbp_` is rejected in `config.ts:80` and `objects.ts:103`. Provider bodies and fetch causes never escape `requestBytes`; unexpected errors print "details withheld"; doctor redacts known secrets. `.env` colon lines fail naming only the key (`config.ts:25-26`). Caveat: the privacy proof is one object, as documented; see m6. |
| (g) MCP budgets | Pass by code and test review: search limit <= 5 and excerpt <= 800 (shrinking), read default 4000 / max 8000 via the schema, list <= 20, total <= 16,000 via `budgetOf`; `responseBudget` is a server option (not a tool argument) and only lowers (`Math.min`); `additionalProperties:false`; ids are regex-pinned (`book_`/`passage_`/`figure_` + 32 hex), so `../../secret.png` is rejected (`mcp.test`/`integration.test.ts:608`); every response carries `untrustedReferenceData` and a notice. See m5. |
| (h) Gate | Constant, not per-question; documented as synthetic in code and evaluation doc; **not an operator step in the guide: M2.** |
| (i) Evaluation non-tautology | Pass with a caveat. `syntheticEmbedding` (`evaluate.ts:20`) hashes text only; labels and expected spans never enter it. Recall counts a hit only if the text really read through `readHostedPassage` contains the evidence and a returned span has the expected page and coordinates; figure checks use returned figure links, fetched asset hash and page+1. Caveat: the queries were written against the same vocabulary the hashed-term vectors reward and the gate was set on the same fixtures, so 1.0 recall shows pipeline wiring, not semantic quality; both the report and the guide say so. |
| (j) Chunk bound / record limit | 1800 units = UTF-8 bytes (or NFD-lowercase bytes if larger) + 32 versus the 2048 ceiling; embedding calls re-check and send `truncate:false`. A WordPiece token is at least one byte, so this over-counts tokens and is safe for the context limit; it yields roughly 400-450 tokens, the low end of the 400-800 target (documented). 32,768-byte record budget with a named, non-truncating failure (`pinecone.test.ts:217`); see m1 for the missing way out. |

## Review of required behaviors

- Committed scope and dependencies: only `packages/books-rag` and docs/README/`.gitignore`/root manifest; two runtime dependencies plus the existing `cmux-mcp`; exact pins; `--ignore-scripts` install documented. No `dev` hook or install script added.
- File-read safety: `safePath` rejects traversal, symlinks (every ancestor), non-absolute paths; `readLocalPdf` uses `O_NOFOLLOW`, regular-file check, size bound, change-during-read detection; store directory must be 0700 and outside every checkout.
- Partial indexing: figures before vectors, vectors fetch-verified, catalog last; readers see only a committed catalog with a matching claim run; an interrupted run leaves readers on the old commit and flags `incomplete_corpus`.
- Stale sources: hosted records are checked by content digest, generation and index configuration against the committed manifest, and a catalog change during a search drops the hits. Stale-original handling at ingestion is the gap in M1.
- Warning-free commands: confirmed above.
- No paid/external calls in tests: all HTTP in tests and the synthetic evaluation targets literal `127.0.0.1`; the Pinecone control-URL hook refuses any other host.

## Measured versus unmeasured quality

**Measured (synthetic, fake embeddings):** pipeline correctness: PDF to chunks to hosted records to search to verified read to next-page figure; recall@5 1.0 on 24 answerable queries at two chunk bounds; 10/10 unrelated abstentions; 0 citation and 0 figure failures; compact record sizes (5,252 B dense test, 9,940 B adversarial ad hoc); real-book page diagnostics for PDF pages 169-174.

**Not measured:** retrieval quality with the real `nomic-embed-text` model; real token counts of 1800-unit passages; a live threshold and false-abstention rate; real Pinecone visibility latency, quotas and pricing; real Supabase S3 behavior (SigV4 compatibility, the HTTP status of an unsigned GET on a private bucket, which this code requires to be 400/401/403); a full ingest of the real 694-page book (coverage gaps, record sizes, table and code fidelity, author-metadata conflict); client loading of the MCP server and image rendering in pihouse, Claude Code or Codex; agent citation discipline.

## Operator prerequisites (all pending, none attempted)

1. Install Ollama 0.40.11 and pull `nomic-embed-text:v1.5` (digest in `books-rag-research.md`); run `doctor`.
2. Create a Pinecone serverless dense index, 768, cosine; choose a dedicated namespace; verify pricing and allowances yourself.
3. Create a private Supabase (or S3-compatible) bucket and S3 access keys (never an `sbp_` token); verify privacy yourself.
4. Write a `KEY=value` env file outside the checkout, `chmod 600`, including `S3_BUCKET_PRIVATE_CONFIRMED=true` after verification. The user's existing `PINE_CONE_API:` line uses a colon and will be refused until fixed.
5. On the writer: `ingest --input <pdf-or-dir>`, then `index` (creates the canary once), then `doctor` on every machine.
6. Register the MCP entry manually per client; the registration commands in the guide were read from help text, not run.
7. Run a labeled live evaluation on held-out queries and recalibrate the gate (M2); only then rely on abstention.
8. Keep a private copy of originals before deleting them: hosted text/figures are derived copies.

## Final record

- **Worktree / branch:** `/Users/jeronimo.deli/Desktop/other/Vs/pi-house-books-rag`, branch `feature/books-rag`, reviewed at `607bcfd`; this review adds one local commit. No push, tag or PR.
- **Local commits reviewed (oldest first):** `8ecc8f8` .. `607bcfd` (`git log --oneline 825bb1f..HEAD`): specs, research/ADR, store, extraction, chunking/figures, embeddings, Pinecone, S3, catalog/indexing, evaluation, MCP, CLI, schema-2 fix, docs and offline integration test.
- **Selected skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning (as the plan fixes; no others).
- **Effective models (ledger):** T2-T8 `openai-codex/gpt-6.1-sol` (pihouse, quota limited); user-authorized switch to `claude-bridge/claude-sonnet-5-5` from T9 (T9, T9-fix, T10); this review `claude-bridge/claude-sonnet-5-5`.
- **Test results:** see Validation; 737/737, check clean, synthetic evaluation passed.
- **Next:** executor sends M1-M3 (and the cheap minors m3, m6 docs) to a builder, revalidates, then requests re-review. Optional operator checks stay labeled pending; they do not block, but nothing above should be reported as validated live.

## Re-review (HEAD `56baf3c`; fixes `2db21ad`, `dd90e50`, `56baf3c`)

**Status: PASS.** No critical or major finding remains. Reviewer validation: `npm run check` clean (254 files), `npm test` 745/745, `evaluate --synthetic` passed (recall@5 1.0, 10/10 abstentions, gate `synthetic-cosine-v1`), `git diff --check` clean, pinned-deps pass. No source or test file was modified by this review.

| Finding | Status | Evidence |
|---|---|---|
| M1 changed original is a separate book | **Resolved** | Ingest A, overwrite the file, `ingest --input P --book <A>`: 2 versions, 1 current (before: 2 current, old unreadable). Without `--book` the CLI still creates a new book but prints a note with the exact `--book` command for the same recorded path; supersede is explicit only (no title matching). `index` now skips a `source_changed` version by name (`indexing.ts:~235`) and publishes the rest; it fails if every version is skipped. Integration test `integration.test.ts:459` covers skip, unknown `--book`, supersede, repeat. Doc corrected. |
| M2 gate not recalibratable / undocumented | **Resolved** | `BOOKS_RELEVANCE_FLOOR`/`_MARGIN` validated as plain decimals (`config.ts`), any override reports `operator-cosine-v1`; every `books_search` result carries `gate.version/minimumScore/maximumDrop`; the guide has a "Live recalibration (pending operator step)" section. The default stays frozen. The live calibration itself is still **pending** and unmeasured. |
| M3 schema-1 misreported | **Resolved** | Reviewer's fake-Pinecone repro no longer throws: `fetch`/`query` return the record (`hostedMetadata` read mode checks schema first). Search drops that candidate with an `identity_mismatch` diagnostic naming `index` as the remedy, marks the corpus incomplete and keeps valid schema-2 hits (`integration.test.ts:437`); `books_read` reports the same message. Writes stay strict. |
| m1 chunk-bound dead end | **Resolved** | `ingest --chunk-bound` / `BOOKS_CHUNK_BOUND`, 100-1800, regex-validated; bound is part of version identity (`--chunk-bound 5000` exits 2, `400` succeeds). |
| m2 prune unreachable | **Resolved** | `prune` is dry-run by default; `--yes` deletes only IDs in saved previous catalogs minus the committed catalog, via explicit-ID deletes in the configured namespace; refuses while the catalog is missing or a publication is pending; saved catalogs are mode-0600, validated, same-library checked. Figure objects in S3 are not pruned (documented). |
| m3 model-rebuild doc | **Resolved** | Rewritten accurately (generation changes, version ID does not). |
| m5 final budget guard | **Resolved** | `withinBudget` wraps list, search and figure metadata; read already had one. Oversize returns `resource_limit` rather than a large response. |
| m6 env permissions / discover trust | **Resolved** | `doctor` warns when the env file is group/world readable (`cli.test.ts:269-273`); the guide documents the bucket trust boundary and `discover` scope. |
| m4 search latency | Open, accepted | Now documented as a known limit; unchanged (about 10 s at 20 books). |

**No new regression found** in privacy (no new hosted fields; prune and previous-catalog files are local only, 0600), budgets (guard added, none loosened; the gate override can only be set by the operator through the env file, not by a tool argument) or stale evidence (superseded and skipped versions are absent from the catalog, so readers cannot be served them).

**New minor observations (non-blocking):**
- `prune --yes` does not take the index lock or writer claim; it checks the catalog is complete first, so running it while another `index` starts is a small race under the single-writer assumption. Run it only when no `index` is active.
- Skipping a changed-original book removes it from the catalog (documented), and `prune` would then offer its hosted IDs; the dry run exists for that reason. Restore the original or supersede it before pruning if the book should stay.
- `prune` opens `CorpusStore` and so creates the local store directory if absent; harmless on the writer, avoid on reader machines.

Operator prerequisites and the "not measured" list above are unchanged: no live Ollama, Pinecone, Supabase or client run exists, and the live relevance threshold is still uncalibrated.
