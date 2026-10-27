// ω99-166c-iii — agent-driver.ts REPL 孪生族 11 面中文化：三条新最小断言的源接线钉。
//
// 166 系列已翻 driver failed 族与 interrupted 族；本弧收 driver 车道与 REPL
// 逐字孪生的散面（审批门横幅、五类「切换记录未写入」、provider 边界失败/
// 拒绝切换、导出覆写回执、compact 中止），译法取 repl 既有先例逐字（孪生归一）。
// 沿 ω99-161 #7 / ω99-164 / ω99-165 / ω99-166a/b 的源接线钉范式
// （readFileSync 定位 src/driver/agent-driver.ts）钉串值本身。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

describe("ω99-166c-iii — driver 孪生告警中文化源接线钉", () => {
  it("wiring pin: 审批门布防横幅为中文（#1 — 孪生 repl :1323 全角括号款）", () => {
    // ω99-166c-iii: #1（agent-driver.ts :1750）approval gate armed (file-edits) → 审批门已布防（file-edits）——。
    expect(driverSrc()).toContain("🚧 审批门已布防（file-edits）——");
  });

  it("wiring pin: provider 拒绝切换回执为中文（#10 — 孪生 repl :2851，源模板字面）", () => {
    // ω99-166c-iii: #10（agent-driver.ts :5400）provider switch refused: → 拒绝切换到 provider。
    expect(driverSrc()).toContain("⚠️ 拒绝切换到 provider ${v.name}：");
  });

  it("wiring pin: compact 中止告警为中文（#9 — 孪生 repl :2555）", () => {
    // ω99-166c-iii: #9（agent-driver.ts :4886）compact aborted — no boundary written → compact 已中止——未写入边界。
    expect(driverSrc()).toContain("⚠️ compact 已中止——未写入边界");
  });
});
