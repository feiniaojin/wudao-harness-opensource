// #455 — balancedDiffRows 纯层（0.3.83 报障「很多 -号的行，+号的行没有看到」）。
// computeDiff 在每个 hunk 内先输出全部 `-` 再输出全部 `+`（git hunk 惯序），
// 折叠窗口落进 del 块时读起来就是「只有删除」——实测报障会话 19/27 次编辑的
// `+` 块全部在 132px 首屏之下。预览保两侧头行 + 每侧只数自己省掉的行。
import { describe, expect, it } from "vitest";
import { balancedDiffRows, collapseContext, computeDiff } from "../src/diff.js";
import type { DiffRow } from "../src/diff.js";

const rowsOf = (oldString: string, newString: string): DiffRow[] =>
  collapseContext(computeDiff(oldString, newString));

describe("#455 — balancedDiffRows 纯层", () => {
  it("两侧头行 + 诚实计数省略标记；每侧只数自己省掉的行，不借对侧的数", () => {
    const oldS = Array.from({ length: 5 }, (_, i) => `a${i}`).join("\n");
    const newS = Array.from({ length: 7 }, (_, i) => `b${i}`).join("\n");
    expect(balancedDiffRows(rowsOf(oldS, newS), 2)).toEqual([
      { kind: "del", text: "a0" },
      { kind: "del", text: "a1" },
      { kind: "gap", count: 3, label: "⋯ 再 -3 行 ⋯" },
      { kind: "add", text: "b0" },
      { kind: "add", text: "b1" },
      { kind: "gap", count: 5, label: "⋯ 再 +5 行 ⋯" },
    ]);
  });

  it("两侧都在 perSide 内 → 两侧原样收下、零标记（上下文行全部让位——预览只答「改了什么」）", () => {
    expect(balancedDiffRows(rowsOf("a\nb\nc", "a\nB\nc"), 3)).toEqual([
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
    ]);
  });

  it("纯删除成立：另一侧整段缺席（0 行头、无标记），绝不编造 + 行", () => {
    expect(balancedDiffRows(rowsOf("x1\nx2\nx3\nx4\nx5\nkeep", "keep"), 2)).toEqual([
      { kind: "del", text: "x1" },
      { kind: "del", text: "x2" },
      { kind: "gap", count: 3, label: "⋯ 再 -3 行 ⋯" },
    ]);
  });

  it("纯添加成立：镜像形态（del 侧缺席，add 头 + 计数标记）", () => {
    expect(balancedDiffRows(rowsOf("keep", "x1\nx2\nx3\nx4\nx5\nkeep"), 2)).toEqual([
      { kind: "add", text: "x1" },
      { kind: "add", text: "x2" },
      { kind: "gap", count: 3, label: "⋯ 再 +3 行 ⋯" },
    ]);
  });

  it("perSide 大于侧长 → 全量收下，无标记（调用方用它保小 diff 原样）", () => {
    expect(balancedDiffRows(rowsOf("a\nb", "a\nB"), 10)).toEqual([
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
    ]);
  });

  it("不变量：对任意溢出 hunk，输出恒含 del 头与 add 头各 ≥1（当且仅当该侧存在）", () => {
    // 报障会话的形态抽样：del 块远大于 add 块。
    const oldS = Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n");
    const newS = Array.from({ length: 4 }, (_, i) => `n${i}`).join("\n");
    const out = balancedDiffRows(rowsOf(oldS, newS), 3);
    expect(out.some((r) => r.kind === "del")).toBe(true);
    expect(out.some((r) => r.kind === "add")).toBe(true);
    // 计数诚实：省略总数 + 头行数 = 该侧全量。
    const delGap = out.find((r) => r.kind === "gap" && r.label?.includes("-"));
    expect(delGap && delGap.kind === "gap" ? delGap.count + 3 : 0).toBe(20);
    // add 侧 4 行 > perSide 3 → 头 3 + 省略 1。
    const addGap = out.find((r) => r.kind === "gap" && r.label?.includes("+"));
    expect(addGap && addGap.kind === "gap" ? addGap.count + 3 : -1).toBe(4);
  });
});
