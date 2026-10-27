// ω99-191 — 杂项文案修正回执：模式词表过期族 + parked 清空行中文化。
// 两类词表裁定：显示层用显示词表（accept/ask/auto/plan——modeLabel 所出），
// 注释/文档层用代码真值（workspace/ask/auto/plan——hooks `if:` 求值对象为
// raw Mode，permission.ts:22 四档）。两组 4 it：
//   A1 /help 默认键位行 cycle 段=显示词表四档（slash-commands.ts:261）；
//   A2 parked 清空行中文化——最小 stub 源接线钉（175 receipts 范式），
//      渲染态逐字串「⏹ 已清空 1 条排队输入」由演进钉 repl.test:826 承担；
//   B1 /help 输出旧词表两形归零（read-only / (ask → auto）；
//   B2 hooks-config 文档枚举=raw 真值（:567 求值行在场 + :53 注释词表 +
//      旧 default|acceptEdits 归零）。
// B2 首断言（求值行在场）改前即绿，按 188/190 先例与红断言并组保红。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { listSlashCommands, formatSlashHelp } from "../src/slash-commands.js";

const hooksFamily = ["hooks-config.ts", "hooks-config-types.ts", "hooks-config-matcher.ts", "hooks-config-exec.ts", "hooks-config-parse.ts", "hooks-compose.ts"] as const;
const hooksSrc = hooksFamily.map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n") as string; // 拆分A：家族拼接读
const replSrc = readFileSync(new URL("../src/repl.ts", import.meta.url), "utf8") as string;

// 无 keysLine caller=TUI 形 → 走默认键位行（slash-commands.ts:261 唯一露出面）。
const helpText = formatSlashHelp(
  listSlashCommands({ skills: [], pluginCommands: [], extensionCommands: [] }),
  { mode: "auto" },
);

describe("ω99-191 A — 模式词表显示层 + parked 清空行中文化", () => {
  it("A1 /help 默认键位行 cycle 段=显示词表四档（accept → ask → auto → plan）", () => {
    expect(helpText).toContain("shift+tab 切换模式");
    expect(helpText).toContain("(accept → ask → auto → plan)");
  });

  it("A2 parked 清空行中文化（源接线钉；渲染逐字串由 repl.test:826 演进钉承担）", () => {
    expect(replSrc).toContain("`⏹ 已清空 ${parkedCleared} 条排队输入\\n`");
  });
});

describe("ω99-191 B — 反向：旧词表归零 + hooks 文档层 raw 真值", () => {
  it("B1 /help 输出旧词表两形归零（read-only / (ask → auto）", () => {
    expect(helpText).not.toContain("read-only");
    expect(helpText).not.toContain("(ask → auto");
  });

  it("B2 hooks-config 文档枚举=raw 值（求值行在场+注释词表+旧值归零）", () => {
    expect(hooksSrc).toContain("modeIf.includes(mode)");
    expect(hooksSrc).toContain("workspace|ask|auto|plan");
    expect(hooksSrc).not.toContain("default|acceptEdits");
  });
});
