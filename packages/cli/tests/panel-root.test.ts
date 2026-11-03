// workspace-ux B1 — the dual-root file panel: the driver's panelRoot state
// and the panelRootSet / agentRootStatus ops. The panel's VIEW root starts
// at the agent's workspaceRoot and moves ONLY through panelRootSet;
// fileTree/fileRead resolve against it (containment included) while the
// agent root — the tools' boundary, the session store's anchor — never
// moves. A successful pick also lands in the recents file (the same store
// the recentWorkspaces op reads, written through recordRecentWorkspace).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { createSettingsOps } from "../src/driver/settings-ops.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: createScriptedModel([]),
    tools: [],
    ...opts,
  });
}

describe("workspace-ux B1 — driver panelRoot + panelRootSet/agentRootStatus", () => {
  let rootA: string;
  let rootB: string;
  let home: string;
  let driver: AgentDriver;
  let savedHome: string | undefined;

  beforeEach(async () => {
    rootA = await mkdtemp(join(tmpdir(), "wudao-panel-a-"));
    rootB = await mkdtemp(join(tmpdir(), "wudao-panel-b-"));
    home = await mkdtemp(join(tmpdir(), "wudao-panel-home-"));
    await mkdir(join(rootA, "sub"));
    await writeFile(join(rootA, "a.txt"), "A");
    await writeFile(join(rootB, "b.md"), "B");
    // panelRootSet records the pick through WUDAO_GLOBAL_HOME — pin it to the
    // tmp home so a successful switch never touches the real one.
    savedHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    driver = makeDriver({ workspaceRoot: rootA });
  });

  afterEach(async () => {
    driver.dispose();
    if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
    else process.env.WUDAO_GLOBAL_HOME = savedHome;
    for (const d of [rootA, rootB, home]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a set re-roots fileTree/fileRead; containment is judged from the NEW root", async () => {
    expect((await driver.fileTree("")).entries.map((e) => e.name)).toEqual(["sub", "a.txt"]);
    await expect(driver.panelRootSet(rootB)).resolves.toEqual({ root: rootB });
    // The panel now lists B — b.md is there, A's entries are not.
    expect((await driver.fileTree("")).entries.map((e) => e.name)).toEqual(["b.md"]);
    expect((await driver.fileRead("b.md")).content).toBe("B");
    // A-relative paths died with the old root.
    await expect(driver.fileTree("sub")).rejects.toThrow(/no such directory/);
    await expect(driver.fileRead("a.txt")).rejects.toThrow(/no such file/);
    // Escape rejection is panelRoot-based: "../" leaves B, not A.
    await expect(driver.fileRead("../escape")).rejects.toThrow(/path escapes workspace/);
    await expect(driver.fileTree("../escape")).rejects.toThrow(/path escapes workspace/);
  });

  it("validation: nonexistent and non-directory paths reject with typed errors, moving nothing", async () => {
    await expect(driver.panelRootSet(join(rootA, "nope"))).rejects.toThrow(/no such directory/);
    await writeFile(join(rootA, "f.txt"), "x");
    await expect(driver.panelRootSet(join(rootA, "f.txt"))).rejects.toThrow(/not a directory/);
    expect((await driver.agentRootStatus()).panelRoot).toBe(rootA);
  });

  it("agentRootStatus: aligned at start; a set diverges the two roots without moving the agent's", async () => {
    expect(await driver.agentRootStatus()).toEqual({ panelRoot: rootA, agentRoot: rootA, bootRoot: rootA, aligned: true }); // 138b：bootRoot=会话锚
    await driver.panelRootSet(rootB);
    expect(await driver.agentRootStatus()).toEqual({ panelRoot: rootB, agentRoot: rootA, bootRoot: rootA, aligned: false });
  });

  it("the pick lands in the recents file — the same store recentWorkspaces reads", async () => {
    await driver.panelRootSet(rootB);
    const raw = JSON.parse(await readFile(join(home, "recent-workspaces.json"), "utf8")) as { path: string }[];
    expect(raw.map((r) => r.path)).toEqual([rootB]);
    const ops = createSettingsOps({ env: { WUDAO_GLOBAL_HOME: home }, workspaceRoot: rootA });
    expect((await ops.recentWorkspaces()).workspaces.map((w) => w.path)).toEqual([rootB]);
  });

  it("busy: panelRootSet applies mid-run — it is only the view root, nothing is disrupted", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const busyDriver = makeDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
        { role: "assistant", content: "DONE" },
      ]),
      // Fail-closed stub tool: without an allow ask the run would park at
      // pendingPermission instead of reaching the gate.
      onPermissionAsk: async () => ({ kind: "allow" }),
      tools: [
        buildTool({
          name: "read_file",
          description: "gated read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
          execute: async () => {
            await gate;
            return { content: "GATED" };
          },
        }),
      ],
      workspaceRoot: rootA,
    });
    busyDriver.submit("go");
    await until(() => busyDriver.getStatus().busy === true, "run to start");
    // Mid-run: the switch neither refuses nor interrupts — the panel re-roots
    // while the run keeps its (agent-root) footing.
    await expect(busyDriver.panelRootSet(rootB)).resolves.toEqual({ root: rootB });
    expect(await busyDriver.agentRootStatus()).toEqual({ panelRoot: rootB, agentRoot: rootA, bootRoot: rootA, aligned: false });
    release?.();
    await until(() => busyDriver.getStatus().busy === false, "run to finish");
    busyDriver.dispose();
  });

  it("no workspaceRoot: panelRoot falls back to cwd (still aligned; escapes reject from there)", async () => {
    const bare = makeDriver();
    expect(await bare.agentRootStatus()).toEqual({ panelRoot: process.cwd(), agentRoot: process.cwd(), bootRoot: process.cwd(), aligned: true });
    await expect(bare.fileRead("../escape")).rejects.toThrow(/path escapes workspace/);
    bare.dispose();
  });
});
