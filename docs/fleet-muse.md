# Muse and Knowledge+ pilot

The M5 can serve one versioned document, `FORMATO.md`, from the local Knowledge+ repository. The file exchange supports source reads. Jobs are submitted separately in the paired Pi House web UI by choosing a project and agent, reviewing the task, and pressing Send. A file in the exchange identifies a request, not the person who wrote it.

## Read-only publication for Muse

For a channel with local reading capability, publish the source before the request. This lets Muse answer without writing a request file. Create an owner-only exchange directory, then run:

```sh
node packages/pihouse/src/fleet-muse-bridge.ts publish "$exchange_dir" "$knowledge_repo"
```

The command atomically writes `source.json` with `path`, `revision` and `text`, leaves identical content in place, and withdraws the last valid projection if the source read fails. A user LaunchAgent can run this command on login and every 60 seconds using absolute paths to Node, the bridge, the exchange directory, and the operator-selected working repository. Include the supported Git binary on its PATH. This follows local committed HEAD. During sleep or while the service is down the last snapshot can remain visible, so return its actual revision with each answer.

For a chat test, ask Muse through its linked WhatsApp to open only that projection and cite a specific sentence and the exact revision. A scheduled single-delivery test is separate from a webhook triggered by completion of an actual fleet job.

## Optional request and receipt exchange

Create a private directory on the coordinator, owned by the logged-in user. Pass its absolute canonical path and the local Knowledge+ working repository to the CLI. The first run creates private inbox and outbox directories. Use the coordinator's installed Git and Node on PATH.

```sh
node packages/pihouse/src/fleet-muse-bridge.ts once "$exchange_dir" "$knowledge_repo"
```

For a source read, write a JSON object containing only `id` and `op` to `inbox/<id>.json`. Use a fresh lowercase UUID v4 and the literal operation `read_source`. Use a temporary file and rename it into place. Run the command above to process queued requests. The matching file in `outbox` has the request ID, completion status, and a source containing the Git path, commit revision and UTF-8 text. A failed read returns `source_unavailable`. Keep existing receipts for as long as requests with their IDs can recur. Reading a later revision requires a new request ID. This reads committed local HEAD, so fetching a remote update and moving local HEAD are separate operator decisions.

The initial exchange assumes processes sharing the operator's OS account are trusted to read the pilot source. Local file ownership cannot authorize work on the owner's behalf. The mailbox accepts only this one document read and starts no jobs.

## Verifying a channel

Before enabling periodic processing, use an isolated test folder. Put a random nonce in a file. Ask Muse via its linked WhatsApp channel to read it, then ask it to write a different nonce in a new file and verify both values on the named Mac. A desktop-only success is a separate result. To test an unsolicited completion notice, request one later check, leave the conversation and place a third unknown nonce in the folder. Check whether it reaches the originating thread without another prompt.

Run the first real read with a new request ID. Check the returned citation and revision independently against Git. A successful local CLI run demonstrates the exchange; delivery requires observing the answer in the originating client. A snapshot of the document can also be registered as a separate Pi House project for the private web fallback.
