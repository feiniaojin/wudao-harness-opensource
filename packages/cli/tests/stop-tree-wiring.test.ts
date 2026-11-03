// stop-tree 接线测试（openwork opencode-interruption 移植弧）。
//
// 面一：stopTreeBox 的武装——driver 构造即把内部协调器的 register/settle 装
// 进盒（空盒进、函数出）；不传盒的宿主（REPL/workflow 等未接线者）派生路
// 径零登记、逐字节不变。
// 面二：interrupt 路径经协调器——parked permission ask 在停泊时进了回收簿，
// Esc 时 withdrawPending 列出 → denyPendingAsk 统一 drain 成 reject（「停干
// 净」：abort 后不留僵尸确认框）；无盒对照臂的行为逐字节一致（行为不回退
// 断言：旧 interrupt 路径在协调器缺席时不变）。
// 协调器纯逻辑（树递归/属主校验/深度上限/admission 三态）的确定性测试在
// packages/core/tests/stop-tree.test.ts——这里只钉接线面。
import { describe, expect, it } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AgentDriver, AgentDriverOptions, Tool } from "../src/driver/agent-driver.js";
import type { StopTreeDispatchPort } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

function stubEditTool(): Tool {
  return buildTool({
    name: "edit",
    description: "stub edit",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    // 停泊在 ask 上后 interrupt 会把它 drain 成 deny——工具本体跑不到，挂一
    // 个防挂死的门即可。
    execute: async () => ({ content: "ok" }),
  });
}

// 一个 run：模型先要 edit（无 onPermissionAsk → driver 级 ask 停泊），随后
// 正常答完。interrupt 场景里第二答永不可见。
function askThenAnswerModel() {
  return createScriptedModel([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "x", new_string: "y" } }] },
    { role: "assistant", content: "DONE" },
  ]);
}

describe("stop-tree 接线（stopTreeBox ↔ driver 协调器）", () => {
  it("driver 构造即武装盒的 register/settle；不传盒不武装（缺省零接线）", () => {
    const model = askThenAnswerModel();
    const box: StopTreeDispatchPort = {};
    const driver = makeDriver({ model, tools: [stubEditTool()], gates: { verify: false }, workspaceRoot: "/tmp/ws", stopTreeBox: box });
    expect(typeof box.register).toBe("function");
    expect(typeof box.settle).toBe("function");
    // 武装后的槽是可重入的登记面：登记 + 落定（协调器纯状态机，不抛）
    expect(() => {
      box.register?.("t-1", "side-1");
      box.settle?.("t-1");
    }).not.toThrow();
    driver.dispose();
  });

  it("interrupt：parked ask 经回收簿 drain 成 reject——树上有登记的孩子也不改停止行为", async () => {
    const model = askThenAnswerModel();
    const box: StopTreeDispatchPort = {};
    const driver = makeDriver({ model, tools: [stubEditTool()], gates: { verify: false }, workspaceRoot: "/tmp/ws", stopTreeBox: box });
    await wait();

    driver.submit("go");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    // 模拟任务工具派生点的登记（前台孩子进停止树；会话 id 随派生面带过）
    box.register?.("t-9", "side-child-9");

    driver.interrupt();
    // 回收已被 drain：ask 的答案面读的是活变量（非 emit 快照）——同步即可断言
    expect(driver.answerPermission(true)).toBe(false);
    await until(() => driver.getStatus().busy === false, "interrupted run to settle");
    // 注：getStatus 的 pendingPermission 是 emit 快照（denyPendingAsk 清活变量
    // 不 emit——既有机制），settle 后的快照才翻 null；答案面已在上面钉死。
    expect(driver.getStatus().pendingPermission).toBeNull();
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已中断"))).toBe(true);
    // 树上的登记孩子随后落定（任务工具 finally 位）——协调器纯接受，不抛
    expect(() => box.settle?.("t-9")).not.toThrow();
    driver.dispose();
  });

  it("行为不回退：无 stopTreeBox（协调器缺席）的旧 interrupt 路径逐字节同行为", async () => {
    const model = askThenAnswerModel();
    const driver = makeDriver({ model, tools: [stubEditTool()], gates: { verify: false }, workspaceRoot: "/tmp/ws" });
    await wait();

    driver.submit("go");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    driver.interrupt();
    expect(driver.answerPermission(true)).toBe(false);
    await until(() => driver.getStatus().busy === false, "interrupted run to settle");
    expect(driver.getStatus().pendingPermission).toBeNull();
    const notices = driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("已中断"));
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]!.text).toBe("⚠️ 已中断"); // user-abort 臂旧形（= driver.test.ts 同款钉）
    driver.dispose();
  });

  it("正常了结的 ask 不进停止回收：答完 → run 完成 → 后续 interrupt 空转", async () => {
    const model = askThenAnswerModel();
    const box: StopTreeDispatchPort = {};
    const driver = makeDriver({ model, tools: [stubEditTool()], gates: { verify: false }, workspaceRoot: "/tmp/ws", stopTreeBox: box });
    await wait();

    driver.submit("go");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "allowed run to finish");
    expect(driver.getHistory().some((e) => e.kind === "assistant" && e.text === "DONE")).toBe(true);
    // run 收束后再 Esc：无挂起 ask、无在飞 run——空转不产生任何可见回执
    const historyBefore = driver.getHistory().length;
    driver.interrupt();
    await wait();
    expect(driver.getHistory().length).toBe(historyBefore);
    driver.dispose();
  });
});
