// ω99-288: #8 — renderTurnDiff 的每文件 +M/−K counts receipts（数据层：
// 从 unifiedDiffBody hunk 累计，绝不解析已渲染文本——216 裁定「渲染层不当
// 数据层」的正道落点）+ 收据回放车道把 optional plus/minus 原样带过
// （resume 的 217 泛型车道读侧——新收据重启后面板计数不丢）。夹具零文件
// 系统（纯函数层）。
import { describe, it, expect } from "vitest";
import { renderTurnDiff } from "../src/turn-diff-render.js";
import { receiptNoticesFromEntries } from "../src/tui/resume.js";
import type { SessionEntry, TurnDiffFile } from "@wudao-org/core";

const WS = "/w";
const rel = (p: string): string => p.slice(WS.length + 1);
const file = (path: string, before: string | undefined, after: string, writes = 1): TurnDiffFile =>
  ({ path, op: before === undefined ? "created" : "modified", before, after, writes });

/** The independent checker: count the rendered detail's own +/− body lines
 *  per file block (the `+++`/`---` headers excluded) — counts must agree. */
function detailCounts(detail: string): { plus: number; minus: number }[] {
  return detail
    .split(/\n\n(?=diff --git )/)
    .filter((b) => b.startsWith("diff --git"))
    .map((block) => {
      let plus = 0;
      let minus = 0;
      for (const line of block.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) plus += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) minus += 1;
      }
      return { plus, minus };
    });
}

describe("ω99-288 renderTurnDiff counts（数据层 +M/−K）", () => {
  it("counts 与 detail hunks 一致（多文件同序；identical-net listed-no-hunks 计 0/0）", () => {
    const files = [
      file(`${WS}/a.ts`, "one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n"),
      file(`${WS}/same.ts`, "x\n", "x\n"), // identical net: listed, no hunks
      file(`${WS}/b.md`, "x\ny\n", "z\n"),
    ];
    const r = renderTurnDiff(files, rel);
    // 与 files 同序（台账序，含无 hunk 文件的 0/0 占位——zip 进 changes 的对齐契约）
    expect(r.counts).toEqual([
      { plus: 2, minus: 1 },
      { plus: 0, minus: 0 },
      { plus: 1, minus: 2 },
    ]);
    // 独立核对：渲染出的 body 自己的 +/− 行数一致（不含 +++/--- 头）
    expect(r.counts.filter((_, i) => files[i]?.before !== files[i]?.after)).toEqual(detailCounts(r.detail));
  });

  it("空台账 counts 空", () => {
    expect(renderTurnDiff([], rel).counts).toEqual([]);
  });

  it("截断不改 counts：超帽 detail 只剩标记，counts 仍是台账全量（数据层，非渲染文本解析）", () => {
    const big = `${"x\n".repeat(500)}`;
    const r = renderTurnDiff([file(`${WS}/big.ts`, "", big)], rel, { maxBytes: 512 });
    expect(r.truncated).toBe(true);
    expect(r.detail.startsWith("…（净变更")).toBe(true); // detail 被帽截
    expect(r.detail).not.toContain("+x");
    expect(r.counts).toEqual([{ plus: 500, minus: 0 }]); // counts 不被帽截
  });
});

describe("ω99-288 收据回放 counts 过境（resume 读侧）", () => {
  it("plus/minus 原样带过；缺省仍缺省（append-only——老收据零变化）", () => {
    const entries: SessionEntry[] = [
      { type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：a.ts(×1)", detail: "d", changes: [{ path: "a.ts", op: "modified", writes: 1, plus: 2, minus: 1 }] } },
      { type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：b.ts(新建)", changes: [{ path: "b.ts", op: "created", writes: 1 }] } },
    ];
    expect(receiptNoticesFromEntries(entries)).toEqual([
      { kind: "notice", text: "回合净变更 1 文件：a.ts(×1)", detail: "d", changes: [{ path: "a.ts", op: "modified", writes: 1, plus: 2, minus: 1 }] },
      { kind: "notice", text: "回合净变更 1 文件：b.ts(新建)", changes: [{ path: "b.ts", op: "created", writes: 1 }] },
    ]);
  });

  it("畸形 counts（半在场/负数）弃条不崩（写者契约整条严格，detail 同款纪律）", () => {
    const entries: SessionEntry[] = [
      { type: "turn_diff_receipt", data: { text: "t", changes: [{ path: "a", op: "created", writes: 1, plus: 1 }] } },
      { type: "turn_diff_receipt", data: { text: "t", changes: [{ path: "a", op: "created", writes: 1, plus: -1, minus: 0 }] } },
    ];
    expect(receiptNoticesFromEntries(entries)).toEqual([]);
  });
});
