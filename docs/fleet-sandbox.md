# Native Mac fleet workers

The fleet service sends a prompt on stdin and uses one finished assistant response on stdout. File-capable runs use a disposable Git checkout created by the service. A native macOS Seatbelt policy applies to each model tool that works on it.

| Agent | Subscription and access | How to sign in on each Mac |
| --- | --- | --- |
| Codex | The installed Codex CLI uses its own ChatGPT sign-in. Its native named permissions profile gives file and shell tools the checkout, private scratch space and minimal system files. Tool networking is off. | Run `node packages/pihouse/src/fleet-sandbox.ts login codex` if `codex login status` does not report ChatGPT. |
| Pi | The pinned pi coding-agent runs its native read, edit, write and bash tools using the `openai-codex/gpt-6-luna` subscription model. The signed-in account must offer that model. | Run `node packages/pihouse/src/fleet-sandbox.ts login pi`. Complete the device login with your ChatGPT account. |
| Claude, chat only | With no dedicated file-tools token, the installed Claude Code CLI uses its own claude.ai sign-in. It starts in an empty directory with an empty tool list, restricted and safe modes, strict empty MCP and slash commands disabled. Its reply identifies chat-only access. | Run `claude auth login --claudeai` if your native login has expired. |
| Claude, project files | An explicitly provisioned subscription token enables Claude Code's restricted Read, Edit, Write, Glob and Grep tools inside Seatbelt. | Run `claude setup-token` locally. Then run `node packages/pihouse/src/fleet-sandbox.ts login claude` and paste the result into the hidden terminal prompt. |

Run the commands from the pi-house installation. The runner also accepts the installed script's absolute path. For a local startup check, run `node packages/pihouse/src/fleet-sandbox.ts doctor pi`, substituting `codex` or `claude` as needed. Doctor checks the executable and a real filesystem policy on the current Mac. A model turn also requires the subscription service to accept the account and selected model.

## Provider credentials

The Codex controller reads its normal sign-in through the native CLI. It starts from an empty directory with user config, exec rules, hooks, apps, plugins and host skill discovery disabled. The checkout path is passed as data. The tool profile denies access to the controller's home, and the controller gives its shells a fresh environment.

Pi signs in under `~/.pihouse/fleet-profiles/pi`. Its native CLI owns OAuth refresh and supplies a current access token to the pinned pi coding-agent in a one-use pipe. The in-memory credential store contains only the current access token. Project extensions, skills, prompt templates and MCP discovery are disabled. A rejected subscription or unavailable model fails the turn.

Claude's dedicated token is stored in the private `~/.pihouse/fleet-profiles/claude` directory. The native CLI reads it from a one-use file descriptor. Both dedicated modes have a fresh home and an allowlist of environment variables. Their tools cannot open either profile. Claude chat-only mode is a trusted native CLI invocation under the signed-in Mac account with all model tools disabled. Platform-managed Claude Code policy is part of the trusted installation.

## Containment

The Pi and Claude file-tools policy follows Sandcastle's deny-default Seatbelt design. It permits the project copy and private scratch directory, selected read-only platform and runtime files, and a per-run loopback proxy. The proxy accepts only TLS tunnels to the selected subscription host on port 443. TLS terminates at the provider. The sandbox denies other TCP destinations, host Unix sockets, and Keychain services. None of these modes use an API key or change providers on a failed turn. [Sandcastle native macOS policy](https://github.com/mattpocock/sandcastle/blob/main/src/seatbeltProfile.ts)

The supported boundary is a trusted Mac, trusted native executables and one authenticated operator. Keep credentials out of project contents. The runner assumes the service has already created the task checkout. The ordinary Codex and Claude subscriptions still use their vendor's own quota and account policies. Native process-tree termination is best effort for processes that deliberately detach and reparent on macOS.
