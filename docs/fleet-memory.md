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

Retrieval starts with a balanced lexical profile. Additional profiles emphasize titles or message and artifact evidence. A trial selects a candidate on training examples and compares it with the incumbent on different source threads. Promotion requires better top-one accuracy on the held-out examples with no individual loss there. Rejected trials are recorded too. New feedback triggers repeated trials; `memory status`, `memory tune` and `memory revert` let the owner inspect, evaluate and roll back the policy. These tests calibrate retrieval on owner-supplied examples, not model weights or executable worker policy. Small or reused test sets give limited evidence. Use representative project questions and fresh independent cases to validate improvements over time.

This design draws on [OmniMem](https://arxiv.org/abs/2604.01007) for experimental memory design, [Self-Improvement Memory](https://arxiv.org/abs/2611.18856) for recording optimization attempts, and [LongMemEval](https://arxiv.org/abs/2410.10813) for update and abstention cases. It does not reproduce their benchmark results.

## Move or restore the coordinator

To inspect history use `git --git-dir=/private/path/to/memory.git branch --all`. The default branch documents the layout. Project state and thread evidence have their own branches. To preserve all versions, run `git --git-dir=/private/path/to/memory.git bundle create /private/path/to/memory.bundle --all` with a private destination and owner-only permissions. Restore into a new, private directory with `git clone --mirror /private/path/to/memory.bundle /private/path/to/restored.git`. Compare `git for-each-ref` on both copies and run `git fsck --connectivity-only`. A replica contains private project evidence. Restrict access on the destination as on the coordinator.

Owner-confirmed relations use `memory link SUBJECT | PREDICATE | OBJECT`. Use `memory unlink` with the same three fields to retire an edge. The graph, search and matched task context carry the source chat and revision. They reconstruct from the private repository. The underlying evidence and previous revisions remain in Git history.

To add a planning machine, see [Planning workers](fleet-workers.md). To move the single writer, stop or drain the existing service, copy the latest memory repository **and** private fleet state through a trusted channel, then configure the new host's Slack connection, native logins, certificate and peers. Restore attachment bytes and Slack delivery receipts with the fleet state. Enable Slack events on exactly one coordinator at a time.
