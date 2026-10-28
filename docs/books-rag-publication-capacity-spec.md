# Publication capacity specification and implementation plan

## Objective / approved scope
Implement the user's approved internal capacity fix for a 19-book library (up to 20 books), without any service use, payment, provisioning, model download or re-ingestion. The detailed user request is the approved specification; no further approval gate is required for this standalone execution.

## Commands / structure / style
`npm run check && npm test && node packages/books-rag/src/cli.ts evaluate --synthetic`.
TypeScript adapters and publication orchestration live in `src/`; Node synthetic tests in `test/`; operational instructions in `docs/`. Follow existing explicit immutable interfaces and `AdapterError("resource_limit", redactedMessage)` style. No dependencies added.

## Plan and acceptance
1. Add validated finite capacity settings and a persistent publication receipt for physical attempts, outbound body bytes and inbound response bytes. Reserve before dispatch; interrupted requests retain conservative charges. Count probes, retries and visibility responses including values, not merely logical operations.
2. Before the first hosted write, build compact manifests one source at a time, validate every object/record, and check planned capacity against remaining cumulative allowances. Estimates are not runtime guarantees; retry/response ceilings remain hard stops. Never reset consumed allowances on resume automatically.
3. Raise internal adapter ceilings to at least 50k vectors/inputs, 1 GiB S3 payload with finite appropriate call/write limits. Preserve per-record, request/response, image, model input, privacy, rate, queue and integrity limits.
4. Amortize writer checks across bounded batches; retain claim/base checks before/after batches and root-last verification. TTL-cache index/model probes. No portable S3 CAS or distributed exclusion is claimed.
5. Test old-limit-exceeding synthetic counters, refusal before uploads, restart charges, actual response accounting and conflict prevention; update operator documentation with unknown account facts explicitly retained.

## Boundaries / validation
Always run offline checks, inspect scoped diff and commit. Never print corpus text/secrets, change provider APIs without tested evidence, change MCP output caps, or contact real services. Account plan/quota eligibility and namespace authorization remain prerequisites, not inferred from internal capacity.
