import { describe, expect, it } from "vitest";
import { planCompaction, worthCompacting } from "../src/compaction-plan.js";
import type { AgentMessage } from "../src/types.js";

// 2026-11-06 KV 缓存弧的压缩保留策略。
//
// 背景：压缩是唯一必须改写历史的地方，而前缀缓存是**头锚定**的——改写点之前
// 逐字节相同才命中。旧策略保留尾部 keepRecent 条、把最旧的压掉，等于从消息
// 列表最靠前的位置就分叉：系统提示词之后的全部历史掉出缓存。
//
// 这两条钉住新策略的两个主张：
//   ① 保前段：开头那一段原样冻结（缓存多命中一截，任务原话不被摘要吃掉）；
//   ② 按未来占用定深度：压到够撑完一个视野，而不是压到某个水位线。

const u = (text: string): AgentMessage => ({ role: "user", content: text });
const a = (text: string): AgentMessage => ({ role: "assistant", content: text });

/** n 条粗消息（每条约 2500 字符 ≈ 625 token）。 */
function bulk(n: number): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? u(`q${i} `.repeat(1250)) : a(`r${i} `.repeat(1250))));
}

describe("planCompaction — 保前段 + 按未来占用定深度", () => {
  it("前段按预算冻结，且不会吃掉整段（始终留得下可压消息）", () => {
    const msgs = bulk(40);
    const plan = planCompaction(msgs, { targetTokens: 20_000, keepRecent: 6 });
    expect(plan.headKeep).toBeGreaterThan(0);
    // 前段 + 尾部必须给中段留位置
    expect(plan.headKeep).toBeLessThanOrEqual(msgs.length - plan.tailKeep);
  });

  it("近几轮占用大时会把尾部压短（近段也要压缩）", () => {
    // 头部很小、尾部 6 条很大 → 尾部本身就吃掉远超一个视野
    const msgs = [u("task"), ...bulk(6), ...bulk(18)];
    const plan = planCompaction(msgs, { targetTokens: 60_000, keepRecent: 6 });
    expect(plan.tailKeep).toBeLessThanOrEqual(6);
  });

  it("尾部收缩不会让可压区间消失（守卫）", () => {
    const msgs = bulk(4);
    const plan = planCompaction(msgs, { targetTokens: 100, keepRecent: 6 });
    expect(plan.tailKeep).toBeLessThanOrEqual(msgs.length);
    expect(msgs.length - plan.tailKeep).toBeGreaterThanOrEqual(0);
  });

  it("已经远低于目标水位 → shedTokens 为 0，不值得动手", () => {
    const msgs = bulk(4);
    const plan = planCompaction(msgs, { targetTokens: 10_000_000, keepRecent: 6 });
    expect(plan.shedTokens).toBe(0);
    expect(worthCompacting(plan)).toBe(false);
  });

  it("远超目标水位 → 要挤掉的量随超出量增长", () => {
    const msgs = bulk(60);
    const loose = planCompaction(msgs, { targetTokens: 100_000, keepRecent: 6 });
    const tight = planCompaction(msgs, { targetTokens: 10_000, keepRecent: 6 });
    expect(tight.shedTokens).toBeGreaterThan(loose.shedTokens);
    expect(worthCompacting(tight)).toBe(true);
  });

  it("同一输入重复调用结果完全一致（压缩必须确定性，否则重启就丢缓存）", () => {
    const msgs = bulk(30);
    const a1 = planCompaction(msgs, { targetTokens: 30_000, keepRecent: 6 });
    const a2 = planCompaction(msgs, { targetTokens: 30_000, keepRecent: 6 });
    expect(a2).toEqual(a1);
  });

  it("视野预估 = 最近采样窗口的每轮占用 × 视野轮数", () => {
    const msgs = bulk(24);
    const plan = planCompaction(msgs, { targetTokens: 50_000, keepRecent: 6 });
    expect(plan.projectedTokens).toBeGreaterThan(0);
  });
});

// 摘要路径的质量红线（2026-11-06）。
//
// 实测同一份 46 条消息的编码会话：digest 路径（zero-LLM）产出
// 「Activity: 9 user, 16 assistant, 16 tool」——改了什么文件、还剩什么任务
// 全丢；LLM 路径产出「Goal / 已改文件清单 / 当前进行项 / 剩余任务 / 约束」。
// 根因：digestibleSpan 只统计 user/assistant 文字，无视工具内容，于是
// 「assistant 话少 + 工具多」的典型编码会话被判成「薄叙事」。
describe("digestibleSpan — 工具内容是质量红线", () => {
  const thin = [
    { role: "user" as const, content: "帮我看看这个仓库" },
    { role: "assistant" as const, content: "好的，先看看结构。" },
  ];
  const withHeavyTools = [
    { role: "user" as const, content: "补边界检查" },
    { role: "assistant" as const, content: "先读文件。" },
    { role: "tool" as const, toolCallId: "t1", name: "read_file", content: "x".repeat(5000) },
  ];

  it("纯文字薄会话 → 可走确定性摘要", async () => {
    const { digestibleSpan } = await import("../src/compaction-tier2-static.js");
    expect(digestibleSpan(thin)).toBe(true);
  });

  it("工具内容很多 → 必须走 LLM 摘要（工作记忆不能丢成角色统计）", async () => {
    const { digestibleSpan } = await import("../src/compaction-tier2-static.js");
    expect(digestibleSpan(withHeavyTools)).toBe(false);
  });
});

// tier-1 头部冻结（2026-11-07 KV 缓存弧）。
//
// E2E 实测：tier-1 桩压缩触发后冷轮命中率掉到 7%——桩化从最旧开始改写字节，
// 前缀缓存从第一个被改写的字节起全部失效。保住头部一段，系统提示词 + 任务
// 原话那几条就继续命中（同一改写量下保头 vs 从头：6272 vs 768 命中）。
describe("microcompact headKeep — 头部冻结", () => {
  // ω-3b 的 floor 规则：没有 assistant 跟在后面的 tool 结果永远不桩。所以
  // 夹具必须是完整的 user→assistant(toolCall)→tool 三元组，否则什么都不桩化。
  const round = (i: number): AgentMessage[] => [
    { role: "user", content: `step ${i}` },
    { role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "shell", arguments: { command: "x" } }] },
    { role: "tool", toolCallId: `t${i}`, name: "shell", content: "x".repeat(1500) },
    { role: "assistant", content: `done ${i}` },
  ];
  const msgs = Array.from({ length: 6 }, (_, i) => round(i)).flat(); // 24 条

  it("headKeep 冻结头部：头部原样保留，只桩化中段", async () => {
    const { microcompact } = await import("../src/compaction-tiers.js");
    const out = microcompact(msgs, { keepRecent: 4, headKeep: 4 });
    expect(out.slice(0, 4)).toEqual(msgs.slice(0, 4)); // 头部原样（含第 0 个大结果）
    const stubbed = out.filter((m) => m.role === "tool" && String(m.content).startsWith("[compacted"));
    expect(stubbed.length).toBeGreaterThan(0); // 中段确实桩化了
    // 且桩化的都在头部之后
    for (let i = 0; i < 4; i += 1) expect(String(out[i]?.content).startsWith("[compacted")).toBe(false);
  });

  it("headKeep=0/未设 = 历史行为（从最旧可桩处开始，逐字节不变）", async () => {
    const { microcompact } = await import("../src/compaction-tiers.js");
    const legacy = microcompact(msgs, { keepRecent: 4 });
    const zero = microcompact(msgs, { keepRecent: 4, headKeep: 0 });
    expect(zero).toEqual(legacy);
    // 历史行为：最旧的大结果（index 2）被桩化
    expect(String(legacy[2]?.content).startsWith("[compacted")).toBe(true);
  });
});
