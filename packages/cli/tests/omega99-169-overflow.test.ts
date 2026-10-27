// ω99-169 — slash 菜单溢出行中文化：TUI 侧源接线钉。
//
// 超过 7 条匹配时 suggest 窗尾部出现 `… N more (↓ scrolls)` 溢出行
// （tui/suggest.tsx 与 web InputBox.tsx 孪生同串）。运行时宿主钉在
// input.test.ts:676（`… ${COMMANDS.length - 7} more` 前缀钉，随源演
// 进）；本文件钉 TUI 侧串值本身（readFileSync 直读源，166 系范式）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  new URL("../src/tui/suggest.tsx", import.meta.url),
  "utf8",
) as string;

describe("ω99-169 — slash 菜单溢出行中文化（TUI 侧源接线钉）", () => {
  it("溢出行为中文（正钉）", () => {
    expect(src).toContain("… 还有 ${hidden} 项（↓ 滚动）");
  });

  it("旧英文溢出行归零（负钉）", () => {
    expect(src).not.toContain("${hidden} more (↓ scrolls)");
  });
});
