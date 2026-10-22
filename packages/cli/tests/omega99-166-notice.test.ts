// ω99-166d-ii — notice 回执族 32 面中文化：四条新最小断言的源接线钉。
//
// 括号 notice 回执族（repl/driver/TUI/headless 四车道）+ ⏸ 暂存族 + 零散
// 尾巴无独立 e2e 宿主可钉累积串，沿 ω99-166b/c/d 的源接线钉范式
// （readFileSync 定位 src 文件）钉串值本身。四个车道各钉一条：
// repl（⏸ 暂存族）、driver（括号 notice 族）、core branch（空树占位）、
// ask-reviewer（降级回执）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

const branchSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../../core/src/session/branch.ts", import.meta.url)), "utf8");

const askReviewerSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/ask-reviewer.ts", import.meta.url)), "utf8");

describe("ω99-166d-ii — notice 回执族中文化源接线钉", () => {
  it("wiring pin: ⏸ 暂存回执为中文（#12 — 全角括号款）", () => {
    // ω99-166d-ii: #12（repl.ts :1621）⏸ input parked (turn in flight) → ⏸ 输入已暂存（本轮运行中）。
    expect(replSrc()).toContain("⏸ 输入已暂存（本轮运行中）");
    expect(replSrc()).not.toContain("(turn in flight)");
  });

  it("wiring pin: driver 括号 notice 族为中文（#17 — 全角括号 + —— 连排）", () => {
    // ω99-166d-ii: #17（agent-driver.ts :4664）(memory unavailable — no workspace) → （memory 不可用——无工作区）。
    expect(driverSrc()).toContain("（memory 不可用——无工作区）");
    expect(driverSrc()).not.toContain("unavailable — no workspace");
  });

  it("wiring pin: branch 空树占位为中文（#30 — core）", () => {
    // ω99-166d-ii: #30（core branch.ts :135）(no turns yet) → （尚无轮次）。
    expect(branchSrc()).toContain("（尚无轮次）");
  });

  it("wiring pin: ask-reviewer 降级回执为中文（#31 — 全角括号含 reason 插值）", () => {
    // ω99-166d-ii: #31（ask-reviewer.ts :439）🛡 ask-reviewer unavailable (…) — plain ask shown → 🛡 ask-reviewer 不可用（…）——已回退普通询问。
    expect(askReviewerSrc()).toContain("🛡 ask-reviewer 不可用（");
  });
});
