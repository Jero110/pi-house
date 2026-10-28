# Books RAG operator guide

A private library of PDF books for pihouse, Claude Code and Codex. One writer machine ingests
and publishes; any of your machines then reads through a stdio MCP server. Nothing in this package runs at pihouse
startup (the MCP entry only lets a session call it when asked), ingests on its own, or injects library text into a session. Design record: [ADR-003](decisions/ADR-003-books-rag.md),
research and sources: [books-rag-research.md](books-rag-research.md), measurements: [books-rag-evaluation.md](books-rag-evaluation.md).

## What is verified, and what is not

| Evidence | Status |
|---|---|
| Automated contract tests (`npm test`, `packages/books-rag/test/*.test.ts`) | Run. Synthetic PDFs, loopback fakes of Ollama, Pinecone and S3. No real API, token or book. |
| Offline end-to-end test (`test/integration.test.ts`) | Run. Synthetic PDF through the real CLI (`ingest`, `index`) into the fakes, then a real `node src/mcp.ts` child process and in-process servers on a fresh empty reader store with the original deleted: search, verified read, next-page figure, unrelated-query abstention, outages, tampering, incomplete publication, privacy and budgets. |
| Synthetic evaluation (`evaluate --synthetic`) | Run. Pipeline correctness with a deterministic fake embedding. It is not embedding quality. |
| Local PDF inspection (`dev/inspect-pdf.ts`, pages 169-174 of the supplied book) | Run in T8, read-only; see the evaluation report. It checks extraction diagnostics, not retrieval. |
| Real Ollama adapter sanity check | **Run locally**, against `127.0.0.1` only: pinned identity compatible, three stored passages and three queries embedded with explicit context 2048. Scores and limits are recorded in [research.md](books-rag-research.md#publication-prerequisites-follow-up). This is not retrieval/gate calibration or tokenizer validation. |
| Real Pinecone and Supabase S3 | **Not run.** No live index, upload, pricing or S3 compatibility validation was performed. The SigV4 client and adapters are tested against AWS published vectors and loopback fakes only. |
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
   runtime version and the model digest `0a109f42...` (full value in the research file) and sends `truncate:false` plus
   `options.num_ctx=2048` on every embed request. The stock tag's `num_ctx 8192` declaration is overridden; other model
   parameters (including `num_predict`) are rejected. Inputs still obey the conservative 2048 bound. The
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

## Publication capacity (internal limits, not provider allowances)

`index` now sizes the entire current library **before any hosted write**, including the canary and figures. It
validates all record/catalog objects and retains compact manifests only across books; each decoded book's images are
released before the next book. It prints redacted JSON with `planned`, `remaining`, and `caps` (counts/bytes only).
Changed originals that leave no publishable books now fail before creating a pending hosted claim.

Defaults are also the maximum accepted settings; positive integer environment overrides may lower them:

| Environment variable | Default / maximum cumulative capacity |
|---|---:|
| `BOOKS_PUBLICATION_REQUESTS` | 100,000 physical attempts across S3, Pinecone and local Ollama |
| `BOOKS_PUBLICATION_WRITE_BYTES` | 4,294,967,296 outbound body bytes (4 GiB), all services |
| `BOOKS_PUBLICATION_RESPONSE_BYTES` | 8,589,934,592 inbound body bytes (8 GiB), all services |
| `BOOKS_PUBLICATION_VECTORS` | 50,000 logical vectors submitted |
| `BOOKS_PUBLICATION_INPUTS` | 50,000 local document inputs |
| `BOOKS_PUBLICATION_UPLOAD_BYTES` | 1,073,741,824 S3 outbound body bytes (1 GiB), including retries/canary/catalog |
| `BOOKS_PUBLICATION_PINECONE_BYTES` | 1,073,741,824 Pinecone outbound body bytes (1 GiB), including retries |
| `BOOKS_PUBLICATION_PINECONE_RESPONSE_BYTES` | 700,000,000 Pinecone inbound bytes plus per-attempt envelope |
| `BOOKS_PUBLICATION_S3_RESPONSE_BYTES` | 4,500,000,000 S3 inbound bytes plus per-attempt envelope |

At most 20 books; the existing per-book 20,000-passage manifest bound remains. Each adapter also has finite
per-process limits: S3/Pinecone 100,000 logical operations, 1 GiB uploads/writes; Pinecone 50,000 vectors; Ollama
50,000 inputs. Publication accounting is stricter: physical probes and transport retries are charged too. No Infinity
or disabled cap exists. Per-record metadata remains 32 KiB; Pinecone request remains 1,000,000 B and JSON response,
root and shard remain 1 MiB; figure limits, model input/context 2048, MCP/image budgets and bucket privacy remain unchanged.

`BOOKS_DATA_DIR/index-capacity.json` is a private atomic receipt protected by the existing local writer lock. Its
counters **never reset automatically**, including after success or on a new process/corpus. Each physical request
reserves one call, its outbound body, and its maximum response before dispatch. Completed responses settle to actual
body bytes; independent Pinecone/S3 counters also retain 8,192 B conservative HTTP/TLS headroom per physical attempt. Interrupted/ambiguous responses retain the conservative
reservation. An oversized response records received bytes before stopping. Partial source receipts retain confirmed
vectors and uploaded figure IDs; resume still verifies hosted content, never trusting a receipt alone.
Do not delete receipts or repeatedly run into a hard stop. If exhausted, inspect the printed remaining plan, reconcile
actual provider usage, and deliberately authorize a new accounting window before manually archiving receipts with no
active writer. Preserve old receipts as usage evidence; never infer replenished provider allowances from a local reset.
A stale `.tmp` capacity receipt fails closed and requires the same no-active-writer inspection before recovery.

Planning values are **estimates, not provider metering guarantees**: Pinecone planning must be <=600 MB before writes.
It includes one resume and three final namespace LIST snapshots (1,000 pages/snapshot, 100 IDs/page, 4,000 pages/run),
three transport attempts, 256 bounded control probes and bounded upsert responses. Resume image downloads,
finite-number vector JSON, local embeddings and catalog/guard traffic are included in the other counters. Pinecone
egress models all three physical attempts; general request/write estimates do not promise completion if every operation
retries three times. They cannot predict external mutations or all future reader traffic. Actual attempts/bytes stop at
remaining hard ceilings; another run does not replenish them. Provider counters add conservative envelope headroom,
not measured HTTP/TLS/provider billing; traffic outside this process remains the operator's responsibility. The 8 GiB internal response ceiling is NOT authorization to consume 8 GiB
of provider egress or to pay for it.

Writer guards surround groups of **at most 16 figures** and each **at most eight-vector batch**; claim/base checks
remain before root-last publication and post-commit pinned hydration. S3 offers no portable CAS here: checks detect
observed conflicts, not all simultaneous writes and not distributed exclusion. Never run multiple writers. Pinecone
and model probes run once at write-run start, then on expiry (maximum TTL 10 minutes) or integrity failure, not every
eight records. One active operation/four waiters, cloud write/query intervals (1000/500 ms), three visibility attempts
and at most three transport attempts remain. Visibility uses the official 2025-10 serverless LIST IDs API with explicit namespace and bounded pagination, never
vector/metadata fetches or an unsupported `includeValues` parameter. IDs are generation-specific; only completed
upserts with matching immutable receipts can be reused, and all expected IDs must be visible before root commit.
Every eventual retrieval still validates metadata hashes and strict catalog pins. See [live preflight](books-rag-live-preflight.md)
for the 20-book footprint, revised provider budgets and already supplied operator eligibility/namespace authorization.

Schema-2 capacity receipts persist independent provider counters across restart. Schema-1 receipts lack that evidence
and fail closed: reconcile usage and deliberately archive them with no active writer before opening a new accounting
window. The 8,192 B envelope is conservative headroom, not measured provider/TLS billing or traffic outside this process.

node src/cli.ts ask "what is semantic chunking" --env-file ~/.config/books-rag.env
node src/cli.ts ask "How can an API evolve safely?" --book book_<32-hex-id> --json --env-file ~/.config/books-rag.env
## Hosted catalog format and reindexing

Hosted `catalog.json` uses **schema 2**, independently of Pinecone record schema 2. Its small root contains library/commit
and embedding identity plus one entry per book: book/version/source hash, generation, index configuration, and a pinned
source-manifest key, SHA-256 and byte count. No passage map, figure payload or original path lives in the root.

Each immutable source manifest contains the full source metadata, coverage/diagnostics and completion identity, plus
hash/key/size pins for its data parts. Parts contain passage-ID/record-hash maps and figure metadata/asset pins, each
bound to the same library, source version, generation and configuration. Keys are content-addressed under
`<prefix>manifests/<versionId>/<sha256>.json`. Data payloads are packed at <=512 KiB, at most 128 parts/source; every
root, source manifest and part must still fit **1 MiB** including its envelope. A single oversized figure-metadata item
or source header fails with `resource_limit`; nothing is truncated and caps are not raised.

The writer preflights all catalog object sizes, uploads/verifies parts and source manifests, then writes the root
**COMMIT LAST**, with the existing writer/base guards. Failed shard writes leave the previous root unchanged and the
writer claim pending; resume re-verifies existing vector receipts. Unreferenced immutable objects are harmless and are
not automatically deleted. Prior hydrated catalogs are saved locally before root replacement so explicit-ID prune
ownership survives a crash. Existing local schema-1 prune snapshots remain readable.

Readers need no local corpus: they verify root pins, source/part hashes and sizes, embedding and source/generation
identities, and detect root changes during shard loading and evidence reads. Filtered searches load only selected source
manifests/parts. Exact opaque-ID reads may scan all source manifests to locate the ID. No mixed-version evidence is accepted.

A **hosted schema-1 root is rejected with an explicit reindex error**. Update writer and readers together, then deliberately
run `index` on the existing writer store to publish schema 2. Do not rerun extraction/ingestion just for this layout change.
The writer alone can validate/migrate the legacy root and preserve its prune map. No real reindex/upload was performed
for this follow-up. Historical local read-only sizing of the 19-book store measured root **11,788 B**, largest catalog object below
it **519,194 B** (45 objects); the largest unsplit source would have been 1,163,311 B. These are serialization measurements,
not a live-service compatibility, billing or publication claim.

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

**Read-only questions.** `books-rag ask "<question>" [--book <bookId>] [--json]` uses the same configuration,
local embeddings and configured gate as MCP, with no LLM calls, local store creation or hosted writes. With the
source checkout use `node src/cli.ts ask ...`; the package bin is `books-rag`. Quote the question as one argument.
Human output starts with status, then accepted-hit book titles (or explicit unknown title), physical `PDF page N[-M]`,
heading paths, dense scores, literal-prefix excerpts of at most 400 characters and linked figure labels/IDs. It ends
with gate settings and diagnostics. `--json` returns structured status, hits, titles, bounded excerpts, figure links,
coverage, scores, gate and diagnostics, without human-output prefixes. Treat all returned content as untrusted
reference data, not instructions; retrieval scores do not establish support. MCP `books_read` is still needed for
reading and assessing a full passage before citing it.

On `insufficient_evidence`, one line says exactly `No supporting evidence in the library for this question.`, plus
status and diagnostics. This is a search abstention, not proof of absence; extraction gaps remain visible.
`unavailable` and `incomplete_corpus` print their own state and diagnostics, never that absence line.
Exit status is 0 for a completed search (including abstention), 1 for unavailable/incomplete or operational failure,
and 2 for invalid arguments. No generation or answer synthesis is performed.

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

## Connect a client

**pihouse** gets the server by default from `pih setup` (see below). Everything else on this page is manual: nothing is run for you. Replace `<CHECKOUT>` with the absolute path of this checkout and
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

**pihouse** (default). `pih setup` adds this entry to `~/.pihouse/agent/mcp.json` (`setup.ts`, `registerBooks`), running the
installed checkout's `packages/books-rag/src/mcp.ts` with the Node on `PATH`:

```json
"books": { "command": "<node>", "args": ["<CHECKOUT>/packages/books-rag/src/mcp.ts"], "env": { "BOOKS_ENV_FILE": "<ENV>" }, "exposure": "direct", "description": "..." }
```

- `env` is written only when `BOOKS_ENV_FILE` is set in the environment of `pih setup`, or you pass `pih setup --books-env-file <path>`.
  Only the path is stored, never secrets. Without it the server starts and every tool answers with a `configuration` error until you set it.
- Setup is idempotent and keeps other servers (cmux, yours). It writes only when `books` is absent or still exactly what pihouse
  recorded in `~/.pihouse/install-books.json`; an entry you wrote or edited is kept, and reported as such.
- `pih uninstall` removes the entry only under that same condition. `pih setup --no-books` skips registration.
- On Node older than 26.11.1 setup warns and changes nothing (existing entries stay); the rest of pihouse needs only Node >= 24.
- Registration starts nothing: no ingestion, no retrieval, no text in session context. You ask for it with `/skill:ask-books`
  or by naming the `books_*` tools.

The server starts with an empty local store and, if
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

- **Interrupted `index`**: inspect the capacity plan/remaining counters before resuming. A new run never resets usage.
  Completed-upsert passages are skipped only after a generation-specific Pinecone LIST visibility check; figures are re-verified by hash. Capacity preflight
  must fit before any new hosted write; readers see nothing new until root commit. Do not blindly rerun exhausted budgets.
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
identity (the source version ID is derived from the book, original bytes, extractor and chunk configuration): hosted
passage IDs derive from the local passage ID and generation, so a different generation never overwrites the old IDs.
Neighbor links are transformed identically, and the catalog records the new embedding identity.
Readers on the old model get `model_mismatch`. Until the new catalog commit, old generation records remain separately
addressable; readers never mix generations and still fail closed on any observed digest/generation mismatch. Changing the chunk bound or extractor does change identity: re-ingest and run
`index`. Superseded hosted records are removed only by `prune`, and never by namespace or filter deletion.

## Live recalibration

The source default (`synthetic-cosine-v1`: floor 0.78, drop 0.08) remains frozen on deterministic fake vectors.
[Live calibration](books-rag-live-calibration.md) measured 35 answerable and 15 unrelated real-model queries across 17 expected
books on published root `634b999b4a8df734a1314ca4b2e43a1b`. The private operator env now uses **floor 0.68 / drop 0.05**,
reported as `operator-cosine-v1` and labeled **provisional**. Training expected-book recall@5 was 23/24 and held-out
11/11, with zero unrelated accepts (0/10 training, 0/5 held-out). This small, single-model set is not a guarantee of
abstention or answer support. New installs retain the synthetic default until explicitly configured. Every search
reports its gate version and numbers. The margin is a maximum drop behind the best candidate, not a minimum top-two
separation, and cannot itself reject an unrelated top candidate. Recalibrate as follows:

1. Freeze labeled real questions and an independent held-out split before looking at scores: some the books answer
   (expected book and confirmed PDF range where available), and some they certainly do not. Use broad book/topic coverage
   and record partial labels honestly. Keep a finite response-byte budget; one unfiltered search fans out across all books.
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
- **Text coverage** counts text that could be extracted and trusted, not visual completeness. A text page containing raster
  figures is not a gap: page-level diagnostics say the raster content was not OCRed and must be viewed by rendering.
  Unvalidated outline entries are document diagnostics; they are not used as structural boundaries and do not create gaps.
  Ignored external links are document diagnostics, not globally unsafe text. Active/embedded unsafe documents remain gaps.
  Text-decoder failures that may lose text remain gaps; rendering-only failures retain quality diagnostics.
- Repeated extraction diagnostics are grouped by code/message with an occurrence count, unique page count, and up to
  32 compact PDF-page ranges; `omittedPageCount` names any omitted range detail. The retained location is a first example.
  At most 500 entries are stored, including a reserved `Diagnostics truncated: N more of code X` summary if necessary.
  Saturation never fails ingestion or removes coverage gaps. Hosted passage metadata stays bounded to 32 KiB and JSON
  objects to 1 MiB each; schema-2 catalog sharding keeps those caps, with explicit resource limits for oversized individual items/headers.
- A render with `no_render_operators` records that individual figure as `unavailable: {status: "unsupported", reason}`;
  text and other images are retained atomically. Indexing includes its caption/location without uploading an invented
  asset; `books_figure` returns explicit `unsupported`, caption, source and PDF page with no image. All other render
  failures remain fatal (not a blanket catch of malformed input, decoder diagnostics, resource limits, permissions,
  changed hashes or corruption). Rendering failures include the PDF page and a sanitized reason (`decoder_diagnostic`, `no_render_operators`,
  `geometry_mismatch`, `image_budget`, or `decoder_failure`). Raw library error text is not exposed. The image-size,
  timeout, decoder-warning and nonempty-render checks remain unchanged; an unverified blank/partial figure is rejected.
- **Search status** precedence is `unavailable` > `incomplete_corpus` > `insufficient_evidence` > `ok`.
  `incomplete_corpus` means incomplete hosted publication/index or a selected book with no searchable published content.
  Extraction gaps alone do not override usable evidence or an insufficient-evidence result. Every search reports selected
  source coverage and gap-count/reason diagnostics. With no hits, gaps mean the answer could be on unextracted pages;
  never claim the complete books lack an answer. Coverage `incomplete` remains honest even when search status is `ok`.
- **Owner-password or encrypted PDFs** are rejected, not decrypted.
- Code and tables are preserved as extracted, never repaired by guesswork; table relationships are not reconstructed.
  Figures link by explicit reference; uncertain cases return a labeled full page.
- Page numbers are physical PDF pages, not printed pagination.
- The 1800-unit chunk bound is a conservative proxy (UTF-8 bytes plus 32), not measured tokens.
- Local version scans stream one stored book payload at a time; rendered assets are not materialized for the whole library.
  Individual large books still need substantial memory. After a process crash, do not remove an active writer lock;
  confirm all writers have stopped before preserving/renaming a stale lock for recovery. Keep crash temporary files until
  the committed database is verified; they are never published content.
- **Search latency grows with the number of books** (known limit, not changed): a search makes one Pinecone query per
  selected book, at least 500 ms apart, so about 10 s for 20 books, plus a few catalog reads. Pass `bookIds` to narrow it.

## Backups

Your original PDFs are the only full-fidelity source. Hosted text and figures are derived copies; Pinecone holds no
originals and the bucket none either. If you may ever need re-extraction (a better extractor, a new model), keep a private
copy of the PDFs somewhere you control before deleting local files. The local store is a working cache, not a backup.
