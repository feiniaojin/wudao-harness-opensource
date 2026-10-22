// MCP orphaned grandchildren (0.3.39): stdio MCP commands are usually
// wrappers — `uvx minimax-coding-plan-mcp` spawns a python grandchild that
// is the REAL server. The old close() signalled only the direct child:
// a wrapper that exited on stdin EOF (the graceful path!) left the
// grandchild running forever. The fix spawns the child in its own process
// group (detached) and close() sweeps the whole group at every escalation
// step — including after a clean EOF exit, exactly the leg this test pins.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcClient } from "../src/mcp/json-rpc.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wudao-mcp-grpkill-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The wrapper-shape server: spawns a grandchild that never exits on its
// own (setInterval pins its event loop), reports both pids, then exits
// CLEANLY on stdin EOF — the graceful path that used to orphan the child.
const WRAPPER_SERVER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], process.pid + " " + grandchild.pid, "utf8");
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
`;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("close() vs wrapper grandchildren (uvx shape)", () => {
  it("a clean EOF exit of the wrapper still reaps the grandchild", async () => {
    const serverPath = join(dir, "wrapper-server.mjs");
    const pidFile = join(dir, "wrapper.pid");
    writeFileSync(serverPath, WRAPPER_SERVER, "utf8");

    const client = new JsonRpcClient({ command: process.execPath, args: [serverPath, pidFile] });

    // Both processes demonstrably up before we close.
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const [wrapperPid, grandchildPid] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
    expect(pidAlive(wrapperPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    await client.close();

    // The wrapper went down via the graceful EOF path (not the escalation
    // ladder on the direct child) — the group sweep is what had to get the
    // grandchild. Pre-fix: grandchild alive forever.
    expect(client.childExitCode).toBe(0);

    const gone = Date.now() + 5000;
    while ((pidAlive(wrapperPid) || pidAlive(grandchildPid)) && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pidAlive(wrapperPid)).toBe(false);
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 20_000);
});
