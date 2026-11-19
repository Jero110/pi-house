# Fleet recovery

Run snapshot on the coordinator while the fleet service is running. The command requests a recovery point through the owner-only Unix socket in the private state directory. Its only stdout line is the absolute path of the newly published package. Copy that file over an authenticated channel to the recovery Mac. Verify the copy before promoting it to the current replica.

```sh
node packages/pihouse/src/fleet-backup.ts snapshot /private/path/to/host.json
node packages/pihouse/src/fleet-backup.ts verify /private/path/to/copy.snapshot
node packages/pihouse/src/fleet-backup.ts restore /private/path/to/copy.snapshot /private/path/to/new-fleet-state
```

Verification prints JSON with the snapshot timestamp, manifest SHA-256, artifact and chat counts, Git refs, checkout count, Slack ledger presence, and the IDs of interrupted turns. Restore validates the same material before creating the destination. The destination must be absent and its parent must exist at its canonical path. Configure the recovery host to use that new state directory and its restored `memory.git`. Provision its private host configuration, Slack tokens, SSH identities, application profiles, and device access separately. Keep one active coordinator for a Slack installation.

The package contains the jobs SQLite database and artifact bytes, optional Slack receipts and pending deliveries, a Git bundle of memory refs, and the working files and Git metadata of available task checkouts. The manifest binds SHA-256 hashes to the package contents and each artifact. Verification checks both SQLite databases, each materialized file, each artifact's bytes, the Slack-to-chat bindings, and the restored Git repository and refs. Task transcripts and working files can contain private project material supplied by their owner. Protect replica files accordingly.

A running worker can change its working files while the host saves its ledger. The manifest names such checkouts in `omittedActive`. The durable conversation and previously captured artifacts survive. On startup the recovered host records queued and running turns as interrupted, and those chats stay closed to further writes. Completed chats retain their isolated checkouts, including uncommitted work. A Slack reply awaiting acknowledgment may be retried with its original delivery ID. Inbound submission receipts remain durable.

Capture briefly holds the host event loop while taking the recovery point. The packer enforces a five-minute deadline, a 16 GiB content limit and 250,000 entries. An unsafe checkout member, integrity failure or missing previously used writable checkout prevents publication. Regular files and safe checkout-relative symlinks are supported. Hard-linked files, external links, mounted subtrees and special files cause capture to fail. Preserve the last verified replica and inspect the service log after a failure. A stale replica cannot establish the recovery-point objective. Schedule transfers frequently enough and monitor the verified package's original timestamp.

To resume after host loss, stop the old coordinator, restore into a fresh directory and run `pih fleet serve` with the recovery host configuration. Re-pair the browser on that host. A `RESTORE-INCOMPLETE` marker causes startup to fail closed after interrupted installation. Restore into a different fresh directory to retry.

## Pull from a second Mac

The standby runs `node packages/pihouse/src/fleet-replica.ts pull /private/path/pull.json`. A private operator JSON file contains `directory` (an owner-only destination), `sshConfig` (an absolute path), and `host` (a dedicated SSH alias). Pin the coordinator's host key from a trusted channel. On the coordinator authorize only the standby's dedicated public key, bound to its tailnet IP with `restrict` and a forced command that runs `node /absolute/path/fleet-replica.ts send /private/path/host.json`. The standby receives a recovery image over that connection. A restored host needs its own secrets, TLS setup and sign-in before it can become the primary.

Schedule the pull on the standby every 300 seconds for a 15-minute target. On macOS a user LaunchAgent can set `RunAtLoad` and `StartInterval` to 300 with that pull command in `ProgramArguments`. It runs in the logged-in user's launch domain. The standby independently verifies each image before publishing and keeps three successful recovery points. A failed or interrupted transfer keeps the last verified point available. Run `fleet-replica.ts status /private/path/pull.json` to inspect the age of the last successful capture. An age above 900 seconds returns exit status 2. Both hosts must be awake and reachable for scheduled copies to progress.
