/**
 * mine.ts — file pi sessions into MemPalace via MCP
 *
 * Replaces the old `pi-mine-sessions` Python script.  Instead of shelling out
 * to `mempalace mine`, it uses the already-open McpClient to call
 * `mempalace_add_drawer` directly — no subprocesses, no temp files, no PATH
 * dependencies beyond the MCP server that is already running.
 *
 * One drawer is filed per session:
 *   wing  — inferred from the session's cwd  (or overridden)
 *   room  — "sessions"                        (or overridden)
 *   content — plain-text transcript (User: / Assistant: turns)
 *
 * Mine state is persisted in ~/.pi/agent/mempalace-mined.json so re-running
 * is safe — already-mined sessions are skipped unless --all is passed.
 */

import type { McpClient } from "./mcp.js";
import {
  discoverSessions,
  loadMinableSession,
  formatTranscript,
  loadMineState,
  saveMineState,
  sessionIdFromFilename,
  type MinableSession,
} from "./session.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MineOptions {
  /** Override the inferred wing for every session in this run. */
  wingOverride?: string;
  /** Room to file sessions into (default: "sessions"). */
  room?: string;
  /** Only discover sessions modified on or after this date. */
  since?: Date;
  /** If true, re-mine sessions already recorded in the state file. */
  mineAll?: boolean;
  /** Parse and preview without filing anything to the palace. */
  dryRun?: boolean;
  /** Root directory to scan for .jsonl files (default: ~/.pi/agent/sessions). */
  sessionsDir?: string;
  /** Called after each session is processed so callers can stream progress. */
  onProgress?: (result: MineResult) => void;
}

export type MineResult =
  | { status: "filed";   session: MinableSession; drawerId: string }
  | { status: "skipped"; session: MinableSession; reason: SkipReason }
  | { status: "error";   path: string;            error: Error };

type SkipReason = "already-mined" | "dry-run";

export interface MineSummary {
  filed:   number;
  skipped: number; // already-mined
  empty:   number; // no user turns — not reported via onProgress
  errors:  number;
  results: MineResult[];
}

// ── Core: mine one session ────────────────────────────────────────────────────

/**
 * File a single MinableSession into MemPalace.
 * Returns the drawer ID on success, or throws on MCP error.
 */
async function fileSession(
  session: MinableSession,
  client: McpClient,
  room: string,
): Promise<string> {
  const transcript = formatTranscript(session);

  const response = await client.callTool("mempalace_add_drawer", {
    wing:        session.wing,
    room,
    content:     transcript,
    source_file: session.path,
    added_by:    "pi-mine-sessions",
  });

  // Response is a JSON string: { "drawer_id": "...", "success": true, ... }
  // Detect explicit failure responses before extracting the ID.
  try {
    const parsed = JSON.parse(response);
    if (parsed.success === false) {
      throw new Error(parsed.error ?? "mempalace_add_drawer returned success=false");
    }
    const id = parsed.drawer_id ?? parsed.id;
    if (!id) throw new Error(`mempalace_add_drawer response missing drawer_id: ${response.slice(0, 120)}`);
    return id;
  } catch (err: any) {
    // Re-throw real errors; only fall back for genuinely unparseable responses
    if (err.message.startsWith("mempalace_add_drawer")) throw err;
    throw new Error(`mempalace_add_drawer unexpected response: ${response.slice(0, 120)}`);
  }
}

// ── High-level: mine a list of session file paths ─────────────────────────────

/**
 * Mine a list of session files into MemPalace.
 *
 * Loads the mine state, skips already-mined sessions (unless mineAll),
 * files each session via MCP, saves updated state, and returns a summary.
 *
 * Progress is streamed via opts.onProgress as each session completes.
 */
export async function mineSessions(
  paths: string[],
  client: McpClient,
  opts: MineOptions = {},
): Promise<MineSummary> {
  const room    = opts.room ?? "sessions";
  const state   = loadMineState();
  const minedIds = state.mined;

  const summary: MineSummary = {
    filed: 0, skipped: 0, empty: 0, errors: 0, results: [],
  };

  for (const path of paths) {
    // ── Already mined? ──────────────────────────────────────────────────────
    if (!opts.mineAll) {
      const fileId = sessionIdFromFilename(path);
      if (fileId && minedIds[fileId]) {
        // Don't emit to onProgress — silently skip so the caller's output
        // isn't flooded with "already mined" lines on every run.
        summary.skipped++;
        continue;
      }
    }

    // ── Parse session ───────────────────────────────────────────────────────
    let session: MinableSession | null;
    try {
      session = loadMinableSession(path, opts.wingOverride);
    } catch (err: any) {
      const result: MineResult = { status: "error", path, error: err };
      summary.errors++;
      summary.results.push(result);
      opts.onProgress?.(result);
      continue;
    }

    // No user turns — nothing useful to file (skip silently like "already mined")
    if (!session) {
      summary.empty++;
      continue;
    }

    // ── Dry run ─────────────────────────────────────────────────────────────
    if (opts.dryRun) {
      const result: MineResult = {
        status: "skipped",
        session,
        reason: "dry-run",
      };
      summary.results.push(result);
      opts.onProgress?.(result);
      continue;
    }

    // ── File to palace ──────────────────────────────────────────────────────
    try {
      const drawerId = await fileSession(session, client, room);
      minedIds[session.id] = new Date().toISOString();

      const result: MineResult = { status: "filed", session, drawerId };
      summary.filed++;
      summary.results.push(result);
      opts.onProgress?.(result);
    } catch (err: any) {
      const result: MineResult = { status: "error", path, error: err };
      summary.errors++;
      summary.results.push(result);
      opts.onProgress?.(result);
    }
  }

  // Persist updated state (no-op on dry run — nothing was actually filed)
  if (!opts.dryRun) {
    saveMineState(state);
  }

  return summary;
}

// ── Convenience: discover + mine in one call ──────────────────────────────────

/**
 * Discover all session files and mine unmined ones.
 * This is what the /mine-sessions command calls.
 */
export async function discoverAndMine(
  client: McpClient,
  opts: MineOptions = {},
): Promise<MineSummary> {
  const paths = await discoverSessions({
    sessionsDir: opts.sessionsDir,
    since:       opts.since,
  });

  return mineSessions(paths, client, opts);
}
