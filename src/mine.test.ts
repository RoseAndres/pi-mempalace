/**
 * mine.test.ts — integration test for mine.ts against the live palace.
 *   npx jiti src/mine.test.ts
 *
 * Files one real session into a throwaway wing ("_pi_mine_test") then
 * deletes the drawer afterwards so the palace stays clean.
 */

import { McpClient } from "./mcp.js";
import { discoverSessions, loadMinableSession, formatTranscript } from "./session.js";
import { mineSessions, discoverAndMine } from "./mine.js";
import { homedir } from "node:os";
import { join } from "node:path";

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

const TEST_WING = "pi-mine-test";
const TEST_ROOM = "sessions";
const filedDrawerIds: string[] = [];

// ── Setup ─────────────────────────────────────────────────────────────────────

console.log("\n── connecting to palace ──");
const client = new McpClient();
await client.connect();
assert("client ready", client.ready);

// Pick a real session with user turns to use as our test subject
const allPaths = await discoverSessions({ sessionsDir: join(homedir(), ".pi", "agent", "sessions") });
const testPath = allPaths.find(p => loadMinableSession(p) !== null);
assert(`found a minable session (${testPath?.split("/").pop()})`, testPath !== undefined);

if (!testPath) {
  console.error("No minable sessions found — cannot continue");
  process.exit(1);
}

const testSession = loadMinableSession(testPath)!;

// ── mineSessions: dry run ─────────────────────────────────────────────────────

console.log("\n── dry run ──");
const dryResults: string[] = [];
const drySummary = await mineSessions([testPath], client, {
  wingOverride: TEST_WING,
  dryRun: true,
  mineAll: true,
  onProgress: (r) => dryResults.push(r.status),
});

assert("dry run: status=skipped",    dryResults[0] === "skipped");
assert("dry run: filed=0",           drySummary.filed === 0);
assert("dry run: no palace changes", drySummary.results[0]?.status === "skipped");

// ── mineSessions: real file ───────────────────────────────────────────────────

console.log("\n── file one session ──");
const progressLog: string[] = [];
const summary = await mineSessions([testPath], client, {
  wingOverride: TEST_WING,
  mineAll: true, // ignore state — we want to actually file it
  onProgress: (r) => {
    progressLog.push(r.status);
    if (r.status === "filed") filedDrawerIds.push(r.drawerId);
  },
});

assert("filed=1",              summary.filed === 1);
assert("errors=0",             summary.errors === 0);
assert("progress callback ran", progressLog[0] === "filed");
assert("drawer ID returned",   filedDrawerIds.length === 1 && filedDrawerIds[0].length > 0);
console.log(`  drawer ID: ${filedDrawerIds[0]}`);

// ── Verify the drawer is retrievable ─────────────────────────────────────────

console.log("\n── verify drawer in palace ──");
const drawerJson = await client.callTool("mempalace_get_drawer", { drawer_id: filedDrawerIds[0] });
const drawer = JSON.parse(drawerJson);

assert("drawer.wing matches",    drawer.wing === TEST_WING);
assert("drawer.room matches",    drawer.room === TEST_ROOM);
assert("drawer has content",     typeof drawer.content === "string" && drawer.content.length > 0);
assert("content has session id", drawer.content.includes(testSession.id));
assert("content has User: turn", drawer.content.includes("User:"));
console.log(`  content: ${drawer.content.length} chars`);

// ── already-mined dedup ───────────────────────────────────────────────────────

console.log("\n── already-mined dedup (state file) ──");
// Mine the same path again without mineAll — should be skipped
// (state was saved by the previous run)
const dedupSummary = await mineSessions([testPath], client, {
  wingOverride: TEST_WING,
  // mineAll: false (default)
  onProgress: (r) => progressLog.push(r.status),
});
assert("dedup: filed=0",   dedupSummary.filed === 0);
assert("dedup: skipped=1", dedupSummary.skipped === 1);

// ── Cleanup: delete test drawers ──────────────────────────────────────────────

console.log("\n── cleanup ──");
for (const id of filedDrawerIds) {
  await client.callTool("mempalace_delete_drawer", { drawer_id: id });
  console.log(`  deleted: ${id}`);
}
assert("cleanup: all drawers deleted", true); // if we got here without throwing, it worked

// ── Teardown ──────────────────────────────────────────────────────────────────

client.disconnect();

console.log(`\n${"─".repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
