// ω99-166f-iii — 杂族回执中文化：源接线钉（agent-driver.ts 20 面 + repl.ts 2 面）。
//
// 路径范式沿 omega99-166fii-switch-receipts.test.ts（readFileSync 定位 src 文件，
// 钉串值本身）。负钉落笔前已对两份源 grep 注释层复核：全部裸负钉在两文件中
// 仅命中面行本身（compact deferred 命中 #7/#8 两面行，均在本弧翻译）；repl.ts
// :860 注释的 "carries them" 不匹配 `carries it` 裸负钉——无需换窄子串（见弧
// 报告）。工具名/skill 名/reason·confidence 等机器插值原样；`effort → x` 路由
// 记号不译；切换通知前缀现行政策：统一中文「模型 → 」——ω99-195: 头注随源演进
// （166fiii 记号裁定 supersede；值侧 ${provider}/${model} 插值原样）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("ω99-166f-iii — 杂族回执中文化源接线钉", () => {
  it("wiring pin: agent-driver.ts 杂族回执为中文（正钉）", () => {
    const s = srcOf("driver/agent-driver.ts");
    expect(s).toContain("工具已加载："); // #1 工具加载回执
    expect(s).toContain("技能钩子已挂载"); // #2
    expect(s).toContain("技能钩子已卸载"); // #3
    expect(s).toContain("缓存可能已冷"); // #4
    expect(s).toContain("提示词被钩子拦截"); // #6
    expect(s).toContain("压缩已推迟"); // #7/#8 孪生
    expect(s).toContain("扩展重扫已在运行收束时落地"); // #9
    expect(s).toContain("已导出会话"); // #13
    expect(s).toContain("导出已取消"); // #15
    expect(s).toContain("扩展面已在新根目录重扫"); // #16
    expect(s).toContain("被 configChange 钩子拦截"); // #17
    expect(s).toContain("configChange 钩子放行"); // #18
    expect(s).toContain("待唤醒任务"); // #19
    expect(s).toContain("↪ 已恢复"); // #20
    expect(s).toContain("在隔离 fork 中运行"); // #12
    expect(s).toContain("技能 fork"); // #10/#11（及 #12 source 字段）
  });

  it("wiring pin: agent-driver.ts 旧英文杂族回执归零（负钉）", () => {
    const s = srcOf("driver/agent-driver.ts");
    expect(s).not.toContain("tools loaded: "); // #1
    expect(s).not.toContain("skill hooks armed"); // #2
    expect(s).not.toContain("cache may be cold"); // #4
    expect(s).not.toContain("prompt blocked by hook"); // #6
    expect(s).not.toContain("compact deferred"); // #7/#8
    expect(s).not.toContain("extension rescan landed"); // #9
    expect(s).not.toContain("exported session"); // #13
    expect(s).not.toContain("export cancelled"); // #15
    expect(s).not.toContain("resumed ${"); // #20（模板形；divider 串在 tui/resume.ts 域外）
    expect(s).not.toContain("isolated fork; its result"); // #12
  });

  it("wiring pin: repl.ts /model /effort 回执为中文（正钉）", () => {
    const s = srcOf("repl.ts");
    expect(s).toContain("—— 下一个请求即生效（/status 显示新标签）"); // #21（前缀已随 ω99-195 改译「模型 → 」；尾串断言零演进）
    expect(s).toContain("effort → ${v.level} —— 下一个请求即生效"); // #22（记号原样；结尾 \n\n 保留）
  });

  it("wiring pin: repl.ts 旧英文切换尾段归零（负钉，裸负钉经 :860 复核安全）", () => {
    const s = srcOf("repl.ts");
    expect(s).not.toContain("— the next request carries it"); // #21/#22（:860 注释为 carries them，不匹配）
  });
});
