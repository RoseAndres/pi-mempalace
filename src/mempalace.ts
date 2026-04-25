/**
 * index.ts — MemPalace pi extension entry point
 *
 * Wires the MemPalace MCP server into pi as native tools and registers the
 * /mempalace and /mine-sessions commands.
 *
 * Lifecycle:
 *   session_start       → boot MCP server, register all palace tools with pi
 *   before_agent_start  → inject Memory Protocol (mempalace_status) once
 *   turn_end            → periodic diary save every PERIODIC_SAVE_TURNS turns
 *   session_before_compact → rescue memories before context compression
 *   session_shutdown    → final diary write (MCP server stays alive for next session)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { McpClient, findPython } from "./mcp.js";
import { saveMemories } from "./diary.js";
import { discoverAndMine, mineSessions, type MineOptions } from "./mine.js";

const PERIODIC_SAVE_TURNS = 15;

// Module-level singleton — survives session_shutdown → session_start cycles
// within the same pi process, keeping the MCP subprocess (and its loaded
// HNSW index) warm. Only pays the cold-start cost once per pi launch.
let _client: McpClient | null = null;

export default function mempalaceExtension(pi: ExtensionAPI) {
  if (!_client) _client = new McpClient();
  const client = _client;
  let statusInjected = false;
  let turnCount = 0;

  // ── session_start: boot server, register all palace tools ────────────────

  pi.on("session_start", async (_event, ctx) => {
    statusInjected = false;
    turnCount = 0;

    if (client.ready) return; // already up — hot reload without shutdown

    try {
      const tools = await client.connect();

      for (const tool of tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.name
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          description: tool.description,
          parameters: tool.parameters,
          async execute(_toolCallId, params) {
            try {
              const text = await client.callTool(tool.name, params);
              return { content: [{ type: "text", text }], details: {} };
            } catch (err: any) {
              return {
                content: [{ type: "text", text: `MemPalace error: ${err.message}` }],
                details: {},
                isError: true,
              };
            }
          },
        });
      }

      ctx.ui.notify(`MemPalace connected — ${tools.length} tools available`, "success");
    } catch (err: any) {
      ctx.ui.notify(`MemPalace: ${err.message}`, "warning");
    }
  });

  // ── before_agent_start: inject Memory Protocol once per session ───────────
  // mempalace_status returns the protocol + palace overview.  Injecting it as
  // a persistent message means the LLM always has the "search before guessing"
  // instruction in context, even after compaction.

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!client.ready || statusInjected) return;
    statusInjected = true;

    try {
      const status = await client.callTool("mempalace_status", {});
      return {
        message: {
          customType: "mempalace-status",
          content: status,
          display: true,
        },
      };
    } catch {
      // Palace not fully initialised yet — tools still work, protocol still loads
    }
  });

  // ── turn_end: periodic diary save ─────────────────────────────────────────

  pi.on("turn_end", async (_event, ctx) => {
    if (!client.ready) return;
    turnCount++;
    if (turnCount % PERIODIC_SAVE_TURNS === 0) {
      await saveMemories(ctx, `periodic save at turn ${turnCount}`, client);
    }
  });

  // ── session_before_compact: rescue memories before context is wiped ────────

  pi.on("session_before_compact", async (_event, ctx) => {
    await saveMemories(ctx, "pre-compaction", client);
    // Return undefined — let pi handle compaction normally
  });

  // ── session_shutdown: final diary write + cleanup ─────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    await saveMemories(ctx, "session end", client);
    // Intentionally do NOT disconnect — keep the MCP subprocess alive so the
    // next session_start reuses the warm process (index already in RAM).
  });

  // ── /delete-wing: bulk-delete all drawers in a wing ───────────────────────

  pi.registerCommand("delete-wing", {
    description: "Delete all drawers in a palace wing (irreversible)",
    handler: async (args, ctx) => {
      const wing = args?.trim();
      if (!wing) {
        ctx.ui.notify("Usage: /delete-wing <wing-name>", "warning");
        return;
      }

      const ok = await ctx.ui.confirm(
        `Delete wing "${wing}"?`,
        `This will permanently delete ALL drawers in the "${wing}" wing. This cannot be undone.`,
      );
      if (!ok) return;

      ctx.ui.setStatus("mempalace-delete", `Deleting wing "${wing}"…`);

      try {
        const python = await findPython();
        const palacePath = process.env.MEMPALACE_PALACE ?? `${process.env.HOME}/.mempalace/palace`;
        const script = [
          "import chromadb",
          `client = chromadb.PersistentClient(path='${palacePath}')`,
          `col = client.get_collection('mempalace_drawers')`,
          `col.delete(where={'wing': '${wing}'})`,
          `print('done')`,
        ].join("; ");

        const result = execSync(`${python} -c "${script}"`, { encoding: "utf8", timeout: 120_000 });
        ctx.ui.setStatus("mempalace-delete", "");

        if (result.trim() === "done") {
          ctx.ui.notify(`Wing "${wing}" deleted from palace`, "success");
        } else {
          ctx.ui.notify(`Unexpected output: ${result}`, "warning");
        }
      } catch (err: any) {
        ctx.ui.setStatus("mempalace-delete", "");
        ctx.ui.notify(`Delete failed: ${err.message}`, "error");
      }
    },
  });

  // ── /mempalace: live palace status ───────────────────────────────────────

  pi.registerCommand("mempalace", {
    description: "Show MemPalace palace status and connection info",
    handler: async (_args, ctx) => {
      if (!client.ready) {
        ctx.ui.notify(
          "MemPalace is not connected. Install with: pipx install mempalace",
          "error",
        );
        return;
      }
      try {
        const status = await client.callTool("mempalace_status", {});
        ctx.ui.notify(status, "info");
      } catch (err: any) {
        ctx.ui.notify(`MemPalace error: ${err.message}`, "error");
      }
    },
  });

  // ── /mine-sessions: import past pi sessions into MemPalace ───────────────
  //
  // Supported args (same surface as the old pi-mine-sessions CLI):
  //   --all                 re-mine sessions already in state file
  //   --since YYYY-MM-DD    only sessions modified on or after this date
  //   --wing NAME           override inferred wing for every session
  //   --room NAME           override room (default: sessions)
  //   --session /path.jsonl mine a single file instead of scanning
  //   --dry-run             preview without filing anything

  pi.registerCommand("mine-sessions", {
    description: "Import past pi sessions into MemPalace",
    handler: async (args, ctx) => {
      if (!client.ready) {
        ctx.ui.notify("MemPalace is not connected", "error");
        return;
      }

      const parsed = parseMineArgs(args ?? "");

      // Live counter shown in the footer status bar during the run
      let filed = 0;
      let errors = 0;
      ctx.ui.setStatus("mempalace-mine", "Mining sessions…");

      const opts: MineOptions = {
        wingOverride: parsed.wing,
        room:         parsed.room,
        since:        parsed.since,
        mineAll:      parsed.all,
        dryRun:       parsed.dryRun,
        onProgress: (result) => {
          if (result.status === "filed") {
            filed++;
            ctx.ui.setStatus("mempalace-mine", `Mining… ${filed} filed`);
          } else if (result.status === "error") {
            errors++;
          }
        },
      };

      try {
        const summary = parsed.session
          ? await mineSessions([parsed.session], client, opts)
          : await discoverAndMine(client, opts);

        ctx.ui.setStatus("mempalace-mine", ""); // clear footer widget

        const parts: string[] = [];
        if (parsed.dryRun)       parts.push(`[dry-run] would file: ${summary.results.filter(r => r.status === "skipped").length}`);
        else                     parts.push(`filed: ${summary.filed}`);
        if (summary.skipped > 0) parts.push(`already mined: ${summary.skipped}`);
        if (summary.empty > 0)   parts.push(`empty: ${summary.empty}`);
        if (summary.errors > 0)  parts.push(`errors: ${summary.errors}`);

        ctx.ui.notify(parts.join(" · "), summary.errors > 0 ? "warning" : "success");
      } catch (err: any) {
        ctx.ui.setStatus("mempalace-mine", "");
        ctx.ui.notify(`Mining failed: ${err.message}`, "error");
      }
    },
  });
}

// ── Arg parser ────────────────────────────────────────────────────────────────

interface ParsedMineArgs {
  all:     boolean;
  dryRun:  boolean;
  wing?:   string;
  room?:   string;
  since?:  Date;
  session?: string;
}

/**
 * Parse the raw args string from pi's command handler into structured options.
 *
 * Handles:
 *   --all
 *   --dry-run
 *   --wing NAME
 *   --room NAME
 *   --since YYYY-MM-DD
 *   --session /absolute/or/relative/path.jsonl
 */
function parseMineArgs(raw: string): ParsedMineArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const result: ParsedMineArgs = { all: false, dryRun: false };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok) {
      case "--all":      result.all    = true;  break;
      case "--dry-run":  result.dryRun = true;  break;
      case "--wing":     result.wing    = tokens[++i]; break;
      case "--room":     result.room    = tokens[++i]; break;
      case "--session":  result.session = tokens[++i]; break;
      case "--since": {
        const raw = tokens[++i];
        const d = new Date(raw);
        if (!isNaN(d.getTime())) result.since = d;
        else console.warn(`[mempalace] --since "${raw}" is not a valid date — ignored`);
        break;
      }
    }
  }

  return result;
}
