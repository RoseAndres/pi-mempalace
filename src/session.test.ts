/**
 * session.test.ts — smoke-test session.ts against real pi session files.
 *
 * Not a framework test — just a runnable script:
 *   npx jiti src/session.test.ts
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseSessionFile,
  resolveActiveBranch,
  extractTurns,
  inferWing,
  loadMinableSession,
  formatTranscript,
  discoverSessions,
  sessionIdFromFilename,
} from "./session.js";

// ── helpers ───────────────────────────────────────────────────────────────────

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── inferWing ─────────────────────────────────────────────────────────────────

console.log("\n── inferWing ──");
const home = homedir();
eq("home/Projects/discourse → discourse", inferWing(`${home}/Projects/discourse`), "discourse");
eq("home/Projects → general",             inferWing(`${home}/Projects`),            "general");
eq("empty string → general",              inferWing(""),                             "general");
eq("home/src/myapp → myapp",              inferWing(`${home}/src/myapp`),            "myapp");
eq("underscores → hyphens",               inferWing(`${home}/my_project`),           "my-project");
eq("/absolute/path/thing → thing",        inferWing("/absolute/path/thing"),         "thing");

// ── sessionIdFromFilename ─────────────────────────────────────────────────────

console.log("\n── sessionIdFromFilename ──");
eq(
  "standard filename",
  sessionIdFromFilename("2026-04-23T17-34-17-426Z_019dbb68-2352-779b-ba13-1b78507c47b9.jsonl"),
  "019dbb68-2352-779b-ba13-1b78507c47b9",
);
eq("no underscore → null", sessionIdFromFilename("nosep.jsonl"), null);

// ── Real session files ────────────────────────────────────────────────────────

const sessionsRoot = join(home, ".pi", "agent", "sessions");

console.log("\n── discoverSessions ──");
const files = await discoverSessions({ sessionsDir: sessionsRoot });
assert(`found sessions (got ${files.length})`, files.length > 0);

// ── Parse every real session ──────────────────────────────────────────────────

console.log(`\n── parsing ${files.length} session files ──`);
let skipped = 0;
let mineable = 0;

for (const f of files) {
  const shortName = f.split("/").slice(-2).join("/");

  // parseSessionFile must not throw
  let parsed;
  try {
    parsed = parseSessionFile(f);
    assert(`parse ok: ${shortName}`, true);
  } catch (err: any) {
    assert(`parse ok: ${shortName}`, false, err.message);
    continue;
  }

  // resolveActiveBranch must not throw
  let branch;
  try {
    branch = resolveActiveBranch(parsed.entries);
    assert(`branch ok: ${shortName} (${branch.length} entries)`, true);
  } catch (err: any) {
    assert(`branch ok: ${shortName}`, false, err.message);
    continue;
  }

  // extractTurns must not throw
  let turns;
  try {
    turns = extractTurns(parsed.entries);
    assert(`turns ok: ${shortName} (${turns.length} turns)`, true);
  } catch (err: any) {
    assert(`turns ok: ${shortName}`, false, err.message);
    continue;
  }

  // loadMinableSession wraps all of the above
  const minable = loadMinableSession(f);
  if (minable === null) {
    skipped++;
  } else {
    mineable++;
    assert(`wing inferred: ${shortName} → ${minable.wing}`, minable.wing.length > 0);
    assert(`transcript non-empty: ${shortName}`, formatTranscript(minable).length > 0);
  }
}

console.log(`\n  minable: ${mineable}, skipped (no user turns): ${skipped}`);

// ── Deep-inspect one session ──────────────────────────────────────────────────

const sample = files.find((f) => f.includes("--home-dre-Projects--"));
if (sample) {
  console.log(`\n── deep inspect: ${sample.split("/").pop()} ──`);
  const s = loadMinableSession(sample);
  if (s) {
    console.log(`  id:         ${s.id}`);
    console.log(`  cwd:        ${s.cwd}`);
    console.log(`  wing:       ${s.wing}`);
    console.log(`  user turns: ${s.userTurnCount}`);
    console.log(`  asst turns: ${s.assistantTurnCount}`);
    console.log(`  first user: ${s.turns.find(t => t.role === "User")?.text.slice(0, 80)}…`);
    const tx = formatTranscript(s);
    console.log(`  transcript: ${tx.length} chars, ${tx.split("\n").length} lines`);
  } else {
    console.log("  (no user turns — skipped)");
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
