// ω99-166b — repl.ts 告警散面 18 面中文化：三条新最小断言的源接线钉。
//
// 与 166a 镜像：repl.ts 的散面告警写 stdout，无独立 e2e 宿主可钉累积
// 串，沿 ω99-161 #7 / ω99-164 / ω99-165 / ω99-166a 的源接线钉范式
// （readFileSync 定位 src/repl.ts）钉串值本身。本弧只收散面 18 面；
// agent-driver 告警（含全部孪生）是 166c 弧，刻意不钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

describe("ω99-166b — repl 散面告警中文化源接线钉", () => {
  it("wiring pin: 审批门布防横幅为中文（#3 — 全角括号含内嵌子句）", () => {
    // ω99-166b: #3（repl.ts :1323）approval gate armed (file-edits) — → 审批门已布防（file-edits）——。
    expect(replSrc()).toContain("🚧 审批门已布防（file-edits）——");
  });

  it("wiring pin: 运行中 /edit 拒绝回执为中文（#16 — 镜像 driver :3803 既有中文款）", () => {
    // ω99-166b: #16（repl.ts :3136）cannot /edit while a run is in flight → 运行中无法 /edit（任务进行中）。
    expect(replSrc()).toContain("⚠️ 运行中无法 /edit（任务进行中）");
  });

  it("wiring pin: persona 文件跳过告警为中文（#1 — e 插值原样）", () => {
    // ω99-166b: #1（repl.ts :920）persona file skipped: → persona 文件已跳过：。
    expect(replSrc()).toContain("⚠️ persona 文件已跳过：");
  });
});
