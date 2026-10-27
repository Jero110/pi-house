# Books RAG evaluation (T8)

## Scope and reproduction

Measured on Node 26.11.1, macOS arm64, using pinned `pdfjs-dist@6.4.299` and `@napi-rs/canvas@1.0.13`. This is **synthetic pipeline correctness**, not real embedding quality, bilingual semantic understanding, or validated live retrieval. No commercial-book content, real credentials, model downloads, cloud calls, or paid tokens enter automated tests.

```sh
node --test packages/books-rag/test/evaluation.test.ts
node -e 'import("./packages/books-rag/src/evaluate.ts").then(async m=>console.log(JSON.stringify(await m.evaluateSynthetic(),null,2)))'
npm run check
npm test
node packages/books-rag/dev/inspect-pdf.ts --input '/Users/jeronimo.deli/Desktop/books/generative-ai-design-patterns-solutions-to-common-challenges-when-building-genai-agents-and-applications-1.pdf' --pages 169-174
```

`evaluateSynthetic()` is reusable by T9's future `evaluate --synthetic` command; it accepts no environment/service configuration. It creates synthetic PDFs/private stores under the OS temporary directory, uses only literal `127.0.0.1` fake HTTP endpoints, and removes its files/connections in `finally`. `tsconfig.json` already includes `packages/*/dev/**/*.ts`; Biome also checks the new dev script. No global settings changed.

## Frozen synthetic protocol

- Corpus: 12 authored technical sections over 12 physical PDF pages, each with two repeated evidence rows; two synthetic vector diagrams have captions on the following page. Repetition deliberately exercises redundant results; the corpus is small and easy, not representative of books.
- PDF SHA-256: `d87bb8167970c95a005dd07c1ceae610249cff67ee3150af4d66e35a515d00f9`.
- Labels/questions: `packages/books-rag/test/evaluation-fixtures.ts`: 24 answerable cases (12 exact-identifier inputs, 12 English question forms paired with original Spanish questions), ten unrelated questions. Expectations specify literal evidence, physical page and top-left row coordinates (178 or 238 points), plus mandatory figure labels for the first four cases. The English reformulations preserve most source vocabulary; this does not measure translation or synonym understanding. No translation model runs.
- Embeddings: **fake** `sha256-term-frequency-768-v1`, a deterministic function of input text. Remove the task prefix, lowercase, tokenize ASCII words/identifiers, omit a fixed general stopword set, hash each remaining token into one of 768 positive term-frequency bins, L2-normalize. The fake server receives corpus/query text through ordinary protocol requests, but never reads evaluation labels, expected matches/spans or scripted expected scores. Cosine scores are calculated from submitted vectors, not scripted by query. Hash collisions and vocabulary overlap are limitations.
- Emulated adapter identity: Ollama 0.40.11, `nomic-embed-text:v1.5`, manifest `sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, 768 dimensions, 2048 context, `search_document: ` / `search_query: `, `truncate:false`. These are **fake protocol probe responses**, not an installed model or tokenizer measurement.
- Chunk budgets: 180 and 320 conservative bound units, identical PDF bytes and query set. Bound = maximum of UTF-8 bytes and NFD/lowercase UTF-8 bytes, plus 32, including all prefix/heading context. These are not measured model tokens or the original 400–800-token hypothesis.
- Frozen retrieval policy: dense only (lexical cache disabled), at most five hits, score floor **0.78**, maximum drop from strongest **0.08** (`synthetic-cosine-v1`). Neither threshold nor production search logic was changed or tuned per question.

Every run uses the real pipeline: synthetic PDF → `ingestPdf` → `publishIngest`/structural chunks and persisted figure rendering → `indexCorpus` through real LocalEmbeddings/Pinecone/Objects adapters into loopback fakes → `loadCatalog` → `searchBooks` → `readHostedPassage` → `fetchHostedFigure`. The original synthetic PDF is deleted after indexing. A second independent local store is created and asserted empty before querying; no local passage cache or preseeded vectors are supplied to search. Only the writer's normal ingestion/indexing requests populate the fake hosted services.

## Results

| Conservative target bound | Chunks | Recall@5 | False negatives | Unrelated false positives | Unrelated abstentions | Citation failures | Figure failures |
|---|---:|---:|---:|---:|---:|---:|---:|
| 180 | 25 | 1.00 (24/24) | 0 | 0 | 10/10 | 0 | 0 |
| 320 | 12 | 1.00 (24/24) | 0 | 0 | 10/10 | 0 | 0 |

Recall counts a query only when `status=ok` and a top-five read contains the full labeled literal evidence at an expected page/row location. All returned hits, not only the expected match, are checked against the ingestion store for full literal text, complete spans, version, PDF hash and excerpt. This yields 48 and 24 provenance checks respectively. Mandatory figure cases additionally require a link on the supporting hit itself, matching caption identity on page+1, and a manifest-verified fetched image hash. Deleted originals are explicitly reported as `recorded-ingestion-hash-only`, not freshly reverified.

| Target | Total returned read characters | Unnecessary characters | Redundant row characters |
|---|---:|---:|---:|
| 180 | 3560 | 1818 | 1742 |
| 320 | 3660 | 1918 | 1742 |

These totals cover 24 answerable queries, not unrelated queries (which returned no hits). Unnecessary characters = all returned full-read characters minus one required evidence string per successful query. Redundancy = character lengths of repeated identical newline-delimited rows within/across reads for each query (excluding newline separators). These are explicit mechanical proxies, not semantic judgments about prose usefulness. The smaller bound saves 100 returned characters but doubles returned hits/provenance work; repeated evidence still dominates both results.

Freeze **180** as the preference for this synthetic benchmark only. It is not an optimal book chunk size; production's default is unchanged. Neither this comparison nor T7's synthetic cosine calibration establishes a suitable live threshold/chunk configuration. No universal abstention, bilingual retrieval, agent citation discipline, real Pinecone visibility, or hosted-service compatibility is claimed.

## Production chunk bound and hosted record size (T9-fix)

Problem: the first hosted record (schema 1) stored one JSON object per character mapping and repeated full location objects, about 120 bytes per text character. Pinecone's 40 KB metadata cap then made any passage above roughly 330 characters unindexable; even a bound of 512 threw `resource_limit`, so the chunker default of 1800 could never be indexed.

Solution (schema 2, lossless): a per-record location table, run-length numeric mappings (`[kind, originalLength, normalizedLength, repeat]`), span starts derived from the previous end, structure slices without repeated block IDs, and a single text copy when original and normalized text are identical. `expandPassageEvidence` is the exact inverse; tests compare it with the local store's evidence. Schema 1 records are rejected as incompatible. The catalog pins the hash of the compact metadata. A record above **32768 bytes** fails indexing with `resource_limit` naming the passage; nothing is truncated.

**Production bound: 1800** conservative units (UTF-8 bytes + 32 of the prefixed input; the model limit is 2048, so 12% headroom, a conservative proxy for the plan's 400-800 token target, not measured tokens). This is the chunker default (`productionTargetBound`) and is what `ingest` uses and records in each version's identity. It is not the synthetic 180/320 preference.

Measured serialized metadata (vector excluded), bound 1800, synthetic layouts only:

| Layout | Largest record |
|---|---:|
| Dense two-page text: prose, table-like short items, Courier code block, figure references (passages of 20+ text items spanning two pages) | 5,252 bytes |
| Adversarial: 60 blocks of 2-character cells plus tiny 2-point lines per page | 9,940 bytes (same at bound 2048) |

Both are far below the 32 KB budget (and 40 KB cap). Real books with many ligature/normalization runs or very deep heading paths have not been measured; the explicit failure above protects against them. Real Nomic token counts of 1800-unit passages remain unmeasured.

Synthetic evaluation re-run after the change (`evaluate --synthetic`, bounds 180 and 320, unchanged protocol): passed, recall@5 1.0 for both, returned characters 3560 and 3660, 25 and 12 chunks.

## Available local PDF check

The executor authorized substituting the read-only Desktop/books file for the absent Downloads path. The script loads local bytes and installed PDF.js assets only. It uses direct PDF.js item/font/label diagnostics, not full production corpus ingestion or chunk/ranking evaluation. It scans text for a first table-caption candidate and inspects that page plus its neighbor. Only compact labels/headings/counts/locations are printed; no passages or table cells are saved. Renders stay in memory, never in the repository or the user's books folder.

Actual output summary:

- **694 physical PDF pages**, matching the specification; **13 top-level / 252 total outline entries**. Decoder diagnostics: **0**.
- PDF pages **169–174** text-item counts: **31, 20, 38, 24, 17, 10**. None is text-empty/scanned by this test.
- Code-like fonts detected on **169 and 170**, consistent with a cross-page code block. This does not verify identifier fidelity, code repair, or semantic continuity.
- Exact heading “Semantic chunking” detected on **171**; Figure **3-6** mentioned on 171 and caption detected on **172**. Consistent with the observed 171–172 section; semantic boundary accuracy is not certified.
- “Handling images and videos” heading detected on **173**. Figure **3-7** reference on **173**, caption on **174**: matches the next-page observation.
- Other compact caption diagnostics: Figure **3-4** on 169, Figure **3-5** on 170.
- First Table **2-1** caption candidate on **PDF 50**: 50 text items; adjacent **51**: 47 items. Simple same-baseline wide-cell-gap detector finds **0 candidate rows** on both. The table location is identified but relationships/units/cells are **not reconstructed or validated**; this is an extraction limitation, not table fidelity success.
- Full-page fallback renders of PDF **50, 172, 174**: **1224×1584** each; PNG sizes **377794, 406960, 332152 bytes** respectively; each base64 payload <=2 MiB. No crop was inferred. No render was persisted; visual legibility/diagram meaning was **not assessed**.

No observation above contradicts the cited figure/heading/page-count observations. Code-font detection and table-caption detection are weaker than visual or structural verification. The check does not validate full-book production ingestion, original author metadata conflicts, actual token counts, all coverage gaps, table fidelity, or real retrieval on this book. The script intentionally does not publish a corpus or contact Pinecone/S3/Ollama.

## Live evaluation: NOT RUN / pending

Exact missing prerequisites: Ollama is not installed; compatible already-installed pinned Nomic weights and installed tokenizer equivalence have not been verified; S3 credentials are not configured. No verified allowed existing Pinecone index/namespace, private S3-compatible bucket/region/canary, account pricing/entitlement, or remaining shared allowances are available for an authorized live benchmark. No probing with real credentials, provisioning, installation, weight download, original/text upload, or paid API call was attempted.

Before measuring real retrieval, the operator must provide those prerequisites within the approved budget/privacy boundaries, then run a separately labeled real local-model/hosted-service evaluation and calibrate a shared threshold on held-out representative queries. Missing prerequisites remain **unvalidated live retrieval**, not synthetic success.
