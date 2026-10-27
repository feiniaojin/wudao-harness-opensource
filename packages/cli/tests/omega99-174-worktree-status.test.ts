// ω99-174 — /worktree 命令层状态与拒因中文化：源接线钉（readFileSync
// 直读源，166/170 系范式）。两组：正钉（worktree.ts 6 面新串，插值/${}
// 结构逐字保留）/ 负钉（旧英文串归零）。负钉落笔前已 grep 注释层+活码
// 层复核：`add failed for`/`cannot inspect`/`(branch `/`  entered: `/
// `pinned at: ` 五串在 worktree.ts 均只命中各自待译活码行（:80/:94/:140/
// :142/:143），注释层零命中；brief 对 `in worktree` 全串的 docstring 相邻
// 预案（:130 附近 "not in a worktree"）经 grep 实测无 `in worktree` 子串
// 命中（"not in a worktree" 中隔 "a"，非连续），故按 brief 采用窄形
// `(branch `，此处披露。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/commands/worktree.ts", import.meta.url), "utf8") as string;

describe("ω99-174 A — worktree.ts 六面中文化（正钉）", () => {
  it("git 拒因两条 + status 块四行为中文（git 命令字面保留）", () => {
    expect(src).toContain("git worktree add 失败：");
    expect(src).toContain("无法读取 worktree 的 git 状态");
    expect(src).toContain("🌳 在 worktree ");
    expect(src).toContain("  路径：${active.path}");
    expect(src).toContain("  进入时间：${active.enteredAt}");
    expect(src).toContain("会话/持久化锚定在：");
    expect(src).toContain("永不迁移");
  });
});

describe("ω99-174 B — worktree.ts 旧英文面归零（负钉）", () => {
  it("add failed for / cannot inspect / (branch 窄形 / entered / pinned at 归零", () => {
    expect(src).not.toContain("add failed for");
    expect(src).not.toContain("cannot inspect");
    expect(src).not.toContain("(branch ");
    expect(src).not.toContain("  entered: ");
    expect(src).not.toContain("pinned at: ");
  });
});
