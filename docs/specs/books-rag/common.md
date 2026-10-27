# Traceable Books RAG: Shared Specification

**Date:** 2026-10-27
**Status:** Approved by the user on 2026-10-27; implementation requires separate plan approval.
**Map:** [CAPABILITY-MAP-books-rag.md](../../../CAPABILITY-MAP-books-rag.md)
**Observed branch:** `feature/lightweight-self-learning` (contains unrelated work; do not change or stage it).

## Objective and binding decisions

Provide a personal library of approximately 20 EPUB/PDF books to pihouse and other MCP clients. Retrieve only relevant passages, preserve verifiable source locations, and attach associated figures on demand. If retrieved evidence does not support the question, the agent must say it did not find support in the library rather than fabricate an answer or citation. This is a statement about the search, not proof that the entire library lacks the answer.

- Extraction, chunking, and embeddings run locally without generative-model calls. They consume local compute, storage, and possibly model-download bandwidth, not the agent's inference quota.
- Pinecone stores vectors and minimal indexing metadata. Full originals, extracted text, captions, and figures stay local.
- The existing agent translates/reformulates Spanish questions into the book language when useful; the MCP server calls no translation LLM. Translation uses the agent's normal inference budget. Preserve original technical identifiers and queries where useful.
- Retrieved passages and requested images may be sent to the agent provider. Vectors and metadata sent to Pinecone are not inherently private or anonymous.
- Never purchase, upgrade, or automatically provision paid resources. If the intended configuration requires payment or exceeds a verified free allowance, stop and report the constraint. Do not claim a free tier guarantees zero charges. Use only an explicitly configured index, with documented limits.
- No visual similarity search, bulk vision descriptions, OCR pipeline, integrated book viewer, DRM bypass, scraping of subscription platforms, or automatic deployment in this version.
- Figures accompany text matches through explicit references, captions, and conservative layout associations. Uncertain associations are marked, never silently asserted.
- This library is separate from workflow memory. Reuse infrastructure patterns, not memory content or scope semantics.

## Assumptions to validate before implementation

- Implement as an optional isolated TypeScript module/package in this repository, with a separate local corpus store and MCP entry. Final file layout is decided in the implementation plan.
- Use a local embedding runtime; choose its exact model, dimensions, version, download requirements, and context limit after documented investigation. No automatic large download or paid fallback.
- Investigate Pinecone's current API, index modes, metadata limits, pricing, and account constraints before choosing the retrieval implementation. “Hybrid” here describes local text plus hosted vectors; sparse+dense Pinecone search is not assumed available or free.
- A local lexical index combined with dense Pinecone candidates is a candidate approach for exact technical terms. Select the approach through evaluation, not an unsupported claim that vector search alone suffices.
- Start with structural chunks around 400–800 embedding-model tokens, then compare against at least one alternative on a labeled evaluation set. This is a tuning hypothesis, not an accepted optimum.
- Scanned/image-only pages are flagged explicitly. A partially extractable PDF must expose coverage gaps; its ingestion is not silently marked complete.

## Local evidence inspected

Source supplied by the user:
`/Users/jeronimo.deli/Downloads/generative-ai-design-patterns-solutions-to-common-challenges-when-building-genai-agents-and-applications-1.pdf`

Local PDFKit inspection found 694 PDF pages, 13 top-level outline entries, and only one page without extractable text (the cover). Rendered pages 169, 172, 173, and 174 were visually inspected. Temporary renders were generated outside the repository; no cloud upload or embedding request occurred.

- Figure 3-6 is on PDF page 172. Internal diagram labels are visible but absent from simple text extraction.
- Page 173 refers to Figure 3-7; its diagram and caption are on page 174.
- On page 169, visually intact Python identifiers such as `embedding_vectors` become fragmented in simple extracted text. The code block continues onto page 170.
- The “Semantic chunking” explanation spans pages 171–172, with “Handling images and videos” starting on page 173.
- File author metadata omits Hannes Hapke, who appears alongside Valliappa Lakshmanan on the title page. Preserve metadata provenance and conflicts; do not blindly trust one field.
- The PDF reports calibre as producer. Do not infer that its pagination matches the printed edition. Citation locations use explicitly labeled PDF page numbers.

This establishes feasibility, not validated automatic extraction accuracy, table fidelity, Pinecone ranking quality, or an optimal chunk size. Never commit the supplied book or rendered copyrighted pages as test fixtures.

## Tech stack and code style

Follow `AGENTS.md`: Node >=24, erasable TypeScript, top-level imports, no `any`, no changes to pi internals. New dependencies require documented necessity, exact version pins, and installation with `npm install --ignore-scripts`. Prefer existing MCP transport facilities such as `serveMcp` in `packages/cmux-mcp/src/server.ts`. Dependency choices remain research work, not approved dependencies.

Example style (a contract illustration, not implemented code):

```ts
export interface PdfLocation {
    kind: "pdf";
    pageNumber: number; // One-based position in this exact PDF, not a print-edition claim.
    printedLabel: string | null;
    bounds: readonly [number, number, number, number] | null;
}
```

## Commands and project structure

Existing repository validation commands:

```sh
npm run check
npm test
```

There is no build command. Existing test discovery is `packages/*/test/*.test.ts`; tests added by the implementation must participate in `npm test`. CLI entry points, arguments, and exact focused evaluation commands must be specified in the implementation plan before coding; no unimplemented command is presented here as runnable.

- `docs/specs/books-rag/`: this shared contract and three module specifications.
- `CAPABILITY-MAP-books-rag.md`: module index and dependency order.
- `docs/plans/books-rag.md`: future implementation plan, written only after spec approval.
- `docs/decisions/`: follow the existing ADR numbering and headings for architecture choices.
- Future source and test files live under `packages/`; choose the isolated location in the plan.
- User corpus data lives outside the checkout, in an explicitly configured private local directory.

## Testing strategy and quality gates

Use Node's test runner, synthetic EPUB/PDF/layout fixtures, fake local embedding endpoints, and fake Pinecone HTTP responses. Automated tests must never use real APIs, paid tokens, or a real user's book. Keep retrieval evaluation deterministic with fixed vectors or recorded synthetic fixtures, clearly separated from an optional operator-run real-model benchmark.

Mandatory success conditions:

1. Every returned quote resolves to its recorded source version and location; mismatched source hashes fail closed.
2. All mandatory synthetic figure/code/boundary/metadata cases in the module specs pass.
3. A labeled synthetic corpus includes at least 20 answerable queries and 10 unrelated queries, with expected passages and figure links. Candidate retrieval must reach recall@5 >= 0.90 on the answerable set. Include exact identifiers and equivalent English reformulations of Spanish questions.
4. All 10 unrelated fixtures produce `insufficient_evidence` under the frozen test configuration. Report false positives and false negatives; similarity scores are not probabilities, and these fixtures cannot prove universal abstention.
5. Compare at least two chunk configurations and report recall@5, unnecessary text returned, and citation/figure correctness. Freeze the chosen configuration and embedding identity for reproducibility.
6. Enforce server-side output limits, visible truncation, and cursor-based continuation. No response dumps an entire chapter by default.
7. Agent citation discipline is documented and evaluated separately from server-side provenance tests. An arbitrary MCP client can ignore instructions; do not promise tool-level enforcement of every generated assertion.

## Boundaries

- Always: preserve originals; record extraction/model versions; distinguish unavailable service, incomplete extraction, and insufficient evidence; run checks/tests; keep secrets and source books out of git; label external content as untrusted data.
- Ask first / stop and report when unattended: paid resources, dependency choices beyond approved research constraints, large model downloads, materially changed privacy boundaries, or replacing Pinecone. Never silently route to a cloud embedding service.
- Never: patch pi, modify unrelated work, upload passage text as Pinecone metadata, fabricate author/edition/page fields, claim RAG eliminates hallucinations, or interpret a service error as no matching content.

## Approval gate

Approve the shared contract and all three module specifications before creating the execution plan. Planning must happen in a later turn than specification creation. No execution handoff is authorized by specification approval alone.
