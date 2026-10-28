# Hosted publication preflight

## Current status — final followups

**OFFLINE VALIDATED; NO HOSTED PUBLICATION PERFORMED.** Starting point: standalone `main` at `352e99c`.
Only the expressly authorized failed twentieth PDF was locally re-ingested. No other book was re-ingested;
no real hosted API, upload, embedding, model pull, resource creation, delete or paid operation was performed.
PDFs and the existing private env file were preserved. Numeric footprint evidence only is tracked here.

### Operator evidence (supplied, not re-queried)

- Pinecone **Starter, no card**. Operator console snapshot: **0.0015 GB / 2 GB storage; RU 0 / 1M;
  WU 0 / 2M; egress 0 / 1 GB**. These are the operator's snapshot, not newly fetched balances or a reset guarantee.
- Supabase **Free confirmed** (also consistent with the historical read-only organization response).
- Materializing namespace **`books` is expressly authorized**. Do not ask for these facts again.
- Historical read-only checks found ready serverless AWS us-east-1 dense/cosine/768 with exact configured host,
  zero vectors/namespaces, and an empty configured private Supabase bucket. These are historical observations,
  not refreshed usage balances. Private canary verification still occurs at publication; no API can certify billing.

## Twentieth book and current local footprint

`building-applications-with-ai-agents-designing-and-implementing-multiagent-systems-1_compress.pdf`:
**successfully ingested**, 355 physical PDF pages, 1,513 passages, 36 figures: **35 available images** and
**one recorded unsupported image on PDF page 69**, reason `no_render_operators`. Text coverage remains honestly
incomplete with seven gap pages. Unsupported is image availability, not an assertion of complete text coverage.

Current totals: **20 books, 38,464 passages, 2,245 figure records, 2,244 available images**.
Available image payload: **782,180,871 B**; largest image **869,859 B**. No passages, PDFs or images are tracked.
Local sizing uses production record/catalog serialization, streaming one stored book at a time; adapters are
constructed but no network methods are called. Original-file mutation checks remain enabled.

| Whole-run planning item | Bytes / count |
|---|---:|
| Logical vectors / local embedding inputs | 38,464 / 38,464 |
| S3 uploads including bounded catalog/canary allowance | 793,407,629 B |
| Pinecone writes, conservative finite-number JSON estimate | 848,588,613 B |
| All outbound including local model input allowance | 1,726,617,042 B |
| Planned Pinecone egress (retry-safe bounded model below) | **491,397,120 B** |
| Planned S3 egress (includes full resumed image allowance) | **4,214,036,171 B** |
| Planned total inbound including local model output | 5,414,401,739 B |
| Planning request estimate (not all possible transport retries) | 48,858 |

These estimates fit current internal defaults. S3 storage payload remains below decimal 1 GB; Pinecone storage
and WU accounting are provider-specific. Larger internal limits do not authorize payment or override quotas.
The S3 egress model is deliberately much larger than fresh-publication traffic: it includes all images downloaded
on resume, triple response traffic, conservative root guards and a 100k-request envelope allowance. A fresh
publication does not download its newly uploaded images. Subsequent reader traffic is outside this publication plan.

## Official LIST investigation and assurance

Read public documentation and official OpenAPI only (no live Pinecone calls):

- <https://docs.pinecone.io/reference/api/2025-10/data-plane/list>
- <https://raw.githubusercontent.com/pinecone-io/pinecone-api/refs/heads/main/2025-10/db_data_2025-10.oas.yaml>

REST **2025-10**, serverless **GET `/vectors/list`**, explicit `namespace`, `limit=100`, request
`paginationToken`, response `vectors:[{id}]` and `pagination.next`. The prose mentions pagination_token;
the wire spelling comes from the official operation/schema. No `includeValues` parameter is supported or sent.
The adapter verifies configured serverless identity, bounds namespace/pagination/ID shapes, and rejects duplicates,
repeated tokens, foreign namespaces, oversized responses and exhausted page budgets.

The old 815 MB–2.44 GB full-vector verification estimate is **superseded**. Indexing no longer fetches values or
full metadata for visibility. It takes one bounded namespace snapshot for resume and at most three final snapshots
for eventual visibility, not one fetch per eight records. Each snapshot has at most **1,000 pages / 100,000 IDs**;
the adapter has **4,000 logical LIST pages/run**, at most three transport attempts per page, and **256 control
probes/run**. List/describe responses are capped at 16,384 B; upsert acknowledgements/error bodies at 4,096 B.
All response shapes remain strict; large unexpected responses stop rather than silently raising budgets.

Hosted passage IDs now derive from the immutable local passage ID **and generation**, with neighbor links transformed
identically. Different generations never overwrite each other's IDs. A local receipt is bound to the exact immutable
source/configuration/model/generation and expected metadata hashes. Resume may reuse only IDs from completed
upserts in that receipt AND present in the configured namespace snapshot. Unrelated or stale-generation IDs do not
prove anything. An acknowledgement is not visibility: **every expected ID must be present in a final snapshot before
root-last commit**, with writer/base guards retained. LIST proves visibility of completed upserts, not content truth.
**Every eventual search/read still checks full metadata hashes against the pinned manifest**, source/generation/config
identity and root/shard pins. No model, dimension, vector precision or relevance gate was changed.

Preflight Pinecone bound = `4000*3*(16384+8192) + batches*3*(4096+8192) + 256*3*(16384+8192)`.
This includes all permitted LIST pages, upsert acknowledgements/error bodies, all three physical attempts and bounded
control probes. There are no publication queries; any unexpected queries using the attached adapter consume the
same runtime budget. The current corpus has 4,818 per-book batches. **Planned Pinecone egress must be <=600,000,000 B**
before any hosted write. Fresh plan **491,397,120 B** is below that bound, leaving >500 MB of the operator's reported
nominal 1 GB egress outside the plan. It is not an assertion that unlimited future reader queries fit Starter.

## Durable runtime ceilings and recovery

`index-capacity.json` schema 2 persists all-provider physical attempts and body bytes plus independent provider egress:

| Counter / environment override | Default / maximum |
|---|---:|
| `BOOKS_PUBLICATION_PINECONE_RESPONSE_BYTES` | **700,000,000 B** |
| `BOOKS_PUBLICATION_S3_RESPONSE_BYTES` | **4,500,000,000 B** |
| `BOOKS_PUBLICATION_RESPONSE_BYTES` | 8,589,934,592 B combined body bytes |
| `BOOKS_PUBLICATION_REQUESTS` | 100,000 physical attempts, all services |
| `BOOKS_PUBLICATION_PINECONE_BYTES` | 1,073,741,824 B outbound Pinecone bodies |
| `BOOKS_PUBLICATION_UPLOAD_BYTES` | 1,073,741,824 B outbound S3 bodies |
| `BOOKS_PUBLICATION_WRITE_BYTES` | 4,294,967,296 B all outbound bodies |
| Vectors / local inputs | 50,000 / 50,000 |

Before each physical request (including retry/control/probe), accounting reserves the maximum bounded response and
**8,192 B conservative HTTP/TLS headroom per provider attempt**; complete responses settle to actual body size plus
that envelope. Interrupted/ambiguous calls retain the full reservation. Counters never reset on restart or success.
The envelope is conservative quota-planning headroom, **not measured TLS or provider billing**; arbitrary remote
protocol overhead and traffic outside this process cannot be certified by application body accounting. Unexpected
oversized responses are recorded and stop; no blind retry or automatic replenishment. Stop on quota/billing errors.

Schema-1 receipts cannot establish historical per-provider egress and fail closed: reconcile provider usage and archive
receipts deliberately with no active writer before a new accounting window. Do not infer renewed allowances from a
local reset. Source receipts record completed upserts, not a waiver of final visibility verification. The existing
single-writer lock, foreign-library/claim checks, source hash checks, strict pins and all per-item limits remain.
Missing images explicitly recorded as unsupported are valid complete stored evidence, not corrupt partial publication.

## Validation

Required gate: `npm run check && npm test && node packages/books-rag/src/cli.ts evaluate --synthetic`.
**PASS, warning-free:** Biome 47 files, TypeScript clean, 139/139 tests, synthetic evaluation `passed: true`.
Synthetic tests include mixed available/unrenderable images and hosted/MCP roundtrip; LIST namespace, pagination,
malformed/different IDs, repeated tokens and retries; generation-disjoint IDs; eventual visibility; root withheld on
missing IDs; hash validation on retrieval; pre-write capacity refusal; and provider accounting retained across restart.
No real hosted publication or live compatibility claim follows from these tests. Real relevance calibration and manual
client rendering remain separate pending operator checks; the default synthetic relevance gate was not changed.
