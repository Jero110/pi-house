# Spec: book-corpus

**Status:** Approved by the user on 2026-10-27. **Depends on:** none.
Shared objective, stack, commands, style, testing rules, assumptions, and boundaries: [common.md](common.md).

## Objective

Turn locally supplied EPUB and text-bearing PDF books into a versioned local corpus whose text, structural chunks, and associated figures resolve back to exact original locations without generative-model ingestion.

## Structure and boundary contract

Implementation belongs in an isolated module under `packages/`, with tests under its `test/` directory; the plan must select exact paths. No workflow-memory database reuse. Expose typed corpus operations to `book-retrieval`: enumerate versions/chunks, resolve immutable passage IDs, resolve figure IDs, and report source availability and extraction completeness.

A source record contains stable book identity, immutable version identity, SHA-256 of original bytes, format, original local path, title, authors, publisher, edition/publication fields when present, field provenance/conflicts, extractor identity/configuration, and extraction diagnostics. Unknown fields are null rather than inferred facts. Metadata overrides are explicit and retain provenance.

A passage contains immutable ID, source version/hash, full heading path, parent-section ID, original extracted text, separately normalized searchable text, mapping back to source blocks, ordered source spans, neighbor IDs, figure references, and quality flags. Configuration changes produce a distinct index version. A section starts/ends at structural boundaries, including mid-page positions; outline destinations are hints to validate against content, not unquestionable boundaries.

PDF spans record one-based physical PDF page number and block coordinates with coordinate-system definition. Printed labels are separate and only populated when reliably available. EPUB spans record archive document/spine identity, heading anchor when available, and a stable text/block locator; no synthetic PDF-style pagination.

Figure records contain source version, figure identifier, exact caption when present, page/location, optional confident crop bounds, linking evidence, and whether output is a crop or full-page fallback. Keep them local. Support lazy rendering so ingestion need not store a raster of every page. Figure references crossing page boundaries must resolve. If an EPUB image cannot be safely decoded, return an explicit unsupported-asset result rather than executing active content.

## Chunking behavior

- Use chapter/pattern/subsection structure first, then complete paragraphs within embedding input limits. Include heading context in search representation and preserve its distinction from literal quoted text.
- Initial 400–800-token target is adjustable by retrieval evaluation and must use the selected embedding model's tokenizer or a documented conservative bound.
- Never cut merely at page boundaries, join different pattern sections indiscriminately, or let overlap create confusing duplicate citations.
- Keep code/table blocks structurally intact where input limits allow. Oversized blocks require explicit continuation and shared headers/context, not silent truncation.
- Code repair must not guess identifiers. Preserve original extraction and the source rendering; flag uncertain reconstruction. Table reconstruction must preserve headers, units, and cell relationships or expose a quality warning and page fallback.
- Associate figures through explicit IDs first. Conservative layout/caption links may supplement them with confidence/status. Mere co-location on a page does not establish relevance.
- Exclude index/back matter and boilerplate from default content retrieval, while retaining them as source material; do not discard all chapter introductions as boilerplate.

## Success criteria and tests

- [ ] A synthetic 171–174-style fixture yields a coherent subsection across pages and links a next-page figure without crossing the next heading.
- [ ] A code block spanning two pages is preserved or flagged, never silently rewritten; source location remains available.
- [ ] Figures rendered as PDF vectors are available through rendering even if there is no single embedded bitmap.
- [ ] Unknown crop bounds yield an explicitly labeled full page; an absent figure yields an explicit error.
- [ ] Metadata with one file author and two title-page authors retains both evidence sources and a visible conflict/override, not a fabricated silent merge.
- [ ] Synthetic tables retain header/row relationships or receive a quality flag. No claim of table fidelity is made solely from plain text extraction.
- [ ] Unchanged imports are idempotent; changed files/extractors/configuration create new versions, and old versions cannot be mistaken for current ones.
- [ ] Scanned pages, encrypted/unsupported PDFs, malformed EPUB archives, unsafe archive paths, oversized assets, and extraction failures have explicit bounded diagnostics.
- [ ] Source modification/missing originals is detected on evidence resolution, including lazy figure reads; no stale citation is returned as verified.
- [ ] Tests and git contain only synthetic or suitably licensed fixtures, never the supplied commercial PDF.

## Commands and validation

`npm run check` and `npm test`; the future plan names exact module-specific commands. All automated tests use fixtures and local fakes. A separate optional local operator check may inspect the supplied book without committing it or sending it to an API.

## Boundaries

Always preserve provenance and expose uncertain extraction. Stop before adding an unapproved extraction dependency or OCR workflow. Never mutate original books, bypass DRM, execute embedded scripts, or describe figures with an ingestion LLM.
