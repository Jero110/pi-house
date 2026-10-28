# Books RAG operator guide

An optional, opt-in private library of PDF books for pihouse, Claude Code and Codex. One writer machine ingests
and publishes; any of your machines then reads through a stdio MCP server. Nothing in this package runs at pihouse
startup, ingests on its own, or injects library text into a session. Design record: [ADR-003](decisions/ADR-003-books-rag.md),
research and sources: [books-rag-research.md](books-rag-research.md), measurements: [books-rag-evaluation.md](books-rag-evaluation.md).

## What is verified, and what is not

| Evidence | Status |
|---|---|
| Automated contract tests (`npm test`, `packages/books-rag/test/*.test.ts`) | Run. Synthetic PDFs, loopback fakes of Ollama, Pinecone and S3. No real API, token or book. |
| Offline end-to-end test (`test/integration.test.ts`) | Run. Synthetic PDF through the real CLI (`ingest`, `index`) into the fakes, then a real `node src/mcp.ts` child process and in-process servers on a fresh empty reader store with the original deleted: search, verified read, next-page figure, unrelated-query abstention, outages, tampering, incomplete publication, privacy and budgets. |
| Synthetic evaluation (`evaluate --synthetic`) | Run. Pipeline correctness with a deterministic fake embedding. It is not embedding quality. |
| Local PDF inspection (`dev/inspect-pdf.ts`, pages 169-174 of the supplied book) | Run in T8, read-only; see the evaluation report. It checks extraction diagnostics, not retrieval. |
| Real Ollama model measurements | **Not run.** Ollama is absent on the development machine, so the pinned model, its tokenizer and real retrieval quality are unmeasured. |
| Real Pinecone and Supabase S3 | **Not run.** No S3 credentials, and no index or pricing was verified. The SigV4 client and adapters are tested against AWS published vectors and loopback fakes only, not against live Supabase. |
| Client checks (pihouse, Claude Code, Codex launching this server) | **Not run.** Only the stdio protocol over real and fake pipes is tested. Client commands below were checked against each client's `--help` and docs, not executed against your configuration. |

Do not read any row marked "not run" as validated.

## Model

- **Text in Pinecone.** Each passage is one record: its vector plus original and normalized text, heading path, PDF page
  spans, source hash and version, and figure links, as compact schema-2 metadata under 32768 bytes (Pinecone caps at 40 KB).
  An oversized record fails indexing naming the passage; nothing is truncated.
- **Figures and catalog in a private S3 bucket.** Figures are rendered once at ingestion (at most 1600 px, 2 MiB) and
  uploaded with the generation-based catalog manifest. Original PDFs are never uploaded.
- **A second machine needs only** the env file, Ollama with the same pinned model, and the MCP entry. No local corpus,
  no originals. Hosted records are checked against the committed catalog (version, hash, generation, record hashes);
  mismatches are dropped and reported as `incomplete_corpus`.
- **One writer.** `ingest` and `index` run on one machine at a time. The writer claim detects conflicts; it is not a
  distributed lock.
- **No hidden behavior.** The server only reads. It never ingests, never writes to a service and never creates a local store.
- **Privacy.** Book text sits in Pinecone and figures in your bucket, both third parties. Text and images a tool returns
  can also reach your agent's model provider. Returned content is labeled untrusted reference data.
- **Trust boundary of the bucket.** Anyone who can write to your bucket can already forge the catalog. Internally, reads
  of hosted objects (`Objects.discover`) accept any key under `S3_LIBRARY_PREFIX` whose name passes the safe-character
  check and whose self-declared `x-amz-meta-sha256` matches the bytes; that is not limited to catalog and figure keys. No MCP
  argument can reach it (figure reads use manifest-pinned hashes), and this is an accepted boundary: keep the bucket
  and its keys private, and use a dedicated prefix.

## Prerequisites

1. **Node >= 26.11.1** (verified on macOS arm64 only). Install with `npm install --ignore-scripts`.
2. **Ollama** with the pinned model, pulled by you: `ollama pull nomic-embed-text:v1.5`. The adapter checks the
   runtime version and the model digest `0a109f42...` (full value in the research file) and uses `truncate:false`. The
   endpoint must be literal loopback. If a machine has no Ollama, it cannot search; no cloud embedding fallback exists.
3. **Pinecone**: a serverless dense index, dimension 768, cosine metric, that **you** create. The adapter only describes
   it. `PINECONE_HOST` must be that index's host. Use a dedicated namespace.
4. **Supabase Storage (or any S3-compatible store)**: a **private** bucket and **S3 access keys** (Project settings,
   Storage, S3 connection). Do not use a `sbp_` personal access token: it is a Management API credential that can
   change projects, and the config loader rejects it.
5. A **private-canary object**: `index` (the writer) creates `S3_PRIVATE_PROBE_KEY` on first run. Every reader and
   `doctor` then require an unauthenticated GET of it to be refused. This proves one object, not the whole bucket
   policy; confirm the bucket is private yourself and only then set `S3_BUCKET_PRIVATE_CONFIRMED=true`.

### Env file

Plain `KEY=value` lines (no `:`; quotes optional). Keep it outside the checkout, `chmod 600`, and never commit it. The
repository `.gitignore` already ignores `.env` and `.env.*`.

```sh
umask 077
cat > ~/.config/books-rag.env <<'EOF'
BOOKS_DATA_DIR=/Users/you/.local/share/books-rag
PINE_CONE_API=...
PINECONE_INDEX_NAME=books
PINECONE_HOST=https://books-xxxx.svc.REGION.pinecone.io
PINECONE_NAMESPACE=library
S3_ENDPOINT=https://PROJECT.supabase.co/storage/v1/s3
S3_REGION=us-east-1
S3_BUCKET=private-books
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_LIBRARY_PREFIX=library/
S3_BUCKET_PRIVATE_CONFIRMED=true
EOF
chmod 600 ~/.config/books-rag.env
```

Resolution order for the file: `--env-file`, then `BOOKS_ENV_FILE`, then `./.env`. Process environment variables
override file values. The MCP server reads only `BOOKS_ENV_FILE`.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `BOOKS_DATA_DIR` | yes | Local working store (writer only; readers never create it). Keep outside the checkout. |
| `PINE_CONE_API` | yes | Pinecone API key (secret). |
| `PINECONE_INDEX_NAME` | yes | Name of your existing index. |
| `PINECONE_HOST` | yes | Exact host of that index (`https`, or literal loopback for tests). |
| `PINECONE_NAMESPACE` | yes | Dedicated namespace; every data call and delete is scoped to it. |
| `S3_ENDPOINT` | yes | S3-compatible endpoint; Supabase uses `https://<project>.supabase.co/storage/v1/s3`. |
| `S3_REGION` | yes | Signing region. |
| `S3_BUCKET` | yes | Private bucket name. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | S3 keys (secrets). Values starting `sbp_` are rejected. |
| `S3_LIBRARY_PREFIX` | yes | Key prefix ending in `/`, for example `library/`. |
| `S3_BUCKET_PRIVATE_CONFIRMED` | yes | Must be exactly `true`, after you verified privacy. |
| `S3_PRIVATE_PROBE_KEY` | no | Canary key; default `<prefix>_private-probe`. |
| `OLLAMA_URL` | no | Default `http://127.0.0.1:11434`; loopback only. |
| `OLLAMA_MODEL` | no | Default `nomic-embed-text:v1.5`; the digest is verified regardless. |
| `BOOKS_ENV_FILE` | no | Env file for the MCP and the CLI. |
| `BOOKS_RELEVANCE_FLOOR` | no | Search relevance floor, a plain decimal in (0, 1]. Default `0.78` (gate `synthetic-cosine-v1`). Any override reports gate `operator-cosine-v1`. See "Live recalibration". |
| `BOOKS_RELEVANCE_MARGIN` | no | Largest allowed score drop behind the best candidate, a plain decimal in [0, 1]. Default `0.08`. |
| `BOOKS_CHUNK_BOUND` | no | Default for `ingest --chunk-bound`; integer 100-1800 (default 1800). |
| `BOOKS_MCP_IMAGES` | no | `off` returns figure metadata and caption without the image block. |
| `BOOKS_PINECONE_CONTROL_URL` | no | Loopback-only test hook; Pinecone rejects any other value. Leave unset. |

## CLI

```sh
cd <absolute checkout>
node packages/books-rag/src/cli.ts --help
node packages/books-rag/src/cli.ts doctor   --env-file ~/.config/books-rag.env
node packages/books-rag/src/cli.ts ingest   --input /path/to/book.pdf --env-file ~/.config/books-rag.env
node packages/books-rag/src/cli.ts index    --env-file ~/.config/books-rag.env
node packages/books-rag/src/cli.ts prune    --env-file ~/.config/books-rag.env          # dry run
node packages/books-rag/src/cli.ts prune    --env-file ~/.config/books-rag.env --yes    # delete superseded IDs
node packages/books-rag/src/cli.ts evaluate --synthetic
```

`doctor` is read-only and prints no secrets. On a brand-new bucket it fails the privacy check until `index` has created
the canary once; that is expected. `ingest` takes a PDF or a directory (not recursive), rejects non-PDFs and symlinks per
file, and never modifies originals. `index` publishes as the single writer. After a successful index you may delete
originals yourself; the tool never does.

**New editions.** A file with new bytes becomes a **new book** unless you say otherwise. To record a changed original as a
new version of the **same** book, pass its ID: `ingest --input /path/to/new-edition.pdf --book <bookId>` (the IDs are in
`books_list`, and `ingest` prints a note with the exact command when the same path was already ingested with different
content). This is the only supersede rule: titles and file names are never matched for you. After the next `index` the old
version is no longer current and cannot be returned as fresh evidence; `index` leaves it out of the catalog. Re-ingesting
an earlier edition's exact bytes does not make it current again.

**Changed originals during `index`.** A current version whose original file changed after ingestion is skipped, with a
named line (`Skipped version_... (book book_...)`) on stderr, and the other books are published. Nothing changed is ever
re-read as if unchanged. If every current version is skipped, nothing is published and `index` fails. A skipped book that was
published earlier disappears from the catalog, and `prune` would then offer its hosted IDs, so read the dry run first.

**Chunk bound.** `ingest --chunk-bound <n>` (or `BOOKS_CHUNK_BOUND`) sets the chunk size bound, 100 to 1800 units. It is part of
the version identity: a different bound is a new version of the same book. Use a smaller bound when `index` reports a
passage above the record budget.

**Pruning.** `index` remembers each catalog it replaces in `BOOKS_DATA_DIR/previous-catalog-<commit>.json`. `prune` compares
those with the committed hosted catalog and lists the passage IDs that are no longer current. It deletes nothing without
`--yes`; with it, it deletes exactly those explicit IDs inside the configured namespace (never by filter or namespace) and
removes the saved files. It refuses to run while a publication is pending. Hosted figure objects in the bucket are not pruned.

## Connect a client (opt-in, manual)

Nothing below is run for you. Replace `<CHECKOUT>` with the absolute path of this checkout and
`<ENV>` with the absolute path of your env file. Pass only the **path** to the env file; the secrets stay in that
`chmod 600` file instead of in client configuration. The command is always
`node <CHECKOUT>/packages/books-rag/src/mcp.ts` (use the absolute path of a Node >= 26.11.1 binary if `node` on the
client's `PATH` is older).

Sources checked 2026-10-27: `claude mcp add --help` and `claude mcp remove --help` (Claude Code 2.1.310),
<https://docs.anthropic.com/en/docs/claude-code/mcp>; `codex mcp add --help` (codex-cli 0.163.0),
<https://developers.openai.com/codex/mcp>; and, for pihouse, this repository's `setPihouseMcp` in
`packages/pihouse/src/setup.ts` plus the `McpStdioServerConfig` type of the bundled pi 1.3.0
(`@earendil-works/pi-coding-agent`, `mcp.json` with a `mcpServers` map). Only these help texts, docs and source were
read; none of the commands was executed.

**Claude Code**

```sh
claude mcp add --scope user --env BOOKS_ENV_FILE=<ENV> books -- node <CHECKOUT>/packages/books-rag/src/mcp.ts
claude mcp remove books --scope user
```

**Codex** (`~/.codex/config.toml`, or `codex mcp add books --env BOOKS_ENV_FILE=<ENV> -- node <CHECKOUT>/packages/books-rag/src/mcp.ts`; remove with `codex mcp remove books`)

```toml
[mcp_servers.books]
command = "node"
args = ["<CHECKOUT>/packages/books-rag/src/mcp.ts"]
env = { BOOKS_ENV_FILE = "<ENV>" }
```

**pihouse** (`~/.pihouse/agent/mcp.json`; add this entry to the existing `mcpServers` object, remove it to disconnect)

```json
{
  "mcpServers": {
    "books": {
      "command": "node",
      "args": ["<CHECKOUT>/packages/books-rag/src/mcp.ts"],
      "env": { "BOOKS_ENV_FILE": "<ENV>" },
      "exposure": "direct",
      "description": "Search and read the private PDF library"
    }
  }
}
```

`pih setup` and `pih uninstall` do not touch this entry. The server starts with an empty local store and, if
configuration is wrong, still starts and answers each tool call with an explicit `configuration` error. To confirm
without a client, run `doctor`. The tools are `books_list`, `books_search`, `books_read` and `books_figure`.

Scope of the compatibility claim: the stdio protocol (initialize, tools/list, tools/call, text and image content blocks)
is tested over real child-process pipes and in-process streams with the repository's `cmux-mcp` transport. That
Claude Code, Codex or pihouse load and call these tools, and render the image, is **a manual check not yet run**. A client
without image support should set `BOOKS_MCP_IMAGES=off`.

## Costs and limits to verify before you start

No code can establish billing. Check your accounts' current terms on the day you start (the links were not fetched while writing this guide; the access-dated limits that were checked are in the research file):

- **Pinecone Starter**: storage, read and write unit and index limits (<https://www.pinecone.io/pricing/>). Passage
  records are large (up to 32 KB each); estimate records times size. Indexes created by you; this tool never upgrades.
- **Supabase Free**: storage and egress limits and the project pause after 7 days of inactivity
  (<https://supabase.com/pricing>). A paused project makes every reader report `unavailable`, which is not evidence that
  the books lack an answer; resume it in the Supabase dashboard.
- **Translation and vision**: the server calls no translation or vision model. Your agent may translate queries and view
  returned figures, which uses your agent provider's tokens. A figure is up to 2 MiB of image.
- Quota or billing responses (HTTP 402, or 429 with billing wording) stop the adapter with a `quota` error; it never retries
  into a paid tier.

## Failure recovery

- **Interrupted `index`**: run it again. Confirmed passages are skipped after a Pinecone fetch check, figures are
  re-verified by hash, and readers see nothing new until the catalog is committed.
- **Writer claim conflict** ("Another writer owns the hosted library", "Concurrent writer conflict"): another machine's claim
  object exists (`<prefix>writer.json`), or two runs overlapped. The tool never steals a claim. Confirm no other run is
  active, then decide deliberately; deleting the claim object is a manual operator action in your bucket.
- **Stale lock** `BOOKS_DATA_DIR/.index.lock` after a crash: remove it by hand once you know no `index` is running.
- **Schema 1 records** (written before schema 2): a reader drops each such candidate with an `identity_mismatch`
  diagnostic ("schema 1 is incompatible ... re-run `index`"), reports the corpus as incomplete, and still returns valid
  schema 2 evidence. On the writer, update the checkout and run `index` to republish with schema 2.
- **Changed original**: `index` skips that version by name and publishes the rest (fails only if all are skipped); restore
  the original, or run `ingest --input <file> --book <bookId>` to record the new edition as a new version of the same book. A
  missing original is fine; stored evidence is published.
- **Unavailable runtime or backend**: searches return `unavailable` with a diagnostic naming the failing stage; retry later.

## Model-version rebuilds

Every vector is tied to the pinned runtime and model digest. Changing the model or digest does **not** change a version's
identity (the source version ID is derived from the book, original bytes, extractor and chunk configuration): the same
passage IDs are rewritten in place under a new generation by `index`, and the catalog records the new embedding identity.
Readers on the old model get `model_mismatch`, and until the catalog commit a reader sees digest or generation mismatches
and fails closed rather than mixing results. Changing the chunk bound or extractor does change identity: re-ingest and run
`index`. Superseded hosted records are removed only by `prune`, and never by namespace or filter deletion.

## Live recalibration (pending operator step)

The relevance gate (`synthetic-cosine-v1`: floor 0.78, drop 0.08) was frozen on deterministic fake vectors. Nobody has measured
it with the real `nomic-embed-text` model, whose cosine scores for genuinely relevant passages may sit well below 0.78. If so,
a live install answers `insufficient_evidence` to everything. **Until you do this, do not rely on abstention.** Every
`books_search` result carries `gate.version`, `gate.minimumScore` and `gate.maximumDrop`, so an over-abstaining install is
attributable.

1. Pick a few labeled real questions before you look at any score: some the books answer (note the expected page) and some
   they certainly do not.
2. Set a deliberately low floor (`BOOKS_RELEVANCE_FLOOR=0.01`, `BOOKS_RELEVANCE_MARGIN=1`) for the measurement only, so
   nothing is gated, and run each question through `books_search`. Record `scores.dense` of the best answering passage and of
   the best passage for each unanswerable question.
3. Choose **one** floor and margin for the whole library from the gap between the two groups; do not tune per question. If the groups overlap, no
   floor separates them: keep the gate loose and rely on reading the passage.
4. Put the chosen values in the env file and re-run the questions. Keep the notes (model digest, library, values, scores).
   Overrides report `operator-cosine-v1`; changing the frozen defaults in source needs a new gate version name and a rerun of
   `evaluate --synthetic`.
5. Re-measure after any model, chunk-bound or corpus change.

## Extraction gaps

- **PDF only.** EPUB is deferred; other formats are rejected explicitly.
- **Scanned pages** have no text layer and become named gap pages (coverage `incomplete`); there is no OCR.
- **Owner-password or encrypted PDFs** are rejected, not decrypted.
- Code and tables are preserved as extracted, never repaired by guesswork; table relationships are not reconstructed.
  Figures link by explicit reference; uncertain cases return a labeled full page.
- Page numbers are physical PDF pages, not printed pagination.
- The 1800-unit chunk bound is a conservative proxy (UTF-8 bytes plus 32), not measured tokens.
- **Search latency grows with the number of books** (known limit, not changed): a search makes one Pinecone query per
  selected book, at least 500 ms apart, so about 10 s for 20 books, plus a few catalog reads. Pass `bookIds` to narrow it.

## Backups

Your original PDFs are the only full-fidelity source. Hosted text and figures are derived copies; Pinecone holds no
originals and the bucket none either. If you may ever need re-extraction (a better extractor, a new model), keep a private
copy of the PDFs somewhere you control before deleting local files. The local store is a working cache, not a backup.
