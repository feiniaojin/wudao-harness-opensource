// PB-3 E2E @e2e @slow — 多车道并发：A 会话发任务（busy）→点侧栏开 B 车道→
// B 可交互→A 侧栏挂 ◐「运行中」徽标→A 落定后徽标退场。核心钉 #3。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseBrowser, startE2E, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainId: "wudao-e2e-main",
    mainEntries: [
      { kind: "user", text: "主会话 A 的开场" },
      { kind: "assistant", text: "主会话 A 就绪" },
    ],
    mainScript: [{ hold: true, reply: "A 的长任务完成了", delayMs: 40 }],
    seeds: [
      {
        id: "wudao-e2e-side-b",
        firstUser: "副会话 B 的首个任务",
        entries: [
          { kind: "user", text: "副会话 B 的首个任务" },
          { kind: "assistant", text: "副会话 B 的旧回答" },
        ],
        script: [{ reply: "B 的独立回复：没问题", delayMs: 60 }],
      },
    ],
  });
  await fx.page.expectAppReady();
});
afterEach(async () => {
  await fx?.dispose();
  fx = null;
});
afterAll(async () => {
  await releaseBrowser();
});

describe("@e2e @slow 多车道并发：A busy→开 B 车道→B 可交互→A ◐ 徽标", () => {
  it("主车道忙时不阻塞切换，副车道独立交互，A 侧栏挂运行中徽标（核心钉 #3）", async () => {
    const { page, driver } = fx as E2EFixture;
    const mainId = driver.mainSessionId;

    // ① A 发长任务（hold）：busy 停住，A 的侧栏行挂「运行中」。
    await page.submitComposer("A 的长任务：重构整个项目");
    await page.expectVisible(".sb-run", 10_000);
    expect((await page.texts('.sb-i:has-text("主会话 A 的开场") .sb-run')).length).toBeGreaterThan(0);

    // ② 主车道忙时点侧栏开 B 车道：不再被旧 busy 门拦（无拒绝回执），
    //    resume 带 sid → 车道采纳 → B 的旧史接管视图。
    await page.click('.sb-i:has-text("副会话 B 的首个任务")');
    await page.expectText(".entry", "副会话 B 的旧回答", 15_000);
    expect((await page.texts("body")).join("")).not.toContain("运行中无法 切换会话");

    // A 的徽标仍在（主车道还在跑），且分键渲染：A 的内容不在 B 视图。
    expect((await page.count(".sb-run"))).toBeGreaterThanOrEqual(1);
    expect((await page.texts(".entry")).some((t) => t.includes("A 的长任务：重构整个项目"))).toBe(false);

    // ③ B 车道可交互：在 B 里发消息 → B 的车道独立回复。
    await page.submitComposer("B 的问题：帮我看一眼");
    await page.expectText(".entry", "B 的独立回复：没问题", 15_000);

    // ④ A 落定：busy 退场 → A 行的 ◐ 徽标消失；A 的回复落在 A 的车道史里。
    driver.finishTurn(mainId);
    await page.expectGone(".sb-run", 15_000);
    expect(driver.historyOf(mainId).some((e) => e.kind === "assistant" && e.text.includes("A 的长任务完成了"))).toBe(true);

    // ⑤ 切回 A：历史完整（开场 + 长任务的问与答都在）。
    await page.click('.sb-i:has-text("主会话 A 的开场")');
    await page.expectText(".entry", "A 的长任务完成了", 15_000);
    await page.expectText(".entry", "主会话 A 就绪");
  });
});
