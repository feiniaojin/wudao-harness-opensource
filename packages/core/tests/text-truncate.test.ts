// 113-A4 —— truncateSafe / truncateTailSafe 的冻结契约测试。
//
// 覆盖三条验收轴：
//   1. 不劈半：任意 cap 位点（全边界矩阵扫描）都不产出孤立代理项；
//   2. ASCII 平价：ASCII 输入下与旧 `slice` 行为逐字节一致（幂等、保序）；
//   3. 纯函数：stub 字节仍是历史的纯函数（同输入同字节，重复调用稳定）。
//
// ── M24 行为修正声明（非缓存破坏）───────────────────────────────────────
// 收编后的位点在“cap 恰好劈在增补平面字符代理对中间”时，产出字节与历史
// 版本不同（旧字节是孤立代理项 = 乱码 bug）。本文件用夹具钉死新法：
// 旧字节本身无效，新字节是该输入下唯一的有效截断；ASCII / BMP 输入的
// 字节则逐字节不变——所以 resume 重推导与 provider 前缀缓存在一切合法
// 历史上保持稳定。
import { describe, it, expect } from "vitest";
import { truncateSafe, truncateTailSafe } from "../src/text-truncate.js";
import { capToLineBoundary } from "../src/compaction-markers.js";
import { deferSummary } from "../src/defer.js";
import { capBuffer } from "../src/tools/shell.js";
import { capSearchOutput } from "../src/tools/web-search.js";
import { shapeWebFetchOutput } from "../src/tools/web-fetch.js";
import { microcompact, COMPACTION_STUB_PREFIX } from "../src/compaction.js";
import type { AgentMessage } from "../src/types.js";

// 孤立代理项检测（收编裁决指定的两条边界检测）。
const ENDS_WITH_HIGH = /[\uD800-\uDBFF]$/;
const STARTS_WITH_LOW = /^[\uDC00-\uDFFF]/;

const ASTRAL_SAMPLE =
  "ascii-prefix 𠮷𠮷𠮷 emoji 😀😀😀 zwj 👨‍👩‍👧‍👦 flag 🇨🇳🇨🇳 tail-ascii";
const ASCII_SAMPLE = "abcdefghijklmnopqrstuvwxyz0123456789";

describe("truncateSafe", () => {
  it("边界矩阵：任意 cap 都不劈代理对（结果两端无孤立代理项、永远是前缀、不超帽）", () => {
    for (let cap = 0; cap <= ASTRAL_SAMPLE.length + 2; cap++) {
      const out = truncateSafe(ASTRAL_SAMPLE, cap);
      expect(out.length, `cap=${cap}`).toBeLessThanOrEqual(cap);
      expect(ENDS_WITH_HIGH.test(out), `cap=${cap} 劈出了尾端孤立高位`).toBe(false);
      expect(STARTS_WITH_LOW.test(out), `cap=${cap} 起始即孤立低位`).toBe(false);
      expect(ASTRAL_SAMPLE.startsWith(out), `cap=${cap} 结果不是前缀`).toBe(true);
    }
  });

  it("高位恰在 cap 位：退 1 保住整对", () => {
    // a×5 + 高位@5 + 低位@6：cap=7 劈在第二对中间 → 退到 6，整对存活。
    expect(truncateSafe("aaaaa𠮷𠮷", 7)).toBe("aaaaa𠮷");
    // cap 落在整对之后（BMP 边界）不退：
    expect(truncateSafe("aaaaa𠮷𠮷", 7 + 2)).toBe("aaaaa𠮷𠮷");
  });

  it("ASCII 平价：与旧 slice(0, max) 逐字节一致（含 0/负/超长帽）", () => {
    for (let cap = 0; cap <= ASCII_SAMPLE.length + 2; cap++) {
      expect(truncateSafe(ASCII_SAMPLE, cap), `cap=${cap}`).toBe(ASCII_SAMPLE.slice(0, cap));
    }
    expect(truncateSafe(ASCII_SAMPLE, -1)).toBe("");
    expect(truncateSafe("", 10)).toBe("");
    expect(truncateSafe("abc", 99)).toBe("abc");
  });

  it("BMP（含常用 CJK）平价：三字节汉字不受影响，逐字节等于旧 slice", () => {
    const bmp = "简体中文常用字符集不落在增补平面";
    for (let cap = 0; cap <= bmp.length + 1; cap++) {
      expect(truncateSafe(bmp, cap), `cap=${cap}`).toBe(bmp.slice(0, cap));
    }
  });

  it("纯函数 + 幂等：同输入同字节；截两次等于截一次", () => {
    for (let cap = 0; cap <= 40; cap++) {
      const a = truncateSafe(ASTRAL_SAMPLE, cap);
      expect(a).toBe(truncateSafe(ASTRAL_SAMPLE, cap));
      expect(truncateSafe(a, cap)).toBe(a);
    }
  });
});

describe("truncateTailSafe", () => {
  it("边界矩阵：尾部截断不从代理对中间起（首字符永非孤立低位、永远是后缀、不超帽）", () => {
    for (let max = 0; max <= ASTRAL_SAMPLE.length + 2; max++) {
      const out = truncateTailSafe(ASTRAL_SAMPLE, max);
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
      expect(STARTS_WITH_LOW.test(out), `max=${max} 以孤立低位开头`).toBe(false);
      expect(ASTRAL_SAMPLE.endsWith(out), `max=${max} 结果不是后缀`).toBe(true);
    }
  });

  it("ASCII 平价：与旧 slice(-max) 逐字节一致（max≥1；max=0 钉空串）", () => {
    for (let max = 1; max <= ASCII_SAMPLE.length + 2; max++) {
      expect(truncateTailSafe(ASCII_SAMPLE, max), `max=${max}`).toBe(ASCII_SAMPLE.slice(-max));
    }
    // 声明的刻意分歧：`s.slice(-0)` 是 JS 脚枪（-0===0 → 返回整串）；
    // 0 单位帽的 sane 语义是空串。位点常量恒为正，无人依赖旧脚枪。
    expect(truncateTailSafe(ASCII_SAMPLE, 0)).toBe("");
    expect(truncateTailSafe("", 10)).toBe("");
    expect(truncateTailSafe("abc", 99)).toBe("abc");
  });

  it("低位恰在窗首：丢 1 保整对（帽是硬上界，宁可短不可劈）", () => {
    // x(0) 高(1) 低(2) b(3)：窗 2 从低位起 → 前移一位，只留 "b"。
    expect(truncateTailSafe("x𠮷b", 2)).toBe("b");
    // 窗 3 从高位起 → 整对在窗内，照旧全取。
    expect(truncateTailSafe("x𠮷b", 3)).toBe("𠮷b");
  });
});

// ---------------------------------------------------------------------------
// 收编位点抽样回归（M24 敏感面）：旧实现劈代理对的位点，新实现产出有效字节。
// 行为修正声明：仅当 cap 劈在增补平面字符中间时字节与历史版本不同——旧字
// 节本身是乱码（孤立代理项），非缓存破坏；ASCII/BMP 输入字节不变。
// ---------------------------------------------------------------------------

describe("收编位点回归：capToLineBoundary（压缩标记共享文本帽，进持久化 stub）", () => {
  it("无换行时退到代理对边界；有换行时行为不变；纯函数", () => {
    // 40 个 a 后是 astral：cap=41 劈在第一对中间 → 退到 40。
    const line = "a".repeat(40) + "𠮷".repeat(30); // 无 \n
    const out = capToLineBoundary(line, 41);
    expect(ENDS_WITH_HIGH.test(out)).toBe(false);
    expect(out).toBe("a".repeat(40));
    expect(capToLineBoundary(line, 41)).toBe(out); // 纯函数
    // 换行边界（真实字符边界）行为不变：
    expect(capToLineBoundary("abc\nrest", 4)).toBe("abc\n");
    const withNl = "第一行\n" + "𠮷".repeat(60);
    expect(capToLineBoundary(withNl, 30).endsWith("\n")).toBe(true);
  });
});

describe("收编位点回归：deferSummary（load_tools 元工具描述 = 模型可见字节）", () => {
  it("摘要帽不劈 emoji/CJK 扩展字符；纯函数；ASCII 行为不变", () => {
    // 无句点 → flat 即文本；107 个 a 后紧跟 astral：cap=110 劈在第二对中间。
    const straddling = "a".repeat(107) + "𠮷".repeat(3);
    const out = deferSummary(straddling);
    expect(ENDS_WITH_HIGH.test(out), JSON.stringify(out)).toBe(false);
    expect(STARTS_WITH_LOW.test(out)).toBe(false);
    expect(out.startsWith("a".repeat(107))).toBe(true);
    expect(deferSummary(straddling)).toBe(out); // 纯函数：同输入同字节
    // 多样夹具（ZWJ 家族序列、旗帜、CJK 扩展区成段）在帽内任意落点都安全：
    for (const desc of [
      `${"𠮷".repeat(20)} 词 `.repeat(20),
      `${"👨‍👩‍👧‍👦".repeat(10)} 句子内容继续变长超过一百一十个字符的上限值。`,
      "Plain ASCII sentence that keeps going past the one hundred and ten char summary cap.",
    ]) {
      const s = deferSummary(desc);
      expect(ENDS_WITH_HIGH.test(s), JSON.stringify(s)).toBe(false);
      expect(deferSummary(desc)).toBe(s);
    }
    // ASCII 输入与旧 slice 语义逐字节一致（帽内第一句 + trimEnd + …）。
    expect(deferSummary("Short. Rest")).toBe("Short.");
  });
});

describe("收编位点回归：capBuffer（终端输出帽，进 ToolResult 字节）", () => {
  it("块序节奏下不产出孤立代理项且不超帽；ASCII 节奏与旧法逐字节一致", () => {
    const chunks = ["🎉".repeat(60), "中文".repeat(40), "a".repeat(99) + "𠮷" + "b".repeat(50)];
    for (const maxBuffer of [10, 64, 100, 257, 4096]) {
      let mine = "";
      for (const c of chunks) {
        mine = capBuffer(mine, c, maxBuffer);
        expect(mine.length).toBeLessThanOrEqual(maxBuffer);
        expect(ENDS_WITH_HIGH.test(mine), `max=${maxBuffer}`).toBe(false);
      }
    }
    // ASCII 平价：与旧 (prev+text).slice(0, max) 逐字节一致。
    const baseAppend = (p: string, t: string, m: number): string =>
      p.length >= m ? p : (p + t).slice(0, m);
    for (const maxBuffer of [10, 64, 100]) {
      let mine = "";
      let ref = "";
      for (const c of ["abcdef", "ghijkl", "mnop"]) {
        mine = capBuffer(mine, c, maxBuffer);
        ref = baseAppend(ref, c, maxBuffer);
      }
      expect(mine).toBe(ref);
    }
  });
});

describe("收编位点回归：capSearchOutput / shapeWebFetchOutput（模型可见工具结果）", () => {
  it("行界回退与头尾 shaping 都不劈代理对", () => {
    const dense = `1. ${"𠮷".repeat(80)} — u\n   snippet`;
    expect(ENDS_WITH_HIGH.test(capSearchOutput(dense, 40))).toBe(false);
    const wf = shapeWebFetchOutput("𠮷".repeat(400) + "ascii-tail", 101);
    expect(wf).toBeDefined();
    for (const part of wf!.split("\n")) {
      expect(ENDS_WITH_HIGH.test(part), JSON.stringify(part)).toBe(false);
      expect(STARTS_WITH_LOW.test(part)).toBe(false);
    }
  });
});

describe("收编位点回归：microcompact stub（持久化 stub 字节 = 历史的纯函数）", () => {
  it("stub 预览帽不劈代理对；两次压缩同历史产出同字节（resume 可重推导）", () => {
    // 59 个 a + astral：旧 slice(0,100) 恰劈在第 21 对中间（高位@99）。
    const mk = (): AgentMessage[] => [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c0", name: "t", content: "a".repeat(59) + "𠮷".repeat(80) },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ];
    const a = microcompact(mk(), { keepRecent: 1, minChars: 100 });
    const b = microcompact(mk(), { keepRecent: 1, minChars: 100 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // 纯函数：同历史同字节
    const stub = (a as AgentMessage[]).find((m) => m.role === "tool" && m.content.startsWith(COMPACTION_STUB_PREFIX));
    expect(stub).toBeDefined();
    expect(ENDS_WITH_HIGH.test(stub!.content)).toBe(false);
    expect(STARTS_WITH_LOW.test(stub!.content)).toBe(false);
  });
});
