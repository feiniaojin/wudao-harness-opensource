// ω99-237: #12 — 「N writable keys」真值锚（brief §零 问题 ②，236 报告 §二
// parked 的注释漂移账）：settings-ops.ts 的 settingsSet unknown-key 错误串枚举
// 是单一事实源——三处「N writable」注释曾各自漂到 8/10/8 而真值已是 12（234
// 语言键落地时未同步）。本钉读源断言枚举恰 12 名、逐字等于权威清单、且每个
// 名都有对应 settingsSet 分支（枚举与行为不漂移），防再次漂移。注释是文档面
// 不钉行为（brief §四）；本件零夹具零 IO 副作用（纯读源——★红线：只读不删）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** 权威 14 名（settings-ops.ts 的 unknown-key 错误串逐字序）。ω99-287: #5 —
 * desktop.backgroundOnClose 加入（12→13）；122 项 2 — schedules.launchAgent
 * 加入（13→14，lockstep——本钉的设计维护路径）。 */
const TRUTH_14 = [
  "ui.defaultMode",
  "ui.theme",
  "ui.accent",
  "memoryEnabled",
  "model.defaultModel",
  "model.defaultEffort",
  "wizard.completedVersion",
  "persona.id",
  "permissions.defaultMode",
  "language.reply",
  "language.reasoning",
  "docSuite.enabled",
  "desktop.backgroundOnClose",
  "schedules.launchAgent",
] as const;

describe("ω99-237 settings-ops writable 枚举计数钉（真值 14）", () => {
  it("unknown-key 错误串枚举恰 14 名、逐字等于权威清单、无重复", () => {
    const src = readFileSync(new URL("../src/driver/settings-ops.ts", import.meta.url), "utf8");
    const m = src.match(/\(writable: ([^)]+)\)/);
    expect(m).not.toBeNull(); // 枚举串在场（本弧起注释/测试都指向他——单一事实源）
    const names = m![1]!.split(",").map((s) => s.trim());
    expect(names).toHaveLength(14);
    expect(names).toEqual([...TRUTH_14]);
    expect(new Set(names).size).toBe(14); // 无重复
  });

  it("枚举与行为不漂移：每个名都有对应 settingsSet 分支（key === \"<name>\"）", () => {
    const src = readFileSync(new URL("../src/driver/settings-ops.ts", import.meta.url), "utf8");
    for (const name of TRUTH_14) {
      expect(src).toContain(`key === "${name}"`);
    }
  });
});
