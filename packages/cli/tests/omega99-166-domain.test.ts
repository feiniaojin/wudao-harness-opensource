// ω99-166c-iv — driver/TUI 域面族 25 面中文化：三条新最小断言的源接线钉。
//
// 沿 ω99-166b（scatter）/ ω99-166c-iii（twins）的源接线钉范式
// （readFileSync 定位 src）：本弧域面多为 driver 内部 appendHistory 回执
// 与 TUI notify，无逐面 e2e 宿主可钉累积串，钉串值本身。
// 断言 ② 用 fallback 款（not.toContain('text: "⚠️ cannot submit')）：
// agent-driver.ts :1892 的 M18 steering 队列注释行永久残留英文短语
// "while a run is in flight"，直钉该短语必红；fallback 前缀同时覆盖
// attachments（:3727）/ images（:4407）/ files（:4420）三族提交拒绝，
// 证明力不弱于原款（brief 预案）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const adSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");
const appSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/tui/app.tsx", import.meta.url)), "utf8");

describe("ω99-166c-iv — driver/TUI 域面族中文化源接线钉", () => {
  it("wiring pin: steering 禁用拒绝回执为中文（#1/#2 孪生臂——busy 与 compact 窗口）", () => {
    // ω99-166c-iv: #1/#2（agent-driver.ts :3699/:3731）steering is disabled (--no-steering) → steering 已禁用（--no-steering）。
    expect(adSrc()).toContain("⚠️ steering 已禁用（--no-steering）");
  });

  it("wiring pin: 提交拒绝族全翻证明——零 'text: \"⚠️ cannot submit' 残留", () => {
    // ω99-166c-iv: #3/#13/#15（:3727/:4407/:4420）——直钉 "while a run is in flight" 撞 :1892 注释行，按预案改前缀款（覆盖三族）。
    expect(adSrc()).not.toContain('text: "⚠️ cannot submit');
  });

  it("wiring pin: TUI /clear 拒绝 notify 为中文（#24 — app.tsx :1904）", () => {
    // ω99-166c-iv: #24（原 app.tsx :1904；拆分运动 C 随提交路由器迁 app-submit.ts）
    // cannot /clear while a run is in flight → 运行中无法 /clear。
    expect(readFileSync(fileURLToPath(new URL("../src/tui/app-submit.ts", import.meta.url)), "utf8")).toContain('a.notify("⚠️ 运行中无法 /clear")');
  });
});
