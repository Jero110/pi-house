# Live publication and reader smoke — 2026-10-28

**Publication: PASS. Retrieval quality: ISSUES; calibration pending.** This live evidence supersedes the historical
“not run” hosted-service observations in [operator-guide.md](books-rag.md) and
[live-preflight.md](books-rag-live-preflight.md), not their safety limits or pending manual client checks.
Source checkout: standalone `main`, `06725b9`. Operator: `openai-codex/gpt-6.1-sol`.

## Authorized execution

The user authorized the 20-book corpus, namespace materialization and object writes to the existing Pinecone Starter
index/private Supabase Free bucket. Free eligibility and balances were supplied operator evidence, not refreshed billing
metering: Pinecone storage 0.0015/2 GB, RU 0/1M, WU 0/2M, egress 0/1 GB; Supabase Free and initially empty bucket.
No payments, provisioning, model pulls, original PDF uploads, re-ingestion, original/env changes or source edits occurred.
No GitHub push or client/default-configuration change was performed by this worker.

Commands used the existing private file, without printing or copying its values:

```sh
node packages/books-rag/src/cli.ts doctor --env-file /Users/jeronimo.deli/Desktop/other/Vs/pi-house/.env
node packages/books-rag/src/cli.ts index --env-file /Users/jeronimo.deli/Desktop/other/Vs/pi-house/.env
```

Doctor passed before publication. The first index stopped after bounded retries with
`index failed: Service unavailable after bounded attempts`, at 6,297 confirmed passages. The sanitized error did not
identify the provider/HTTP status; a WiFi move was suspected, not proven. No quota/billing error was reported.
After explicit authorization for **one** resume, read-only doctor passed again and the offline remaining plan fit every
preserved schema-2 counter. No index process, writer lock or capacity temporary file remained. The same CLI ran once
more, using the original receipts/counters, and exited 0. No counters, claims or receipts were manually reset/deleted.
An idle-sleep assertion was attached to the new index process (the earlier process had already exited).

Root commit: **`634b999b4a8df734a1314ca4b2e43a1b`**. All expected generation-specific IDs passed final LIST visibility
before root-last commit; post-commit manifest hydration passed. Final doctor reported **20 committed books**.
Totals: **38,464 passages, 2,245 figure records, 2,244 available images**. Recorded available image payload:
782,180,871 B. Originals remain untouched. Full text extraction is not claimed: existing gaps remain reported.

Embedding: local Ollama **0.40.11**, **nomic-embed-text:v1.5**, 768 dimensions, cosine index, context 2048,
`truncate:false`, digest `sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.
No cloud embeddings were used.

## Capacity evidence

All figures are bytes, not billing guarantees. The initial whole-run plan and cumulative durable accounting include the
failed run and single resume. Resume planned 32,167 pending inputs/vectors; Pinecone/S3 response plans remained
491,397,120/4,214,036,171 B against remaining 693,471,208/4,450,915,294 B. All limits stayed finite.

| Counter | Initial plan | Final cumulative accounted | Hard cap |
|---|---:|---:|---:|
| Physical attempts, all services | 48,858 | 39,144 | 100,000 |
| Logical vectors / local document inputs | 38,464 / 38,464 | 38,464 / 38,464 | 50,000 / 50,000 |
| All outbound bodies | 1,726,617,042 | 1,287,561,145 | 4,294,967,296 |
| All inbound bodies/reservations | 5,414,401,739 | 570,902,095 | 8,589,934,592 |
| S3 outbound bodies | 793,407,629 | 795,234,535 | 1,073,741,824 |
| Pinecone outbound bodies | 848,588,613 | 471,323,248 | 1,073,741,824 |
| Pinecone response estimate, including envelope | 491,397,120 | 45,738,224 | 700,000,000 |
| S3 response estimate, including envelope | 4,214,036,171 | 439,498,647 | 4,500,000,000 |

S3 uploads exceeded the fresh plan slightly due to the interrupted attempt/resume, still below the cap. These persisted
counters settle complete responses to body bytes and retain conservative reservations for ambiguous calls; provider
response counters add 8,192 B per attempt. They are **not measured TLS traffic, final storage totals, RU/WU or provider
billing meters**. Resumed image verification explains the extra S3 reads. Remaining publication response headroom:
Pinecone 654,261,776 B; S3 4,060,501,353 B. Receipts were preserved after success, not replenished.

The separately instrumented in-process read-only smoke measured S3 897 requests / 191,764,122 inbound body bytes
(199,112,346 B including envelope) and Pinecone 128 requests / 8,685,396 inbound body bytes (9,733,972 B including
envelope), plus 9 local Ollama requests / 83,056 inbound body bytes. These reader measurements are separate from writer
receipts. Doctor calls, the additional figure-reference verification and stdio-child list were outside this smoke meter;
no exact all-process/provider billing total is claimed. No cloud object writes occurred during reader checks.

## Empty-store reader and real queries

The reader used `/tmp/books-rag-live/empty-reader-store`, which remained empty. Paginated `books_list` returned all
20 books. The actual `node packages/books-rag/src/mcp.ts` child initialized and listed all 20 over stdio, exited 0 with zero stderr bytes.
Search/read/figure tool handlers also ran against the real hosted services with this empty-store configuration.
No local corpus or original was used by the reader.

The frozen gate stayed **`synthetic-cosine-v1`, floor 0.78, maximum drop 0.08**. No env/source gate override was made.
The table reports the highest hash-verified Pinecone candidate score, captured read-only before gating; rejected
candidates are **diagnostic only**, not fabricated accepted search hits. Each listed candidate was independently read
through `books_read`, with `status: ok` and nonempty literal text; no book prose is included here.

| Exact English query | Search status | Top dense score | Candidate passage ID | Physical PDF pages |
|---|---|---:|---|---|
| How does semantic chunking split documents for retrieval augmented generation? | `insufficient_evidence` | 0.768735766 | `passage_d9ed7b7ba18d60a5732eee1f7e8aad80` (diagnostic only) | 171–172 |
| How are embedding_vectors created and used for vector similarity search? | `ok` | 0.854195595 | `passage_add72aecba987bba9e0ec9df8c309a9e` | 568–569 |
| How should microservice boundaries be chosen around business capabilities? | `ok` | 0.807495177 | `passage_51d261996f3872817e962a7b304711e5` | 52–53 |
| What strategies support API versioning and backward compatibility? | `ok` | 0.801497817 | `passage_c9f309a4004df1b47cafe5fbc33bea09` | 54 |
| How does information hiding reduce software module complexity? | `ok` | 0.837939501 | `passage_e81e046ed35b39f3b27e495acb1b1d79` | 40–41 |
| How do lunar eclipses occur on the far side of Jupiter? | `insufficient_evidence` | 0.596448958 | `passage_afc2619ac6bfef82810102931f7966cf` (diagnostic only) | 159 |

Citation identity mapping (in table order):

| Query | Book ID | Version ID |
|---|---|---|
| Semantic chunking / unrelated diagnostic | `book_c1040240939db69dfd9893b3854486e9` | `version_0e02342e61a8db83efd1aa0790bc48d8` |
| embedding_vectors | `book_4e0ee4357589e87cab283d43730e8b81` | `version_59da1fb64bfce1650c7462f127f15972` |
| Microservice boundaries | `book_142f3b1bac2b9dcd85f24ed2004dfd48` | `version_52571c1ea4ca9933a34c9280c1855451` |
| API versioning | `book_b8719a5d94d532dce227c4f59a0541f3` | `version_b6d6416e8a33221e81544761915d8b9e` |
| Module complexity | `book_185b2e55c30ffc02cd8b09f33da0b097` | `version_78d40ae30870c168aeb70cc595d7692f` |

All six searches carried existing `extraction_failed` coverage diagnostics, not hosted-integrity failures. Four of five
in-domain queries produced accepted hits; semantic chunking abstained below 0.78. The unrelated query abstained, but
one negative and five positives do **not** validate a general relevance/abstention threshold. Calibration against labeled
real questions remains pending. No supported-answer judgment follows solely from a nearest-neighbor score.

### Next-page figure and explicitly unavailable figure

Hash-verified pre-gate candidates from the smoke queries located the correct explicit-reference
passage `passage_409fc36f26c3bf818c20772adbf06a88` in
`book_c1040240939db69dfd9893b3854486e9` / `version_0e02342e61a8db83efd1aa0790bc48d8`.
Its spans cover PDF 172–175; the **explicit Figure 3-7 reference is on PDF 173**, and the linked figure is on **PDF 174**.
Literal read and image delivery both returned `ok`; this is a diagnostic retrieval-path check, not an assertion that the
original semantic-chunking query passed its gate.

- Figure ID: `figure_967d251b613b344db9ff2dc993aabfe2`.
- Delivered image: **1224 × 1584**, actual decoded-byte hash matched the manifest:
  `sha256:64ab09732874ea87478080fefcd0307bc45cb2581dababe0953340d37346cf3f`.
- Unsupported figure: `figure_4e5d94987a9587df8b30cf03cc58e65a`,
  `book_d303ab392161947f5b543c153f14098f` / `version_522058af5b591001f8cb42af15a9ffc7`,
  **PDF 69**, correctly returned `unsupported`, reason `no_render_operators`, without an image.

## Validation and remaining scope

Post-publication validation **PASS**, warning-free: `npm run check` (Biome 47 files and TypeScript), `npm test`
(**139/139**), `node packages/books-rag/src/cli.ts evaluate --synthetic` (`passed: true`), and `git diff --check`.
Synthetic evaluation remains synthetic; its embedded “liveEvaluation: NOT RUN” describes that evaluator's scope, not
this separate operational smoke. Operational logs and compact non-prose measurements remain outside the checkout
under `/tmp/books-rag-live/`; private writer receipts remain in the original data directory.

Pending: labeled real-model gate calibration; actual pihouse/Claude Code/Codex registration, tool calls and image
rendering; current provider-console metering reconciliation. Same-machine empty-store checks prove no corpus dependency,
not a separate-machine installation. Successful publication does not erase extraction gaps or guarantee retrieval relevance.
