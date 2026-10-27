# Capability Map: Traceable Books RAG

Status: module boundaries and specifications approved by the user on 2026-10-27; implementation plan pending approval.

| Module id | Responsibility | Depends on | Specification |
|---|---|---|---|
| book-corpus | Local extraction, source identity, structural chunks, original text, and linked figures | — | [book-corpus](docs/specs/books-rag/book-corpus.md) |
| book-retrieval | Local embeddings, Pinecone indexing, bounded retrieval, and evidence resolution | book-corpus | [book-retrieval](docs/specs/books-rag/book-retrieval.md) |
| books-mcp | Read-only multi-harness tools and the agent citation contract | book-retrieval | [books-mcp](docs/specs/books-rag/books-mcp.md) |

Build order: book-corpus → book-retrieval → books-mcp. All modules use the [shared contract](docs/specs/books-rag/common.md).

This is a personal library of approximately 20 EPUB/PDF books. Retrieval is text-based; figures accompany relevant passages on demand. Complete books and extracted text remain local. Pinecone receives vectors and minimal metadata, not passage text, captions, image bytes, absolute paths, or secrets. The agent provider receives retrieved passages and requested figures. This is not an entirely offline system.

Only the user-selected development skills apply: spec-driven-development, documentation-and-adrs, and git-workflow-and-versioning. Planning and implementation must wait for specification approval in a later turn.
