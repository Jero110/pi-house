# Read-only `ask` smoke — 2026-10-28

Operator gate `operator-cosine-v1`: floor 0.68, drop 0.05. Real hosted library,
local pinned embeddings; no LLM calls. Commands completed with exit 0:

```sh
node packages/books-rag/src/cli.ts ask "what is semantic chunking" --json --env-file <private-env>
node packages/books-rag/src/cli.ts ask "How long should I bake sourdough bread in a Dutch oven?" --json --env-file <private-env>
```

Only status/citations/scores are reproduced; no excerpts. These are retrieval
candidates, not an asserted answer or passage-support judgment.

## `what is semantic chunking`

Status: **ok**.

| Book title | Passage ID | Physical PDF pages | Dense score |
|---|---|---|---:|
| Generative AI Design Patterns | `passage_2363a789c188c3a4c9bb7d397355fa42` | 184–185 | 0.761777520 |
| Generative AI Design Patterns | `passage_d9ed7b7ba18d60a5732eee1f7e8aad80` | 171–172 | 0.760521531 |
| Unknown title (`book_2cb5bfc37be30316225300eb97341bc8`) | `passage_9b15671baf8cbc57382556dde25952ef` | 215 | 0.760077834 |
| Generative AI Design Patterns | `passage_6e1041d6dac15ff568d3f1e32449f1ea` | 678–680 | 0.753309727 |
| Generative AI Design Patterns | `passage_8de35b35debfef68ab7db6dd8552756e` | 165 | 0.747656226 |

## Unrelated question

Status: **insufficient_evidence**. Citations: **none**.
