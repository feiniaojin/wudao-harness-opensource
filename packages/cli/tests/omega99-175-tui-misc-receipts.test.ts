// ω99-175 — TUI/引擎杂族回执中文化：源接线钉（readFileSync 直读源，
// 166/169/170 系范式）。两组：tui/app.tsx（brief 面 1/2/3：模式切换暗行、
// 扩展命令缺失、后台在飞列表）+ driver/session-engine.ts（brief 面 4：会话
// 保存失败）。插值/${} 结构逐字保留；modeLabel 枚举字面（accept/ask/auto/
// plan/workspace）为 wire 层，保留。
// 漏判面披露：§五.5 grep 门（4 旧串在两文件=0）迫使第 5 面进场——
// app.tsx:1346 notifyRef(`⚠️ session save failed: …`)（TUI 侧 persistFailed，
// 与面 4 同串同族同插值形状），本测试 A 组同步钉其新串；宿主钉演进
// （tui-ux ×3 / tui-bg ×3 / app.test ×2）随弧落，见 report。
// 负钉落笔前已 grep 注释层复核：app.tsx 无 `mode → ` 注释命中（唯一活码
// =:1719 本弧面），宽形安全；其余三串无注释层命中。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("../src/tui/app.tsx", import.meta.url), "utf8") as string;
// 拆分运动 C 钉随迁：按键处理器/提交路由器外提至 app-keys.ts/app-submit.ts，
// 四钉中三钉随内容迁新家（保逐字钉，宿主改指新路径）。
const keysSrc = readFileSync(new URL("../src/tui/app-keys.ts", import.meta.url), "utf8") as string;
// 拆分运动 C 钉随迁（第二批）：persistFailed 保存失败回执随持久化回调簇迁 app-persist.ts。
const persistSrc = readFileSync(new URL("../src/tui/app-persist.ts", import.meta.url), "utf8") as string;
const submitSrc = readFileSync(new URL("../src/tui/app-submit.ts", import.meta.url), "utf8") as string;
const engineSrc = readFileSync(new URL("../src/driver/session-engine.ts", import.meta.url), "utf8") as string;

describe("ω99-175 A — tui/app.tsx 杂族回执中文化（brief 面 1/2/3 + 漏判面 5）", () => {
  it("模式切换/扩展命令缺失/后台在飞/保存失败为中文（正钉；modeLabel 插值逐字）", () => {
    expect(keysSrc).toContain("模式 → ${modeLabel(next)}");
    expect(submitSrc).toContain("⚠️ 无此扩展命令");
    expect(submitSrc).toContain("⏳ 后台在飞：");
    expect(persistSrc).toContain("⚠️ 会话保存失败：");
  });

  it("旧英文回执归零（负钉；宽形 `mode → ` 注释层已复核无命中）", () => {
    expect(keysSrc).not.toContain("mode → ");
    expect(submitSrc).not.toContain("no extension command");
    expect(submitSrc).not.toContain("bg in flight");
    expect(persistSrc).not.toContain("session save failed");
    expect(appSrc).not.toContain("session save failed");
  });
});

describe("ω99-175 B — driver/session-engine.ts 保存失败回执中文化（brief 面 4）", () => {
  it("保存失败回执为中文（正钉；插值逐字）", () => {
    expect(engineSrc).toContain("⚠️ 会话保存失败：");
  });

  it("旧英文回执归零（负钉）", () => {
    expect(engineSrc).not.toContain("session save failed");
  });
});
