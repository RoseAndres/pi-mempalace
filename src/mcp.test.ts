/**
 * mcp.test.ts — smoke-test McpClient against the live MemPalace MCP server.
 *   npx jiti src/mcp.test.ts
 */

import { McpClient, findPython, DEFAULT_TOOL_TIMEOUT_MS } from "./mcp.js";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

// ── DEFAULT_TOOL_TIMEOUT_MS / env var ───────────────────────────────────────

console.log("\n── timeout config ──");
assert(`DEFAULT_TOOL_TIMEOUT_MS is a positive integer`, Number.isInteger(DEFAULT_TOOL_TIMEOUT_MS) && DEFAULT_TOOL_TIMEOUT_MS > 0);
console.log(`  DEFAULT_TOOL_TIMEOUT_MS = ${DEFAULT_TOOL_TIMEOUT_MS} (env: ${process.env["PI_MEMPALACE_TOOL_TIMEOUT"] ?? "unset"})`);

// constructor override takes priority over env var
const fastClient = new McpClient(5_000);
assert("constructor override: 5000", fastClient.toolTimeoutMs === 5_000);

// default client uses the env-derived value
const defaultClient = new McpClient();
assert(`default client uses DEFAULT_TOOL_TIMEOUT_MS`, defaultClient.toolTimeoutMs === DEFAULT_TOOL_TIMEOUT_MS);

// ── findPython ────────────────────────────────────────────────────────────────

console.log("\n── findPython ──");
const py = await findPython();
assert(`found python: ${py}`, py.length > 0);

// ── connect ───────────────────────────────────────────────────────────────────

console.log("\n── McpClient.connect() ──");
const client = new McpClient();
const tools = await client.connect();

assert("client.ready after connect", client.ready);
assert(`pythonPath set: ${client.pythonPath}`, client.pythonPath !== null);
assert(`tools discovered (got ${tools.length})`, tools.length > 0);

// Every tool must have name, description, and parameters
const malformed = tools.filter(
  (t) => !t.name || !t.description || !t.parameters,
);
assert(`all tools well-formed (malformed: ${malformed.length})`, malformed.length === 0);

console.log("  tool names:", tools.map((t) => t.name).join(", "));

// ── callTool: mempalace_status ────────────────────────────────────────────────

console.log("\n── callTool: mempalace_status ──");
const status = await client.callTool("mempalace_status", {});
assert("status response non-empty", status.length > 0);
assert("status contains palace_path", status.includes("palace_path"));
console.log(`  response: ${status.length} chars`);

// ── callTool: error handling ──────────────────────────────────────────────────

console.log("\n── callTool: bad tool name ──");
try {
  await client.callTool("mempalace_does_not_exist", {});
  assert("bad tool should throw", false, "no error thrown");
} catch (err: any) {
  assert(`bad tool throws (${err.message.slice(0, 60)})`, true);
}

// ── second connect() is idempotent ────────────────────────────────────────────

console.log("\n── connect() idempotency ──");
const tools2 = await client.connect();
assert("still ready", client.ready);
assert("same tool count", tools2.length === tools.length);

// ── disconnect ────────────────────────────────────────────────────────────────

console.log("\n── disconnect ──");
client.disconnect();
assert("not ready after disconnect", !client.ready);

// Calls after disconnect must throw, not hang
try {
  await client.callTool("mempalace_status", {});
  assert("callTool after disconnect should throw", false, "no error thrown");
} catch (err: any) {
  assert(`callTool after disconnect throws (${err.message.slice(0, 50)})`, true);
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
