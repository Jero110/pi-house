# Slack for the fleet

Enable Socket Mode on one fleet host. That Mac makes an outbound connection to Slack. Direct messages and invited-channel mentions from the configured owner create fleet chats. Replies in a bound thread continue the same chat. The web UI can open the same conversation using the link in the thread. A second Socket Mode worker for the same app would share event delivery with the first worker, so leave Slack unconfigured on the planning Mac.

## Create and install pi-house

1. Choose **Create New App → From a manifest** in Slack's app settings. Select your workspace, paste the repository manifest and create **pi-house**. The manifest enables a writable App Home Messages tab and the four bot events for DMs, mentions and invited public/private channel follow-ups. [App settings](https://api.slack.com/apps) · [Manifest](slack-app-manifest.json)
2. Under **OAuth & Permissions**, install the app in the workspace. Copy the Bot User OAuth Token beginning with `xoxb-`. An administrator may need to approve installation.
3. Under **Basic Information → App-Level Tokens**, generate a token with the single `connections:write` scope. Copy the token beginning with `xapp-`. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
4. Record the workspace ID and your member ID. You can copy the latter from your Slack profile. For a channel, copy its ID from the channel details and invite the app. An empty channel list enables owner DMs only.

## Store the credentials on the listening Mac

Run this in a local zsh terminal as the user that runs the fleet. Both prompts hide pasted values. The shell writes a mode-0600 file in a mode-0700 directory. Keep this directory outside project repositories, artifacts and shared folders.

```zsh
(
  set -e
  umask 077
  fleet_credentials_dir="$HOME/.pihouse/fleet-slack"
  mkdir -p "$fleet_credentials_dir"
  chmod 700 "$fleet_credentials_dir"
  read -rs 'fleet_app_token?Slack app token (hidden): '
  print
  read -rs 'fleet_bot_token?Slack bot token (hidden): '
  print
  fleet_credentials_tmp=$(mktemp "$fleet_credentials_dir/.tokens.XXXXXX")
  trap 'rm -f "$fleet_credentials_tmp"' EXIT
  builtin printf '{"appToken":"%s","botToken":"%s"}\n' "$fleet_app_token" "$fleet_bot_token" > "$fleet_credentials_tmp"
  mv -f "$fleet_credentials_tmp" "$fleet_credentials_dir/tokens.json"
)
```

Add this property to the listening Mac's existing private host configuration. Set `project` to one of that host's configured project keys. Use the canonical absolute path to the token file.

```json
{
  "slack": {
    "team": "T123EXAMPLE",
    "owner": "U123EXAMPLE",
    "channels": [],
    "project": "app",
    "tokensFile": "/Users/dev/.pihouse/fleet-slack/tokens.json"
  }
}
```

Restart the fleet service, then open **Apps → pi-house → Messages** in Slack and send a task. For channel use, add the channel ID to `channels`, restart, mention the bot to open a thread and reply in that thread.

## Delivery and recovery

The transport checks the bot identity and workspace, opens Slack's short-lived authenticated WebSocket URL, and acknowledges eligible events once they have been stored. Intentional exclusions, including events from other workspaces, bot installations or users, are acknowledged and ignored. Results use plain-text message blocks in the originating thread. The bridge records a delivery ID with each outgoing message. A lost response after Slack accepted the message can still cause a duplicate reply.

Slack rate limits and temporary transport failures trigger bounded backoff. If six consecutive attempts fail, the service logs a credential-free status and retains pending work for restart. If an app is uninstalled, a scope changes, or a token is revoked, repair the installation or replace the private token file, then restart the host service. The web chat remains the local record of the conversation.
