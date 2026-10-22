// ω99-166d-i — usage 回执族中文化的 4 接线钉（readFileSync 源面断言，红→绿
// 先行留档）：①schedules 7 面换头且旧头绝迹；②app.tsx /edit 孪生面；③index
// 的 perms-lint 走守卫泳道且头已换（源字面含 \n 转义，按实披露）；④缝 A/B
// 拆除后 repl 与 agent-driver 都不再包 `用法：${parsed.error}` 双头。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ω99-166d-i — usage 回执族 38 面 + 双头缝", () => {
  it("schedules.ts：/schedule usage 7 面全部换 用法： 头，旧 usage: 头绝迹", () => {
    const s = src("../src/schedules-command.ts"); // 拆分B：/schedule 用法面随命令族迁居
    expect(s).toContain("用法：/schedule rm <id>");
    expect(s).not.toContain("usage: /schedule");
  });

  it("tui/app.tsx：/edit 越界面与 repl:3146 孪生（—— 连排款）", () => {
    // 拆分运动 C 钉随迁：提交路由器外提至 app-submit.ts。
    const s = src("../src/tui/app-submit.ts");
    expect(s).toContain("用法：/edit <n>——没有第");
  });

  it("index.ts：perms-lint usage 提示仍走 stdoutGuard 泳道且头已换（源字面含 \\n）", () => {
    const s = src("../src/commands/perms.ts"); // v7 弧α 顺带拆分：perms 用法面随命令迁居
    expect(s).toContain('writeRawStdout("用法：wudao perms lint\\n")');
  });

  it("缝 A/B：repl 与 agent-driver 均不再包 `用法：${parsed.error}` 双头", () => {
    expect(src("../src/repl.ts")).not.toContain("`用法：${parsed.error}`");
    expect(src("../src/driver/agent-driver.ts")).not.toContain("`用法：${parsed.error}`");
  });
});
