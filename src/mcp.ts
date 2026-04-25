/**
 * mcp.ts — MemPalace MCP server lifecycle + JSON-RPC client
 *
 * Spawns `python -m mempalace.mcp_server` as a stdio subprocess and speaks
 * the MCP JSON-RPC protocol over it.  Also converts MCP tool schemas into
 * TypeBox so pi can register them natively.
 *
 * One McpClient instance lives for the duration of a pi session.  All other
 * modules (mine, diary, index) receive it as a constructor argument or via
 * the connect() return value — no globals.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// ── MCP JSON Schema types ─────────────────────────────────────────────────────

interface JsonSchemaField {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaField;
  properties?: Record<string, JsonSchemaField>;
  required?: string[];
  anyOf?: JsonSchemaField[];
  oneOf?: JsonSchemaField[];
}

interface MCPInputSchema extends JsonSchemaField {
  type: "object";
  properties?: Record<string, JsonSchemaField>;
  required?: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPInputSchema;
  /** TypeBox schema ready for pi.registerTool(), produced by convertSchema(). */
  parameters: ReturnType<typeof Type.Object>;
}

// ── JSON Schema → TypeBox conversion ─────────────────────────────────────────
// Best-effort conversion that covers every field type MemPalace uses.

function convertField(field: JsonSchemaField, isRequired: boolean): any {
  const meta = field.description ? { description: field.description } : {};
  let schema: any;

  const union = field.anyOf ?? field.oneOf;
  if (union) {
    const members = union.map((f) => convertField(f, true));
    schema = members.length === 1 ? members[0] : Type.Union(members, meta);
  } else {
    switch (field.type) {
      case "string":
        schema = field.enum
          ? Type.Union(field.enum.map((v) => Type.Literal(v)), meta)
          : Type.String(meta);
        break;
      case "number":
      case "integer":
        schema = Type.Number(meta);
        break;
      case "boolean":
        schema = Type.Boolean(meta);
        break;
      case "array":
        schema = Type.Array(
          field.items ? convertField(field.items, true) : Type.Any(),
          meta,
        );
        break;
      case "object":
        schema = convertObject(field as MCPInputSchema, meta);
        break;
      default:
        schema = Type.Any(meta);
    }
  }

  return isRequired ? schema : Type.Optional(schema);
}

function convertObject(schema: MCPInputSchema, meta: object = {}): any {
  const required = new Set(schema.required ?? []);
  const props: Record<string, any> = {};
  for (const [key, val] of Object.entries(schema.properties ?? {})) {
    props[key] = convertField(val, required.has(key));
  }
  return Type.Object(props, meta);
}

/** Convert an MCP inputSchema into a TypeBox object schema for pi.registerTool(). */
export function convertSchema(inputSchema: MCPInputSchema): ReturnType<typeof Type.Object> {
  return convertObject(inputSchema);
}

// ── Python discovery ──────────────────────────────────────────────────────────

/**
 * Find a Python interpreter that has `mempalace` importable.
 *
 * Search order:
 *   1. pipx venv (most common for CLI-tool installs)
 *   2. python3 on PATH
 *   3. python on PATH
 *
 * Throws a user-friendly error if none works.
 */
export async function findPython(): Promise<string> {
  const home = process.env.HOME ?? "/root";
  const candidates = [
    `${home}/.local/share/pipx/venvs/mempalace/bin/python`,
    "python3",
    "python",
  ];

  for (const py of candidates) {
    try {
      await execFileAsync(py, ["-c", "import mempalace"]);
      return py;
    } catch {
      // not this one — try next
    }
  }

  throw new Error(
    "MemPalace is not installed or not importable.\n" +
    "Install it with:  pipx install mempalace\n" +
    "Or:               pip install mempalace",
  );
}

// ── McpClient ─────────────────────────────────────────────────────────────────

/** Default tool-call timeout in ms. Override with PI_MEMPALACE_TOOL_TIMEOUT. */
export const DEFAULT_TOOL_TIMEOUT_MS = (() => {
  const env = process.env["PI_MEMPALACE_TOOL_TIMEOUT"];
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
    console.warn(`[mempalace] PI_MEMPALACE_TOOL_TIMEOUT="${env}" is not a valid positive integer — using default 120000`);
  }
  return 120_000;
})();

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private _ready = false;
  /** Resolved tool-call timeout for this client instance. */
  readonly toolTimeoutMs: number;
  /** The Python executable path found during connect(). */
  pythonPath: string | null = null;

  constructor(toolTimeoutMs?: number) {
    this.toolTimeoutMs = toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  get ready(): boolean {
    return this._ready;
  }

  // ── Low-level JSON-RPC ──────────────────────────────────────────────────

  private sendRaw(msg: object): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: object = {}, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._ready && method !== "initialize") {
        reject(new Error("MemPalace MCP server is not connected"));
        return;
      }

      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MemPalace MCP request timed out: ${method}`));
        }
      }, timeoutMs);

      // Ensure the timer doesn't keep Node alive if everything else finishes
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Call a named MCP tool and return its text output.
   * Joins multiple text content parts with newlines.
   * Throws on MCP-level errors (server returns error response).
   *
   * @param timeoutMs  Per-call timeout in ms.  Defaults to 120 s — tool calls
   *                   may involve vector DB operations that take a long time on
   *                   cold start (e.g. loading a 143 k-drawer HNSW index).
   */
  async callTool(name: string, args: object, timeoutMs?: number): Promise<string> {
    timeoutMs ??= this.toolTimeoutMs;
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const parts: any[] = result?.content ?? [];
    const text = parts
      .filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text))
      .join("\n");
    return text || JSON.stringify(result);
  }

  /**
   * Start the MCP server subprocess, complete the initialisation handshake,
   * and return the full list of available tools (with TypeBox parameters
   * already attached).
   *
   * Safe to call multiple times — returns immediately if already connected.
   */
  async connect(): Promise<MCPTool[]> {
    if (this._ready) {
      // Already connected — just return current tool list
      const { tools } = await this.request("tools/list");
      return this.attachParameters(tools ?? []);
    }

    this.pythonPath = await findPython();

    this.proc = spawn(this.pythonPath, ["-m", "mempalace.mcp_server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (err) => {
      console.error("[mempalace] MCP server process error:", err.message);
    });

    this.proc.on("exit", (code, signal) => {
      if (this._ready) {
        // Unexpected exit — the session is still running
        console.warn(
          `[mempalace] MCP server exited unexpectedly (code=${code}, signal=${signal})`,
        );
        this._ready = false;
      }
    });

    // Wire up response parsing before sending the handshake
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.error
              ? p.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)))
              : p.resolve(msg.result);
          }
        }
      } catch {
        // Non-JSON startup noise — ignore
      }
    });

    // MCP initialisation handshake (request fires before _ready is set, so
    // we bypass the guard by passing method="initialize")
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "pi-mempalace", version: "1.0.0" },
    });

    // Notify server — fire-and-forget, no response expected
    this.sendRaw({ jsonrpc: "2.0", method: "notifications/initialized" });

    this._ready = true;

    const { tools } = await this.request("tools/list");
    return this.attachParameters(tools ?? []);
  }

  /**
   * Kill the subprocess and reject all in-flight requests.
   * Safe to call even if already disconnected.
   */
  disconnect(): void {
    this._ready = false;

    for (const { reject } of this.pending.values()) {
      reject(new Error("MemPalace MCP server shutting down"));
    }
    this.pending.clear();

    this.proc?.kill();
    this.proc = null;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private attachParameters(rawTools: any[]): MCPTool[] {
    return (rawTools as Array<{ name: string; description: string; inputSchema: MCPInputSchema }>)
      .map((t) => ({
        ...t,
        parameters: convertSchema(t.inputSchema),
      }));
  }
}
