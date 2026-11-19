# Workflow Factory

Open **Factory** in the authenticated fleet browser. Choose a project, create a workflow and describe the worker's task. Each revision pins the agent, instructions and examples. Each example has a sample input and an expected case-sensitive literal. The worker sees the instructions and sample input. The evaluation service compares the worker's final answer to the expected literal and links to the evaluation chat. A passing literal check measures that assertion; review the full answer to assess other qualities.

Evaluate a draft, inspect each result, then publish that exact revision. Edits create new drafts while the previous published revision remains available for runs. The server rejects a stale edit, a publication whose latest evaluation failed and an attempt to run an unpublished revision. Evaluation and production submissions use request IDs to keep retries from scheduling a second set of jobs.

Each run is a normal fleet job with its own checkout, activity and output artifacts. The coordinator records the revision, test results, publication and run chat IDs in the project-scoped factory tables in the operational database. Recovery snapshots include that database. Workflows use the same worker permissions as ordinary tasks. The initial UI supports manual runs. External triggers and delivery connectors must be provisioned separately.

The lifecycle follows the editor, experiments, publish and run-history pattern visible in [HappyRobot's public builder](https://builder.happyrobot.ai/builder).
