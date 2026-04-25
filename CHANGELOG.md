# Changelog

## 0.1.0 — 2026-04-24

Initial release.

- 29 MemPalace MCP tools registered natively in pi
- Memory Protocol injected as a persistent message on session start
- Automatic diary write on session exit, pre-compaction, and every 15 turns
- Agent name derived dynamically from the active model id (`claude-sonnet-4-6` → `claude`)
- `/mempalace` command — live palace status
- `/mine-sessions` command — import past pi sessions into the palace without leaving pi
  - Supports `--all`, `--since`, `--wing`, `--room`, `--session`, `--dry-run`
- `PI_MEMPALACE_TOOL_TIMEOUT` env var — configurable MCP call timeout (default 120 s)
- `PI_MEMPALACE_AGENT_NAME` env var — override diary agent name
