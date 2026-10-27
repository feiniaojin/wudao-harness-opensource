// ω99-165 — agent-driver 孪生回执中文化：三条新最小断言的源接线钉。
//
// 与 164 镜像：TUI/web 走的 agent-driver.ts 孪生串无独立 e2e 宿主可钉
// stdout 累积串，沿 ω99-161 #7 / ω99-164 的源接线钉范式（readFileSync
// 定位 src/driver/agent-driver.ts）钉串值本身。renderBranchTree 树身
// （@wudao/core 导出）刻意不钉——本弧不触树身。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const driverSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/driver/agent-driver.ts", import.meta.url)), "utf8");

describe("ω99-165 — agent-driver 回执中文化源接线钉", () => {
  it("wiring pin: /tree 常规头为中文（#18 — 树身 renderBranchTree 不在本弧域）", () => {
    // ω99-165: #18 /tree 头（agent-driver.ts :3901）中文化，树身调用原样。
    expect(driverSrc()).toContain("会话树（← = 活跃链；/edit <n> 开分叉，/switch <n> 切换）：");
  });

  it("wiring pin: /switch 裸清单头与行模板为中文（#19/#20）", () => {
    // ω99-165: #20 清单头（agent-driver.ts :3914）中文化。
    expect(driverSrc()).toContain("分支（/switch <n> 切换；* = 当前）：");
    // ω99-165: #19 行模板（agent-driver.ts :3913）的分叉子句中文化。
    expect(driverSrc()).toContain("分叉自 ");
  });

  it("wiring pin: /loop 无调度器通知为中文（#24 — 去术语化）", () => {
    // ω99-165: #24 空面通知（agent-driver.ts :5675）中文化。
    expect(driverSrc()).toContain("无调度器可用——检查 WUDAO_DISABLE_CRON");
  });
});
