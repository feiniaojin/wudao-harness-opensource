// ω99-166c-ii — agent-driver.ts interrupted 族 2 面中文化：三条新最小断言的源接线钉。
//
// 166a/b/c-i 后 REPL 车道中断回执已中文，driver 车道孪生面（:3200 aborted
// terminal / :3235 abort-shaped throw）仍英文。沿 ω99-161 #7 / ω99-164 /
// ω99-165 / ω99-166a/b/c-i 的源接线钉范式（readFileSync 定位
// src/driver/agent-driver.ts）钉串值本身。本弧只翻 interrupted 族 2 面；
// ⏳ cannot-be-interrupted 等待族（:6075）是后续弧，③ 为声明绿卫钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

describe("ω99-166c-ii — driver interrupted 族中文化源接线钉", () => {
  it("wiring pin: 中断回执为中文（#1/#2 双源面共用一钉 — repl :1940/:1981 逐字）", () => {
    // ω99-166c-ii: #1/#2（agent-driver.ts :3200/:3235）⚠️ interrupted → ⚠️ 已中断（= 166b repl 先例逐字）。
    // v7 γ2 钉随演进：字面量外提为 run-end-cause.ts 的 interruptedNotice()
    // （user-abort/成因不可知两臂逐字节返回「⚠️ 已中断」——REPL 逐字钉
    // 由 run-end-cause.test.ts 的两臂断言承接）；源接线钉改为钉调用点。
    expect(driverSrc()).toContain("text: interruptedNotice(runEndCause)");
  });

  it("wiring pin: 英文原串全翻证明（域内零残留）", () => {
    // ω99-166c-ii: 全翻证明 — interrupted 族翻毕后 agent-driver.ts 域内 ⚠️ interrupted 应为 0 面。
    expect(driverSrc()).not.toContain("⚠️ interrupted");
  });

  it("wiring pin: ⏳ cannot-be-interrupted 等待族 scope 守卫（:6075 在位，声明绿卫钉）", () => {
    // ω99-166c-ii: 改前即绿 — :6075 ⏳ 等待族刻意不触，属后续弧；本钉守卫其不被误翻。
    expect(driverSrc()).toContain("不可中断——等待其结束"); // ω99-166e-i: 钉随 #6 演进（绿卫钉转正向中文化钉）
  });
});
