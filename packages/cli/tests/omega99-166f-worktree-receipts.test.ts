// ω99-166f-i — worktree 操作回执族中文化：四条最小断言的源接线钉。
//
// 🌳 entered/exited worktree 回执（agent-driver.ts 9 面：轮界 enter/exit×2、
// 在飞排队 enter、直落 enter、exit keep 排队×2、exit keep/remove/remove-失败
// 落地）无独立 e2e 宿主可钉累积串（worktree-driver.test.ts 的 untilNotice
// 子串钉已随源演进），沿 ω99-166b/c/d/e 的源接线钉范式（readFileSync 定位
// src 文件）钉串值本身。
// 域界：worktree.ts 命令层 `entered: <ts>` 状态行与 <workspace_changed>
// 信封、其余 30+ 英文 notice（model/provider/persona/skill/cache 族）=
// 后续 166f-ii/iii 弧，本弧禁触 —— 故对 agent-driver.ts 只按本族串正负钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

describe("ω99-166f-i — worktree 操作回执族中文化源接线钉", () => {
  it("wiring pin: 🌳 已进入/已退出 worktree 回执为中文（#1-#7 正向钉）", () => {
    // ω99-166f-i: #1/#4（:3569/:4256）entered worktree …（branch …）→ 已进入 worktree …（分支 …）
    // ω99-166f-i: #2/#7（:3576/:4318）exited worktree …（keep）→ 已退出 worktree …（keep）
    // （尾随空格钉 —— 紧跟 ${name} 插值，源码字面即含。）
    expect(driverSrc()).toContain("已进入 worktree ");
    expect(driverSrc()).toContain("已退出 worktree ");
  });

  it("wiring pin: 英文 entered/exited worktree 回执在源中归零（负钉）", () => {
    expect(driverSrc()).not.toContain("entered worktree");
    expect(driverSrc()).not.toContain("exited worktree");
  });

  it("wiring pin: 🌳 /worktree exit keep 已排队回执为中文（#5/#6 两臂同前缀）", () => {
    // ω99-166f-i: #5（:4284）queued — a run is in flight → 已排队——有运行在飞
    // ω99-166f-i: #6（:4300）queued — a run just started → 已排队——运行刚起步
    expect(driverSrc()).toContain("/worktree exit keep 已排队");
  });

  it("wiring pin: remove 失败臂回执为中文（#9 前缀钉）", () => {
    // ω99-166f-i: #9（:4333）but removal FAILED → 但删除失败 / the tree remains at → 树仍保留在
    expect(driverSrc()).toContain("但删除失败");
    expect(driverSrc()).toContain("树仍保留在 ");
  });
});
