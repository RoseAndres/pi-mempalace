# pi-mempalace

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that connects your session history to a [MemPalace](https://mempalaceofficial.com) memory palace.

Every conversation is automatically saved as a diary entry on exit. Past sessions can be mined into the palace on demand. All MemPalace MCP tools are registered natively in pi so the LLM can search, file, and recall memories without leaving the session.

---

## Features

- **29 MCP tools** registered natively — search, add drawers, query the knowledge graph, write diary entries, and more
- **Memory Protocol injection** — on every session start, the palace status is injected as a persistent system message so the LLM knows to verify before guessing about people, projects, and past events
- **Automatic diary write** on session exit (and periodically every 15 turns)
- **Pre-compaction save** — memories rescued before context is compressed
- **`/mine-sessions` command** — import past pi sessions into the palace without leaving pi, using the same MCP connection already open

---

## Requirements

- [pi coding agent](https://github.com/mariozechner/pi-coding-agent) installed
- MemPalace installed in a pipx venv (recommended) or on `PATH`:
  ```bash
  pipx install mempalace
  ```

---

## Installation

### From npm

```bash
pi install npm:pi-mempalace
```

### From git

```bash
pi install git:github.com/RoseAndres/pi-mempalace
```

### Local (development)

```bash
git clone https://github.com/RoseAndres/pi-mempalace
cd pi-mempalace
npm install
```

Add the project path to `~/.pi/agent/settings.json` under `packages`:

```json
{
  "packages": [
    "/absolute/path/to/pi-mempalace"
  ]
}
```

Then `/reload` in pi. Pi reads `package.json`, finds the `pi-mempalace` name and `pi.extensions`, and loads the extension.

> **Note:** Do not use a symlink in `~/.pi/agent/extensions/` — pi resolves the symlink path for module imports, which breaks relative imports between `src/` files.

---

## Configuration

All configuration is via environment variables — set them in your shell profile (`.bashrc`, `.zshrc`, etc.).

| Variable | Default | Description |
|---|---|---|
| `PI_MEMPALACE_TOOL_TIMEOUT` | `120000` | Timeout in ms for MCP tool calls. Increase if your palace is large and cold-starts time out. |
| `PI_MEMPALACE_AGENT_NAME` | _(model family)_ | Overrides the diary agent name. By default the first segment of the active model id is used (`claude-sonnet-4-6` → `claude`, `gpt-4o` → `gpt`). |

### Why 120 seconds?

MemPalace loads its HNSW vector index into memory on first use. With a large palace (e.g. 140k+ drawers from a mined codebase) this can take 30–90 seconds. The 120s default gives headroom. Smaller palaces can use a tighter value:

```bash
# Small palace — 10 seconds is plenty
export PI_MEMPALACE_TOOL_TIMEOUT=10000

# Very large palace — give it more time
export PI_MEMPALACE_TOOL_TIMEOUT=180000
```

---

## Commands

| Command | Description |
|---|---|
| `/mempalace` | Show live palace status (wing/drawer counts, connection info) |
| `/mine-sessions` | Import unmined pi sessions into the palace |
| `/mine-sessions --all` | Re-mine all sessions, ignoring prior state |
| `/mine-sessions --since 2026-01-01` | Only sessions modified on or after a date |
| `/mine-sessions --wing myproject` | Override inferred wing name for all sessions |
| `/mine-sessions --dry-run` | Preview what would be mined without filing anything |
| `/delete-wing <name>` | Permanently delete all drawers in a wing (prompts for confirmation) |

---

## How wing names are inferred

When mining sessions, the wing name is derived from the session's working directory:

```
~/Projects/discourse   →  discourse
~/Projects/myapp       →  myapp
~/src/api-gateway      →  api-gateway
~/Projects             →  general   (generic dirs are skipped)
~                      →  general
```

Generic segments stripped before inference: `projects`, `src`, `repos`, `code`, `work`, `dev`, `home`, `workspace`, `sites`.

Pass `--wing <name>` to `/mine-sessions` to override for all sessions in a run.

---

## Project structure

```
pi-mempalace/
├── src/
│   ├── session.ts       # pi JSONL parsing — branch resolution, turn extraction, wing inference
│   ├── session.test.ts  # smoke tests against real session files
│   ├── mcp.ts           # MCP server lifecycle + JSON-RPC client (McpClient)
│   ├── mcp.test.ts      # smoke tests against live MemPalace MCP server
│   ├── mine.ts          # session filing via callTool("mempalace_add_drawer")
│   ├── mine.test.ts     # integration test against live palace
│   ├── diary.ts         # saveMemories / diary write
│   ├── diary.test.ts    # unit + integration tests (stub ctx + live write)
│   └── mempalace.ts     # pi extension entry point
├── package.json
└── README.md
```

### Module responsibilities

| Module | Responsibility |
|---|---|
| `session.ts` | Pure TypeScript — reads pi JSONL files, resolves active branch, extracts turns, infers wings. No subprocesses. |
| `mcp.ts` | Manages one MCP server subprocess per session. Speaks JSON-RPC over stdio. Converts MCP schemas to TypeBox for pi tool registration. |
| `mine.ts` | Combines session parsing with MCP filing. Replaces the old `pi-mine-sessions` Python script. Files one drawer per session into room `sessions` under the inferred wing. |
| `diary.ts` | Writes session transcripts to the palace diary on exit, compaction, and periodically. Agent name derived from active model id (`claude-sonnet-4-6` → `claude`), overridable with `PI_MEMPALACE_AGENT_NAME`. |
| `mempalace.ts` | pi extension entry point — wires lifecycle events (`session_start`, `before_agent_start`, `turn_end`, `session_before_compact`, `session_shutdown`), registers all palace tools, and provides `/mempalace`, `/mine-sessions`, and `/delete-wing` commands. |

---

## Running tests

Tests run against your real palace and real session files — no mocks.

```bash
# Session parser (fast, no network/subprocesses)
npx jiti src/session.test.ts

# MCP client (spawns the MemPalace server — takes ~60s on first run to load index)
npx jiti src/mcp.test.ts

# Session miner (files a real session to a throwaway wing, then deletes it)
npx jiti src/mine.test.ts

# Diary writer (unit tests + live write/read-back against real palace)
npx jiti src/diary.test.ts
```

To test the full extension inside pi, run `/reload` after adding it to `settings.json`.
