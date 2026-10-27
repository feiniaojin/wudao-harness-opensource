// ω99-164 — REPL 命令回执与清单中文化：两条新最小断言的源接线钉。
//
// #1 启动横幅与 #4 tasks 回执均无真 REPL e2e 宿主（唯一跑 startRepl 的
// o99-35-headless-multiline harness 不暴露 stdout 累积串，加暴露=改测试
// 基建，违反零逻辑改动军规），沿 ω99-161 #7 的源接线钉范式
// （tests/repl-sigint-exit.test.ts 的 wiring pin 用例）钉串值本身。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

describe("ω99-164 — REPL 回执中文化源接线钉", () => {
  it("wiring pin: 启动横幅为中文（#1 — 渲染路径无 e2e 宿主，钉串值本身）", () => {
    // ω99-164: #1 REPL 启动横幅（repl.ts :1482）中文化。
    expect(replSrc()).toContain("交互模式 — /help 查看命令 · /exit 退出");
  });

  it("wiring pin: /tasks 无注册表回执为中文（#4）", () => {
    // ω99-164: #4 tasks 回执（repl.ts :3090）中文化。
    expect(replSrc()).toContain("tasks: 后台 agent 注册表不可用");
  });
});
