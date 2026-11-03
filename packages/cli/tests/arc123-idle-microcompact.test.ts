// 123-5（zcode microcompact idle 触发引进）— 空闲清理收据。
// 用户离开 ≥60min → tier-0/1 纯清理（零 LLM 零 run）→ 有变化才有回执；
// 未到门槛/无变化/kill switch 三零噪音门；活动后重臂。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

let ws = "";
let realNow: () => number;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc123-idle-"));
  realNow = Date.now;
});
afterEach(async () => {
  Date.now = realNow;
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 大结果工具（可压缩面）。 */
function bigTool(name: string): import("@wudao-org/core").Tool {
  return {
    name,
    description: "big",
    parameters: { type: "object", properties: { seq: { type: "number" } }, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(input: { seq?: number }) {
      return { content: `BIG-RESULT#${String(input.seq ?? 0)}-` + "x".repeat(2000) };
    },
  } as unknown as import("@wudao-org/core").Tool;
}

/** 一个跑 N 轮工具调用的模型。 */
function toolLoopModel(n: number): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input) {
      inputs.push(input);
      if (i < n) {
        i += 1;
        return { role: "assistant", content: `查 ${i}`, toolCalls: [{ id: `c${i}`, name: "bigtool", arguments: { seq: i } }] };
      }
      return { role: "assistant", content: "DONE" };
    },
  } as never;
}

async function driveToIdle(n: number) {
  const model = toolLoopModel(n);
  const driver = createAgentDriver({
    model,
    tools: [bigTool("bigtool")],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    sessionId: "idlecomp1",
    onPermissionAsk: async () => ({ kind: "allow" as const }),
  });
  driver.submit("go");
  await (async () => {
    const until = async (cond: () => boolean, what: string, ms = 8000): Promise<void> => {
      const by = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > by) throw new Error(`timeout: ${what}`);
        await wait(20);
      }
    };
    await until(() => driver.getStatus().busy === false, "run settle");
  })();
  return { driver, model };
}

describe("123-5 — idle microcompact seam", () => {
  it("空闲 ≥60min → 陈旧大工具结果被清理 + 一条回执 + 零新模型调用", async () => {
    // 隔离构造：手写一个带 8 条陈旧大工具结果的会话文件再 resume——run 内
    // 的请求路径管线从未碰过它（这些结果不经过任何 run），空闲档是它们
    // 的第一个压缩者。这是对本缝的孤立验证；run 内路径已有自己的管线。
    const store = new (await import("@wudao-org/core")).createJsonlSessionStore(join(ws, ".wudao", "sessions"));
    const rows: AgentMessage[] = [{ role: "user", content: "go" }];
    for (let i = 1; i <= 8; i += 1) {
      rows.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "bigtool", arguments: { seq: i } }] });
      rows.push({ role: "tool", toolCallId: `c${i}`, name: "bigtool", content: `STALE#${i}-` + "x".repeat(1500) });
    }
    rows.push({ role: "assistant", content: "OLD-DONE" });
    for (const m of rows) await store.append("stalecomp", m);

    const model = toolLoopModel(0); // 立即终答——resume 后不起 run
    const driver = createAgentDriver({
      model,
      tools: [bigTool("bigtool")],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ws,
      sessionId: "freshchild9",
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    try {
      expect(await driver.resume("stalecomp")).toEqual({ ok: true });
      const callsBefore = model.inputs.length;
      const skew = 61 * 60_000;
      Date.now = (() => realNow() + skew) as () => number;
      const by = Date.now() + 6_000;
      let cleanNotices: string[] = [];
      while (Date.now() < by) {
        await wait(300);
        cleanNotices = driver.getHistory()
          .filter((h) => h.kind === "notice")
          .map((h) => (h as { text: string }).text)
          .filter((t) => t.includes("空闲清理"));
        if (cleanNotices.length > 0) break;
      }
      expect(cleanNotices.length).toBeGreaterThanOrEqual(1);
      expect(cleanNotices[0]).toContain("tokens");
      expect(model.inputs.length).toBe(callsBefore); // 维护不是输入：零新模型调用
      const toolMsgs = (driver.state as unknown as { messages: AgentMessage[] }).messages.filter((m) => m.role === "tool");
      const stubbed = toolMsgs.filter((m) => String(m.content).startsWith("[Old tool result content cleared]") || String(m.content).startsWith("[compacted"));
      expect(stubbed.length).toBeGreaterThanOrEqual(1);
    } finally {
      driver.dispose();
    }
  }, 20_000);

  it("未到门槛（59min）→ 零动作零回执", async () => {
    const { driver } = await driveToIdle(8);
    const skew = 59 * 60_000;
    Date.now = (() => realNow() + skew) as () => number;
    await wait(2600);
    const notices = driver.getHistory().filter((h) => h.kind === "notice").map((h) => (h as { text: string }).text);
    expect(notices.some((t) => t.includes("空闲清理"))).toBe(false);
    driver.dispose();
  }, 20_000);

  it("kill switch → 永不清理", async () => {
    process.env.WUDAO_DISABLE_IDLE_MICROCOMPACT = "1";
    try {
      const { driver } = await driveToIdle(8);
      const skew = 61 * 60_000;
      Date.now = (() => realNow() + skew) as () => number;
      await wait(2600);
      const notices = driver.getHistory().filter((h) => h.kind === "notice").map((h) => (h as { text: string }).text);
      expect(notices.some((t) => t.includes("空闲清理"))).toBe(false);
      driver.dispose();
    } finally {
      delete process.env.WUDAO_DISABLE_IDLE_MICROCOMPACT;
    }
  }, 20_000);
});
