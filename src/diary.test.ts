/**
 * diary.test.ts — unit + integration tests for diary.ts
 *   npx jiti src/diary.test.ts
 *
 * Unit tests cover the pure functions with no MCP.
 * The integration test writes a real diary entry then reads it back to verify.
 */

import { McpClient } from "./mcp.js";
import {
  agentNameFromContext,
  reasonToTopic,
  buildDiaryEntry,
  turnsFromContext,
  saveMemories,
} from "./diary.js";
import type { Turn } from "./session.js";

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

function eq<T>(label: string, actual: T, expected: T): void {
  const ok = actual === expected;
  assert(label, ok, ok ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── agentNameFromContext ──────────────────────────────────────────────────────

console.log("\n── agentNameFromContext ──");

// model id family extraction
eq("claude-sonnet-4-6 → claude", agentNameFromContext({ model: { id: "claude-sonnet-4-6" } }), "claude");
eq("gpt-4o → gpt",               agentNameFromContext({ model: { id: "gpt-4o" } }),             "gpt");
eq("gemini-pro → gemini",         agentNameFromContext({ model: { id: "gemini-pro" } }),         "gemini");
eq("llama-3.1-8b → llama",       agentNameFromContext({ model: { id: "llama-3.1-8b" } }),       "llama");

// provider fallback when no model id
eq("provider fallback",  agentNameFromContext({ model: { provider: "anthropic" } }), "anthropic");

// hard fallback
eq("null ctx → claude",   agentNameFromContext(null),  "claude");
eq("empty ctx → claude",  agentNameFromContext({}),    "claude");
eq("empty id → provider", agentNameFromContext({ model: { id: "", provider: "openai" } }), "openai");

// env var override beats everything
const origEnv = process.env["PI_MEMPALACE_AGENT_NAME"];
process.env["PI_MEMPALACE_AGENT_NAME"] = "my-agent";
eq("env override wins", agentNameFromContext({ model: { id: "gpt-4o" } }), "my-agent");
// restore
if (origEnv !== undefined) process.env["PI_MEMPALACE_AGENT_NAME"] = origEnv;
else delete process.env["PI_MEMPALACE_AGENT_NAME"];

console.log(`  env: PI_MEMPALACE_AGENT_NAME=${process.env["PI_MEMPALACE_AGENT_NAME"] ?? "unset"}`);

// ── reasonToTopic ─────────────────────────────────────────────────────────────

console.log("\n── reasonToTopic ──");
eq("session end → session-end",            reasonToTopic("session end"),              "session-end");
eq("pre-compaction → pre-compaction",      reasonToTopic("pre-compaction"),           "pre-compaction");
eq("periodic save at turn 15 → periodic",  reasonToTopic("periodic save at turn 15"), "periodic-save");
eq("unknown → general",                    reasonToTopic("something else"),            "general");

// ── buildDiaryEntry ───────────────────────────────────────────────────────────

console.log("\n── buildDiaryEntry ──");

const sampleTurns: Turn[] = [
  { role: "User",      text: "how do I fix this bug?" },
  { role: "Assistant", text: "Let me check the error. The issue is on line 42." },
  { role: "User",      text: "thanks that worked" },
];

const entry = buildDiaryEntry(sampleTurns, "session end", "/home/dre/Projects/myapp");
assert("entry is non-empty",            entry.length > 0);
assert("entry has header",              entry.startsWith("[pi session"));
assert("entry has reason",              entry.includes("session end"));
assert("entry has cwd",                 entry.includes("/home/dre/Projects/myapp"));
assert("entry has turn counts",         entry.includes("2u") && entry.includes("1a"));
assert("entry has User turn",           entry.includes("User: how do I fix this bug?"));
assert("entry has Assistant turn",      entry.includes("Assistant: Let me check"));
assert("does not end with blank line",  !entry.endsWith("\n\n"));

// edge: empty turns
const emptyEntry = buildDiaryEntry([], "session end", "/tmp");
assert("empty turns: header still present", emptyEntry.includes("[pi session"));

// edge: missing cwd
const noCwdEntry = buildDiaryEntry(sampleTurns, "session end", "");
assert("missing cwd → 'unknown'", noCwdEntry.includes("cwd: unknown"));

// ── turnsFromContext ──────────────────────────────────────────────────────────

console.log("\n── turnsFromContext ──");

const stubCtx = {
  cwd: "/home/dre/Projects/test",
  model: { id: "claude-sonnet-4-6", provider: "anthropic" },
  sessionManager: {
    getEntries: () => [
      {
        type: "message",
        id: "aaa",
        parentId: null,
        timestamp: "2026-04-23T10:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "what is 2+2?" }],
        },
      },
      {
        type: "message",
        id: "bbb",
        parentId: "aaa",
        timestamp: "2026-04-23T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "simple arithmetic" },
            { type: "text",     text: "4" },
          ],
        },
      },
    ],
  },
};

const ctxTurns = turnsFromContext(stubCtx);
assert("2 turns extracted",                       ctxTurns.length === 2);
assert("first turn is User",                      ctxTurns[0].role === "User");
assert("second turn is Assistant",                ctxTurns[1].role === "Assistant");
assert("thinking block stripped",                 ctxTurns[1].text === "4");

assert("null ctx → empty",                        turnsFromContext(null).length === 0);
assert("ctx without sessionManager → empty",      turnsFromContext({ cwd: "/tmp" }).length === 0);

// agentNameFromContext using stub (has model.id)
eq("agent name from stub ctx", agentNameFromContext(stubCtx), "claude");

// ── Live integration: saveMemories ────────────────────────────────────────────

console.log("\n── saveMemories (live) ──");
const client = new McpClient();
await client.connect();
assert("client ready", client.ready);

const ok = await saveMemories(stubCtx, "session end", client);
assert("saveMemories returned true", ok);

// Read back the most recent diary entry to confirm it landed under the right agent
const agentName = agentNameFromContext(stubCtx); // "claude"
const readJson  = await client.callTool("mempalace_diary_read", {
  agent_name: agentName,
  last_n: 1,
});
const readResult = JSON.parse(readJson);
const latest     = readResult.entries?.[0];

assert("diary entry exists",               latest !== undefined);
assert("topic is session-end",             latest?.topic === "session-end");
assert("content has User turn",            latest?.content?.includes("User: what is 2+2?") ?? false);
assert("content has Assistant turn",       latest?.content?.includes("Assistant: 4") ?? false);
assert("thinking block absent from diary", !(latest?.content?.includes("simple arithmetic") ?? true));

// not-ready client must return false without throwing
const skipped = await saveMemories(stubCtx, "session end", new McpClient());
assert("not-ready client returns false", skipped === false);

client.disconnect();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
