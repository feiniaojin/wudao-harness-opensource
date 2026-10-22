// ω99-166e-i — 余量回执族中文化：五条最小断言的源接线钉。
//
// always-rule 写入失败回执（permission / session-engine×2 / TUI 四车道）
// + ⏳ 延迟工具加载回执 + ⏳ 不可中断等待回执 + /worktree 排队操作被根
// 切换取代回执（driver）+ bang 用户回显族（formatBangEcho 臂）无独立
// e2e 宿主可钉累积串，沿 ω99-166b/c/d 的源接线钉范式（readFileSync
// 定位 src 文件）钉串值本身。
// 域界：bang.ts buildBangContextPrefix（:88-95）是模型可见
// <shell_context> 信封域，刻意保持英文 —— 故本文件对 bang.ts 只做
// 正向钉、禁全文件负钉（brief 第四节披露表）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const permissionSrc = (): string => read("../src/permission.ts");
const tuiSrc = (): string => read("../src/tui/app.tsx");
const sessionEngineSrc = (): string => read("../src/driver/session-engine.ts");
const driverSrc = (): string => read("../src/driver/agent-driver.ts");
const bangSrc = (): string => read("../src/bang.ts");

describe("ω99-166e-i — 余量回执族中文化源接线钉", () => {
  it("wiring pin: always-rule 写入失败回执为中文（#1-#4 四车道全翻，一断言三读）", () => {
    // ω99-166e-i: #1-#4（permission.ts :1487 / tui/app.tsx :2068 / session-engine.ts :588/:1101）
    // permissions: always-rule write failed (…) — this session's rule still applies
    //   → permissions：always-rule 写入失败（…）——本会话规则仍然生效。
    for (const [name, src] of [
      ["permission.ts", permissionSrc()],
      ["tui/app.tsx", tuiSrc()],
      ["driver/session-engine.ts", sessionEngineSrc()],
    ] as const) {
      expect(src, name).toContain("permissions：always-rule 写入失败（");
      expect(src, name).not.toContain("always-rule write failed");
    }
  });

  it("wiring pin: ⏳ 延迟工具加载回执为中文（#5）", () => {
    // ω99-166e-i: #5（agent-driver.ts :3049）⏳ deferred tools loaded: … → ⏳ 延迟工具已加载：…。
    expect(driverSrc()).toContain("⏳ 延迟工具已加载：");
    expect(driverSrc()).not.toContain("deferred tools loaded");
  });

  it("wiring pin: ⏳ 不可中断等待回执为中文（#6）", () => {
    // ω99-166e-i: #6（agent-driver.ts :6086）cannot be interrupted — waiting for it to finish
    //   → 不可中断——等待其结束（稍后再按 Esc）。
    expect(driverSrc()).toContain("不可中断——等待其结束");
    expect(driverSrc()).not.toContain("cannot be interrupted");
  });

  it("wiring pin: /worktree 排队操作被根切换取代回执为中文（#7）", () => {
    // ω99-166e-i: #7（agent-driver.ts :6236）(the queued /worktree … was superseded by this
    //   root switch …) → （排队的 /worktree …已被本次根切换取代——从未落地……）。
    expect(driverSrc()).toContain("已被本次根切换取代");
  });

  it("wiring pin: bang 用户回显族为中文（#8-#10 — formatBangEcho 臂，正向钉）", () => {
    // ω99-166e-i: #8-#10（bang.ts :62-64）(no output)/[output truncated …]/(exit code …)
    //   → （无输出）/［输出已在 … 字符处截断——…］/（退出码 …）。
    // （退出码 用前缀钉 —— ${r.code} 是插值不出现在源码字面。域界：buildBangContextPrefix
    // （:88-95）是模型可见信封臂，仍含英文 "(no output)"，故禁全文件负钉。
    expect(bangSrc()).toContain("（无输出）");
    expect(bangSrc()).toContain("（退出码 ");
  });
});
