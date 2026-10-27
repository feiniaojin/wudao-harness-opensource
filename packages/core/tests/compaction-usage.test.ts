// 调研引入弧 B（2026-10 spec research-import）— 缓存感知压缩调度纯函数收据。
//
//   B1 指纹信任门：前缀指纹相等/不等/钳位、报告值先决、fallback 置空语义
//      （trusted 但 reported 缺席 → 估算说了算）；
//   B2 compactionOpportunity 三 reason 分支（usage_over / cache_dying / no）
//      + 「默认行为不回退」断言（旧纯阈值判断放行的输入，新判断必放行）；
//   B3 未读大结果降级：大小降序替换、替换收据、预算内/已读/非 read/幂等
//      不动。
import { describe, expect, it } from "vitest";
import {
  usagePrefixFingerprint,
  shouldTrustUsage,
  thresholdDecision,
  compactionOpportunity,
  degradePendingReads,
  formatPendingReadDowngrade,
  PENDING_READ_DOWNGRADE_PREFIX,
  DEFAULT_CACHE_DYING_SOFT_RATIO,
  type UsageEvidence,
} from "../src/compaction-usage.js";
import type { AgentMessage, CacheClassification } from "../src/index.js";

// ---------------------------------------------------------------------------
// 夹具（纯内存，无文件）
// ---------------------------------------------------------------------------

const user = (text: string): AgentMessage => ({ role: "user", content: text });
const asstWithCalls = (content: string, ids: string[]): AgentMessage => ({
  role: "assistant",
  content,
  toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: {} })),
});
const asstDone = (content: string): AgentMessage => ({ role: "assistant", content });
const readResult = (id: string, size: number): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name: "read_file",
  content: "x".repeat(size),
});
const shellResult = (id: string, size: number): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name: "shell",
  content: "y".repeat(size),
});

const clock = (reason: CacheClassification["reason"], confidence: CacheClassification["confidence"]): CacheClassification => ({
  reason,
  confidence,
  idleSeconds: 600,
});

const WARM = clock("idle", "warm");
const MAYBE_COLD = clock("idle", "may_be_cold");
const EXPIRED = clock("identity_changed", "expired");
const IDLE_EXPIRED = clock("idle", "expired");
const AGE_UNKNOWN = clock("age_unknown", "may_be_cold");

// ---------------------------------------------------------------------------
// B1 — 前缀指纹 + 信任门 + thresholdDecision
// ---------------------------------------------------------------------------

describe("弧 B1 — usagePrefixFingerprint", () => {
  const base: AgentMessage[] = [user("u1"), asstDone("a1"), readResult("c1", 10)];

  it("同一前缀 → 同一指纹（确定性）；逐次调用稳定", () => {
    expect(usagePrefixFingerprint(base, 3)).toBe(usagePrefixFingerprint(base, 3));
    expect(usagePrefixFingerprint(base, 2)).toBe(usagePrefixFingerprint(base, 2));
  });

  it("前缀内容变一个字节 → 指纹必变；前缀长度变 → 指纹必变", () => {
    const mutated = [user("u1"), asstDone("a2"), readResult("c1", 10)];
    expect(usagePrefixFingerprint(mutated, 3)).not.toBe(usagePrefixFingerprint(base, 3));
    // 长度不同（2 vs 3）即使前 2 条相同也必不同
    expect(usagePrefixFingerprint(base, 2)).not.toBe(usagePrefixFingerprint(base, 3));
  });

  it("键序不同、语义相同 → 同一指纹（canonical serializer 单一真值点）", () => {
    const a: AgentMessage = { role: "user", content: "same" };
    const b = { content: "same", role: "user" } as AgentMessage; // 插入序相反
    expect(usagePrefixFingerprint([a], 1)).toBe(usagePrefixFingerprint([b], 1));
  });

  it("钳位：upto 越界 = 全长；≤0/非有限 = 空前缀常量", () => {
    expect(usagePrefixFingerprint(base, 99)).toBe(usagePrefixFingerprint(base, 3));
    expect(usagePrefixFingerprint(base, 0)).toBe(usagePrefixFingerprint([], 0));
    expect(usagePrefixFingerprint(base, Number.NaN)).toBe(usagePrefixFingerprint([], 0));
    expect(usagePrefixFingerprint(base, -5)).toBe(usagePrefixFingerprint([], 0));
    // 空前缀携带 count=0 标记（与任何非空前缀可分辨）
    expect(usagePrefixFingerprint(base, 0)).not.toBe(usagePrefixFingerprint(base, 1));
  });
});

describe("弧 B1 — shouldTrustUsage（指纹相等才采信）", () => {
  const FP = usagePrefixFingerprint([user("u1")], 1);

  it("指纹相等 + 正有限报告值 → 采信", () => {
    expect(shouldTrustUsage(12345, FP, FP)).toBe(true);
  });

  it("指纹不等 → 不采信（旧计数不约束新前缀）", () => {
    const other = usagePrefixFingerprint([user("u2")], 1);
    expect(shouldTrustUsage(12345, FP, other)).toBe(false);
    expect(shouldTrustUsage(12345, other, FP)).toBe(false);
  });

  it("报告值缺席/0/NaN/负数 → 不采信（指纹相等也不行）", () => {
    expect(shouldTrustUsage(undefined, FP, FP)).toBe(false);
    expect(shouldTrustUsage(0, FP, FP)).toBe(false);
    expect(shouldTrustUsage(Number.NaN, FP, FP)).toBe(false);
    expect(shouldTrustUsage(-100, FP, FP)).toBe(false);
  });

  it("指纹缺席/空串 → 不采信（无可比证据）", () => {
    expect(shouldTrustUsage(12345, undefined, FP)).toBe(false);
    expect(shouldTrustUsage(12345, FP, undefined)).toBe(false);
    expect(shouldTrustUsage(12345, "", FP)).toBe(false);
    expect(shouldTrustUsage(12345, FP, "")).toBe(false);
  });
});

describe("弧 B1 — thresholdDecision", () => {
  it("trusted 用报告值：估算更大也不顶替报告结论", () => {
    const out = thresholdDecision({ reportedTokens: 9000, trusted: true, estimatedTokens: 15000, threshold: 10000 });
    expect(out.source).toBe("reported");
    expect(out.effectiveTokens).toBe(9000);
    expect(out.over).toBe(false);
  });

  it("trusted 用报告值：报告过线即过线（估算再小不拉回）", () => {
    const out = thresholdDecision({ reportedTokens: 11000, trusted: true, estimatedTokens: 5000, threshold: 10000 });
    expect(out.over).toBe(true);
    expect(out.source).toBe("reported");
  });

  it("untrusted 一律估算", () => {
    const out = thresholdDecision({ reportedTokens: 11000, trusted: false, estimatedTokens: 5000, threshold: 10000 });
    expect(out.source).toBe("estimated");
    expect(out.effectiveTokens).toBe(5000);
    expect(out.over).toBe(false);
  });

  it("fallback 置空语义：trusted 但 reported 缺席 → 估算说了算（旧计数不约束下一请求）", () => {
    const out = thresholdDecision({ reportedTokens: undefined, trusted: true, estimatedTokens: 12000, threshold: 10000 });
    expect(out.source).toBe("estimated");
    expect(out.effectiveTokens).toBe(12000);
    expect(out.over).toBe(true);
  });

  it("非正/非有限阈值 → over=false（破损触发线永不自动触发）", () => {
    expect(thresholdDecision({ trusted: false, estimatedTokens: 999999, threshold: 0 }).over).toBe(false);
    expect(thresholdDecision({ trusted: false, estimatedTokens: 999999, threshold: Number.NaN }).over).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2 — compactionOpportunity
// ---------------------------------------------------------------------------

describe("弧 B2 — compactionOpportunity 三 reason 分支", () => {
  const TH = 10_000;
  const est = (n: number): UsageEvidence => ({ trusted: false, estimatedTokens: n });

  it("usage_over：用量过线即时钟无关（warm 也压）——量到了就该压", () => {
    for (const c of [WARM, MAYBE_COLD, EXPIRED, IDLE_EXPIRED, AGE_UNKNOWN]) {
      expect(compactionOpportunity(c, est(12_000), TH)).toEqual({ compactNow: true, reason: "usage_over" });
    }
    // 恰好压线 = 过线
    expect(compactionOpportunity(WARM, est(TH), TH).reason).toBe("usage_over");
  });

  it("usage_over 用的是采信后的值：trusted 报告值否决高估的提前触发", () => {
    const out = compactionOpportunity(MAYBE_COLD, { reportedTokens: 6_000, trusted: true, estimatedTokens: 15_000 }, TH);
    expect(out).toEqual({ compactNow: true, reason: "cache_dying" }); // 报告 6000 < 10000 但 ≥ 软线 5000
    const under = compactionOpportunity(MAYBE_COLD, { reportedTokens: 4_000, trusted: true, estimatedTokens: 15_000 }, TH, { softThresholdTokens: 5_000 });
    expect(under.reason).toBe("no"); // 报告值 4000 连软线都没过——估算的 15000 不作数
  });

  it("cache_dying：expired/may_be_cold 且过软线（缺省 0.5×threshold）", () => {
    expect(DEFAULT_CACHE_DYING_SOFT_RATIO).toBe(0.5);
    for (const c of [MAYBE_COLD, EXPIRED, IDLE_EXPIRED]) {
      expect(compactionOpportunity(c, est(6_000), TH)).toEqual({ compactNow: true, reason: "cache_dying" });
    }
    // 恰好软线 = 过软线
    expect(compactionOpportunity(MAYBE_COLD, est(5_000), TH).reason).toBe("cache_dying");
  });

  it("no：warm 永不提前（过软线也不压）；将逝但未过软线不压；age_unknown 零行为差（T002 F7）", () => {
    expect(compactionOpportunity(WARM, est(6_000), TH)).toEqual({ compactNow: false, reason: "no" });
    expect(compactionOpportunity(WARM, est(9_999), TH, { softThresholdTokens: 5_000 })).toEqual({ compactNow: false, reason: "no" });
    expect(compactionOpportunity(MAYBE_COLD, est(4_999), TH)).toEqual({ compactNow: false, reason: "no" });
    expect(compactionOpportunity(AGE_UNKNOWN, est(6_000), TH)).toEqual({ compactNow: false, reason: "no" });
  });

  it("显式软线覆盖缺省", () => {
    expect(compactionOpportunity(MAYBE_COLD, est(9_500), TH, { softThresholdTokens: 9_000 }).reason).toBe("cache_dying");
    expect(compactionOpportunity(MAYBE_COLD, est(8_500), TH, { softThresholdTokens: 9_000 }).reason).toBe("no");
  });

  it("默认行为不回退：旧纯阈值判断（估算 ≥ 阈值）放行的输入，新判断必放行", () => {
    // 旧判断 = occupancy(估算) >= threshold（无时钟耦合）。对全时钟矩阵 ×
    // 过线水位，新判断的 compactNow 恒 true（usage_over 分支在判定序第一）。
    const oldWouldCompact = (estimated: number, threshold: number): boolean => estimated >= threshold;
    for (const c of [WARM, MAYBE_COLD, EXPIRED, IDLE_EXPIRED, AGE_UNKNOWN]) {
      for (const over of [TH, TH + 1, TH * 3]) {
        expect(oldWouldCompact(over, TH)).toBe(true);
        expect(compactionOpportunity(c, est(over), TH).compactNow).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B3 — degradePendingReads
// ---------------------------------------------------------------------------

describe("弧 B3 — degradePendingReads", () => {
  /** 标准未读面：assistant 带 3 个 read_file 调用 + 3 个结果（5000/3000/1000）。 */
  const pending3 = (): AgentMessage[] => [
    user("去读"),
    asstWithCalls("读这三个", ["c1", "c2", "c3"]),
    readResult("c1", 5000),
    readResult("c2", 3000),
    readResult("c3", 1000),
  ];

  const contentAt = (msgs: readonly AgentMessage[], i: number): string => (msgs[i] as { content: string }).content;

  it("预算内不动：原数组引用原样归还", () => {
    const msgs = pending3(); // 未读总量 9000
    const out = degradePendingReads(msgs, 9000);
    expect(out.downgraded).toEqual([]);
    expect(out.messages).toBe(msgs);
  });

  it("超预算按大小降序替换：先最大的，回到预算内即停；收据记录索引与原大小", () => {
    const msgs = pending3();
    const out = degradePendingReads(msgs, 6_000); // 总 9000 > 6000
    expect(out.downgraded.length).toBe(1);
    expect(out.downgraded[0]).toEqual({ index: 2, originalChars: 5000 }); // c1（最大）在原数组索引 2
    // 替换桩是分段重读引导
    expect(contentAt(out.messages, 2)).toBe(formatPendingReadDowngrade(5000));
    expect(contentAt(out.messages, 2).startsWith(PENDING_READ_DOWNGRADE_PREFIX)).toBe(true);
    // 其余原样
    expect(contentAt(out.messages, 3)).toBe("x".repeat(3000));
    expect(contentAt(out.messages, 4)).toBe("x".repeat(1000));
    // 替换后未读面回到预算内（桩短于原文）
    const stub = contentAt(out.messages, 2);
    expect(3000 + 1000 + stub.length).toBeLessThanOrEqual(6000);
    expect(stub.length).toBeLessThan(5000);
    // 原数组不被就地改写（投影源由调用方接管）
    expect(contentAt(msgs, 2)).toBe("x".repeat(5000));
  });

  it("预算 0 → 候选全部替换，顺序严格按大小降序", () => {
    const msgs = pending3();
    const out = degradePendingReads(msgs, 0);
    expect(out.downgraded).toEqual([
      { index: 2, originalChars: 5000 },
      { index: 3, originalChars: 3000 },
      { index: 4, originalChars: 1000 },
    ]);
    for (const d of out.downgraded) {
      expect(contentAt(out.messages, d.index).startsWith(PENDING_READ_DOWNGRADE_PREFIX)).toBe(true);
    }
  });

  it("已读结果不动：settled 尾（最后一条是 assistant）没有未读面", () => {
    const msgs: AgentMessage[] = [
      user("去读"),
      asstWithCalls("读", ["c1"]),
      readResult("c1", 5000),
      asstDone("读完了，结论是……"),
    ];
    const out = degradePendingReads(msgs, 0);
    expect(out.downgraded).toEqual([]);
    expect(out.messages).toBe(msgs);
  });

  it("只动「最后一条 assistant 之后」的结果：更早的 read 已被后续 assistant 消化", () => {
    const msgs: AgentMessage[] = [
      user("先读 A"),
      asstWithCalls("读 A", ["cA"]),
      readResult("cA", 5000),
      asstWithCalls("再读 B", ["cB"]),
      readResult("cB", 4000),
    ];
    const out = degradePendingReads(msgs, 0);
    expect(out.downgraded).toEqual([{ index: 4, originalChars: 4000 }]);
    expect(contentAt(out.messages, 2)).toBe("x".repeat(5000)); // cA 已读，原样
    expect(contentAt(out.messages, 4).startsWith(PENDING_READ_DOWNGRADE_PREFIX)).toBe(true);
  });

  it("非 read_file 类结果不是候选；error 结果不是候选", () => {
    const msgs: AgentMessage[] = [
      asstWithCalls("跑", ["s1", "e1"]),
      shellResult("s1", 8000),
      { role: "tool", toolCallId: "e1", name: "read_file", content: "read_file failed: nope", isError: true },
    ];
    const out = degradePendingReads(msgs, 0);
    expect(out.downgraded).toEqual([]);
    expect(out.messages).toBe(msgs);
  });

  it("幂等：对降级产物再跑一遍是 no-op", () => {
    const first = degradePendingReads(pending3(), 0);
    const second = degradePendingReads(first.messages, 0);
    expect(second.downgraded).toEqual([]);
    expect(second.messages).toBe(first.messages);
  });

  it("桩不小于原文的候选跳过（替换无净收益）；全跳过 → 原样归还", () => {
    const msgs: AgentMessage[] = [
      asstWithCalls("读小文件", ["c1", "c2"]),
      readResult("c1", 100),
      readResult("c2", 100),
    ];
    const out = degradePendingReads(msgs, 0); // 总 200 > 0 但每个都小于桩
    expect(out.downgraded).toEqual([]);
    expect(out.messages).toBe(msgs);
  });

  it("readToolNames 扩展判定集；非有限预算 fail-open 不动", () => {
    const msgs: AgentMessage[] = [asstWithCalls("读", ["s1"]), shellResult("s1", 5000)];
    expect(degradePendingReads(msgs, 0).messages).toBe(msgs); // shell 不在缺省集
    const out = degradePendingReads(msgs, 0, { readToolNames: ["shell"] });
    expect(out.downgraded).toEqual([{ index: 1, originalChars: 5000 }]);
    expect(degradePendingReads(msgs, Number.NaN).messages).toBe(msgs);
  });

  it("无 assistant 消息 → 无未读面（防御形状）", () => {
    const msgs: AgentMessage[] = [user("空转"), readResult("c1", 5000)];
    expect(degradePendingReads(msgs, 0).messages).toBe(msgs);
  });
});
