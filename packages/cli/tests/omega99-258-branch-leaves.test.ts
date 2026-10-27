// ω99-258: #1 — 面一（cli driver 读方法）R 件：branchLeaves() 是 web 分支面板
// 的数据面——与 tree()/switchBranch() 同一 JSONL 读路径（allMessagesForTree），
// 返回 core listBranchLeaves 的结构化叶表（{n, leafKey, forkPreview,
// messageCount, isCurrent}）直传，零持久层改动。另钉 disarmEdit() 的解除语义
// （armed 取消 → 下一次普通 submit 走主线：新轮 parentUuid = 线性前驱，不岔开）
// 与 P2-10 回退窗口的 isCurrent 全伪镜像（switchBranchFn 同款裁定）。全 mock
// （scripted model + stub 工具零真模型零真网络）；夹具只写 mkdtemp(os.tmpdir())
// 只写不删（★红线）。
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createJsonlSessionStore, createScriptedModel, nodeKey } from "@wudao/core";
import type { AgentMessage, AssistantMessage, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function stubReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "STUB FILE CONTENT" }),
  });
}

/** ω99-258: the M53 /tree-test harness — a REAL workspace store + identity
 *  persistence (onRunComplete appends only unseen identities; the set REBUILDS
 *  on onHistoryReplaced — the swap loads a fresh chain of objects, the real
 *  frontends' rule) so the driver's branch reads see the abandoned branches in
 *  the JSONL; the in-memory chain alone holds only the active line. */
function makePersistedDriver(dir: string, replies: readonly AssistantMessage[]) {
  const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
  const persistedSet = new Set<AgentMessage>();
  const driver = createAgentDriver({
    model: createScriptedModel(replies),
    tools: [stubReadTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: dir,
    sessionId: "o258",
    onHistoryReplaced: (messages: readonly AgentMessage[]) => {
      persistedSet.clear();
      for (const m of messages) persistedSet.add(m);
    },
    onRunComplete: async (messages: readonly AgentMessage[]) => {
      for (const m of messages) {
        if (persistedSet.has(m)) continue;
        persistedSet.add(m);
        await store.append("o258", m);
      }
    },
  });
  return driver;
}

const idle = (driver: ReturnType<typeof makePersistedDriver>, what: string) =>
  until(() => driver.getStatus().busy === false, what);

describe("ω99-258 branchLeaves() — the structured leaf table (面一)", () => {
  it("R1: a two-fork session reads 3 leaves from the JSONL — one current, forkPreview/messageCount per chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o258-3l-"));
    const driver = makePersistedDriver(dir, [
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "B1" },
      { role: "assistant", content: "A2" },
      { role: "assistant", content: "A3" },
    ]);
    driver.submit("first");
    await idle(driver, "run 1");
    driver.submit("second");
    await idle(driver, "run 2");
    await wait(50); // fire-and-forget persistence
    expect(driver.beginEdit(1)).toBe("second");
    driver.submit("second v2");
    await idle(driver, "branched run v2");
    await wait(50);
    // switch back to the original "second" chain, then fork it again → 3 leaves
    await driver.switchBranch(1);
    expect(driver.beginEdit(1)).toBe("second");
    driver.submit("second v3");
    await idle(driver, "branched run v3");
    await wait(50);

    const leaves = await driver.branchLeaves();
    expect(leaves.map((l) => l.n)).toEqual([1, 2, 3]);
    // exactly one current leaf — the v3 chain (the last submitted line)
    const current = leaves.filter((l) => l.isCurrent);
    expect(current).toHaveLength(1);
    const lastUser = [...driver.state.messages].reverse().find((m) => m.role === "user") as AgentMessage;
    expect(current[0]?.leafKey).toBe(nodeKey(lastUser));
    // every leaf diverges right after "first" (the nearest ancestor turn)
    expect(leaves.every((l) => l.forkPreview === "first")).toBe(true);
    // each chain is user+assistant+user+assistant — no tool traffic fired
    expect(leaves.map((l) => l.messageCount)).toEqual([4, 4, 4]);
    driver.dispose();
  });

  it("R1b: a no-branch session has exactly one leaf — current, empty forkPreview (the trunk root)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o258-1l-"));
    const driver = makePersistedDriver(dir, [
      { role: "assistant", content: "r1" },
      { role: "assistant", content: "r2" },
    ]);
    driver.submit("one");
    await idle(driver, "run 1");
    driver.submit("two");
    await idle(driver, "run 2");
    await wait(50);
    const leaves = await driver.branchLeaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.isCurrent).toBe(true);
    // the trunk's only leaf is "two" — its nearest ancestor turn is "one"
    // ("" is reserved for a single-turn trunk root)
    expect(leaves[0]?.forkPreview).toBe("one");
    expect(leaves[0]?.messageCount).toBe(4);
    driver.dispose();
  });

  it("R2: disarmEdit() voids an armed branch — the next submit stays on the mainline (linear parent link, still one leaf)", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "r1" },
        { role: "assistant", content: "r2" },
        { role: "assistant", content: "r3" },
      ]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    driver.submit("one");
    await until(() => driver.getStatus().busy === false, "run 1");
    driver.submit("two");
    await until(() => driver.getStatus().busy === false, "run 2");
    expect(driver.beginEdit(1)).toBe("two");
    expect(driver.disarmEdit()).toBe(true);
    expect(driver.disarmEdit()).toBe(true); // idempotent — a bare disarm still succeeds
    driver.submit("three");
    await until(() => driver.getStatus().busy === false, "run 3");
    const messages = driver.state.messages;
    const lastUser = [...messages].reverse().find((m) => m.role === "user") as AgentMessage;
    const idx = messages.findIndex((m) => m === lastUser);
    const predecessor = idx > 0 ? messages[idx - 1] : undefined;
    // linear: the new turn's parent link is its IMMEDIATE chain predecessor
    // (the armed cut would have linked it backwards past "two"/"r2")
    expect((lastUser as { parentUuid?: string }).parentUuid).toBe(
      predecessor !== undefined ? nodeKey(predecessor) : undefined,
    );
    const leaves = await driver.branchLeaves();
    expect(leaves).toHaveLength(1); // no fork was created — the mainline is the only line
    expect(leaves[0]?.isCurrent).toBe(true);
    driver.dispose();
  });

  it("R2b: in a /rewind window no leaf reads as current (the P2-10 mirror of switchBranchFn)", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "r1" },
        { role: "assistant", content: "r2" },
      ]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    driver.submit("one");
    await until(() => driver.getStatus().busy === false, "run 1");
    driver.submit("two");
    await until(() => driver.getStatus().busy === false, "run 2");
    // /rewind turn 1 rolls back to before "two" — the active chain is a
    // prefix, not a leaf (the rewoundCutKey window; fire-and-forget, one tick)
    driver.submit("/rewind turn 1");
    await wait(30);
    const leaves = await driver.branchLeaves();
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((l) => l.isCurrent === false)).toBe(true);
    driver.dispose();
  });
});
