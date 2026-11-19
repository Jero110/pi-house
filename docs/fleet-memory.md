# Fleet project memory

The coordinator owns a separate, owner-only bare Git repository. Configure an absolute `memoryRepo` outside any project checkout, for example a directory named `pi-house-memory.git` on a private volume. The default is `memory.git` inside the private fleet state directory. The app makes local commits; it never configures a remote or pushes personal data. The application repository contains the harness, UI, adapters, schema and synthetic evals. Put the memory repository and the fleet state directory in the owner's backup plan. Local history alone cannot recover a lost drive.

## Data and authority

- Slack delivers an owner's request to a specific workspace and thread. SQLite on the coordinator binds the Slack thread to a fleet chat and records delivery receipts. The browser and the Slack bridge call the same jobs service.
- The private repository stores completed conversation evidence with structured actor and artifact metadata. A per-thread Git reference preserves revisions. Confirmed project facts, their source chat, feedback examples, trial scores and the current retrieval profile live under a separate per-project reference. References update atomically. SQLite remains the live work queue and stores attachment bytes separately.
- The graph is derived from recorded relationships between project, thread, machine, artifact and confirmed fact. It does not infer a person or a business relationship from prose. Archived evidence remains readable when the live job is absent. Artifact metadata alone cannot reconstruct file bytes.
- Workers on other minis receive a task-specific prompt plus matched owner-confirmed project facts from the coordinator. They do not need a cloned memory repository, Slack credentials or a shared database filesystem. A secondary web host can set `coordinatorOrigin` to direct new work to the single writer. There is no automatic election on coordinator failure.
- Search, fact management, and calibration use the paired private web app. A Slack memory command returns a link to the private app. Slack still retains regular messages and replies according to workspace retention settings.

## Feedback and evaluation

Use the Memory panel to search within one project. In the private composer, `memory save launch day = Thursday` records a versioned fact. Reusing the same key updates it; `memory forget launch day` retires it from recall. Historical Git objects remain. Use `memory feedback <question>` in the thread that best answers that question. The same normalized question counts once. Administrative exchanges are excluded from research evidence.

Retrieval starts with a balanced profile. The owner can evaluate two alternatives that emphasize titles or evidence. Feedback records a label. Only an explicit owner decision can change the active profile.

1. Add feedback in the source threads. Every third distinct thread is reserved for evaluation. All questions from one thread share its assignment. Run `memory status` to see the number of training threads, fresh holdout threads and used feedback slots.
2. Run `memory tune` in a private control chat. The trial needs at least four training threads and two fresh holdout threads. It selects the strongest alternative on training questions and compares it with the current profile on the reserved questions. Its reply reports both top-result counts and the number of independent source threads. Every inspected holdout thread is permanently spent, including when the candidate loses. Holdouts saved by earlier versions are treated as exposed.
3. If the candidate improves both scores and loses no previously correct held-out answer, the reply includes `memory promote <trial-id>`. Review the counts and send that exact command to apply the candidate. Approval checks the project, latest trial, feedback revision, incumbent, retrieval implementation revision and searchable evidence snapshot. A changed snapshot requires a new trial with fresh holdout threads. Use `memory revert` to undo the latest active promotion.

The private Git repository preserves trials, source assignments, comparisons and decisions. The evaluation set holds 96 labels per project. A full register returns an explicit capacity message and keeps existing labels. These owner-provided examples measure whether the first result points to the expected source thread. They do not establish general retrieval accuracy. Synthetic regression tests separately check abstention, updated facts, exact attachment citations and data retention at the current limits.

This design draws on [OmniMem](https://arxiv.org/abs/2604.01007) for experimental memory design, [Self-Improvement Memory](https://arxiv.org/abs/2611.18856) for recording optimization attempts, and [LongMemEval](https://arxiv.org/abs/2410.10813) for update and abstention cases. It does not reproduce their benchmark results.

## Move or restore the coordinator

To inspect history use `git --git-dir=/private/path/to/memory.git branch --all`. The default branch documents the layout. Project state and thread evidence have their own branches. To preserve all versions, run `git --git-dir=/private/path/to/memory.git bundle create /private/path/to/memory.bundle --all` with a private destination and owner-only permissions. Restore into a new, private directory with `git clone --mirror /private/path/to/memory.bundle /private/path/to/restored.git`. Compare `git for-each-ref` on both copies and run `git fsck --connectivity-only`. A replica contains private project evidence. Restrict access on the destination as on the coordinator.

Owner-confirmed relations use `memory link SUBJECT | PREDICATE | OBJECT`. Use `memory unlink` with the same three fields to retire an edge. The graph, search and matched task context carry the source chat and revision. They reconstruct from the private repository. The underlying evidence and previous revisions remain in Git history.

To add a planning machine, see [Planning workers](fleet-workers.md). To move the single writer, stop or drain the existing service, copy the latest memory repository **and** private fleet state through a trusted channel, then configure the new host's Slack connection, native logins, certificate and peers. Restore attachment bytes and Slack delivery receipts with the fleet state. Enable Slack events on exactly one coordinator at a time.

## Indexed retrieval

The coordinator uses SQLite FTS5 to read passage candidates from archived evidence. The index is derived from canonical Git evidence and can be rebuilt after restore. Search results retain their source chat or artifact reference. Source revisions and live overlays determine which evidence is current. Use `node scripts/bench-fleet-memory.mjs` to build and query 10,000 synthetic Git evidence refs without using personal data. The acceptance limits are a cold first query under two seconds, warm p95 under 250 milliseconds and peak RSS growth under 256 MiB.
