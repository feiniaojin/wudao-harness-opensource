// PB-3 E2E @e2e @slow — 断连重连：杀 server→重连横幅出现→同 port 重启→
// 横幅消失→历史重放→可继续发消息。核心钉 #4。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseBrowser, startE2E, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainScript: [{ reply: "断连前的回复", delayMs: 40 }, { reply: "重连后的回复：恢复正常", delayMs: 40 }],
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

describe("@e2e @slow 断连重连：server 死→横幅→server 回→横幅退场→可发消息", () => {
  it("杀 server → 重连横幅 → 重启 → 横幅消失 → 发消息可用（核心钉 #4）", async () => {
    const { page, driver } = fx as E2EFixture;

    // ① 正常发一条，收到回复（基线）。
    await page.submitComposer("断连前的问题");
    await page.expectText(".entry", "断连前的回复", 15_000);

    // ② 杀 server：WS 异常断开 → 「连接断开 — 正在重连」横幅立即在场。
    await page.expectGone(".banner.quiet", 1_000).catch(() => {});
    const kill = fx as E2EFixture;
    await kill.server.close();
    await page.expectVisible(".banner.quiet", 10_000);
    await page.expectText(".banner.quiet", "连接断开");

    // ③ 同 port 重启（fake 状态全程存活）：重连梯子（1s 起退避）接上，
    //    横幅退场，历史整段重放（断连前的问答都还在）。
    await kill.restartServer();
    await page.expectGone(".banner.quiet", 30_000);
    await page.expectText(".entry", "断连前的回复", 10_000);
    await page.expectText(".entry", "断连前的问题", 10_000);

    // ④ 恢复正常：继续发消息 → 收到回复。
    await page.submitComposer("重连后的问题");
    await page.expectText(".entry", "重连后的回复：恢复正常", 15_000);
    expect(driver.mainHistory().length).toBeGreaterThanOrEqual(4);
  });

  it("断连期间视图保留（重连态不清空会话转录）", async () => {
    const { page } = fx as E2EFixture;
    await page.submitComposer("留在页面上的问题");
    await page.expectText(".entry", "断连前的回复", 15_000);
    const holder = fx as E2EFixture;
    await holder.server.close();
    await page.expectVisible(".banner.quiet", 10_000);
    // 重连态（非 connecting）下 App 照常渲染：转录不退场。
    await page.expectText(".entry", "留在页面上的问题", 2_000);
    await holder.restartServer();
    await page.expectGone(".banner.quiet", 30_000);
  });
});
