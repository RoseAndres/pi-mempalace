/**
 * session.ts — pi JSONL session parser
 *
 * Reads pi's JSONL session files, resolves the active conversation branch
 * (handling forked/branched trees), and extracts plain-text turns.
 *
 * Pi session files are newline-delimited JSON.  Each file has:
 *   - One header line:   { type: "session", id, version, timestamp, cwd }
 *   - N entry lines:     { type, id, parentId, timestamp, [message] }
 *
 * Entries form a tree via parentId references.  The "active branch" is the
 * path from root to the most recently timestamped leaf node.
 *
 * This module is pure TypeScript — no subprocesses, no Python required.
 * The consumer decides what to do with the extracted turns (file to palace,
 * write to diary, etc.).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Raw JSONL shapes ──────────────────────────────────────────────────────────

/** First line of every pi session file. */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string; // ISO 8601
  cwd: string;
}

/** A content block inside a message. */
export interface ContentBlock {
  type: "text" | "thinking" | "toolCall" | "image" | string;
  text?: string;
  thinking?: string;
  // toolCall fields omitted — we don't need them
  [key: string]: unknown;
}

/** A pi message object (user / assistant / toolResult). */
export interface PiMessage {
  role: "user" | "assistant" | "toolResult";
  content: ContentBlock[] | string;
  timestamp?: number;
  // toolResult-specific
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** A single entry in the JSONL tree (not the header). */
export interface SessionEntry {
  type: string; // "message" | "model_change" | "thinking_level_change" | "custom" | ...
  id: string;
  parentId: string | null;
  timestamp: string; // ISO 8601
  message?: PiMessage;
  // custom entry fields
  customType?: string;
  data?: unknown;
}

/** Parsed session file. */
export interface ParsedSession {
  header: SessionHeader;
  entries: SessionEntry[];
}

// ── Parsed output shapes ──────────────────────────────────────────────────────

/** A single conversation turn extracted from the active branch. */
export interface Turn {
  role: "User" | "Assistant";
  text: string;
}

/** A session ready to be filed, with everything resolved. */
export interface MinableSession {
  /** Absolute path to the source .jsonl file. */
  path: string;
  /** Session ID (UUID from header). */
  id: string;
  /** ISO 8601 session start timestamp. */
  timestamp: string;
  /** Working directory when the session was created. */
  cwd: string;
  /** Inferred wing name (from cwd). */
  wing: string;
  /** Ordered turns on the active branch. */
  turns: Turn[];
  /** Number of user turns. */
  userTurnCount: number;
  /** Number of assistant turns. */
  assistantTurnCount: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a pi JSONL session file into its header and entries.
 * Lines that are not valid JSON, or have no "id" field (and are not the
 * session header), are silently skipped.
 */
export function parseSessionFile(filePath: string): ParsedSession {
  const raw = readFileSync(filePath, "utf-8");
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // malformed line — skip
    }

    if (obj["type"] === "session") {
      header = obj as unknown as SessionHeader;
    } else if (typeof obj["id"] === "string") {
      entries.push(obj as unknown as SessionEntry);
    }
  }

  if (!header) {
    // Synthesise a minimal header so callers don't have to null-check
    header = {
      type: "session",
      version: 0,
      id: "unknown",
      timestamp: new Date().toISOString(),
      cwd: "",
    };
  }

  return { header, entries };
}

// ── Branch resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the active branch of a session tree.
 *
 * Pi sessions are an append-only tree.  Branching happens via /fork, /clone,
 * or /tree navigation — each creates a new path diverging from a past entry.
 *
 * The "active branch" is the path from root to the most recently timestamped
 * leaf (an entry with no children pointing at it).
 *
 * Returns entries in chronological order (root → leaf).
 */
export function resolveActiveBranch(entries: SessionEntry[]): SessionEntry[] {
  if (entries.length === 0) return [];

  // Build a set of all IDs that appear as someone's parentId
  const hasChildren = new Set<string>(
    entries
      .map((e) => e.parentId)
      .filter((id): id is string => id !== null && id !== undefined),
  );

  // Leaves = entries that nothing points at as a parent
  const leaves = entries.filter((e) => !hasChildren.has(e.id));

  if (leaves.length === 0) return []; // degenerate / empty

  // Pick the leaf with the latest timestamp as the active tip
  const activeLeaf = leaves.reduce((best, e) =>
    e.timestamp > best.timestamp ? e : best,
  );

  // Walk leaf → root via parentId, then reverse
  const byId = new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
  const branch: SessionEntry[] = [];
  let cur: SessionEntry | undefined = activeLeaf;

  while (cur) {
    branch.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  return branch.reverse(); // chronological order
}

// ── Text extraction ───────────────────────────────────────────────────────────

/**
 * Extract plain text from a pi message content field.
 * Handles both the string form (legacy) and the block array form.
 * Skips "thinking" blocks — only "text" blocks are included.
 */
export function extractText(content: ContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();

  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(" ")
    .trim();
}

/**
 * Walk the active branch and extract User/Assistant turns.
 * Skips:
 *   - Non-message entries (model_change, thinking_level_change, custom, …)
 *   - toolResult messages (role === "toolResult") — too noisy for memory
 *   - Messages with empty text after extraction
 */
export function extractTurns(entries: SessionEntry[]): Turn[] {
  const branch = resolveActiveBranch(entries);
  const turns: Turn[] = [];

  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;

    const { role, content } = entry.message;

    if (role === "user") {
      const text = extractText(content);
      if (text) turns.push({ role: "User", text });
    } else if (role === "assistant") {
      const text = extractText(content);
      if (text) turns.push({ role: "Assistant", text });
    }
    // toolResult: intentionally skipped
  }

  return turns;
}

// ── Wing inference ────────────────────────────────────────────────────────────

/**
 * Derive a MemPalace wing name from a session's working directory.
 *
 * Strategy:
 *   1. Strip the home directory prefix
 *   2. Drop common top-level "noise" directories (projects, src, repos, …)
 *   3. Use the deepest remaining path segment as the wing name
 *   4. Sanitise to lowercase-hyphenated slug
 *   5. Fall back to "general" if nothing meaningful remains
 */
const SKIP_SEGMENTS = new Set([
  "projects",
  "src",
  "repos",
  "code",
  "work",
  "dev",
  "home",
  "workspace",
  "sites",
]);

export function inferWing(cwd: string): string {
  if (!cwd) return "general";

  const home = homedir();
  // Strip home prefix and split into parts
  const relative = cwd.startsWith(home) ? cwd.slice(home.length) : cwd;
  const parts = relative
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Drop generic top-level dirs
  const meaningful = parts.filter((p) => !SKIP_SEGMENTS.has(p.toLowerCase()));

  const name = meaningful.length > 0 ? meaningful[meaningful.length - 1] : "general";

  // Sanitise: lowercase, spaces/underscores → hyphens, strip non-alphanum-hyphen
  return (
    name
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

// ── High-level assembly ───────────────────────────────────────────────────────

/**
 * Parse a session file and return a MinableSession ready to be filed.
 * Returns null if the session has no usable conversation turns (so callers
 * can skip it without special-casing).
 */
export function loadMinableSession(
  filePath: string,
  wingOverride?: string,
): MinableSession | null {
  const { header, entries } = parseSessionFile(filePath);
  const turns = extractTurns(entries);

  const userTurnCount = turns.filter((t) => t.role === "User").length;
  if (userTurnCount === 0) return null; // nothing worth filing

  return {
    path: filePath,
    id: header.id,
    timestamp: header.timestamp,
    cwd: header.cwd,
    wing: wingOverride ?? inferWing(header.cwd),
    turns,
    userTurnCount,
    assistantTurnCount: turns.filter((t) => t.role === "Assistant").length,
  };
}

/**
 * Format a MinableSession as a plain-text transcript.
 *
 * The header comment lines (# prefix) are ignored by MemPalace's text miner
 * and serve as human-readable metadata.
 */
export function formatTranscript(session: MinableSession): string {
  const lines: string[] = [
    `# pi session ${session.id}`,
    `# date: ${session.timestamp}`,
    `# cwd:  ${session.cwd}`,
    "",
  ];

  for (const turn of session.turns) {
    lines.push(`${turn.role}: ${turn.text}`);
    lines.push(""); // blank line between turns
  }

  return lines.join("\n").trimEnd();
}

// ── Session discovery ─────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** Root directory to scan (default: ~/.pi/agent/sessions). */
  sessionsDir?: string;
  /** Only include sessions with mtime on or after this date. */
  since?: Date;
}

/**
 * Discover all .jsonl session files under sessionsDir, sorted by mtime
 * (oldest first so we mine in chronological order).
 */
export async function discoverSessions(opts: DiscoverOptions = {}): Promise<string[]> {
  const root = opts.sessionsDir ?? join(homedir(), ".pi", "agent", "sessions");

  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory not readable — skip
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (name.endsWith(".jsonl")) {
        if (!opts.since || st.mtime >= opts.since) {
          files.push(full);
        }
      }
    }
  }

  await walk(root);

  // Sort by mtime ascending (oldest first)
  const withMtime = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await stat(f)).mtime })),
  );
  withMtime.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  return withMtime.map((x) => x.f);
}

// ── Mine-state tracking ───────────────────────────────────────────────────────

export interface MineState {
  /** Map of session ID → ISO timestamp of when it was mined. */
  mined: Record<string, string>;
}

const STATE_PATH = join(homedir(), ".pi", "agent", "mempalace-mined.json");

export function loadMineState(): MineState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as MineState;
  } catch {
    return { mined: {} };
  }
}

export function saveMineState(state: MineState): void {
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Extract the session UUID from a .jsonl filename.
 * Filenames have the form: <iso-timestamp>_<uuid>.jsonl
 */
export function sessionIdFromFilename(filePath: string): string | null {
  const name = filePath.split("/").pop() ?? "";
  const stem = name.endsWith(".jsonl") ? name.slice(0, -6) : name;
  const parts = stem.split("_");
  return parts.length >= 2 ? parts.slice(1).join("_") : null;
}
