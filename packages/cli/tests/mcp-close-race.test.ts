// MCP boot-SIGTERM race (0.3.39 smoke red): connectServer spawns the child
// in the JsonRpcClient constructor but only registered it in the `clients`
// array AFTER initialize + tools/list — a SIGTERM landing inside the
// handshake window (the smoke kills ~1s after boot; the user-level uvx
// MiniMax entry made this window real) left the child outside
// closeMcpTools() 的收走范围, its stdio pins kept the event loop alive, and
// the sidecar never exited. The fix registers the client at SPAWN time.
// Repro ladder: SIGTERM@0.8s hung, SIGTERM@4s exited — this test pins the
// early-kill leg.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpTools, closeMcpTools } from "../src/mcp/tools.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wudao-mcp-race-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A MCP server that never answers initialize: writes its pid, then politely
// drains stdin and exits on EOF (the graceful-shutdown contract). It stays
// alive UNTIL someone closes its stdin — exactly the state the smoke's
// early SIGTERM found unowned.
const SILENT_SERVER = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid), "utf8");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", () => {});
`;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("closeMcpTools vs the in-flight handshake (boot SIGTERM race)", () => {
  it("a SIGTERM during the handshake window still reaps the spawned child", async () => {
    const serverPath = join(dir, "silent-server.mjs");
    const pidFile = join(dir, "server.pid");
    writeFileSync(serverPath, SILENT_SERVER, "utf8");

    // Boot the connect; do NOT await — the kill must land mid-handshake.
    const connecting = loadMcpTools(
      { servers: { silent: { command: process.execPath, args: [serverPath, pidFile] } } },
      () => {},
      { connectMs: 4000 },
    );

    // Wait until the child is demonstrably up (it wrote its pid) — the race
    // window is exactly "spawned but not yet registered".
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pidAlive(pid)).toBe(true);

    // The early SIGTERM's equivalent: close everything that exists.
    await closeMcpTools();

    // The child must die from the close (stdin EOF here) within a bounded
    // wait — pre-fix it was never in `clients` and survived untouched.
    const gone = Date.now() + 3000;
    while (pidAlive(pid) && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pidAlive(pid)).toBe(false);

    // The interrupted connect settles fail-closed: the failed server is
    // skipped (loadMcpTools's warn-and-skip contract), not a hung promise.
    await expect(connecting).resolves.toEqual([]);
  });
});
