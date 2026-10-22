// 125 项 1（the upstream formatresolveCompactSpec 形）— 预留感知压缩触发线的钉子。
//
// 形状：threshold = min(thresholdRatio × window, window − outputReserve − headroom)
// （the upstream formatpackages/compaction/compaction-basic/src/config.ts 的 resolveCompactSpec，
// 1M 窗三次真实死亡的事故尸检背书）。三个不变量钉在本文件：
//   1. reserve 缺席 = 平比 0.8（M24 行为锚点，字节不变）；
//   2. ratio 帽是硬上限 —— 新公式永远 ≤ 旧公式（只在长输出时收紧）；
//   3. 长输出场景（prompt + maxTokens > window − headroom）提前触发，
//      prompt + maxTokens ≤ window − headroom 的正常会话不提前。
import { describe, it, expect } from "vitest";
import {
  resolveCompactionThresholdTokens,
  resolveOutputReserveTokens,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  DEFAULT_COMPACTION_HEADROOM_TOKENS,
  COMPACTION_THRESHOLD_FLOOR_TOKENS,
  runAgentLoop,
  type AgentState, type LoopEvent, type Tool,
} from "../src/index.js";
import type { ModelClient } from "../src/model-client.js";

const drain = async (gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> => {
  const out: LoopEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe("125 项 1 — resolveCompactionThresholdTokens（纯函数）", () => {
  it("reserve 缺席 = 平比 0.8（M24 行为锚点，逐字节一致）", () => {
    for (const window of [4_096, 64_000, 128_000, 1_000_000]) {
      expect(resolveCompactionThresholdTokens({ windowTokens: window })).toBe(Math.floor(0.8 * window));
      // 0/负 reserve 与缺席同义（无请求帽知识 → 平比）。
      expect(resolveCompactionThresholdTokens({ windowTokens: window, outputReserveTokens: 0 })).toBe(Math.floor(0.8 * window));
    }
  });

  it("长输出提前触发：threshold = window − reserve − headroom（prompt+maxTokens > window−headroom 的线）", () => {
    // 128K 窗 + 32K 输出（glm-4.5 + defaultMaxTokens 32768 的真实形态）：
    // 平比 102_400 会在 prompt 96K 时仍不触发 —— 96K + 32K = 128K 已撞墙。
    const t = resolveCompactionThresholdTokens({ windowTokens: 128_000, outputReserveTokens: 32_768 });
    expect(t).toBe(Math.min(Math.floor(0.8 * 128_000), 128_000 - 32_768 - DEFAULT_COMPACTION_HEADROOM_TOKENS));
    expect(t).toBe(93_184);
    expect(t).toBeLessThan(Math.floor(0.8 * 128_000)); // 收紧了
  });

  it("短输出不提前：ratio 帽赢（新公式 ≤ 旧公式，正常会话字节不变）", () => {
    // 1M 窗（DeepSeek）+ 4K 请求帽：压力预算 993_952 > 平比 800_000 → 平比赢。
    const t = resolveCompactionThresholdTokens({ windowTokens: 1_000_000, outputReserveTokens: 4_096 });
    expect(t).toBe(800_000);
    // 204.8K 窗（glm-4.6）+ 32_768 帽：压力预算 169_984 > 163_840 → 平比赢。
    expect(resolveCompactionThresholdTokens({ windowTokens: 204_800, outputReserveTokens: 32_768 })).toBe(163_840);
  });

  it("ratio 帽仍生效：任意配置下新公式 ≤ floor(ratio×window)，ratio 可配", () => {
    for (const [window, reserve, ratio] of [
      [64_000, 8_192, 0.8],
      [32_000, 16_384, 0.9],
      [100_000, 60_000, 0.5],
    ] as const) {
      const t = resolveCompactionThresholdTokens({ windowTokens: window, outputReserveTokens: reserve, thresholdRatio: ratio });
      expect(t).toBeLessThanOrEqual(Math.floor(ratio * window));
    }
    // 显式 ratio 覆写缺省：0.5×100K = 50K 帽赢过压力预算 37_952。
    expect(resolveCompactionThresholdTokens({ windowTokens: 100_000, outputReserveTokens: 60_000, thresholdRatio: 0.5 })).toBe(37_952);
    expect(resolveCompactionThresholdTokens({ windowTokens: 100_000, thresholdRatio: 0.5 })).toBe(50_000);
  });

  it("headroom 可配；压力预算非正钳到地板（永不产出 ≤0 的阈值）", () => {
    expect(resolveCompactionThresholdTokens({ windowTokens: 100_000, outputReserveTokens: 60_000, headroomTokens: 0 })).toBe(40_000);
    // 预留吃满窗口的病态配置（64K 帽 / 32K 窗）→ 地板（立即压缩一侧）。
    expect(resolveCompactionThresholdTokens({ windowTokens: 32_000, outputReserveTokens: 64_000 })).toBe(COMPACTION_THRESHOLD_FLOOR_TOKENS);
    expect(COMPACTION_THRESHOLD_FLOOR_TOKENS).toBeGreaterThan(0);
  });

  it("缺省常量是 M24 锚点（0.8 / 2048）", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD_RATIO).toBe(0.8);
    expect(DEFAULT_COMPACTION_HEADROOM_TOKENS).toBe(2048);
  });
});

describe("125 项 1 — resolveOutputReserveTokens（窗口语义 × 请求帽的 reserve 计算）", () => {
  it("independent（glm-code）与 shared（deepseek）的已画像窗口语义都扣请求帽", () => {
    // 两种已知语义下请求帽约束同形（prompt + max_tokens ≤ window 才不 413：
    // DeepSeek 的 max_tokens 顶穿总额度是文档化行为；anthropic-wire 网关按
    // prompt+max_tokens 检查请求帽）—— reserve 都取 maxTokens。
    expect(resolveOutputReserveTokens(32_768, "independent")).toBe(32_768);
    expect(resolveOutputReserveTokens(8_192, "shared")).toBe(8_192);
  });

  it("unknown（未画像端点）不扣 —— 平比，零行为变化（红线）", () => {
    expect(resolveOutputReserveTokens(32_768, "unknown")).toBeUndefined();
    expect(resolveOutputReserveTokens(32_768, undefined)).toBeUndefined();
  });

  it("请求帽未知（无 maxTokens 配置/画像缺省）不扣", () => {
    expect(resolveOutputReserveTokens(undefined, "shared")).toBeUndefined();
    expect(resolveOutputReserveTokens(0, "independent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Loop 级：同一会话，只有 outputReserveTokens 有无的差别。
// ---------------------------------------------------------------------------

/** 合法形态的种子历史：老 tool result（>30K chars = tier-0 clear 的对象，
 * keepRecent 之外、其后有 assistant —— floorCutoff 的「已看过」条件）。 */
const seededState = (toolChars: number): AgentState => ({
  systemPrompt: "sys",
  messages: [
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "seed-0", name: "read_file", arguments: {} }] },
    { role: "tool", toolCallId: "seed-0", name: "read_file", content: "x".repeat(toolChars) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "go" },
  ],
  tools: [],
  status: "idle",
});

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isOpenWorld: () => false,
  async execute() {
    return { content: "ok" };
  },
};

describe("125 项 1 — runAgentLoop 的触发行为", () => {
  /** 两轮脚本（tool 轮 + 终答轮）驱动 + 门全关 —— compaction-carryover 夹具同款。 */
  const drive = async (windowTokens: number, toolChars: number, compaction: Record<string, number | undefined>): Promise<LoopEvent[]> => {
    let calls = 0;
    const model: ModelClient = {
      async generate() {
        calls += 1;
        if (calls === 1) return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] };
        return { role: "assistant", content: "done" };
      },
    };
    const state = seededState(toolChars);
    state.tools = [echoTool];
    return drain(runAgentLoop(state, model, {
      maxTurns: 6,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: windowTokens, keepRecent: 1, zeroLlmDigest: false, ...compaction },
    }));
  };

  it("平比（无 reserve）：occupancy ~8.1K < 平比 12.8K → 全程不压缩（既有行为锚）", async () => {
    // 窗 16K；32K chars 的老 tool result ≈ 8K token。
    const events = await drive(16_000, 32_000, {});
    expect(events.some((ev) => ev.type === "compacted")).toBe(false);
  });

  it("长输出（reserve 6K）：同一 occupancy 提前触发 —— 轮边界压缩真实发生", async () => {
    // 窗 16K + reserve 6K + headroom 2_048 → threshold = min(12_800, 7_952) = 7_952。
    // occupancy ≈ 8_010：≥ 7_952（新线拦到，prompt+maxTokens > window−headroom）
    // 且 < 12_800（平比拦不到）—— 只有预留感知能在撞墙前压。
    const events = await drive(16_000, 32_000, { outputReserveTokens: 6_000 });
    const compacted = events.filter((ev) => ev.type === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
    if (compacted[0]?.type === "compacted") {
      expect(compacted[0].tier).toBe(0); // 便宜的 tier-0 clear 就够（32K chars > 30K 阈）
      expect(compacted[0].reason).toBe("threshold");
    }
  });

  it("immediate 臂：occupancy ≥ threshold+8K 时模型调用前就压（长输出的撞墙前一步）", async () => {
    // 窗 10K + reserve 5K → threshold 2_952；occupancy ≈ 12K ≥ 2_952+8_192 → immediate。
    let calls = 0;
    const model: ModelClient = {
      async generate() {
        calls += 1;
        return { role: "assistant", content: "done" };
      },
    };
    const state = seededState(48_000); // ≈12K token
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 10_000, keepRecent: 1, zeroLlmDigest: false, outputReserveTokens: 5_000 },
    }));
    const compacted = events.find((ev) => ev.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type === "compacted") expect(compacted.tier).toBe(0);
    expect(calls).toBe(1); // 压缩发生在唯一的模型调用之前（turn 顶 immediate 臂）
  });

  it("短输出 + 小 reserve：行为与平比一致（同一事件面，无 compacted）", async () => {
    // 窗 10K + reserve 512 → threshold min(8_000, 7_488) = 7_488；
    // occupancy ≈ 6_010 < 7_488 → 不触发（正常短输出会话零变化）。
    const events = await drive(10_000, 24_000, { outputReserveTokens: 512 });
    expect(events.some((ev) => ev.type === "compacted")).toBe(false);
  });
});
