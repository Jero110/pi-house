# ADR-003: Traceable books retrieval with local evidence and hosted candidates

## Status
Proposed; T1 BLOCKED on complete extraction-stack feasibility. No implementation dependency adoption is authorized by this record.

## Date
2026-10-27

## Context
The approved [capability map](../../CAPABILITY-MAP-books-rag.md), [shared specification](../specs/books-rag/common.md) and [plan](../plans/books-rag.md) require a separate optional library of about 20 EPUB/PDF books. Originals, text, captions and figures remain local. Pinecone receives only vectors and minimal metadata; client agents can send requested evidence to their providers. Research must establish a reliable stack with no install scripts or system installs and warning-free validation. Two new production npm packages are a preference, not a binding cap. The corrected T1 retry explicitly permits a justified modest third pure-JS package; that alone is not a materially broader toolchain.

Problem: extracted text is not equivalent to a faithfully viewed page. Example: a diagram can be vector-drawn and code identifiers can fragment during text extraction. Solution: preserve original and normalized text separately with immutable source hashes/spans, quality diagnostics, and lazy verified crop or explicitly labeled full-page rendering. Never infer missing code, authors, printed page numbers or diagram meaning.

Problem: the measured PDF stack does not cover EPUB, and high-level EPUB libraries do not automatically provide a bounded security boundary. Example: Node ZIP warns, while the tested third package `epub@2.1.1` exposes spine/raw XHTML but internally expands XML before caller byte-budget controls and retains only the first creator in convenience metadata. Solution: investigate source/API behavior and a public streaming archive/ordered XML adapter rather than treating the package-count preference as a cap, writing bespoke parsers, or silently accepting unbounded defaults. The [research record](../books-rag-research.md) records the single corrected retry, sources and limitations.

## Decision
Retain the approved architecture as the intended design, **conditional on resolving the T1 blocker**:

- A separate `packages/books-rag` workspace, opt-in CLI/stdio MCP, no pi changes, no startup ingestion/context injection, and a private configured corpus store outside the checkout.
- Immutable local source/version records, original/normalized extraction and explicit uncertainty. SQLite/FTS5 conventions may be reused but workflow-memory tables/content must not be shared. Node 26.11.1 passed SQLite/FTS without warnings; Node 24 warning behavior is not assumed compatible.
- Reuse public `cmux-mcp` exports for `serveMcp` and text/image types. Tool-specific validation, budgets, source checks and client verification remain books responsibilities.
- PDF candidate: exact `pdfjs-dist@6.4.299` (Apache-2.0) and `@napi-rs/canvas@1.0.13` (MIT plus bundled notices). The legacy PDF.js build and a platform prebuilt binary worked with `--ignore-scripts`; dispose `PDFDocumentLoadingTask`, not the document proxy. These two direct packages installed three artifacts including the canvas binary. **Not a complete PDF/EPUB choice yet.**
- Local embedding candidate: Ollama 0.40.11 (MIT), `nomic-embed-text:v1.5` F16/137M (Apache-2.0), full pinned manifest digest in research, 768 dimensions, document/query prefixes, `truncate:false`. Respect the Ollama tag's 2048-token limit rather than the upstream card's 8192 claim. Use a source-backed conservative budget `max(UTF8_BYTES(full prefixed input), UTF8_BYTES(LOWERCASE(NFD(full prefixed input)))) + 32 <= 2048` and `truncate:false`; this is not actual measured tokens. Installed GGUF tokenizer equivalence is an optional live compatibility check, not a standalone core blocker; no weights are downloaded automatically.
- Hosted candidate adapter: native fetch, documented Pinecone REST 2025-10, pre-existing serverless dense cosine index of dimension 768 with a configured dedicated namespace. Opaque IDs/minimal markers only, finite requests/retries/bytes, no provisioning, integrated embedding, cloud fallback or paid-resource use. Operator plan/allowance verification is mandatory and is not established by public documentation.
- Use local lexical candidates only if later evaluation justifies them. Scores are not evidence confidence; local source resolution and agent passage assessment are separate gates. Backend failure, incomplete corpus and insufficient support must remain distinguishable.

Do not proceed to T2 until complete extraction feasibility has a defensible bounded-security resolution within authorization. Conservative input accounting is source-backed without a live model; live equivalence is not falsely claimed. This record changes no binding privacy/scope requirement and makes no claim of real retrieval quality.

## Alternatives considered

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
T1 stops BLOCKED; T2–T11 remain unstarted. No root/package versions, dependency manifests, production code, user settings or pi files changed. The approved map/spec/plan baseline is preserved separately from these research findings. The executor ledger is not owned or committed by this task.

The initial hard-two-package blocker rationale is withdrawn. PDF feasibility on macOS arm64 is measured and conservative token budgeting is source-backed. Complete bounded EPUB support remains unresolved after retry 1/1; real-book extraction, installed local embeddings/tokenizer equivalence, Pinecone account eligibility/remaining quotas and client image behavior remain unmeasured. Missing optional live prerequisites remain pending, not invented success. A later scoped research task or approved dependency-bound amendment is necessary; no automatic expansion, resource creation, payment, cloud corpus upload, or model download follows this ADR.
