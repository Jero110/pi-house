# Planning workers

A primary Mac owns each chat, its project checkout and its artifacts. A planning Mac receives the bounded conversation context through the configured SSH transport and returns a short suggestion from a disposable workspace. Its label appears in the execution history. The selected project agent runs on the primary Mac using its native harness.

## Configure more than one planner

The existing single-worker `planner` setting continues to work. To configure a pool, replace that setting with a `planners` array in the primary Mac’s private host configuration. Each entry describes one real machine that you have provisioned. The following example uses placeholder values.

```json
{
  "planners": [
    {
      "handle": "m4",
      "label": "Mac mini M4",
      "host": "worker@studio.example-tailnet.ts.net",
      "identityFile": "/absolute/path/to/studio-identity",
      "knownHostsFile": "/absolute/path/to/studio-known-hosts",
      "node": "/absolute/path/to/worker-node",
      "entry": "/absolute/path/to/pi-house/packages/pihouse/src/fleet-planner.ts"
    }
  ]
}
```

Use the machine’s actual tailnet DNS name or Tailscale IPv4 address. Keep SSH identities and verified host keys on the primary Mac. Install the supported Node version, pi-house and the authenticated native Codex CLI on each planning Mac. Run the worker doctor there. Provision the restricted SSH key according to the [fleet setup guide](fleet.md#add-a-planning-mac).

Every entry must have a distinct label, handle and host. A handle accepts letters, numbers, underscores and hyphens, starting with a letter or number. If omitted, the handle comes from the chip name in the label (for example, `Mac mini M4` gives `@M4`), or from the label’s words joined with hyphens. Set explicit handles such as `m4-office` and `m4-studio` when several machines use the same chip.

## Address a machine in a chat

Start a message with the configured handle, for example `@M4 review the migration plan`. The same literal spelling works in the browser and in a connected Slack conversation. In a channel where the bridge requires its Slack app mention, mention the app first, then type the planner handle as plain text. A reference to a machine later in a sentence keeps automatic routing.

An unaddressed turn selects one configured planner by hashing the chat ID and worker identities. Reordering the configuration preserves assignments. Adding a future Mac moves only the chats it wins under that selection rule. A directly addressed turn chooses the named planner on that turn. The transcript distinguishes its suggestion from the primary agent’s work. An unknown handle produces an error with the configured choices.

To add a future M6, provision and verify its actual host, add it with a unique handle, restart the primary service with the updated configuration, and send a request beginning with `@M6`. Confirm the recorded planner response and machine label. With an empty pool, unaddressed turns run directly on the primary.
