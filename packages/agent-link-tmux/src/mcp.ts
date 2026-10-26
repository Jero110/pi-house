#!/usr/bin/env node
// agent-link-tmux mcp: the agent-link MCP server for harnesses in tmux panes. Everything but the backend lives in
// agent-link-core; the hub it talks to is the composed daemon of the agent-link package (ensureHub's default).
import { placeFromEnv, runMcpServer } from "agent-link-core";

await runMcpServer({ backend: "tmux", place: placeFromEnv("tmux") });
