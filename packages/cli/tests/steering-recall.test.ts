// 借鉴弧 α2（CC 2.1.269 思想）— steering 未读撤回：
//   驱动面  recallSteer 的 CAS 语义（同帧 index+text 相符才删；已消费/错
//   文本/越界 → false；撤回进历史 notice；系统车道不可撤——它根本不在
//   queued 数组里）
//   纯层   parseRecallCommand / recallTargetOf（/find-core 同款 TUI 自有命令）
// 对垒在位者：mid-run take()/结算 drain 只消费不回退；简单面的 parked chips
// 放弃钮只管客户端本地离线队列（App state），从未覆盖服务端 steering 队列。
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput } from "@wudao-org/core";
import { createAgentDriver, type AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { parseRecallCommand, recallTargetOf } from "../src/tui/recall-core.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A driver whose model GATES on manual promises — busy stays true while we
 *  park steers. settleAll releases every gate in turn (a leftover steer can
 *  auto-start a follow-up run at settle — the M14 fallback — so one release
 *  is not always enough; keep releasing until the driver is truly idle). */
function makeGatedDriver(): { driver: AgentDriver; settleAll: () => Promise<void>; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let releaseFn: (() => void) | null = null;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<{ role: "assistant"; content: string }> {
      inputs.push(input);
      await new Promise<void>((resolve) => { releaseFn = resolve; });
      return { role: "assistant", content: "ok" };
    },
  };
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [],
    gates: { todo: false, verify: false },
  });
  const settleAll = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      if (!driver.getStatus().busy) return;
      await until(() => releaseFn !== null, `model call #${i + 1} gates`);
      const r = releaseFn;
      releaseFn = null;
      r?.();
      await until(() => driver.getStatus().busy === false || releaseFn !== null, `run #${i + 1} settles or re-gates`);
    }
    await until(() => driver.getStatus().busy === false, "final settle");
  };
  return { driver, settleAll, inputs };
}

describe("α2 驱动面 — recallSteer 的 CAS 语义", () => {
  it("removes a still-queued steer (index+text from the same frame); wrong pair / consumed / out-of-range all refuse", async () => {
    const { driver, settleAll, inputs } = makeGatedDriver();
    driver.submit("first");
    await until(() => driver.getStatus().busy === true, "run goes busy");
    expect(driver.submit("steer-a")).toBe("steered");
    expect(driver.submit("steer-b")).toBe("steered");
    expect(driver.getStatus().queued).toEqual(["steer-a", "steer-b"]);
    // CAS hit: same frame's index+text.
    expect(driver.recallSteer(0, "steer-a")).toBe(true);
    expect(driver.getStatus().queued).toEqual(["steer-b"]);
    // CAS misses: wrong text, stale index, out-of-range, non-integer.
    expect(driver.recallSteer(0, "steer-a")).toBe(false);
    expect(driver.recallSteer(5, "steer-b")).toBe(false);
    expect(driver.recallSteer(-1, "steer-b")).toBe(false);
    expect(driver.recallSteer(1.5, "steer-b")).toBe(false);
    // The receipt landed in history (morning evidence).
    expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已撤回排队消息:steer-a"))).toBe(true);
    // The surviving steer still delivers: settle everything and the model saw it.
    await settleAll();
    expect(inputs.some((i) => i.messages.some((m) => m.role === "user" && m.content === "steer-b"))).toBe(true);
    expect(inputs.some((i) => i.messages.some((m) => m.role === "user" && m.content === "steer-a"))).toBe(false);
    expect(driver.getStatus().queued).toEqual([]);
  });

  it("the system lane is not recallable through the user queue (it never appears in queued)", async () => {
    const { driver, settleAll } = makeGatedDriver();
    driver.submit("first");
    await until(() => driver.getStatus().busy === true, "run goes busy");
    driver.steer("<workspace_changed>…</workspace_changed>"); // the SYSTEM lane
    expect(driver.getStatus().queued).toEqual([]); // not the user's words — invisible here
    expect(driver.recallSteer(0, "<workspace_changed>…</workspace_changed>")).toBe(false);
    await settleAll();
  });
});

describe("α2 纯层 — /recall 命令形状（/find-core 同款）", () => {
  it("parses bare /recall (last) and /recall <n>; prefix-neighbors stay prompts", () => {
    expect(parseRecallCommand("/recall")).toEqual({ n: "last" });
    expect(parseRecallCommand(" /recall 3 ")).toEqual({ n: 3 });
    expect(parseRecallCommand("/recallx")).toBeUndefined();
    expect(parseRecallCommand("/recall abc")).toBeUndefined();
    expect(parseRecallCommand("hello")).toBeUndefined();
  });

  it("resolves the target against the live snapshot with honest refusals", () => {
    expect(recallTargetOf([], "last")).toEqual({ refusal: expect.stringContaining("没有可撤回") });
    expect(recallTargetOf(["a", "b"], "last")).toEqual({ index: 1, text: "b" });
    expect(recallTargetOf(["a", "b"], 1)).toEqual({ index: 0, text: "a" });
    expect(recallTargetOf(["a", "b"], 5)).toEqual({ refusal: expect.stringContaining("没有第 5 条") });
  });
});
