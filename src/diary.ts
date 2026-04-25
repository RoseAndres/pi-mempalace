/**
 * diary.ts — automated diary writes to MemPalace
 *
 * Handles the three save triggers from the pi lifecycle:
 *   - session_shutdown  (session end)
 *   - session_before_compact  (pre-compaction rescue)
 *   - turn_end every N turns  (periodic save)
 *
 * Each save extracts the active conversation branch from pi's session manager,
 * formats it as a structured transcript, and calls mempalace_diary_write via
 * the already-open McpClient.
 *
 * Agent name is read from PI_MEMPALACE_AGENT_NAME (default: "claude") so the
 * diary wing is correct for non-Claude models too.
 */

import type { McpClient } from "./mcp.js";
import { extractTurns, type SessionEntry, type Turn } from "./session.js";

// ── Agent name ───────────────────────────────────────────────────────────────

/**
 * Derive a stable diary agent name from pi's ExtensionContext.
 *
 * Resolution order:
 *   1. PI_MEMPALACE_AGENT_NAME env var  (explicit user override)
 *   2. Model family from ctx.model.id  (e.g. "claude-sonnet-4-6" → "claude")
 *   3. ctx.model.provider              (e.g. "anthropic")
 *   4. "claude"                        (hard fallback)
 *
 * We take only the first hyphen-separated segment of the model id so all
 * versions of a model family share one diary wing:
 *   claude-sonnet-4-6  → claude
 *   gpt-4o             → gpt
 *   gemini-pro         → gemini
 *   llama-3.1-8b       → llama
 */
export function agentNameFromContext(ctx: any): string {
  const envOverride = process.env["PI_MEMPALACE_AGENT_NAME"];
  if (envOverride) return envOverride;

  const modelId: string | undefined = ctx?.model?.id;
  if (modelId) {
    const family = modelId.split("-")[0].toLowerCase();
    if (family) return family;
  }

  const provider: string | undefined = ctx?.model?.provider;
  if (provider) return provider.toLowerCase();

  return "claude";
}

// ── Topic derivation ──────────────────────────────────────────────────────────

/**
 * Convert a human-readable save reason into a short topic slug.
 *
 *   "session end"            → "session-end"
 *   "pre-compaction"         → "pre-compaction"
 *   "periodic save at turn N" → "periodic-save"
 *   anything else            → "general"
 */
export function reasonToTopic(reason: string): string {
  if (reason.startsWith("session"))  return "session-end";
  if (reason.startsWith("pre-comp")) return "pre-compaction";
  if (reason.startsWith("periodic")) return "periodic-save";
  return "general";
}

// ── Entry formatting ──────────────────────────────────────────────────────────

/**
 * Build the diary entry string from a list of conversation turns.
 *
 * Format:
 *   [pi session — <reason> — <iso-timestamp>]
 *   cwd: <cwd>
 *   turns: <N>u <M>a
 *
 *   User: ...
 *
 *   Assistant: ...
 *
 * The header lines give MemPalace enough context to date and locate the
 * session without the LLM having to parse turn content.
 */
export function buildDiaryEntry(
  turns: Turn[],
  reason: string,
  cwd: string,
): string {
  const ts  = new Date().toISOString();
  const nu  = turns.filter(t => t.role === "User").length;
  const na  = turns.filter(t => t.role === "Assistant").length;

  const lines: string[] = [
    `[pi session \u2014 ${reason} \u2014 ${ts}]`,
    `cwd: ${cwd || "unknown"}`,
    `turns: ${nu}u ${na}a`,
    "",
  ];

  for (const turn of turns) {
    lines.push(`${turn.role}: ${turn.text}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Extract turns from pi session context ─────────────────────────────────────

/**
 * Pull conversation turns out of pi's ExtensionContext.
 *
 * ctx.sessionManager.getEntries() returns the full session tree; we feed
 * those entries through the same branch-resolution + turn-extraction logic
 * used by session.ts so diary writes are consistent with mined sessions.
 *
 * Accepts `any` because pi's ExtensionContext isn't importable at runtime
 * outside of the extension itself.
 */
export function turnsFromContext(ctx: any): Turn[] {
  const entries: SessionEntry[] = ctx?.sessionManager?.getEntries?.() ?? [];
  return extractTurns(entries);
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Extract the current session's conversation and write it to the MemPalace
 * diary.  Non-throwing — failures are logged as warnings so they never block
 * session shutdown or compaction.
 *
 * Returns true if the diary write succeeded, false otherwise.
 */
export async function saveMemories(
  ctx: any,
  reason: string,
  client: McpClient,
): Promise<boolean> {
  if (!client.ready) return false;

  const turns = turnsFromContext(ctx);
  if (turns.length === 0) return false;

  const cwd        = ctx?.cwd ?? "";
  const entry      = buildDiaryEntry(turns, reason, cwd);
  const topic      = reasonToTopic(reason);
  const agent_name = agentNameFromContext(ctx);

  try {
    await client.callTool("mempalace_diary_write", {
      agent_name,
      entry,
      topic,
    });
    return true;
  } catch (err: any) {
    // Non-fatal — warn and continue.  Session shutdown / compaction must
    // not be blocked by a diary write failure.
    console.warn("[mempalace] diary write failed:", err.message);
    return false;
  }
}
