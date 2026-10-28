# ADR-002: Explicit, evidence-backed workflow learning

## Status
Accepted; supersedes only conflicting workflow-memory behavior in ADR-001.

## Date
2026-10-27

## Context
The first workflow-memory design used a long-lived keeper, hidden context resets, model-written reports, and automatic pruning. That couples routine sessions to accumulated context and treats short summaries as sufficient grounds for retention changes. The implemented workflow instead separates code-computed evidence, isolated model reasoning, durable operations, and human authorization.

## Decision
Keep canonical knowledge in readable documents, authoritative jobs, metrics, decisions and receipts in local SQLite, and FTS5 as a rebuildable derived index. Reports are code-only snapshots and may be partial. Digest and batch review are manual operations in separate agents; successful digests are technically validated and can authorize deletion only of pi-house-owned captured conversational copies. Unstable or unverifiable evidence is deferred. Native harness sessions, repository files, and migration backups are not deleted.

Expose `/workflow report [--last]`, `save [reason]`, `digest`, `self-learning`, `ask <question>`, `proposals`, `approve <id>`, and `reject <id> [reason]`. Retired review/keeper invocations return actionable errors, not aliases. Approval pins the displayed proposal version and is not automatic application: changes are limited to allowlisted skill/memory targets and verified with a receipt. The writer lock coordinates pi-house writers but is not an operating-system compare-and-swap against arbitrary editors; exact-change deduplication is not universal semantic equivalence.

Memory is consulted on demand through scoped retrieval. It is not injected at startup. Routing uses explicit authorized profiles and available signals; same-harness native switching is supported only where verified. Optional context monitoring requires opt-in and a manual apply action. Cross-harness continuation is an explicit, fenced agent-link `replace` (confirmed exit before one replacement, code-built continuation, late output dropped), not an automatic routing action. Manual skill expansion and grouped shell rendering are unsupported by the pinned pi API.

## Alternatives considered

- **Long-lived keeper with hidden context bootstrap:** rejected because it creates persistent hidden context and blurs operational state with model-authored summaries.
- **Automatic pruning or native-session cleanup:** rejected because evidence ownership and liveness cannot be universally verified.
- **Model-driven reports or startup memory injection:** rejected because reports need deterministic provenance and routine contexts should remain lightweight.
- **Vector/hosted search and automatic edits:** rejected because local canonical documents and explicit approval meet the current scope without new services or dependencies.

## Consequences
Users explicitly start digest/review work and approve changes. SQLite backups must be preserved alongside canonical documents; FTS may be rebuilt without discarding operations. Digest loss of detail is possible, so unavailable conversational context is acknowledged rather than silently recovered from native files. The Luna fixture smoke is a narrow experiment, not a generalized quality, cost, or model-ranking claim. See [architecture](../architecture.md), [workflow memory specification](../specs/workflow-memory.md), and [self-learning details](../self-learning.md).
