<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="assets/pihouse-light.svg">
    <img alt="pi-house" src="assets/pihouse.svg" width="160">
  </picture>
</p>

<h1 align="center">pi-house</h1>

<p align="center">
  A lightweight, inter-harness coding agent built on unmodified <a href="https://github.com/earendil-works/pi">pi</a>.<br>
  It plans with you and runs agents in their own cmux or tmux panes.
</p>

<p align="center">
  <a href="https://github.com/Jero110/pi-house/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Jero110/pi-house/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Jero110/pi-house/main/install.sh | bash
```

The installer asks whether to use cmux or tmux and installs `pih`, agent-link, and isolated pi-house configuration. To choose cmux without a prompt:

```bash
bash -s -- --backend cmux
```

Node.js 24+, git, and tmux (when selected) are installed if missing. See [Windows/WSL](#windows) for Windows setup. The optional Claude bridge is enabled with `--claude-bridge`; review provider terms and account policy before using subscription-backed access.

## Use

```bash
cd your-project
pih
```

Start a plan with `/skill:planner <idea>`, or use the workflow commands directly:

| Command | What it does |
|---|---|
| `/workflow report [--last]` | Writes a code-computed Markdown report and returns its path. Active work is labeled partial. It does not call a model or enroll the session. |
| `/workflow save [reason]` | Captures an otherwise unselected conversation for learning. |
| `/workflow digest` | Manually generates missing digests in separate agents for eligible evidence. |
| `/workflow self-learning` | Prepares missing digests, scans and reviews a batch in separate agents. Does not apply proposals. |
| `/workflow ask <question>` | Selectively consults retained workflow evidence, metrics, architecture and skills. |
| `/workflow proposals` | Lists proposed changes and their evidence/status. |
| `/workflow approve <id>` | Approves the displayed proposal version and attempts its validated application. |
| `/workflow reject <id> [reason]` | Records rejection and its reason. |
| `/skill:<name>` | Invokes a skill manually, e.g. `/skill:code-review-and-quality`. |

`/workflow review`, `/keeper`, and `pih keeper` are retired and return concise guidance; they are not aliases. Digest and review require an agent-link-enabled pihouse session. The initiating conversation gets short status and paths, not full generated output. Approval never means a proposal was silently or automatically applied.

On a fresh interactive `pih` start, pihouse may replace the saved default with an exact, authenticated Claude-bridge or OpenAI-Codex model only when its subscription quota has a fresh observation confirming room. If quota is unknown, it may keep/select an authenticated candidate with a clear uncertainty warning; if all observed accounts are exhausted, it makes no automatic selection and tells you to wait or use `/login` and `/model`. Claude's 5h/7d subscription windows are requested through Claude Code's experimental SDK `/usage` control request (no model prompt); local status-line files and response headers are fallbacks. OpenAI's subscription windows come from the ChatGPT usage endpoint. If either endpoint omits its windows or fails, the display cannot assert current percentages. This is not universal quota visibility: providers without a supported usage source cannot be confirmed. Explicit `--model`, resumed/forked sessions, and later manual `/model` choices remain authoritative. The temporary choice does not change the saved default; `/model` remains available and `Ctrl+S` there saves a new default.

## Self-learning and data

Planner/executor runs are selected automatically; other conversations require `/workflow save`. Reports and structured metrics are computed by code. Digesting and cross-run review are explicit, isolated model work. Unstable or unverifiable runs are deferred. Validated digest cleanup can remove only pi-house-owned captured conversational copies; it does not delete native harness sessions, repository files, or migration backups. Summaries can omit detail, and the system does not claim lossless transcript replacement.

Canonical knowledge remains readable documents. SQLite is authoritative for operational jobs, metrics, decisions and receipts; FTS5 is a rebuildable derived index, not the operational database. Everyday agents receive retrieval tools and a short instruction, not automatically injected memories. Routing uses explicit authorized profiles; unsupported or unknown availability pauses rather than silently enabling a paid fallback. Native model switching is limited to verified same-harness support. Optional context monitoring is opt-in and recommendations require manual application.

Legacy migration is explicit, not an automatic startup action. It creates a verified `migration-backup/` before importing. Snapshot and restore guidance, API limitations, and retention boundaries are in [Workflow self-learning](docs/self-learning.md). The detailed contracts are in [module specifications](docs/specs/self-learning/common.md); historical rationale remains in [ADR-001](docs/decisions/ADR-001-workflow-memory.md), with current decisions in [ADR-002](docs/decisions/ADR-002-self-learning.md).

## Books library

A read-only MCP server and CLI over a private PDF library: passage text in your Pinecone index, figures in your private S3 bucket, embeddings from a local Ollama model. A new `pih setup` registers the server with pihouse by default (needs Node >= 26.11.1, else setup warns and skips it; `--no-books` leaves it out; `--books-env-file <path>` or an inherited `BOOKS_ENV_FILE` points it at your env file). Claude Code and Codex are still configured by hand. pihouse never ingests, never searches on its own and adds no library text to session context; without an env file the tools answer with a configuration error. Setup for pihouse, Claude Code and Codex, costs, recovery and what is and is not verified: [Books RAG operator guide](docs/books-rag.md).

Ask the library from a terminal without a model: `node packages/books-rag/src/cli.ts ask "how should I decide microservice boundaries"` prints cited passages (book, PDF page, heading, score) or one line saying the library has no supporting evidence. In a pihouse session, `/skill:ask-books <question>` answers only from the library, and the `rag-based-development` build skill grounds plan tasks in it. Live measurements: [publication](docs/books-rag-live-publication.md) and [relevance calibration](docs/books-rag-live-calibration.md).

## Architecture

All diagrams use the same legend: blue = code/policy, purple = LLM processing, green = stored data, yellow = human action.

### Communication and ownership

```mermaid
flowchart LR
  U([Human]) --> P[pih / planner] --> H[Per-home agent-link hub]
  H --> E[Executor pane] --> W[Worker panes]
  W -->|result to parent| E
  H --> J[(Journal: agent identity and lineage)]
  P -. explicit retrieval .-> M[Separate memory MCP]
  W -. explicit retrieval .-> M
  M --> D[(Canonical documents)]
  M --> O[(SQLite operational state)]
  M --> F[(Derived FTS5 index)]
  N[No automatic memory injection] -.-> M
```

### Evidence to learning

```mermaid
flowchart TB
  H([Human manually starts digest / self-learning]) --> C[Code captures revision + metrics]
  C --> R[(Captured report and transcript copies)]
  R --> D{{Isolated digest agent}} --> V[Code validates identity and durable bytes]
  V -->|invalid, unstable, or live| Q[Retain and queue / defer]
  V -->|valid and quiescent| G[(Canonical digest + receipt)] --> X[Remove owned captured copies only]
  G --> S[Candidate scan] --> B{{Separate bounded batch review agent}}
  B --> P[(Review and proposals)] --> A([Human approves pinned change])
  A --> I[Allowlisted apply + validation] --> K[(Approved knowledge + receipt)]
```

### On-demand memory

```mermaid
flowchart LR
  H([Human asks]) --> A[/workflow ask/] --> M[Scoped memory MCP]
  E[Everyday agent] -. explicit search / get .-> M
  M --> F[(Rebuildable FTS5)]
  M --> D[(Canonical digests, reviews, approved records)]
  M --> O[(Operational SQLite: metrics, decisions, receipts)]
  M --> C[Bounded sourced context] --> E
  N[No startup injection] -.-> E
```

### Quota-aware routing

```mermaid
flowchart LR
  H([Human / plan authority]) --> P[(Explicit authorized profiles)]
  Q[(Observable quota, auth, capability)] --> R[Select compatible authorized option]
  P --> R
  R -->|verified native support| S[Same-harness model switch] --> W[One active writer]
  R -->|unknown / unsupported| X[Pause with reason; no silent paid fallback]
  R -. optional context monitor: recommendation only .-> H
```

The [architecture guide](docs/architecture.md) explains responsibility boundaries and limitations. These diagrams distinguish code decisions, model work, persistent state, and human authorization; they do not claim universal quota visibility. The pihouse initial model preference is separate from profile-based task routing; cross-harness continuation remains the explicit, fenced `replace` tool, never an automatic switch.

## Skills

Skills are plain Markdown organized in pre-build, build, post-build and extras groups. The [catalog](skills/README.md) lists them and their sources. The planner recommends development skills; selected skills are carried into the plan and executor tasks.

## MCP servers

**agent-link** launches and messages workers through native harness interfaces and journals their lineage. **cmux MCP** (cmux only) finds sessions and arranges panes/workspaces. Both use stdio; see [Architecture](docs/architecture.md) for package responsibilities and tool details.

## Windows

pi-house requires Unix sockets and a Unix shell. On Windows, use WSL2 with tmux:

```powershell
irm https://raw.githubusercontent.com/Jero110/pi-house/main/install.ps1 | iex
```

Open Ubuntu, then run `pih` from a project under the Linux home directory. See the [installer](install.ps1) for options.

## Develop

```bash
git clone https://github.com/Jero110/pi-house && cd pi-house
npm install --ignore-scripts
npm run check && npm test
```

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## Uninstall

```bash
pih uninstall             # removes the MCP registrations (a books entry you edited stays) and the pihouse profile
rm -rf ~/.pihouse ~/.local/bin/pih ~/.local/bin/pihouse ~/.local/bin/agent-link
```

## License

MIT. Third-party skills retain their licenses; see [skills/LICENSES](skills/LICENSES/README.md).
