# Books RAG feasibility research (T1)

Date/access date for every external source below: **2026-10-27**. Scope: T1 only; no RAG package, production parser, index, model download, cloud corpus upload, or client registration was implemented.

## Result: BLOCKED on the complete extraction stack

PDF extraction and raster rendering are feasible on the current runtime. A **complete, verified PDF plus EPUB stack within the two-new-production-package bound is not established**. Do not start T2 based on the PDF trial alone. This is a bounded investigation result, not proof that no possible two-package solution exists.

Two candidate approaches were investigated:

1. `pdfjs-dist@6.4.299` plus `@napi-rs/canvas@1.0.13` passed a synthetic PDF text/vector-render trial with install scripts disabled. These consume both direct-package slots. PDF.js does not read EPUB. Node 26's built-in ZIP reader successfully enumerates an EPUB, **but emits an ExperimentalWarning**. Using it in ordinary checks/tests would violate the warning-free gate; do not suppress the warning globally. Node has no global `DOMParser` here. A custom ZIP reader plus XML/XHTML parser would need substantial malformed-input/security and preservation validation; testing inflate/CRC primitives is not verification of that parser. This approach has not passed the EPUB feasibility gate.
2. `mupdf@1.28.1` is a potential single-package WASM PDF/EPUB renderer, but its AGPL-3.0-or-later license is materially different from this repository's MIT packages. Its published declarations expose layout, structured text, link destinations including chapter/page, but did not establish preservation of EPUB archive-document/spine/anchor identity through reflow. It was inspected, not installed/executed or approved for adoption. Do not silently assume AGPL distribution obligations or substitute virtual reflow pagination for the approved EPUB locators.

A subsequent authorized research decision must either demonstrate a suitable two-package solution with the required locators and licensing, or approve a revised dependency bound. For example, a reviewed EPUB archive/XML library alongside the PDF pair needs another direct package. No such expansion is authorized here. No privacy or binding specification change was made.

## Local environment and dependency evidence

Observed: macOS **26.7.1**, Darwin arm64, Node **26.11.1**, npm **11.20.0**. This is the tested platform, not a claim of Windows/Linux or Node 24 compatibility.

| Component | Exact identity / license | Evidence and constraints |
|---|---|---|
| Node | 26.11.1; Node distribution license includes MIT and third-party notices | `node:sqlite` works without warnings; SQLite 3.54.0 and FTS5 creation passed. Node's ZIP API (added 26.8.0) is experimental and warns. `inflateRawSync`, `crc32` are usable primitives, not a safe EPUB parser. |
| PDF.js | `pdfjs-dist@6.4.299`, Apache-2.0 | npm engines `>=22.13.0 || >=24`; no package lifecycle scripts; optional canvas range `^1.0.10`. Use `legacy/build/pdf.mjs` on Node, not the modern build that warns. Direct exact pin on canvas resolves the optional range in the trial. |
| Canvas | `@napi-rs/canvas@1.0.13`, MIT, plus bundled/native third-party notices | Prebuilt `@napi-rs/canvas-darwin-arm64@1.0.13` was installed as an optional transitive binary. No install/postinstall needed. Two direct dependencies means three installed packages here; do not describe this as only two total artifacts. Optional dependencies must not be omitted. |
| Alternative, not selected | `mupdf@1.28.1`, AGPL-3.0-or-later | Registry tarball includes WASM/JS, declarations, LICENSE; no production dependencies declared. Published prepack builds are publisher operations, not a consumer requirement. No trial established Node 26 rendering or EPUB locator fidelity. |
| Additional EPUB candidate, not installed/selected | `epub2@3.0.2`, ISC | Declares adm-zip, xml2js, Bluebird and other ranged transitives. Not audited or tested; not an approved workaround for the cap. |

Canvas's README describes Apple M support, Linux ARM CPU restrictions and glibc >=2.18 requirements. Other platforms need their appropriate available prebuilt binary and a smoke test; do not trigger a source build/system install if a binary is missing. Missing fonts, CMaps and bundled standard-font/WASM assets may affect real PDFs. Resolve required PDF.js assets locally, never by fetching URLs from books. Retain dependency notices if distributed.

### Executed research trials

All temporary downloads/fixtures were under `/tmp/books-rag-t1`; no worktree package or lockfile changed. Only the two PDF packages were installed, using:

```sh
npm install --prefix /tmp/books-rag-t1 --ignore-scripts --save-exact pdfjs-dist@6.4.299 @napi-rs/canvas@1.0.13
node /tmp/books-rag-t1/pdf-spike.mjs
node /tmp/books-rag-t1/epub-primitives.mjs
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite";const db=new DatabaseSync(":memory:"); db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");console.log(JSON.stringify(db.prepare("select sqlite_version() as version").get()));db.close()'
```

Install output: `added 3 packages in 6s`. The PDF trial creates a valid one-page synthetic PDF with Helvetica text and a stroked vector rectangle, calls `getTextContent`, renders through canvas, encodes PNG and JPEG, and disposes the **loading task**. Its successful output:

```json
{"node":"v26.11.1","pages":1,"text":"Synthetic Figure 1","textTransform":[16,0,0,16,20,150],"width":600,"height":400,"pngBytes":7843,"jpegBytes":7959,"vectorRendered":true}
```

The initial PDF trial extracted/rendered successfully but failed cleanup with `TypeError: doc.destroy is not a function`. Source inspection showed this release requires `PDFDocumentLoadingTask.destroy()`; the corrected trial exited 0 without warnings. This API difference must survive into implementation; older examples are not sufficient evidence.

The EPUB primitive trial used a synthetic four-entry ZIP with stored mimetype and deflated XML/XHTML, checked lengths/CRC32 and fixture container/spine/anchor bytes. Output: `PASS: Node ZIP stored/deflate/CRC32 primitives; synthetic EPUB container, OPF spine and XHTML anchor bytes preserved; XML parser/security not validated`. This is **not** an extraction-stack pass. A separate `new ZipBuffer(...)` probe printed `entries=4` followed by `ExperimentalWarning: The zlib ZIP archive API is an experimental feature and might change at any time`. Expected-warning research output is disclosed, not a warning-free production solution. SQLite output: `{"version":"3.54.0"}`.

The temporary scripts are investigation artifacts, not committed implementation or stable public commands. The descriptions above state their limited scope; later extraction tests must recreate synthetic fixtures under the approved test paths.

## PDF behavior and figure constraints

Official PDF.js API/source exposes `getTextContent` (text items, transforms, dimensions), `getOutline`, `getDestination`, `getPageIndex`, `getPageLabels`, `getMetadata`, viewport transforms and `page.render`. Outline destinations must be validated against page text; font sizes/coordinates are layout evidence, not reliable semantic heading or table recognition. Preserve original text items and coordinate transforms; normalize into a separate representation. Code identifiers, reading order, ligatures, multi-column text and tables may be wrong. Flag uncertainty and retain a rendered source fallback; never guess repairs. Scanned pages have no guaranteed text, and OCR is excluded. Encrypted/unsupported/corrupt inputs must fail explicitly, not request passwords or bypass DRM automatically.

Render a verified crop only when bounds are known; otherwise explicitly label full-page fallback. Rendering supports vector diagrams, unlike bitmap extraction alone. The trial proves a vector render path, not recognition of its meaning, crop detection, real-book font fidelity or table fidelity. Use local byte input rather than URL input, no viewer/scripting layer or external resource resolution, finite page/pixel/time budgets and cancellation. Do not execute document actions or use an embedded script as program code.

Use PNG (`image/png`) initially, base64 in MCP image content; JPEG (`image/jpeg`) is a possible explicit fallback for large raster pages. Enforce longest side <=1600 and **base64 ASCII payload <=2 MiB** (a conservative interpretation of encoded-byte budget, so binary must be <=1,572,864 bytes), one image/call. Re-encode/downscale with a finite retry count; fail explicitly if still oversized. Mark reduced resolution and illegibility. MCP transport accepts arbitrary MIME strings, but manual client image support is not yet tested.

## EPUB requirements that remain unresolved

W3C EPUB OCF specifies ZIP packaging, `META-INF/container.xml`, a package document, a manifest and ordered spine; XHTML headings/IDs and document paths provide citations, not rendered page numbers. A conforming stack must resolve these identities without executing JavaScript, CSS imports, active SVG or remote links. Image decoding can use the already tested canvas for supported bounded raster formats; unsupported assets, particularly active/external SVG, must return an explicit unsupported-asset diagnostic.

An archive reader must validate central/local directory agreement, sizes, compression, CRC, duplicate/colliding names, traversal/absolute paths, symlinks, ZIP bombs, encryption and truncation before use. Bound input size, total expansion, per-entry expansion, entry count and parsing time. Avoid filesystem extraction entirely. An XML parser must be non-executing, namespace-aware and bounded, with external entities/DTD resolution disabled; preserve text, code whitespace, table relationships, anchors and spine ordering. Regex fixture checks do not meet these requirements. Reject unsupported DRM, malformed archives and unhandled markup explicitly. A new custom parser cannot be called reliable solely because Node can inflate one fixture.

## Local embedding candidate: identified, NOT live-validated

Recommended for a future resolved stack: **Ollama 0.40.11** (MIT runtime) with local **`nomic-embed-text:v1.5`**, F16 137M, Apache-2.0 model. Official release API reports v0.40.11 published 2026-10-24. Registry manifest retrieved as small JSON only:

- Manifest SHA-256: `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.
- Model-layer SHA-256: `970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6`; size **274,290,656 bytes**. **Weights were not downloaded.**
- Registry config: `nomic-bert`, 137M, F16. Full vector dimension **768**. No image input. Document prefix `search_document: `; query prefix `search_query: `, including all heading context in the input budget.
- The upstream Nomic card advertises 8192 context with specific scaling. **Ollama's published v1.5 tag advertises 2K**, so use **2048 as the hard ceiling**, not 8192. Verify installed `/api/show` context/embedding metadata before serving. `latest` and even v1.5 tags are mutable; require the full installed digest from `/api/tags`, not just the model name.
- Tokenizer family is BERT WordPiece (`bert-base-uncased` per model card). Exact installed tokenizer equivalence and counting remain pending. No chars/4 claim is justified. Until a verified tokenizer is available, a conservative bound can count the length after BERT-compatible normalization/splitting and reserve special/prefix tokens, but that bound must itself be tested against the pinned runtime. **This is an unresolved input-accounting prerequisite, not validated counting.** Starting chunk targets 400–800 actual tokens remain a hypothesis, not a measured result.
- Local HTTP `POST http://127.0.0.1:11434/api/embed`, JSON `model`, `input`, **`truncate:false`**, no reduced `dimensions`. Source normalizes embedding vectors; validate 768 finite values/nonzero norm and consistent configuration for documents/queries. Default truncation is true, so never rely on the default. Overflow must be an explicit error, not silent evidence loss.
- Only a literal loopback runtime endpoint is allowed; deny redirects/cloud model suffixes, never call pull/create endpoints. Read-only probes: `GET /api/version`, `GET /api/tags`, `POST /api/show` with `{"model":"nomic-embed-text:v1.5"}`. Future synthetic embed smoke payload: `{"model":"nomic-embed-text:v1.5","input":"search_query: synthetic compatibility probe","truncate":false}`. These were **not** sent.
- macOS requirement: Sonoma 14+; Apple M supports CPU/GPU, x86 CPU-only. Windows/Linux have separate operator prerequisites; not tested here. Model file size is not peak memory; loading/batch memory and throughput need an operator measurement. Initial batch 8, concurrency 1, 60s/request, at most two transient retries; no retry on identity/context mismatch.

`command -v ollama` returned no executable and no Ollama application was observed in `/Applications`. This does not prove no compatible service exists elsewhere. No runtime installation, service startup, weight discovery/download or model request occurred. Real embeddings/ranking/token counts are **pending**, never synthetic success.

## Pinecone: source-backed REST candidate, NOT an account check

Use a pre-existing **serverless dense, cosine, 768-dimensional BYO-vector index**, not an integrated-embedding/text/full-text resource. Native Node fetch suffices; no Pinecone SDK dependency. Pin the documented compatible REST version **2025-10**, explicitly not a claim this is the newest version. No request containing credentials or vectors was made.

1. Read-only `GET https://api.pinecone.io/indexes/{configured-name}` with `Api-Key` and `X-Pinecone-Api-Version: 2025-10` to verify ready status, dimension, metric, dense vector type, serverless cloud/region and returned host. Require the configured data host to match the returned host, HTTPS, no redirects; never derive it from index name alone. API key must belong to the intended project. Refuse incompatible/integrated configurations.
2. Use that exact data host for `POST /vectors/upsert`, `POST /query`, optional `POST /describe_index_stats`, and scoped explicit-ID `POST /vectors/delete`. Include the same API-version/header and a **nonempty dedicated namespace** in every data operation. No control-plane create/update/upgrade/delete calls; no namespace-wide delete. Ordinary vector upserts may materialize an absent namespace, so require an operator-confirmed existing namespace if no resource creation at all is allowed.
3. Hosted IDs/metadata contain opaque IDs and numeric schema/index-generation markers only. Exclude titles/authors/text/captions/images/paths/prompts/secrets. Keep book filters resolvable through opaque version IDs. `includeValues:false`, `includeMetadata:false` on query unless a specific allowlisted marker is actually required. Resolve every hit locally and reject stale/incompatible/missing versions. Pinecone metadata has type restrictions, no nulls or nested documents; omission is preferable to invented values.
4. Provider limits: upsert <=1000 records / 2 MB, record ID <=512 chars, dense dimension <=20,000, filterable metadata <=40 KB. Proposed stricter adapter bounds: 50 vectors/batch, serialized request <=1,000,000 bytes, concurrency 1, <=1 upsert/s; query topK <=20, <=2 queries/s, response <=1 MiB, request timeout 15s, at most two transient retries with capped backoff. Never retry billing/quota-exhaustion errors as short-term rate limits. Namespace/id allowlists and finite per-run vector/byte budgets are necessary. Deletes only explicit owned IDs, <=50/batch. Search publishes <=5 excerpts, not topK raw vectors.
5. Pinecone is eventually consistent. An acknowledged upsert is not immediate search visibility. Keep local indexing receipts and completed-generation state, perform bounded visibility checks, and report incomplete availability rather than mixing versions. Local lexical FTS may supplement candidates but cannot turn a backend outage into a successful fully hosted search.

### Pricing and free restrictions (public facts, not operator eligibility)

The pricing page and linked limit references currently list Starter: **$0**, AWS **us-east-1**, **5 indexes**, **100 namespaces/index**, **2 GB storage**, **2,000,000 write units/month**, **1,000,000 read units/month**, **1 GB/month egress**. Builder is a different plan; Standard advertises a **$50 monthly minimum** and usage-based billing. Do not use paid plans simply because initial usage looks small. Monthly quota exhaustion returns 429; the official suggestion to upgrade is explicitly forbidden here.

768 float32 values alone are 3072 bytes/vector; 20,000 vectors would have 61,440,000 raw vector bytes before IDs, metadata, indexing overhead and service accounting. This is **not a billing/storage guarantee**. Twenty books is not a verified vector count. Read units are not identical to request counts, and allowances are shared across organization activity. Local budgets cannot discover other users' usage or establish entitlement. Before any real indexing the operator must verify the actual organization plan, project/region/index/namespace, remaining shared allowances, service terms, egress rules and expected corpus size in the console/current docs. Save only non-secret confirmation/limits locally. Stop if unverified, payment is required or verified remaining allowances would be exceeded; never auto-provision or upgrade.

Vectors/minimal metadata leave the machine for AWS us-east-1 in this Starter candidate. They are not anonymous. Original files, text and figures remain local, but requested evidence/images may reach the client agent's provider. Corpus rights/privacy are the operator's responsibility; package/model licenses do not grant permission to redistribute books.

## Repository reuse and remaining gates

`packages/cmux-mcp/package.json` exports `.` -> `src/index.ts`; that index publicly re-exports `server.ts`. Reuse `serveMcp`, `Tool`, `ToolResult`, `Content` through **`cmux-mcp`**, not the unexported `cmux-mcp/src/server.ts` subpath. It supports newline JSON-RPC initialize/list/call/ping and text or base64 image content, with injected streams suitable for offline tests. It echoes requested protocol versions; it does not validate arbitrary argument schemas, enforce output/image budgets, serialize tool concurrency or guarantee all clients support images. Books must enforce its own schemas/bounds; T9/T10 need transport/client checks, not universal compatibility claims.

`packages/pihouse/src/workflow/storage.ts` imports `DatabaseSync` at top level, sets private directory modes, foreign keys/busy timeout, uses `BEGIN IMMEDIATE`/rollback and probes FTS5 with a disposable virtual table. Reuse these conventions, **not its operational tables or store opener**. FTS is derived; source/version truth stays separate. On Node 26.11.1 no SQLite warning was observed. Node docs call SQLite release-candidate since 25.7; do not promise the same warning behavior on Node 24. Do not globally suppress warnings. A books-only runtime minimum can be raised without changing ordinary pihouse startup, but requires implementation tests.

Pending core gate: extraction/rendering stack with reliable EPUB identities within authorized dependencies. Also unresolved: exact tokenizer/input accounting. Pending optional operator/live gates: installed runtime and model identity/limits, real embedding ranking/thresholds, Pinecone eligibility/remaining allowances/visibility, real supplied-PDF extraction, client image behavior. No provided commercial book was read or uploaded during T1. Existing specification observations are historical evidence, not new T1 measurements. No T2–T11 acceptance is satisfied by these trials.

## Official sources

All accessed 2026-10-27; package registry queries and tarballs are publisher artifacts. URLs without a pinned release are mutable and must be rechecked before live use.

- Node: https://nodejs.org/api/zlib.html (ZIP API stability, CRC/inflate/limits); https://nodejs.org/docs/latest-v26.x/api/sqlite.html; https://github.com/nodejs/node/blob/v26.11.1/LICENSE.
- PDF.js: https://registry.npmjs.org/pdfjs-dist/6.4.299; https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/src/display/api.js; https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/src/display/node_utils.js.
- Canvas: https://registry.npmjs.org/@napi-rs%2fcanvas/1.0.13; https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/README.md; published package's `package.json`/LICENSE and native optional binary.
- EPUB/XML/ZIP: https://www.w3.org/TR/epub-33/; https://www.w3.org/TR/xml/; https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT.
- Alternatives: https://registry.npmjs.org/mupdf/1.28.1; https://registry.npmjs.org/mupdf/-/mupdf-1.28.1.tgz (LICENSE and `dist/mupdf.d.ts` inspected); https://registry.npmjs.org/epub2/3.0.2.
- Ollama: https://api.github.com/repos/ollama/ollama/releases/latest; https://raw.githubusercontent.com/ollama/ollama/v0.40.11/LICENSE; https://raw.githubusercontent.com/ollama/ollama/v0.40.11/server/routes.go; https://docs.ollama.com/api/embed; https://docs.ollama.com/macos.md.
- Model: https://ollama.com/library/nomic-embed-text/tags; https://registry.ollama.ai/v2/library/nomic-embed-text/manifests/v1.5; https://registry.ollama.ai/v2/library/nomic-embed-text/blobs/sha256:31df23ea7daa448f9ccdbbcecce6c14689c8552222b80defd3830707c0139d4f; https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md.
- Pinecone: https://www.pinecone.io/pricing/; https://docs.pinecone.io/reference/api/database-limits.md and linked https://docs.pinecone.io/reference/api/database-limits/rate-limits.md, https://docs.pinecone.io/reference/api/database-limits/object-limits.md, https://docs.pinecone.io/reference/api/database-limits/operation-limits.md, https://docs.pinecone.io/reference/api/database-limits/identifier-limits.md; https://docs.pinecone.io/reference/api/known-limitations.md.
- Pinecone REST: https://docs.pinecone.io/reference/api/2025-10/control-plane/describe_index; https://docs.pinecone.io/reference/api/2025-10/data-plane/upsert.md; https://docs.pinecone.io/reference/api/2025-10/data-plane/query.md.
