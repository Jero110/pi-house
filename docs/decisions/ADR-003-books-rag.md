# ADR-003: Traceable books retrieval with local evidence and hosted candidates

## Status
Accepted for PDF-only scope, amended by the user's authorized hosted-corpus decision (2026-10-27). The T1 research history below is retained; the T6 amendment supersedes its vector-only/local-only/lazy-rendering boundary. Earlier EPUB feasibility blockers are historical, not current PDF-only blockers.

## Real-data coverage amendment
The authorized follow-up refines the partial-extraction rule: coverage gaps represent missing/untrusted **text**, not
unread images or unvalidated outline hints. Mixed raster/text pages retain page quality diagnostics and render fallback;
outline mismatches and ignored external links retain document diagnostics without marking all pages missing. The real
188-page reproduction's null-location `unsupported_asset` came from ordinary `/URI` links in the lexical safety scan.
Parsed JavaScript actions, current embedded attachments and XFA still gap all pages; ordinary navigation/OpenAction
metadata alone does not. Raw asset names can occur as literal text or in obsolete incremental PDF revisions: retain
an ignored-content diagnostic, but do not infer whole-document unsafety. The real DDIA file had raw embedded-file
names but no parsed current attachments or JavaScript; those obsolete names must not make its 613 pages gaps. Text-decoder recovery or image-only pages remain gaps. Parsed permission metadata rejects
owner-password encryption even when PDF.js can open with an empty user password. Book-scale real data also justified
raising the disposable worker V8 heap from 256 MiB to 1024 MiB; this is neither an unlimited resource policy nor a
native-memory sandbox guarantee. Per-page operator resources are cleaned in `finally`; full-document text items and
per-scalar normalization mappings remain intentionally retained until extraction completes. Streaming those records
instead of retaining the immutable extraction is a separate architectural change.

The diagnostic follow-up supersedes the temporary 20,000-notice cap: group by `(code, message)`, retain occurrence
count and compact physical-PDF-page ranges (at most 32 ranges, with exact omitted-page count), and cap output at 500
entries including one reserved truncation summary with counts per omitted code. Diagnostic saturation never fails
an import and never removes independently tracked coverage gaps. Grouped notices retain their first location only as
an example, not their complete affected-page list. Existing 32 KiB passage-metadata and 1 MiB JSON-object limits remain
unchanged and enforced; aggregation does not authorize larger hosted records/catalogs.

Hosted publication/index completeness is independent of extraction coverage. Search precedence stays `unavailable` >
`incomplete_corpus` > `insufficient_evidence` > `ok`, but `incomplete_corpus` now describes incomplete publication/index
or selected books without searchable published content. Gaps are always exposed in coverage and source-scoped count/reason
diagnostics; no-hit responses warn that the answer could be on unextracted pages. This avoids making every query unusable
because a book has a cover image, without pretending partially extractable PDFs are complete. Extractor adapter identity
is bumped so re-ingestion cannot reuse the old coverage interpretation. No OCR, default gate change or hosted call is added.

## Date
2026-10-27

## Context
The approved [capability map](../../CAPABILITY-MAP-books-rag.md), [shared specification](../specs/books-rag/common.md) and [plan](../plans/books-rag.md) now require a separate optional library of about 20 PDF books. Originals, text, captions and figures remain local. Pinecone receives only vectors and minimal metadata; client agents can send requested evidence to their providers. Research must establish a reliable stack with no install scripts or system installs and warning-free validation. Two new production npm packages are a preference, not a binding cap. The corrected T1 retry permitted a justified modest third pure-JS package; that alone was not a materially broader toolchain. Subsequently, the user explicitly authorized a PDF-only first version ("si queires slo para pdfs", 2026-10-27). EPUB ingestion, locators and assets are deferred; no further EPUB dependencies are investigated or adopted.

Problem: extracted text is not equivalent to a faithfully viewed page. Example: a diagram can be vector-drawn and code identifiers can fragment during text extraction. Solution: preserve original and normalized text separately with immutable source hashes/spans, quality diagnostics, and lazy verified crop or explicitly labeled full-page rendering. Never infer missing code, authors, printed page numbers or diagram meaning.

Problem: the measured PDF stack does not cover EPUB, and high-level EPUB libraries do not automatically provide a bounded security boundary. Example: Node ZIP warns, while the tested third package `epub@2.1.1` exposes spine/raw XHTML but internally expands XML before caller byte-budget controls and retains only the first creator in convenience metadata. The initial retry investigated source/API behavior instead of writing bespoke parsers or accepting unbounded defaults. The subsequent user-authorized solution is to defer EPUB and select the measured PDF stack, not weaken quality or safety. The [research record](../books-rag-research.md) preserves that history, scope amendment, sources and limitations.

## Decision
Adopt the researched architecture for the **user-authorized PDF-only first version**, with every other approved gate preserved:

- A separate `packages/books-rag` workspace, opt-in CLI/stdio MCP, no pi changes, no startup ingestion/context injection, and a private configured corpus store outside the checkout.
- Immutable local source/version records, original/normalized extraction and explicit uncertainty. SQLite/FTS5 conventions may be reused but workflow-memory tables/content must not be shared. Node 26.11.1 passed SQLite/FTS without warnings; Node 24 warning behavior is not assumed compatible.
- Reuse public `cmux-mcp` exports for `serveMcp` and text/image types. Tool-specific validation, budgets, source checks and client verification remain books responsibilities.
- Select exact `pdfjs-dist@6.4.299` (Apache-2.0) and `@napi-rs/canvas@1.0.13` (MIT plus bundled notices). The legacy PDF.js build and a platform prebuilt binary worked with `--ignore-scripts`; dispose `PDFDocumentLoadingTask`, not the document proxy. These two direct packages installed three artifacts including the canvas binary. Use the verified Node 26.11.1/macOS arm64 baseline and a books-only Node >=26.11.1 prerequisite; other platforms require their own prebuilt-binary smoke check. No system tools, EPUB parser or AGPL dependency are selected.
- Reject unsupported/non-PDF inputs explicitly. Preserve physical PDF page/block coordinates, immutable hashes, original/normalized text, structural boundaries, uncertain-code/table diagnostics, full-page figure fallback and all source checks. Deferring EPUB does not permit arbitrary paths/symlinks, unsafe PDF asset decoding, external URL fetches, embedded-attachment ingestion or PDF JavaScript/actions. Bound file/page/pixel/output/time resources and fail explicitly on malformed, encrypted, scanned/incomplete or unsupported material.
- Local embedding candidate: Ollama 0.40.11 (MIT), `nomic-embed-text:v1.5` F16/137M (Apache-2.0), full pinned manifest digest in research, 768 dimensions, document/query prefixes, `truncate:false`. Respect the Ollama tag's 2048-token limit rather than the upstream card's 8192 claim. Use a source-backed conservative budget `max(UTF8_BYTES(full prefixed input), UTF8_BYTES(LOWERCASE(NFD(full prefixed input)))) + 32 <= 2048` and `truncate:false`; this is not actual measured tokens. Installed GGUF tokenizer equivalence is an optional live compatibility check, not a standalone core blocker; no weights are downloaded automatically.
- Hosted candidate adapter: native fetch, documented Pinecone REST 2025-10, pre-existing serverless dense cosine index of dimension 768 with a configured dedicated namespace. Opaque IDs/minimal markers only, finite requests/retries/bytes, no provisioning, integrated embedding, cloud fallback or paid-resource use. Operator plan/allowance verification is mandatory and is not established by public documentation.
- Use local lexical candidates only if later evaluation justifies them. Scores are not evidence confidence; local source resolution and agent passage assessment are separate gates. Backend failure, incomplete corpus and insufficient support must remain distinguishable.

PDF-only feasibility and conservative input accounting now pass the T1 research gate; do not proceed to T2 until executor verification. Live equivalence is not falsely claimed. The only binding scope change is the explicitly authorized EPUB deferral; all privacy, provenance, extraction, rendering, retrieval and evaluation requirements remain intact. This record makes no claim of implemented parser accuracy or real retrieval quality.

## Hosted-corpus amendment (T6)

Problem: a second computer cannot resolve vector-only candidates without the local books. Example: deleting an original after successful ingestion would remove lazy rendering and local evidence access. Authorized solution: host passage original/normalized text and citation metadata in Pinecone, render figures once at ingestion and upload them plus a versioned catalog manifest to an existing **private S3-compatible bucket** (Supabase Storage target). Originals are optional thereafter. Do not host original PDFs. Every client still needs identical pinned **local** embeddings; no hosted embedding fallback. Book text/figures now cross a third-party boundary, and requested evidence may additionally reach the agent provider. This changes only the books decision, never workflow-memory storage.

Use native fetch and `node:crypto` SigV4 (no new dependency). Preserve Supabase's S3 endpoint path and path-style bucket addressing; expose only bounded PUT/GET/HEAD and explicit-key delete under the configured library prefix. Do not expose public URLs/ACLs, resource creation, prefix deletion, or a Management API. Reject `sbp_` personal access tokens as S3 credentials. Store SHA-256 metadata and verify GET bytes against caller-pinned hashes; HEAD verifies metadata/size only. Operator must separately confirm private bucket policy (`S3_BUCKET_PRIVATE_CONFIRMED=true`). Additionally configure `S3_PRIVATE_PROBE_KEY`, a known existing private canary under the library prefix: an unsigned GET must return 400/401/403 before signed access. A successful GET fails closed with `Bucket appears public`; a missing object/redirect/other failure is not proof of privacy. Cache the anonymous refusal for at most 10 minutes. This checks the known object, not every bucket policy; no adapter creates the canary. AWS published IAM signing and S3 canonical-request vectors and fake loopback servers verify offline behavior, not live Supabase compatibility.

Pinecone records now carry allowlisted text, PDF citations/spans/mappings, headings, source/version/hash/configuration/generation, figure IDs/evidence and structural context. Structured fields are JSON strings inside flat permitted metadata types; >40 KiB is an explicit error, never truncation. No local paths, image bytes, arbitrary caller fields or secrets. Query must request metadata, not vectors. Read-only describe-index validates readiness, serverless/dense/cosine/768, no integrated embeddings and exact configured host. Cache verified index/model prerequisites for queries for at most 10 minutes rather than spending low control-plane quotas on every tool call; force verification for every write/indexing batch and explicit doctor check. Mismatch-like data errors invalidate/re-probe without replaying writes. No control-plane mutation. Apply a bounded FIFO queue (one active, four waiting, default 15-second wait timeout, explicit busy beyond the bound) to all adapters so parallel MCP calls do not fail merely because one operation is active. All data operations include the dedicated namespace and deletes name <=50 explicit opaque IDs. Adapter bounds, exact environment keys and credentials/error-redaction rules are recorded in [research](../books-rag-research.md#t6-hosted-corpus-amendment-and-adapter-contract).

Single writer publishes generation-based manifests. T7 must verify matching source hash/version/configuration/generation and pinned figure hashes across hosted records and the manifest; incomplete generations report `incomplete_corpus`, not mixed results. A deleted original cannot be freshly re-hashed or re-rendered beyond stored evidence. Local corpus storage remains an ingestion working store/optional cache, not a read-only client's prerequisite. Local lexical candidates are optional and require T8 measurement without that cache.

Before real access, the operator verifies pricing, account entitlement and remaining shared allowances for Pinecone Starter and Supabase Free, existing index/namespace/private bucket, region, corpus estimate and egress. **Supabase Free may pause projects after 7 days of inactivity**; this is backend unavailability, not evidence absence. Public limits/API errors cannot establish zero billing. Do not automatically provision, upgrade, resume via management APIs, install models or spend money. No real cloud/model/account checks were performed in T6. See the research's operator-source links and pending live checks.

The following T1 alternatives/consequences are historical where they conflict with this explicit amendment; hosted extracted text/figures are now approved, hosted originals/cloud embeddings remain forbidden.

## Operational decisions (T10)

- **PDF only.** EPUB stays deferred; other formats are rejected per file.
- **Hosted text and figures.** Passage text and citations live in Pinecone metadata, figures and the catalog in a private S3-compatible bucket; originals are never hosted and are optional after ingestion. Readers need no local store.
- **Single writer.** One machine runs `ingest` and `index`; the writer claim detects conflicts and is never stolen automatically.
- **Record schema 2.** Compact lossless metadata; schema-1 records are refused and require `index` to republish.
- **Production chunk bound 1800** conservative units (UTF-8 bytes plus 32 against the 2048 limit), chosen so the largest measured record stays under the 32 KB budget; it is not measured tokens.
- **Clients connect manually.** Setup is documented as commands and config fragments in the [operator guide](../books-rag.md) with the env file path (`BOOKS_ENV_FILE`), not inline secrets. No setup command edits client or pi configuration.
- **Verification scope.** An offline integration test covers the real CLI and MCP over loopback fakes. Real Ollama, Pinecone, Supabase and client runs are not done and are reported as pending.

## Alternatives considered

The EPUB alternatives below preserve earlier research history only. They are deferred by the subsequent PDF-only authorization, not pending current-version adoption or further dependency research.

- **PDF.js plus canvas and Node ZIP/custom XML:** PDF extraction/vector rendering passed. Built-in ZIP warned; primitive inflate/CRC fixture checks do not establish reliable EPUB parsing, security or locator preservation. Not adopted as a complete stack.
- **MuPDF 1.28.1 WASM:** potentially handles both formats with fewer direct packages, but AGPL-3.0-or-later distribution obligations and EPUB spine/document identity preservation require investigation/authorization. Source inspected only; not adopted, installed or live-tested.
- **Third direct EPUB library:** permitted by the corrected research authority. `epub@2.1.1` (MIT) installed script-free in `/tmp` and passed synthetic root/spine/raw-chapter checks, but its default decoding/parser interface has no caller output/depth controls. `@smoores/epub@0.1.9` and `@daisy/epub-utils@1.4.6` were source-inspected; their public APIs respectively hide archive-output controls or default to filesystem extraction. None is adopted as a bounded archive/XML boundary.
- **Existing AWS XML parser:** `@aws-sdk/xml-builder@3.972.41` does export `parseXML`, but loses mixed content order/code whitespace and mishandles non-BMP numeric entities. Reuse would compromise source fidelity; its existence does not resolve XHTML extraction.
- **Public archive/XML primitives:** `@zip.js/zip.js@2.24.0` (BSD-3-Clause) plus `fast-xml-parser@5.11.2` (MIT), alongside PDF.js/canvas, is a four-direct-dependency candidate with source-backed strict/streaming and ordered/depth options. Four packages are not automatically a broader toolchain; explicit clarification was requested from the executor instead of assuming the corrected third-package authorization extends further. Source inspected, not installed/adopted.
- **Poppler, Calibre, Python, Homebrew or native builds:** broader system toolchain, outside authorization. No install attempted.
- **Hosted parsing, hosted original text, cloud embedding, OCR or LLM reconstruction:** violate the approved privacy/scope or cost boundary. Not alternatives to silently fall back to.
- **Entirely local vectors:** avoids managed-service prerequisites, but replacing Pinecone is a binding design change. Not authorized by research.

This does **not** reverse ADR-001/ADR-002's rejection of hosted search for workflow memory. Workflow memory has local canonical documents and scoped learning/approval operations and remains local. Books are a separately approved, larger external-source corpus with a specifically authorized vector-only hosted candidate boundary. No workflow data or operational tables migrate to Pinecone.

## Consequences
T1 PDF-only research passed (historical statement; the implementation exists since and T10 documents it). No root/package versions, dependency manifests, production code, user settings or pi files changed. The approved map/spec/plan baseline is preserved separately from these research findings. The executor ledger is not owned or committed by this task.

The initial hard-two-package blocker rationale is withdrawn, and the remaining EPUB blocker is removed only by the user's explicit format-scope amendment. PDF feasibility on macOS arm64 is measured and conservative token budgeting is source-backed. EPUB remains deferred, not validated. Real-book extraction, installed local embeddings/tokenizer equivalence, Pinecone account eligibility/remaining quotas and client image behavior remain unmeasured. Missing optional live prerequisites remain pending, not invented success. All mandatory later synthetic evaluation and extraction/rendering safety gates still apply. The user explicitly reinforced full PDF-only T1–T11 delivery: offline ingest→chunks→fake-endpoint index→search→verified read→next-page figure plus unrelated abstention and failure/privacy/output-budget checks, and supplied-PDF pages 169–174 inspection when available. This is not an extraction-only feature or completion claim. EPUB implementation/testing remains deferred; live smoke checks require already available compatible prerequisites and verified allowed resources or are reported pending. No resource creation, payment, cloud corpus upload, model download or automatic T2 execution follows this ADR.
