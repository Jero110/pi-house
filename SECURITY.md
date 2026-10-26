# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of this repository,
then **Report a vulnerability**. Include what you found, how to reproduce it and which version you ran
(`pih --version`). You should get an answer within a week.

## What matters here

pi-house starts other coding agents and relays messages between them, so these are in scope:

- The agent-link hub: its Unix socket, its token and what an unauthenticated process can do through it.
- The MCP servers (`agent-link`, `cmux`) and the tools they expose.
- The installer (`install.sh`, `install.ps1`) and what it writes outside this repository.
- Anything that reads or copies credentials, such as the pi login pi-house reuses from `~/.pi/agent`.

Vulnerabilities in pi itself or in a harness (Claude Code, Codex, opencode) belong to those projects.
