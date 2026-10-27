// ω99-192 — compact 通知行中文化回执：formatCompactedLine 模板 + 档/触发词表。
// M25 §A4：tier/trigger 是 loop 内部词汇，词表职责就是「map them to the words
// users read」——中文化是本职演进非越界。中文词表裁定：
//   tier    clear→清理 / micro-compact→微压缩 / summary→摘要 / emergency drop→紧急丢弃
//   trigger pre-call→调用前 / at turn boundary→轮界（CLAUDE.md 压缩管线既有词汇）
//           overflow→溢出 / static fallback→静态回退 / manual→手动
// token 保留：♻️、`49.8k → 12.1k`（formatTokensK+→）、`${mag ? ` ${mag}` : ""}` 条件
// 空格结构、`·` 分隔符、回退形 `tier-${tier}` 与未知 trigger 原样透传。两组 5 it：
//   A1 四档全渲染（tier 0-3 × 代表触发，全串逐字——5 个不同触发值全覆盖）；
//   A2 magnitude 缺失分支（NaN 传参）→ 无 mag 空格形逐字；
//   A3 mag 形 `49.8k → 12.1k` token 原样（A3 首 regex 断言保红，token 断言
//      改前即绿按 188/190/191 先例与红断言并组保红）；
//   B1 旧形六串在四档全部输出归零（not.toContain）；
//   B2 回退形 tier-9 / 未知 trigger 原样透传在场（token 正钉，全串 toBe）。
import { describe, expect, it } from "vitest";

import { formatCompactedLine } from "../src/log.js";

describe("ω99-192 A — compact 通知行中文化形态", () => {
  it("A1 四档全渲染：清理/微压缩/摘要/紧急丢弃 × 溢出/调用前/轮界/手动/静态回退", () => {
    // tier 0 · immediate → 溢出
    expect(formatCompactedLine(0, "immediate", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · 清理 · 溢出（继续中…）",
    );
    // tier 1 · threshold → 调用前
    expect(formatCompactedLine(1, "threshold", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · 微压缩 · 调用前（继续中…）",
    );
    // tier 2 · boundary → 轮界
    expect(formatCompactedLine(2, "boundary", 49800, 12100)).toBe(
      "♻️ 上下文已压缩 49.8k → 12.1k · 摘要 · 轮界（继续中…）",
    );
    // tier 3 · emergency → 溢出
    expect(formatCompactedLine(3, "emergency", 70000, 30000)).toBe(
      "♻️ 上下文已压缩 70k → 30k · 紧急丢弃 · 溢出（继续中…）",
    );
    // reactive / static-fallback / manual 三键 → 溢出 / 静态回退 / 手动
    expect(formatCompactedLine(2, "reactive", 70000, 30000)).toBe(
      "♻️ 上下文已压缩 70k → 30k · 摘要 · 溢出（继续中…）",
    );
    expect(formatCompactedLine(1, "static-fallback", 70000, 30000)).toBe(
      "♻️ 上下文已压缩 70k → 30k · 微压缩 · 静态回退（继续中…）",
    );
    expect(formatCompactedLine(2, "manual", 49800, 12100)).toBe(
      "♻️ 上下文已压缩 49.8k → 12.1k · 摘要 · 手动（继续中…）",
    );
  });

  it("A2 magnitude 缺失分支（NaN 传参）→ 无 mag 空格形逐字", () => {
    expect(formatCompactedLine(2, "boundary", Number.NaN, 12100)).toBe(
      "♻️ 上下文已压缩 · 摘要 · 轮界（继续中…）",
    );
    expect(formatCompactedLine(2, "boundary", 49800, Number.NaN)).toBe(
      "♻️ 上下文已压缩 · 摘要 · 轮界（继续中…）",
    );
  });

  it("A3 mag 形 49.8k → 12.1k token 原样（formatTokensK + →）", () => {
    const line = formatCompactedLine(2, "boundary", 49800, 12100);
    expect(line).toMatch(/^♻️ 上下文已压缩 49\.8k → 12\.1k ·/);
    expect(line).toContain("49.8k → 12.1k");
  });
});

describe("ω99-192 B — 旧形归零 + 回退形透传", () => {
  it("B1 旧形六串在四档全部输出归零（context compacted/(continuing…)/micro-compact/emergency drop/pre-call/at turn boundary）", () => {
    const oldForms = [
      "context compacted",
      "(continuing…)",
      "micro-compact",
      "emergency drop",
      "pre-call",
      "at turn boundary",
    ];
    const outputs = [
      formatCompactedLine(0, "immediate", 60000, 20000),
      formatCompactedLine(1, "threshold", 60000, 20000),
      formatCompactedLine(2, "boundary", 49800, 12100),
      formatCompactedLine(3, "emergency", 70000, 30000),
    ];
    for (const out of outputs) {
      for (const old of oldForms) expect(out).not.toContain(old);
    }
  });

  it("B2 回退形 tier-9 与未知 trigger 原样透传在场（token 正钉）", () => {
    expect(formatCompactedLine(9, "immediate", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · tier-9 · 溢出（继续中…）",
    );
    expect(formatCompactedLine(0, "never-seen-trigger", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · 清理 · never-seen-trigger（继续中…）",
    );
  });
});
