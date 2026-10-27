// ω99-166a — repl.ts 告警 failed 族 22 面中文化：三条新最小断言的源接线钉。
//
// 与 164/165 镜像：repl.ts 的失败回执写 stdout，无独立 e2e 宿主可钉
// 累积串，沿 ω99-161 #7 / ω99-164 / ω99-165 的源接线钉范式（readFileSync
// 定位 src/repl.ts）钉串值本身。本弧只收 failed 收据族 22 面；散面 17 面
// 与 agent-driver 告警是后续弧，刻意不钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

describe("ω99-166a — repl failed 回执中文化源接线钉", () => {
  it("wiring pin: /loop 失败回执为中文（#1 — 斜杠 token 与 err 三元插值原样）", () => {
    // ω99-166a: #1（repl.ts :2325）failed: → 失败：（全角冒号）。
    expect(replSrc()).toContain("⚠️ /loop 失败：");
  });

  it("wiring pin: /init 写入失败回执为中文（#13 — write → 写入）", () => {
    // ω99-166a: #13（repl.ts :2944）write failed: → 写入失败：。
    expect(replSrc()).toContain("⚠️ /init 写入失败：");
  });

  it("wiring pin: tasks 列表失败回执为中文（#20 — listing → 列表）", () => {
    // ω99-166a: #20（repl.ts :3098）listing failed: → 列表失败：。
    expect(replSrc()).toContain("⚠️ tasks 列表失败：");
  });
});
