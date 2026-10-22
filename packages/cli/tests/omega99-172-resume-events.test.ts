// ω99-172 — resume/事件臂中文化：源接线钉（8 面 = app.tsx×1 + index.ts×3 +
// tui/resume.ts divider×1 + run.ts×2 + repl.ts×1）。
//
// 范式同 omega99-166fiii-misc-receipts.test.ts（readFileSync 定位 src 文件，钉串值
// 本身）。负钉落笔前已对 5 份源 grep 注释层复核：全部裸负钉仅命中面行本身，无
// 注释层命中，无需换窄子串（见弧报告 §复核）。wire 判断串（resume.ts
// isMarkerUserMessage 的 `[todo board` 前缀族）与 helper 名
// （formatOneShotResumeLine/formatResumeLine）不在钉域。names/reason/label 等
// 机器插值原样；`· 上次模型：`/`（推理档 …）`的 `·` 分隔与全角括号按面表逐字。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("ω99-172 — resume/事件臂中文化源接线钉", () => {
  it("wiring pin: app.tsx / index.ts 事件打印臂为中文、旧英文归零（正+负）", () => {
    const app = srcOf("tui/app.tsx");
    const idx = srcOf("index.ts");
    // 拆分运动 C 钉随迁：onDeferLoaded 随持久化回调簇迁 app-persist.ts。
    expect(srcOf("tui/app-persist.ts")).toContain("工具已加载："); // #1（f-iii #1-孪生，与 repl:1904 同源）
    expect(idx).toContain("工具已加载："); // #2
    expect(idx).toContain("压缩已推迟："); // #3（f-iii #7-孪生）
    expect(idx).toContain("提示词被钩子拦截："); // #4（f-iii #6-孪生）
    expect(app).not.toContain("tools loaded: "); // #1 旧串归零
    expect(idx).not.toContain("tools loaded: "); // #2
    expect(idx).not.toContain("compact deferred"); // #3
    expect(idx).not.toContain("prompt blocked by hook"); // #4
  });

  it("wiring pin: resume.ts / run.ts / repl.ts 恢复回执为中文、旧英文归零（正+负）", () => {
    const resume = srcOf("tui/resume.ts");
    const run = srcOf("run.ts");
    const repl = srcOf("repl-commands.ts"); // ω99 拆分运动：恢复回执随纯函数族迁居（repl.ts 门面 re-export）
    expect(resume).toContain("已恢复 ${"); // #5
    expect(run).toContain("已恢复 ${"); // #6/#7
    expect(repl).toContain("已恢复 ${"); // #8
    expect(resume).toContain("条消息");
    expect(run).toContain("条消息");
    expect(repl).toContain("条消息");
    expect(run).not.toContain("· last model: "); // #6 旧串归零
    expect(repl).not.toContain("; last: "); // #8
    expect(resume).not.toContain("· last model: ");
    expect(resume).not.toContain("; last: ");
  });

  it("wiring pin: resume.ts divider 为中文码元形、旧 divider 归零（正+负）", () => {
    const resume = srcOf("tui/resume.ts");
    expect(resume).toContain("`已恢复 ${sessionId.slice(0, 8)} · ${messages.length} 条消息`"); // #5 码元形
    expect(resume).not.toContain("· ${messages.length} messages"); // 旧 divider 归零
  });
});
