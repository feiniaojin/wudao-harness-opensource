// ω99-41 — 流式线性累积的 driver 级 parity：缓冲折叠后字节不变。
// 累积侧从「每 delta 整串拷贝」换成 chunk 缓冲后，以下三点必须逐字节保持：
// 1) 节流窗内 N 次 delta 只碰缓冲，窗到时 emit 广播的 live.answer 是**全量**
//    拼接（emit 顶部 materialize 的红线）；
// 2) run 落定后 history 终答 entry 与非流式 scripted 模型逐字节相同；
// 3) 跨调用窗口的 reasoning 切片不变（#302 的 reasoningMark 游标 + 0.3.8
//    终答留存），flushAssistantSegment 顶部 materialize 先行。
// 另有源钉：agent-driver.ts 源码不再出现 `live.answer + ev.text` /
// `live.reasoning + ev.text` 形（防回潮）。
import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AssistantMessage, ModelClient, ModelStreamEvent, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions, HistoryEntry } from "../src/driver/agent-driver.js";

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

const readOnlyParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "STUB FILE CONTENT"): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: readOnlyParams,
    execute: async () => ({ content }),
  });
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

type Assistant = Extract<HistoryEntry, { kind: "assistant" }>;

const assistantEntries = (driver: AgentDriver): Assistant[] =>
  (driver.getHistory() as HistoryEntry[]).filter((e): e is Assistant => e.kind === "assistant");

describe("AgentDriver — ω99-41 流式线性累积 parity", () => {
  it("字节 parity：300 delta 压在一个节流窗内，窗到时广播的 live.answer 是全量拼接；终答与非流式逐字节相同", async () => {
    vi.useFakeTimers();
    const DELTAS = 300;
    const PIECE = "字";
    const FULL = PIECE.repeat(DELTAS);
    const model: ModelClient = {
      async *stream() {
        // 微任务连发：300 个 delta 全部落在同一个 100ms 节流窗内（fake
        // clock 在微任务排水期间不走），随后 park 250ms——节流 timer 在
        // park 期间到期，此时流尚未 done，广播只能来自 emit 的折叠。
        for (let i = 0; i < DELTAS; i += 1) yield { type: "text_delta", text: PIECE };
        await new Promise((r) => setTimeout(r, 250));
        yield { type: "done", message: { role: "assistant", content: FULL } };
      },
    };
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow });
    const seen: string[] = [];
    driver.subscribe(() => seen.push(driver.getStatus().live.answer));
    let streamed: Assistant[];
    try {
      driver.submit("go");
      // 排水微任务（全部 300 delta 进缓冲）并走到 100ms 窗口边界。
      await vi.advanceTimersByTimeAsync(100);
      expect(seen.length).toBeGreaterThan(0);
      // 节流窗到期的那次广播必须已经携带全量文本（materialize 先于广播）。
      expect(seen[seen.length - 1]).toBe(FULL);
      // 释放 park（t=250），run 落定。
      for (let i = 0; i < 20 && driver.getStatus().busy; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(driver.getStatus().busy).toBe(false);

      streamed = assistantEntries(driver);
    } finally {
      vi.useRealTimers();
      driver.dispose();
    }
    expect(streamed.length).toBe(1);
    expect(streamed[0]!.text).toBe(FULL);
    expect(streamed[0]!.reasoning).toBeUndefined();

    // 非流式参照（真实时钟）：同一权威文本，走 generate 路径——终答 entry
    // 逐字节相同。
    const ref = makeDriver({ model: createScriptedModel([{ role: "assistant", content: FULL }]), tools: [stubReadTool()], onPermissionAsk: allow });
    try {
      ref.submit("go");
      await until(() => ref.getStatus().busy === false, "reference run");
      const plain = assistantEntries(ref);
      expect(plain.length).toBe(1);
      expect(plain[0]!.text).toBe(streamed[0]!.text);
      expect(plain[0]!.reasoning).toBe(streamed[0]!.reasoning);
      // durationMs 的出现性也一致（scripted 模型两侧都不报耗时）。
      expect("durationMs" in plain[0]!).toBe("durationMs" in streamed[0]!);
    } finally {
      ref.dispose();
    }
  });

  it("reasoningMark 切片不变：多 delta 跨调用窗口，每段携带本窗全量 reasoning、终答只带最后一窗", async () => {
    // 每窗 40 个 reasoning delta（2 字/个）+ 按字切的正文 delta：折叠缺失时
    // reasoningMark 游标切到的是空/残段——期望值是逐段拼接的全量。
    const R = "R";
    const threeCallScript: readonly AssistantMessage[] = [
      { role: "assistant", content: "先看文件", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "改好了", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b.txt" } }] },
      { role: "assistant", content: "完成" },
    ];
    const reasons = [`${R}1`.repeat(40), `${R}2`.repeat(40), `${R}3`.repeat(40)];
    let calls = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        throw new Error("stream-path only");
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        const n = calls;
        calls += 1;
        const reply = threeCallScript[n];
        if (reply === undefined) throw new Error(`scripted model exhausted (call ${n})`);
        const reasoning = reasons[n]!;
        for (let i = 0; i < reasoning.length; i += 2) yield { type: "reasoning_delta", text: reasoning.slice(i, i + 2) };
        for (const ch of reply.content) yield { type: "text_delta", text: ch };
        yield { type: "done", message: reply };
      },
    };
    const driver = makeDriver({ model, tools: [stubReadTool()], onPermissionAsk: allow });
    try {
      driver.submit("hi");
      await until(() => driver.getStatus().busy === false, "run to finish");
      const rows = assistantEntries(driver).map((e) => [e.text, e.reasoning]);
      expect(rows).toEqual([
        ["先看文件", `${R}1`.repeat(40)],
        ["改好了", `${R}2`.repeat(40)],
        ["完成", `${R}3`.repeat(40)],
      ]);
    } finally {
      driver.dispose();
    }
  });

  it("源钉：agent-driver.ts 不再出现逐 delta 整串拼接形（防回潮）", async () => {
    const src = await readFile(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("live.answer + ev.text");
    expect(src).not.toContain("live.reasoning + ev.text");
  });
});
