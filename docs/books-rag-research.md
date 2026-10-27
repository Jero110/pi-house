# Books RAG feasibility research (T1)

Date/access date for every external source below: **2026-10-27**. Scope: T1 only; no RAG package, production parser, index, model download, cloud corpus upload, or client registration was implemented.

## Current result: PASS for user-authorized PDF-only T1 research

On 2026-10-27 the user explicitly permitted a PDF-only first version ("si queires slo para pdfs"). **EPUB ingestion, locators and assets are deferred**, not validated or silently supported. This supersedes the historical EPUB blocker only; privacy, provenance, bounded extraction/rendering, retrieval and all evaluation gates remain unchanged. Capability map, all four specifications and plan reflect that authorization. Stop before T2 for executor verification.

Select **`pdfjs-dist@6.4.299` + `@napi-rs/canvas@1.0.13`**, verified script-free on **Node 26.11.1 / macOS arm64**. Use the legacy PDF.js build, local assets and loading-task cleanup. Require Node >=26.11.1 for the books package only; other platforms require prebuilt-binary smoke checks, not source builds. Conservative full-prefixed-input UTF-8/normalization budgeting with a 32-token allowance and `truncate:false` is source-backed below. Real model/Pinecone/operator prerequisites remain pending, not synthetic success. No worktree dependencies or T2 implementation were added.

## Historical initial format investigation (EPUB now deferred)

The initial PDF+EPUB scope did not establish a complete bounded EPUB adapter. Two packages were a preference, not a binding cap; a third was investigated in the corrected retry. No bespoke complex archive/XML parser or AGPL package was adopted. The history below explains the earlier stops; it is not a current PDF-only blocker or authorization for more EPUB research.

Two candidate approaches were investigated:

1. `pdfjs-dist@6.4.299` plus `@napi-rs/canvas@1.0.13` passed a synthetic PDF text/vector-render trial with install scripts disabled. These account for the preferred two direct packages, not a binding maximum. PDF.js does not read EPUB. Node 26's built-in ZIP reader successfully enumerates an EPUB, **but emits an ExperimentalWarning**. Using it in ordinary checks/tests would violate the warning-free gate; do not suppress the warning globally. Node has no global `DOMParser` here. A custom ZIP reader plus XML/XHTML parser would need substantial malformed-input/security and preservation validation; testing inflate/CRC primitives is not verification of that parser. This PDF-only approach has not passed the EPUB feasibility gate; a third package is permitted for the corrected retry.
2. `mupdf@1.28.1` is a potential single-package WASM PDF/EPUB renderer, but its AGPL-3.0-or-later license is materially different from this repository's MIT packages. Its published declarations expose layout, structured text, link destinations including chapter/page, but did not establish preservation of EPUB archive-document/spine/anchor identity through reflow. It was inspected, not installed/executed or approved for adoption. Do not silently assume AGPL distribution obligations or substitute virtual reflow pagination for the approved EPUB locators.

The initial stop treated the two-package preference too strictly. The corrected retry below investigates a third direct package and existing dependencies instead of proposing a bespoke parser for package-count optics. A suitable modest npm-only expansion would be a technical-assumption change, not automatically a materially broader toolchain or privacy change. No privacy or binding specification change was made.

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

## Deferred EPUB requirements (historical research; not this version)

W3C EPUB OCF specifies ZIP packaging, `META-INF/container.xml`, a package document, a manifest and ordered spine; XHTML headings/IDs and document paths provide citations, not rendered page numbers. A conforming stack must resolve these identities without executing JavaScript, CSS imports, active SVG or remote links. Image decoding can use the already tested canvas for supported bounded raster formats; unsupported assets, particularly active/external SVG, must return an explicit unsupported-asset diagnostic.

An archive reader must validate central/local directory agreement, sizes, compression, CRC, duplicate/colliding names, traversal/absolute paths, symlinks, ZIP bombs, encryption and truncation before use. Bound input size, total expansion, per-entry expansion, entry count and parsing time. Avoid filesystem extraction entirely. An XML parser must be non-executing, namespace-aware and bounded, with external entities/DTD resolution disabled; preserve text, code whitespace, table relationships, anchors and spine ordering. Regex fixture checks do not meet these requirements. Reject unsupported DRM, malformed archives and unhandled markup explicitly. A new custom parser cannot be called reliable solely because Node can inflate one fixture.

## Local embedding candidate: identified, NOT live-validated

Recommended for a future resolved stack: **Ollama 0.40.11** (MIT runtime) with local **`nomic-embed-text:v1.5`**, F16 137M, Apache-2.0 model. Official release API reports v0.40.11 published 2026-10-24. Registry manifest retrieved as small JSON only:

- Manifest SHA-256: `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.
- Model-layer SHA-256: `970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6`; size **274,290,656 bytes**. **Weights were not downloaded.**
- Registry config: `nomic-bert`, 137M, F16. Full vector dimension **768**. No image input. Document prefix `search_document: `; query prefix `search_query: `, including all heading context in the input budget.
- The upstream Nomic card advertises 8192 context with specific scaling. **Ollama's published v1.5 tag advertises 2K**, so use **2048 as the hard ceiling**, not 8192. Verify installed `/api/show` context/embedding metadata before serving. `latest` and even v1.5 tags are mutable; require the full installed digest from `/api/tags`, not just the model name.
- Tokenizer family is BERT WordPiece (`bert-base-uncased` per model card). The corrected retry establishes a conservative UTF-8 input budget from official tokenizer metadata/source; see the proof below. Exact installed GGUF tokenizer equivalence remains an **optional live prerequisite**, not a reason by itself to block implementation. No chars/4 claim or live token-count validation is made. Starting chunk targets remain hypotheses; conservative-bound units are not actual measured tokens.
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

Current T1 PDF-only feasibility gate passes on the measured platform; all implementation accuracy/security gates remain for later tasks. EPUB archive/XML identities are deferred by user authorization, no longer a core gate. Conservative source-backed input budgeting is documented below; live tokenizer equivalence remains optional. Pending optional operator/live gates: installed runtime and model identity/limits, real embedding ranking/thresholds, Pinecone eligibility/remaining allowances/visibility, real supplied-PDF extraction, client image behavior. No provided commercial book was read or uploaded during T1. Existing specification observations are historical evidence, not new T1 measurements. No T2–T11 acceptance is satisfied by these trials.

## Corrected T1 research retry 1/1 (before PDF-only authorization)

### Existing dependencies and third-package candidates

`package-lock.json` contains no existing ZIP library or general DOM/SAX parser. It does contain **`@aws-sdk/xml-builder@3.972.41`** (Apache-2.0), whose public `parseXML` export was overlooked initially. Its installed source was inspected: it collects text separately from grouped child tags (losing mixed-content order), merges attributes into element objects, drops newline-only text, and uses `String.fromCharCode` for numeric entities (not correct for non-BMP scalars). It does not fetch external entities, but it is not a source-faithful XHTML tree. Reusing it to avoid a dependency would compromise code/text provenance. Do not import an undeclared transitive parser into books or write a replacement XML parser around these deficiencies.

The following third-direct-package candidates were examined, without production adoption:

| Candidate | Official publisher artifact / license | Feasibility finding |
|---|---|---|
| `epub@2.1.1` | npm registry and published `epub.ts`; MIT; Node >=22.6 | Pure JS; depends on JSZip and fast-xml-parser. Trial installation with `--ignore-scripts` succeeded on Node 26.11.1; temporary audit reported zero known vulnerabilities. Public `rootFile`, manifest/spine and `getChapterRaw` preserve document identity and raw XHTML. However, `parse()` internally inflates mimetype/container/OPF with `file.async('nodebuffer')` before exposing archive state, has no output-byte/depth/DTD policy options, and its XML parser is not exported. Its convenience metadata retains only the first creator. Do not use default metadata as complete provenance, HTML rewriting as evidence extraction, or this high-level API as a bounded ZIP/XML boundary. |
| `@smoores/epub@0.1.9` | npm tarball `index.js`/`index.d.ts`; MIT | Pure JS; public ordered XML/XHTML parsers and spine/manifest APIs are promising. `Epub.from` uses zip.js, but archive entries/read functions are private and subsequent reads call `entry.getData()` into a byte array without a caller byte-budget writer. A bounded adapter would need undocumented private access/monkeypatching or separately declared archive/XML dependencies. Not adopted for package-count optics. |
| `@daisy/epub-utils@1.4.6` | npm tarball `lib/epub.js`/`lib/epub-parse.js`; MIT | Uses node-stream-zip and xmldom, but its high-level path extracts to a temporary filesystem tree then parses documents, rather than providing the desired bounded read-only in-memory interface. Do not use its default extraction path on untrusted books. |
| `epub2@3.0.2` | previously inspected npm artifact; ISC | Uses adm-zip/xml2js; convenience package APIs do not establish the required configurable, order-preserving bounded XML/XHTML extraction boundary. Not installed. |

Only `epub@2.1.1` was installed as the retry's third direct candidate, in the existing temporary prefix:

```sh
npm install --prefix /tmp/books-rag-t1 --ignore-scripts --save-exact epub@2.1.1
```

Real output: `added 22 packages, changed 3 packages, and audited 40 packages in 2s` / `found 0 vulnerabilities`. Resolved key transitives: JSZip **3.10.2**, fast-xml-parser **5.11.2**, pako **1.0.11**. This is a research dependency tree, not a committed lockfile or proof of absence of vulnerabilities. No worktree dependency files changed.

A synthetic EPUB3 trial returned root `OPS/package.opf`, ordered spine item `ch1` -> `OPS/chapter.xhtml`, retained heading anchor `intro`, mixed inline text order and two-line indented code in `getChapterRaw`. Metadata returned creator `First` despite two creators in the OPF. This establishes access to source identities/raw bytes, **not** bounded decoding, parsed XHTML fidelity or a complete secure extraction stack. No large decompression bomb was executed merely to demonstrate that the API has no output cap.

A clean public-API alternative is `@zip.js/zip.js@2.24.0` (BSD-3-Clause) plus `fast-xml-parser@5.11.2` (MIT), alongside the verified PDF pair: **four direct dependencies**, no system toolchain. Source/declarations show zip.js strict archive/name policies, local/central checks, CRC/overlap checks, abort signals and writable streaming output; fast-xml-parser exposes ordered parsing, whitespace/type-preservation options and `maxNestedTags`. This alternative is not automatically materially broader merely because it has four packages. It was source-investigated, not installed or adopted in this retry: the explicit correction authorized a modest third direct dependency, and clarification about four was sent to the executor rather than silently assumed. If authorized separately, trial strict archive validation and byte-counting writable streams (do not trust header sizes alone), reject DOCTYPE/ENTITY before parsing, cap XML bytes/depth, preserve order/text/attributes, reject unsupported assets/remote references and run malicious-input fixtures. Do not replace the measured PDF stack with a less-tested renderer solely to reduce package count.

### Conservative WordPiece input accounting (not a live-model test)

Retrieved the official Nomic tokenizer **metadata/vocabulary only**, no model weights: repository revision `e9b6763023c676ca8431644204f50c2b100d9aab`, tokenizer JSON SHA-256 `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66`. It declares BERT normalization (clean text, separate CJK, strip accents by default when lowercasing), BERT punctuation/whitespace pretokenization, WordPiece with a 100-character word ceiling and `[UNK]`, and single-sequence `[CLS]`/`[SEP]` processing.

Use a conservative budget over the **entire prefixed input including heading context**, for example:

```text
B(s) = max(UTF8_BYTES(s), UTF8_BYTES(LOWERCASE(NFD(s)))) + 32
accept only B(s) <= 2048; send truncate:false
```

Proof for the inspected tokenizer family: cleaning/deleting controls cannot add content tokens; CJK separation adds only whitespace; canonical decomposition/stripping accents and lowercasing are covered conservatively by the second byte count (retain marks in the bound, although the tokenizer strips them). Whitespace/punctuation splitting preserves or removes content scalars. Every successful WordPiece step consumes at least one scalar of a nonempty word; `##` is a vocabulary lookup prefix, not extra input tokens. Unknown or overlong words yield one `[UNK]`, not more tokens than their scalar count. Unicode scalars are bounded by UTF-8 byte length. Existing added special tokens each consume a nonempty spelling; the postprocessor adds two tokens; **32** reserves more than those two and includes no hidden heading/prefix exemption. Reject unpaired UTF-16 surrogates. The bound intentionally overcounts and is not a chars/4 estimate or an exact tokenizer implementation. Use source-bound units honestly when comparing chunk budgets; do not report them as actual measured model tokens.

`node /tmp/books-rag-t1/token-bound.mjs` inspected metadata and exhaustively enumerated all **1,112,064 Unicode scalar values** using Node 26.11.1 / Unicode 17.0. For NFD -> strip Mn -> default lowercase, **zero** scalars produced a content-scalar count exceeding their original UTF-8 bytes; four prefixed technical/multilingual/special/long-word examples also met that bound. The implemented Node formula above is even more conservative because it takes the larger decomposed/lowercase byte count and does not strip marks. Source review supplies the WordPiece consuming-token argument; this exhaustive normalization check is supporting evidence, not an installed-runtime equivalence test or a proof about arbitrary future normalization rules.

Installed GGUF tokenizer equivalence/Unicode tables remain an **optional live compatibility check**, not a core feasibility blocker. `truncate:false` is the runtime fail-closed gate if the installed runtime counts differently or has a smaller context. Never retry overflow by truncating, never accept dropped input, and retain explicit context errors. Model dimension/digest/configuration checks remain mandatory before real use, without requiring a weight download during research.

### Historical retry outcome and superseding authorization

The corrected retry withdrew the hard-two-package rationale and established conservative token budgeting without a live model. It stopped BLOCKED on the unestablished bounded EPUB archive/XML adapter, not package-count preference or missing optional live services. **That format blocker is now superseded by explicit user authorization for PDF-only scope**, not by a claim that EPUB parsing became safe. The three-/four-package EPUB candidates are deferred; there is no outstanding current-version request to adopt them or continue their research.

### PDF-only scope amendment and selected commands

The amendment changes format scope only. Reject EPUB/other non-PDF input explicitly, including misleading extensions or unsupported signatures. Preserve PDF path/symlink checks, source-hash verification, bounded byte/page/pixel/time limits, encrypted/malformed/scanned diagnostics, code/table preservation warnings, exact page/block provenance, structural section handling, explicit figure links and lazy crop/full-page rendering. Never follow PDF external resources, execute scripts/actions or treat embedded attachments as trusted sources. The selected PDF stack still requires these implementation guards and tests; the one-page smoke is not a security or fidelity certification. Initial adapter limits: input <=128 MiB, <=2000 PDF pages, one page processed/rendered at a time, <=4 MiB extracted text/page, <=30 seconds/page and <=30 minutes/import, cancellation plus loading-task cleanup on failure. Reject non-finite/oversized geometry before allocating the bounded <=1600-side output canvas. PDF.js exposes `stopAtErrors` and `maxImageSize`; configure `maxImageSize:16000000` and expose skipped/unsupported images as incomplete coverage. Its OffscreenCanvas/canvas-area controls are not a process-memory sandbox on Node; do not claim those options hard-limit arbitrary decoder memory. Hostile PDF decoding needs an isolated cancellable worker/process and explicit resource diagnostics in implementation; input/image/page limits alone do not prove immunity to malformed files. All these are planned adapter gates, not claims that the trial enforced them.

After T2 creates the workspace (not during T1), the selected installation command is:

```sh
npm install --ignore-scripts --save-exact --workspace packages/books-rag pdfjs-dist@6.4.299 @napi-rs/canvas@1.0.13
```

Use a books-only Node >=26.11.1 prerequisite; ordinary pihouse startup remains unchanged. Read/render local supplied bytes, use `pdfjs-dist/legacy/build/pdf.mjs` and the exact canvas binary, configure any needed CMaps/fonts/WASM assets from the installed package, and dispose `PDFDocumentLoadingTask`. Missing assets/binaries or unsupported runtime are explicit errors, never system installs or remote fetch fallback. No EPUB, XML, ZIP or AGPL production dependency is selected.

The mandatory >=20 answerable / >=10 unrelated synthetic queries, recall@5 >=0.90, all citation/figure cases, unrelated-query abstention, >=2 chunk configurations, real supplied-PDF local inspection where available, source-version integrity and MCP byte/character/image limits are **unchanged**. Optional real-model/tokenizer/Pinecone/client checks remain separately pending. No book uploads, model weights, resource creation/payment, original-checkout edits, T2 work or ledger edits occurred. The user's follow-up explicitly requires T1–T11 and the complete PDF-only pipeline, not an extraction-only deliverable. T10/T11 and overall plan validation now explicitly require offline synthetic PDF ingest→chunks→index through fake endpoints→search→verified read→next-page figure, unrelated abstention and failure/privacy/output-budget cases. Preseeded retrieval fixtures alone do not prove that complete path. Supplied PDF pages 169–174 remain a required local check when available; compatible already-installed local-model/Pinecone/client smoke checks remain conditional and otherwise pending. EPUB implementation and EPUB-specific testing are deferred; generic unsupported-format rejection does not require an EPUB parser or fixture suite. T1 is PASS for the amended PDF-only research contract only, pending executor verification; it does not mark any downstream task complete. Stop here.

## Official sources

All accessed 2026-10-27; package registry queries and tarballs are publisher artifacts. URLs without a pinned release are mutable and must be rechecked before live use.

- Node: https://nodejs.org/api/zlib.html (ZIP API stability, CRC/inflate/limits); https://nodejs.org/docs/latest-v26.x/api/sqlite.html; https://github.com/nodejs/node/blob/v26.11.1/LICENSE.
- PDF.js: https://registry.npmjs.org/pdfjs-dist/6.4.299; https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/src/display/api.js; https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/src/display/node_utils.js.
- Canvas: https://registry.npmjs.org/@napi-rs%2fcanvas/1.0.13; https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/README.md; published package's `package.json`/LICENSE and native optional binary.
- EPUB/XML/ZIP: https://www.w3.org/TR/epub-33/; https://www.w3.org/TR/xml/; https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT.
- Alternatives: https://registry.npmjs.org/mupdf/1.28.1; https://registry.npmjs.org/mupdf/-/mupdf-1.28.1.tgz (LICENSE and `dist/mupdf.d.ts` inspected); https://registry.npmjs.org/epub2/3.0.2.
- Retry EPUB artifacts: https://registry.npmjs.org/epub/2.1.1; https://registry.npmjs.org/epub/-/epub-2.1.1.tgz (`epub.ts`); https://registry.npmjs.org/@smoores%2fepub/0.1.9 and its published tarball (`index.js`, `index.d.ts`); https://registry.npmjs.org/@daisy%2fepub-utils/1.4.6 and its published tarball (`lib/epub.js`, `lib/epub-parse.js`).
- Retry existing XML source: installed `node_modules/@aws-sdk/xml-builder/dist-cjs/index.js` matching the worktree lockfile, publisher artifact https://registry.npmjs.org/@aws-sdk%2fxml-builder/3.972.41.
- Retry streaming/XML alternatives: https://raw.githubusercontent.com/gildas-lormeau/zip.js/v2.24.0/index.d.ts; https://raw.githubusercontent.com/gildas-lormeau/zip.js/v2.24.0/lib/core/zip-reader.js; https://raw.githubusercontent.com/gildas-lormeau/zip.js/v2.24.0/LICENSE; https://raw.githubusercontent.com/NaturalIntelligence/fast-xml-parser/v5.11.2/src/xmlparser/OptionsBuilder.js and installed 5.11.2 `src/xmlparser/{XMLParser,OrderedObjParser}.js` (retry's temporary prefix).
- Ollama: https://api.github.com/repos/ollama/ollama/releases/latest; https://raw.githubusercontent.com/ollama/ollama/v0.40.11/LICENSE; https://raw.githubusercontent.com/ollama/ollama/v0.40.11/server/routes.go; https://docs.ollama.com/api/embed; https://docs.ollama.com/macos.md.
- Retry tokenizer proof: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/e9b6763023c676ca8431644204f50c2b100d9aab/tokenizer.json; https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/tokenizer_config.json; https://raw.githubusercontent.com/huggingface/tokenizers/v0.22.1/tokenizers/src/normalizers/bert.rs; https://raw.githubusercontent.com/huggingface/tokenizers/v0.22.1/tokenizers/src/pre_tokenizers/bert.rs; https://raw.githubusercontent.com/huggingface/tokenizers/v0.22.1/tokenizers/src/models/wordpiece/mod.rs; https://raw.githubusercontent.com/huggingface/transformers/v4.57.1/src/transformers/models/bert/tokenization_bert.py.
- Model: https://ollama.com/library/nomic-embed-text/tags; https://registry.ollama.ai/v2/library/nomic-embed-text/manifests/v1.5; https://registry.ollama.ai/v2/library/nomic-embed-text/blobs/sha256:31df23ea7daa448f9ccdbbcecce6c14689c8552222b80defd3830707c0139d4f; https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md.
- Pinecone: https://www.pinecone.io/pricing/; https://docs.pinecone.io/reference/api/database-limits.md and linked https://docs.pinecone.io/reference/api/database-limits/rate-limits.md, https://docs.pinecone.io/reference/api/database-limits/object-limits.md, https://docs.pinecone.io/reference/api/database-limits/operation-limits.md, https://docs.pinecone.io/reference/api/database-limits/identifier-limits.md; https://docs.pinecone.io/reference/api/known-limitations.md.
- Pinecone REST: https://docs.pinecone.io/reference/api/2025-10/control-plane/describe_index; https://docs.pinecone.io/reference/api/2025-10/data-plane/upsert.md; https://docs.pinecone.io/reference/api/2025-10/data-plane/query.md.
