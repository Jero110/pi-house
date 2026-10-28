# Traceable Books RAG

**Plan:** docs/plans/books-rag.md · **Planned:** 2026-10-27 · **Branch:** feature/lightweight-self-learning (observed; execution uses an isolated feature branch/worktree)

## Goal

Give pihouse, Claude Code, and Codex access to a personal library of approximately 20 PDF books through an optional local stdio MCP server. A query retrieves bounded text evidence with verified source/version/location; relevant figures are available separately on demand. Example: a question about chunking retrieves the relevant subsection and links Figure 3-6 on PDF page 172 of the supplied book, rather than sending the whole chapter. An unrelated question receives an honest lack-of-support result, not an invented citation.

Approved specifications: `/Users/jeronimo.deli/Desktop/other/Vs/pi-house/CAPABILITY-MAP-books-rag.md` and `/Users/jeronimo.deli/Desktop/other/Vs/pi-house/docs/specs/books-rag/{common,book-corpus,book-retrieval,books-mcp}.md`. Read all five before execution. Specification approval does not itself authorize executing this plan.

## Authorized scope amendment (2026-10-27)

The user explicitly permitted a PDF-only first version ("si queires slo para pdfs"). EPUB ingestion, archive/spine locators and assets are deferred; non-PDF inputs must fail explicitly. This supersedes only the earlier EPUB-format requirements, not privacy, provenance, source hashes, structural extraction, figure rendering, path/asset safety, bounded retrieval or evaluation requirements. T1 may select the verified PDF.js/canvas pair and conservative fail-closed input budget. No EPUB dependency research or T2 implementation follows this amendment; executor verification of T1 is still required.

The user's subsequent clarification requires the **full PDF-only pipeline and T1–T11**, not an extraction-only spike. Mandatory offline end-to-end tests must cover synthetic PDF ingest → structural chunks → index via fake local-embedding/Pinecone endpoints → search → verified read → next-page figure, plus unrelated-query abstention and failure/privacy/output-budget cases. The supplied PDF pages 169–174 local check remains required when the input is available. Real local-model/Pinecone/client smoke checks run only with already available compatible prerequisites and verified allowed resources; otherwise report them pending. No provisioning, downloads, payments or original/text uploads are authorized. EPUB implementation and EPUB-specific testing are deferred; generic unsupported-format rejection remains required without building an EPUB parser or fixture suite.

## Authorized hosted-corpus amendment (2026-10-27)

The user explicitly authorized moving the corpus to their own hosted services so the library works from any of their computers without keeping or re-downloading the books ("texto en Pinecone, figuras en S3/Supabase y los PDFs se pueden borrar tras la ingesta", confirmed with "haz lo que dijimos"). This supersedes, and only supersedes, these earlier decisions: Pinecone receiving vectors only, originals/text/figures staying local, lazy on-demand rendering, and the out-of-scope exclusion of hosted text/figures and cross-machine use.

- **Pinecone (text):** each passage record carries its vector plus the passage text needed to answer and cite: original and normalized text, heading path, PDF page/span locators, source/version/hash identity and figure IDs, within Pinecone metadata limits (40 KB per record; types restricted, no nulls). Never local paths or secrets. The dedicated configured namespace remains mandatory.
- **Object storage (figures and catalog):** figures are rendered once during ingestion (verified crop or explicitly labeled full page, <=1600 px longest side, <=2 MiB) and uploaded to a **private** bucket through the **S3-compatible API**, signed with SigV4 using Node built-ins (no SDK dependency). Supabase Storage's S3 endpoint is the target; the same code must work with any S3-compatible store. A small versioned catalog/manifest object (books, versions, extraction coverage, index generation) lives in the same bucket. Bucket must be private; never public URLs.
- **Originals are optional after ingestion.** Citations are verified against the source hash recorded at ingestion plus hosted-record consistency (same version/hash/generation across Pinecone and the manifest). If the original is still present locally it may additionally be re-hashed. Report honestly that deleted originals cannot be re-verified or re-rendered beyond what was stored.
- **Single writer:** ingestion/indexing runs on one machine at a time; other machines are read-only clients. Writes must be generation-based and never mix versions; a reader seeing an incomplete generation reports `incomplete_corpus`.
- **Every client machine** still needs the local embedding runtime with the identical pinned model; no cloud embeddings.
- **Local store (T3)** remains the ingestion working store and optional cache; it is not required for queries on a second machine.
- **Lexical candidates:** a local FTS index is optional (cache-only). Retrieval quality without it must be measured in T8, not assumed.
- **Privacy:** book text now resides in Pinecone and figures in the user's object storage, both third-party services. Retrieved text/figures may still reach the agent provider. Documentation must state this plainly.
- **Credentials:** read from environment or a gitignored `.env`: `PINE_CONE_API`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. A Supabase personal access token (`sbp_`, Management API) must **not** be used: it can create/modify projects, which is forbidden provisioning. Never log or output secrets.
- Unchanged: no payments, no automatic creation of indexes/buckets/projects (operator creates them), no model downloads, no OCR/LLM ingestion, synthetic tests with fake Pinecone and fake S3 HTTP servers only, bounded outputs, explicit statuses, PDF-only.

Task impact: T5 renders figures at ingestion; T6 adds `packages/books-rag/src/objects.ts` (S3-compatible SigV4 client) with `test/objects.test.ts` and Pinecone text metadata; T7 resolves evidence from hosted records with manifest/generation checks; T9/T10 must support a read-only second machine; T10 integration covers ingest → upload (fake Pinecone + fake S3) → delete local original → search → read → next-page figure on a fresh empty local store.

## Decisions (binding)

- Approximately 20 PDF books for this version; EPUB deferred by explicit user authorization. Text retrieval, not visual similarity search.
- Extract, chunk, and embed locally without an ingestion LLM. SUPERSEDED IN PART by the hosted-corpus amendment above: passage text goes to Pinecone metadata and figures to private S3-compatible storage; never local paths or secrets.
- The existing client agent may translate/reformulate queries into English; no separate translation model or server-side generation.
- Retrieved text and requested images may reach the agent provider. This privacy boundary must be explicit.
- Preserve source hashes, edition/author provenance, structural paths, source spans, and unknown fields. PDF positions are explicitly PDF pages, never assumed printed pagination.
- Link figures by explicit references where possible, including next-page figures. Render a verified crop or explicitly labeled full-page fallback on demand. Captions are not substitutes for viewing figures.
- Preserve original and normalized extracted text separately. Do not guess code repairs. Flag incomplete/scanned pages and uncertain tables/figures.
- Distinguish no supporting evidence, incomplete corpus, stale sources, and unavailable backend. A nearest-neighbor match alone does not prove support; the agent must assess the passage.
- No OCR pipeline, image descriptions, integrated viewer, paid resources, automatic provisioning, cloud embedding fallback, DRM bypass, or bulk subscription downloads.
- Stop and report if the configured Pinecone resource requires payment, exceeds verified free allowances, or cannot be used safely. Do not promise zero billing from a local estimate or create resources automatically.
- Only the three selected development skills below apply. Do not add TDD or other development skills implicitly.
- No automatic model/account fallback or routing profile is authorized. Agents use their harness default, fixed at launch; record the resolved model in the execution ledger.
- Do not modify, stage, overwrite, or commit unrelated working-tree changes. No push, tag, release, PR, root version bump, or publishing in this plan. Keep a new internal package on the root's current version; a future release must follow root version synchronization.

## Assumptions (the executor may change these)

- Implement a separate workspace `packages/books-rag`, not a new workflow-memory feature. Reuse `cmux-mcp` transport exports after inspecting their public entry points. Changing internal file boundaries is allowed without changing the approved module contracts.
- Proposed CLI entry: `node packages/books-rag/src/cli.ts`; MCP entry: `node packages/books-rag/src/mcp.ts`. Store data in an explicitly configured local directory; do not write a user's corpus into the repository.
- Use Node SQLite/FTS where available for local manifest/text/lexical lookup; reuse the repository's approach to SQLite warnings/capability detection without coupling to workflow tables. T1 verified Node 26.11.1 / SQLite 3.54.0 / FTS5 without warnings on macOS arm64 only; do not assume warning-free Node 24 compatibility. The public `cmux-mcp` root export includes `serveMcp` and image/text types; do not import an unexported transport subpath. Investigate portability before choosing a workaround.
- A local embedding runtime is an operator prerequisite. T1 identified Ollama 0.40.11 with local nomic-embed-text:v1.5 F16, manifest SHA-256 `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, 768 dimensions, task prefixes and `truncate:false` as a candidate, not a live-validated installation. Use the Ollama tag's 2048-token ceiling, not the upstream card's extended 8192 context. T1 retry supports conservative input budgeting over the entire prefixed input: `max(UTF8_BYTES(s), UTF8_BYTES(LOWERCASE(NFD(s)))) + 32 <= 2048`, with `truncate:false` as runtime fail-closed gate. This is an upper-bound budget, not actual measured tokens; installed GGUF tokenizer equivalence remains an optional live check, not a standalone implementation blocker. Do not download model weights automatically. Missing runtime/model prerequisites remain pending live checks, not reasons for cloud fallback.
- Extraction dependencies: select `pdfjs-dist@6.4.299` (Apache-2.0), `@napi-rs/canvas@1.0.13` (MIT plus bundled notices), installed with `npm install --ignore-scripts --save-exact --workspace packages/books-rag pdfjs-dist@6.4.299 @napi-rs/canvas@1.0.13` only after T2 registers the workspace. The verified stack uses PDF.js `legacy/build/pdf.mjs` and the exact canvas platform binary; no EPUB/archive/XML package is selected. Two direct packages are a preference, not a hard cap; no broader system toolchain, pip/Homebrew or install scripts are authorized. Node 26.11.1 / macOS arm64 is the verified runtime/platform; use a books-only `node >=26.11.1` prerequisite with explicit rejection of unsupported runtimes, leaving ordinary pihouse startup unchanged. T1 PDF-only feasibility and token-budget research pass, subject to executor verification and the remaining implementation gates. See `docs/books-rag-research.md` and `docs/decisions/ADR-003-books-rag.md`.
- Start with structural 400–800-token chunks; compare at least one smaller or larger configuration under the same evaluation conditions. A measurable choice replaces this initial assumption.
- Use a local lexical index combined with hosted dense candidates if evidence supports it. Pinecone sparse+dense support is not assumed available/free. The word hybrid describes local corpus plus hosted vectors unless explicitly qualified.
- Use pihouse defaults for workers because the user selected no models. Sequential execution limits quota use and avoids file conflicts. A separate final reviewer checks the evidence without repeating all implementation work.

## Skills

| Skill | Author | Absolute path | What it changes in this work |
|---|---|---|---|
| spec-driven-development | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/spec-driven-development/SKILL.md | Approved specifications govern contracts and testable acceptance; material scope changes stop for approval. |
| documentation-and-adrs | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/documentation-and-adrs/SKILL.md | Record technology decisions, privacy limits, commands, citations, and verified compatibility. |
| git-workflow-and-versioning | Addy | /Users/jeronimo.deli/Desktop/other/vs/pi-house/skills/build/git-workflow-and-versioning/SKILL.md | Isolate this feature, preserve unrelated work, and create atomic validated local commits. |

## Agents

| Agent | Harness | Model | Does |
|---|---|---|---|
| workflow-executor | pihouse | default | Read executor skill, dispatch tasks, verify evidence, integrate scoped commits, and report limitations. |
| books-builder | pihouse | default | Execute T1–T10 in task-sized turns, loading assigned skills each time. Reuse the worker where context permits. |
| books-reviewer | pihouse | default | Independently inspect the completed feature, tests, leakage boundaries, and actual validation evidence in T11. |

`default` means the harness's configured default, not an unresolved user model name. The executor records the effective provider/model at spawn. Check `account_usage` before every spawn and never launch on an exhausted account. If no authorized account can run the fixed default, report BLOCKED; do not improvise a fallback profile.

## Execution

Linear dependency chain: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11. Nothing runs in parallel: the library is small and tasks share contracts and workspace configuration. Each task integrates before the next starts; no concurrent edits in the same worktree.

Before T1, executor inspects git state and creates an isolated branch/worktree using tracked HEAD, then copies only this initiative's approved map/specs/plan into it, preserving their bytes. Do not carry unrelated uncommitted changes. If safe isolation cannot be established, stop. All validation runs from that worktree. The existing checkout may contain other agents' active work.

After every task change, run `npm run check && npm test` with no warnings; focused commands below are additional gates. Do not disable checks, suppress newly introduced warnings globally, or alter unrelated failing tests. Stage only initiative-owned files and relevant workspace/lockfile hunks; inspect staged diff for secrets and unrelated changes before each atomic local commit. Never reset the user's tree. Report integration branch/worktree and commits; no automatic merge into the dirty source checkout.

Research in T1 is the first external investigation; no setup that spends money or uploads the supplied PDF is permitted. Missing optional real-service prerequisites are recorded separately from automated test results. If a core extractor or retrieval contract cannot be implemented within bounds, stop rather than reporting a complete feature.

## Tasks

### T1: Resolve feasibility and document technology choices

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** none · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `docs/decisions/ADR-003-books-rag.md` (use next available number if occupied), `docs/books-rag-research.md`, `docs/plans/books-rag.md`

Objective: verify an extraction/rendering stack, local embedding runtime/model, and Pinecone REST configuration against official documentation and source behavior before implementation. Inspect repository SQLite/MCP helpers and current external docs; do not assume earlier recommendations are compatible.

Acceptance:
- [ ] Document exact package/runtime/model versions, official source URLs and access dates, licenses, supported PDF/layout/rendering behavior and explicit rejection of deferred EPUB, tokenizer limits, image encoding, platform prerequisites, and install-script constraints.
- [ ] Verify Pinecone endpoint/index/namespace compatibility, embedding dimension, current pricing/free restrictions, metadata exclusions, bounded operations, and no automatic resource creation. No real upload is necessary for research.
- [ ] Choose concrete dependencies and commands within assumptions; record failure modes and alternatives. Stop if no feasible stack meets the approved boundaries.
- [ ] ADR follows existing Status/Date/Context/Decision/Alternatives considered/Consequences format and explains why this feature does not reverse workflow-memory's separate no-hosted-search choice.
- [ ] Update only technical assumptions and exact commands in this plan when warranted; binding/privacy changes require stopping, not unilateral approval.

Validation: `npm run check && npm test`; inspect research for source-backed compatibility and explicit unresolved prerequisites.
Stop when: validation and feasibility gates pass, or report BLOCKED after two failed attempts.

### T2: Establish the isolated workspace and source contracts

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T1 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** root `package.json`, `package-lock.json`, `packages/books-rag/package.json`, `packages/books-rag/src/contracts.ts`, `packages/books-rag/test/contracts.test.ts`

Objective: register the optional internal workspace and typed source/passage/figure/search-status contracts without adding a model dependency to ordinary pihouse startup.

Acceptance:
- [ ] Package version matches the current root; all dependencies are exact-pinned and installed using `npm install --ignore-scripts` only.
- [ ] Contracts cover immutable source versions/hash, provenance conflicts, nullable fields, original/normalized text, source spans, heading paths, figure linking evidence, and explicit coverage/errors.
- [ ] Define precedence for unavailable/incomplete/insufficient statuses without losing usable partial-result diagnostics.
- [ ] Synthetic contract tests reject impossible locations and inconsistent source identities. No commercial-book fixtures.

Validation: `node --test packages/books-rag/test/contracts.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T3: Implement the local versioned corpus store

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T2 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/books-rag/src/store.ts`, `packages/books-rag/src/locations.ts`, `packages/books-rag/test/store.test.ts`, `packages/books-rag/test/locations.test.ts`

Objective: persist private corpus records outside the checkout and resolve IDs only within the configured library.

Acceptance:
- [ ] Imports are idempotent for identical source/configuration and produce immutable distinct versions on changes.
- [ ] Original and normalized text stay distinct with source-span mappings; passage IDs cannot resolve to another source version.
- [ ] Source read/render checks detect missing/changed originals. Path traversal, unsafe symlinks, invalid IDs, and partial writes fail explicitly.
- [ ] Store creation and migrations preserve existing bytes on failure; no workflow-memory tables are reused.

Validation: `node --test packages/books-rag/test/store.test.ts packages/books-rag/test/locations.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T4: Extract PDF structure and preserve quality diagnostics

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T3 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `packages/books-rag/src/pdf.ts`, `packages/books-rag/src/ingest.ts`, `packages/books-rag/test/extraction.test.ts`, `packages/books-rag/test/fixtures.ts`

Objective: extract structural blocks and source locations without a generative model, keeping uncertainty visible.

Acceptance:
- [ ] PDF headings/outlines are validated against content and positions, including mid-page boundaries and cross-page sections; immutable source spans retain physical PDF page/coordinates.
- [ ] Synthetic two-page code, table headers/units/cells, metadata conflicts, scanned/mixed pages, malformed/encrypted/unsupported PDFs, unsupported formats including EPUB, unsafe paths/symlinks and oversized/unsafe PDF assets have preservation or explicit bounded diagnostic paths. Do not execute PDF actions/scripts, follow external asset URLs or trust embedded attachments.
- [ ] Do not fix code by guessed string replacements. Preserve a source rendering fallback for uncertain code/tables.
- [ ] Neither originals nor extracted commercial text are added to git or sent to remote services.

Validation: `node --test packages/books-rag/test/extraction.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T5: Add structural chunking and lazy figure resolution

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T4 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/books-rag/src/chunks.ts`, `packages/books-rag/src/figures.ts`, `packages/books-rag/test/chunks.test.ts`, `packages/books-rag/test/figures.test.ts`, `packages/books-rag/test/fixtures.ts`

Objective: build bounded structural chunks and associate relevant figures without visual search or bulk image interpretation.

Acceptance:
- [ ] Chunk boundaries follow subsections/paragraphs rather than pages; no mixing patterns indiscriminately. Code/tables remain coherent or have explicit oversized continuation and headers.
- [ ] Heading context is distinct from literal quote text; counts obey the chosen embedding input limits using its tokenizer or a documented conservative bound.
- [ ] Next-page figure references resolve by figure identity; vague same-page proximity is not silently treated as certainty.
- [ ] Vector-drawn diagrams can be rendered. Unknown crop bounds return an explicitly labeled whole page; absent/unsupported assets report errors.
- [ ] Lazy renders preserve source-hash checks and enforce <=1600-pixel longest side, <=2 MiB encoded bytes, and one image per call; do not claim illegible text was understood.

Validation: `node --test packages/books-rag/test/chunks.test.ts packages/books-rag/test/figures.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T6: Implement bounded local embeddings and Pinecone adapters

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T5 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `packages/books-rag/src/embeddings.ts`, `packages/books-rag/src/pinecone.ts`, `packages/books-rag/src/config.ts`, `packages/books-rag/test/embeddings.test.ts`, `packages/books-rag/test/pinecone.test.ts`

Objective: support a configured local embedding runtime and configured compatible Pinecone resource without installing models or provisioning cloud infrastructure automatically.

Acceptance:
- [ ] Matching model identity/version/dimension/configuration is mandatory for indexing and queries; missing/mismatched prerequisites produce explicit errors.
- [ ] Fake HTTP servers prove hosted records omit all text/captions/images/paths/secrets; use opaque IDs and minimal metadata. Credentials appear only where required by the request protocol, never in logs/output.
- [ ] Bounded retries, timeouts, batch/concurrency limits, namespaces, rate-limit handling, and safe resource usage are tested. No delete outside the configured library/version namespace.
- [ ] Never create/upgrade a resource or use a paid/cloud-embedding fallback; document operator verification of pricing/account limits rather than pretending billing can always be inferred from API errors.

Validation: `node --test packages/books-rag/test/embeddings.test.ts packages/books-rag/test/pinecone.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T7: Implement incremental indexing and evidence-gated retrieval

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T6 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/books-rag/src/indexing.ts`, `packages/books-rag/src/search.ts`, `packages/books-rag/src/lexical.ts`, `packages/books-rag/test/indexing.test.ts`, `packages/books-rag/test/search.test.ts`

Objective: resolve hosted candidates into local current passages, combine lexical candidates if justified, and expose bounded results with honest status/coverage.

Acceptance:
- [ ] Interrupted upserts resume; only completed compatible source/index versions are searchable. Stale/deleted IDs never become fresh evidence.
- [ ] De-duplicate hits, apply book filters and hard limits, and use an evaluated relevance gate rather than unconditionally returning k nearest vectors.
- [ ] Preserve original technical terms; no server-side translation LLM. Query text uses only local embeddings.
- [ ] Unavailable Pinecone/runtime, source corruption, incomplete extraction, and genuine low relevance remain distinguishable; scores are not labeled factual confidence.

Validation: `node --test packages/books-rag/test/indexing.test.ts packages/books-rag/test/search.test.ts && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T8: Compare chunk configurations and test the supplied PDF locally

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T7 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `packages/books-rag/src/evaluate.ts`, `packages/books-rag/test/evaluation.test.ts`, `packages/books-rag/test/evaluation-fixtures.ts`, `packages/books-rag/dev/inspect-pdf.ts`, `docs/books-rag-evaluation.md`

Objective: publish reproducible evidence of synthetic retrieval correctness and a narrow local extraction check, without disguising fake-vector tests as real embedding quality.

Acceptance:
- [ ] Use >=20 answerable and >=10 unrelated synthetic queries with expected source spans and figure links. Include exact identifiers and English reformulations of Spanish questions. Compare >=2 chunk configurations under identical conditions.
- [ ] Require recall@5 >=0.90 on answerable synthetic cases, all mandatory citation/figure cases correct, and insufficient-evidence status on all 10 unrelated fixtures. Do not tune thresholds per individual question or encode expected answers in search logic.
- [ ] Record model/config/tokenizer, corpus hash, recall, false positives/negatives, unnecessary text/redundancy, provenance integrity, and limits of deterministic/fake-vector results.
- [ ] Inspect supplied PDF locally only, with original path from common.md, focusing on pages 169–174 and a real table if identified. Save only compact diagnostics/locations and no commercial-book content to tracked artifacts. A missing input is a clearly reported unavailable operator check.
- [ ] Optional real-model/Pinecone evaluation is explicitly not run unless compatible already-installed local weights and a verified allowed index are available. Missing prerequisites remain visible as unvalidated live retrieval, not fake success.

Validation: `node --test packages/books-rag/test/evaluation.test.ts && npm run check && npm test`; local extraction check: `node packages/books-rag/dev/inspect-pdf.ts --input '/Users/jeronimo.deli/Desktop/books/generative-ai-design-patterns-solutions-to-common-challenges-when-building-genai-agents-and-applications-1.pdf' --pages 169-174`.
Stop when: mandatory synthetic and available local gates pass with honest limitations, or report BLOCKED after two failed attempts. Never declare real retrieval quality validated without real measurements.

### T9: Expose the bounded read-only MCP and CLI

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T8 · **Parallel with:** none
**Skills:** spec-driven-development, git-workflow-and-versioning
**Files:** `packages/books-rag/src/mcp.ts`, `packages/books-rag/src/cli.ts`, `packages/books-rag/src/instructions.ts`, `packages/books-rag/test/mcp.test.ts`, `packages/books-rag/test/cli.test.ts`

Objective: make the full pipeline usable without injecting library text into startup context or ordinary pihouse sessions.

Acceptance:
- [ ] MCP advertises `books_list`, `books_search`, `books_read`, `books_figure`; schemas reject invalid IDs/paths/non-finite limits. Returned content is untrusted reference data.
- [ ] Enforce search <=5 excerpts of <=800 characters; read default 4000/max 8000; catalog <=20 entries; total serialized text <=16000 characters; visible cursors/truncation retain citation fields.
- [ ] Full quote and figure reads verify source version/hash; image support/failure is explicit, not replaced by invented descriptions.
- [ ] CLI supplies `--help`, `doctor`, `ingest --input <path>`, `index`, and `evaluate --synthetic`, with configured store/runtime/Pinecone prerequisites. `doctor` is read-only and redacts secrets; `evaluate --synthetic` never uses remote APIs.
- [ ] Short server instructions tell agents to translate queries if useful, search/read evidence before citing, distinguish inference, ask for figures only as needed, and abstain without supporting evidence. No claim that an arbitrary client must obey these instructions.

Validation: `node --test packages/books-rag/test/mcp.test.ts packages/books-rag/test/cli.test.ts && node packages/books-rag/src/cli.ts --help && node packages/books-rag/src/cli.ts evaluate --synthetic && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T10: Document opt-in multi-harness setup and end-to-end contract

**Agent:** books-builder · **Harness:** pihouse · **Model:** default · **Blocked by:** T9 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `README.md`, `docs/architecture.md`, `docs/books-rag.md`, `packages/books-rag/test/integration.test.ts`, `docs/decisions/ADR-003-books-rag.md` (or T1's chosen number)

Objective: deliver a reproducible opt-in connection for pihouse/Claude Code/Codex without editing user settings or pi files automatically.

Acceptance:
- [ ] Document exact current client setup/removal commands or config fragments, using `node <absolute checkout>/packages/books-rag/src/mcp.ts`; inspect current client docs/settings format before claiming compatibility.
- [ ] Explain that all clients need the same local store; remote agents cannot resolve evidence solely from Pinecone. No hidden startup ingestion or library injection.
- [ ] Document environment variables chosen in T6, prerequisites, pricing verification, failure recovery, model-version rebuilds, extraction gaps, translation/vision costs, and private backups.
- [ ] Offline end-to-end integration starts from a synthetic PDF and exercises ingest→structural chunks→index via fake local-embedding/Pinecone endpoints→search→verified read→next-page figure, plus unrelated-query abstention. Do not substitute preseeded passages/vectors for the whole ingestion/indexing path. Include backend/runtime failure, missing/changed source, incomplete corpus, privacy-exclusion and text/image/output-budget cases. Assert source/version/location integrity and bounded explicit errors throughout. No real APIs, paid tokens, supplied-book content or downloads in automated tests. Transport image/text support and client compatibility claims name actual test scope.
- [ ] Clearly distinguish automated contract tests, local PDF inspection, optional real-model measurements, and manual client checks not yet run. Preserve the supplied PDF and unrelated configurations.

Validation: `node --test packages/books-rag/test/integration.test.ts && node packages/books-rag/src/cli.ts evaluate --synthetic && npm run check && npm test`.
Stop when: validation passes, or report BLOCKED after two failed attempts.

### T11: Independently review and integrate the completed feature

**Agent:** books-reviewer · **Harness:** pihouse · **Model:** default · **Blocked by:** T10 · **Parallel with:** none
**Skills:** spec-driven-development, documentation-and-adrs, git-workflow-and-versioning
**Files:** `docs/books-rag-review.md`; implementation fixes only in a separately dispatched scoped builder task if necessary

Objective: verify the approved contract and report the evidence and remaining operator prerequisites without overclaiming success.

Acceptance:
- [ ] Inspect staged/committed scope, dependencies, file-read safety, metadata leaks, output budgets, stale sources, partial indexing, warning-free commands, and no paid/external calls in tests.
- [ ] Re-run full validation, synthetic evaluation and the complete offline PDF ingest→chunks→fake-endpoint index→search→read→next-page figure integration, including abstention/failure/privacy/budget cases. Check evaluation is not tautological and figure/source assertions correspond to actual returned metadata. An extraction/render spike alone cannot complete T1–T11.
- [ ] Review local PDF diagnostics and explicitly name any absent real-model/Pinecone/client smoke evidence. Core violations block completion; optional operator checks are labeled pending.
- [ ] Record critical/major findings with file/line and reproduction. Executor sends scoped fixes to builder, revalidates, then requests review; two failed fix attempts stop BLOCKED.
- [ ] Final report names worktree/branch, local commits, selected skills, effective models, test results, measured versus unmeasured quality, and precise operator setup steps. No merge into the dirty source checkout or remote action.

Validation: `node packages/books-rag/src/cli.ts evaluate --synthetic && npm run check && npm test`; inspect `git diff --check` and scoped commit history.
Stop when: validation passes and no critical/major finding remains, or report BLOCKED after two failed attempts.

## Validation

From the isolated implementation worktree, after tools exist:

```sh
npm run check
npm test
node packages/books-rag/src/cli.ts --help
node packages/books-rag/src/cli.ts evaluate --synthetic
node --test packages/books-rag/test/integration.test.ts
node packages/books-rag/dev/inspect-pdf.ts --input '/Users/jeronimo.deli/Downloads/generative-ai-design-patterns-solutions-to-common-challenges-when-building-genai-agents-and-applications-1.pdf' --pages 169-174
git diff --check
```

The PDF command is a local operator check and must not trigger Pinecone, model downloads, or LLM calls. The CLI and module files above are planned outputs, not commands available at planning time. T1 may revise exact commands with documented technical reasons before implementation.

Current baseline before plan execution: specification-only changes passed `npm run check` and all 634 tests on 2026-10-27. This does not validate any new RAG behavior. If unrelated files have changed since then, establish and report the isolated worktree baseline instead of attributing unrelated failures to this feature.

## Out of scope

- EPUB implementation, EPUB-specific testing, archive/spine/anchor locators and EPUB assets: deferred by explicit user authorization for the PDF-only first version. Reject rather than partially ingest unsupported formats; this does not remove PDF path/asset safety checks.
- OCR/scanned-book pipeline, vision embeddings, visual similarity queries, LLM summaries/descriptions during ingestion, GraphRAG, RAPTOR, or a wiki rewrite.
- Hosting original PDF files, remote multiuser access/authentication, and integrated PDF/EPUB viewing. (Hosted extracted text/figures and single-user cross-machine use are now in scope per the hosted-corpus amendment.)
- Automatic Pinecone account/resource creation, plan upgrades, payments, cloud embedding fallback, and large model downloads.
- Production deployment, public sharing of books, licensing guarantees, DRM removal, or subscription scraping.
- Reworking workflow memory, changing pi internals, UI/statusbar changes, skill catalog changes, or unrelated self-learning work.
- Claiming perfect abstention, no hallucinations, best chunk sizes, or real Pinecone retrieval quality based only on synthetic/fake-vector tests.
