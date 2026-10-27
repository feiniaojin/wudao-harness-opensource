// ω99-166c-i — agent-driver.ts failed 通知族 31 面中文化：三条新最小断言的源接线钉。
//
// 与 166a/b 镜像：driver 车道的失败回执写 appendHistory notice，部分面无
// 独立 e2e 宿主可钉累积串，沿 ω99-161 #7 / ω99-164 / ω99-165 / ω99-166a/b
// 的源接线钉范式（readFileSync 定位 src/driver/agent-driver.ts）钉串值本身。
// 本弧只收 failed 族 31 面；driver 散面（🚧/interrupted/refused 等）是
// 166c-ii，刻意不钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

describe("ω99-166c-i — driver failed 通知族中文化源接线钉", () => {
  it("wiring pin: /mission 失败回执为中文（#27 — m81:192 钉的孪生模板）", () => {
    // ω99-166c-i: #27（agent-driver.ts :5636）/mission failed: → /mission 失败：全角冒号；err 三元原样。
    expect(driverSrc()).toContain("⚠️ /mission 失败：");
  });

  it("wiring pin: provider 切换失败回执为中文（#4 — 源模板字面，动词前移款）", () => {
    // ω99-166c-i: #4（agent-driver.ts :4134）provider switch to ${provider} failed: → provider 切换到 ${provider} 失败：。
    expect(driverSrc()).toContain("⚠️ provider 切换到 ${provider} 失败：");
  });

  it("wiring pin: memory 命令失败回执为中文（#8 — command→命令）", () => {
    // ω99-166c-i: #8（agent-driver.ts :4676）memory command failed: → memory 命令失败：。
    expect(driverSrc()).toContain("⚠️ memory 命令失败：");
  });
});
