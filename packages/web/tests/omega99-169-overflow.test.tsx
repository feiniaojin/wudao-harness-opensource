// ω99-169 — slash 菜单溢出行中文化：源接线钉。
//
// 超过 7 条匹配时菜单尾部出现 `… N more (↓ scrolls)` 溢出行（web
// InputBox.tsx 与 TUI suggest.tsx 孪生同串）。本文件钉 web 侧：串值
// 本身（无渲染宿主——溢出行需要 >7 条 slash 匹配才出现，且 census
// 证明 web 测试树无既有钉），readFileSync 直读源文件（ω99-72 范式）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  join(fileURLToPath(import.meta.url), "../../src/components/InputBox.tsx"),
  "utf8",
);

describe("ω99-169 — slash 菜单溢出行中文化（web 侧源接线钉）", () => {
  it("溢出行为中文（正钉）", () => {
    expect(src).toContain("… 还有 ${hidden} 项（↓ 滚动）");
  });

  it("旧英文溢出行归零（负钉）", () => {
    expect(src).not.toContain("${hidden} more (↓ scrolls)");
  });
});
