// ω99-166e-ii — 帮助块族中文化 5 面接线钉（readFileSync 源面断言，红→绿
// 先行留档）：①workflow USAGE 全块换头（usage→用法）且旧头绝迹；②块尾
// journal 行钉（中文化后块体完整落位的哨兵）；③worktree 错误回执 + ④四行
// WORKTREE_USAGE 数组（`用法：/worktree ——` 头钉 + 旧 `usage: /worktree`
// 绝迹）；⑤plugins 两用法头（CLI + slash）同换。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ω99-166e-ii — 帮助块族中文化 5 面", () => {
  it("workflow/cli.ts：USAGE 全块换 `用法：wudao workflow` 头，旧 usage 头绝迹", () => {
    const s = src("../src/workflow/cli.ts");
    expect(s).toContain("用法：wudao workflow");
    expect(s).not.toContain("usage: wudao workflow");
  });

  it("workflow/cli.ts：块尾 journal 行中文化（块体整体替换的哨兵钉）", () => {
    const s = src("../src/workflow/cli.ts");
    expect(s).toContain("journal：.wudao/workflows/");
  });

  it("commands/worktree.ts：错误回执 + WORKTREE_USAGE 换 `用法：/worktree` 头，旧头绝迹", () => {
    const s = src("../src/commands/worktree.ts");
    expect(s).toContain("用法：/worktree —— 主会话的隔离 worktree");
    expect(s).not.toContain("usage: /worktree");
  });

  it("commands/plugins-command.ts：CLI 与 slash 两用法头同换", () => {
    const s = src("../src/commands/plugins-command.ts");
    expect(s).toContain("用法：wudao plugin");
    expect(s).toContain("用法：/plugin");
    expect(s).not.toContain("usage: wudao plugin");
  });
});
