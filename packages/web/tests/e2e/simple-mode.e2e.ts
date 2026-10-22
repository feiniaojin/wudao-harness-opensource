// PB-3 E2E @e2e @slow — 简洁模式：偏好里切到简洁→壳即时切换→发消息→简洁
// 渲染→切回高级模式。同一 fake 会话，三壳（buddy/simple/advanced）一镜到底。
import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import { releaseBrowser, startE2E, waitFor, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainScript: [{ reply: "简洁模式下的回复：好的，办好了", delayMs: 60 }],
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

describe("@e2e @slow 简洁模式：切换→发消息→简洁渲染→切回高级", () => {
  it("偏好切换简洁模式（写面落库+壳即时切换），发消息简洁渲染，再切回高级", async () => {
    const { page, driver } = fx as E2EFixture;

    // ① 设置→偏好→简洁模式：写面落 fake 设置表，收据「已切换到简洁模式」。
    await page.clickDom('.topbar button[aria-label="设置"]');
    await page.expectVisible(".settings-page");
    await page.click('[data-settings-tab="preferences"]');
    await page.expectVisible("#settings-panel-preferences");
    await page.click('button.pick:has-text("简洁模式")');
    await waitFor("ui.defaultMode=simple 落表", () => driver.settings["ui.defaultMode"] === "simple");
    // 关页（设置页在时壳不可见——关页才见简洁壳）。
    await page.click('button:has-text("返回会话")');
    await page.expectGone(".settings-page", 5_000);

    // ② 简洁壳在场：单列 .simple，buddy 双栏与高级三栏都退场。
    await page.expectVisible('.simple[data-mode="simple"]', 10_000);
    await page.expectGone(".buddy", 3_000);
    await page.expectGone(".ide", 3_000);

    // ③ 简洁模式下发消息：同一个输入框车道（textarea.composer-ta）。
    await page.submitComposer("用大白话帮我总结一下");
    await page.expectText(".entry", "简洁模式下的回复：好的，办好了", 15_000);
    await page.expectText(".entry", "用大白话帮我总结一下");

    // ④ 切回高级模式：偏好→高级→关页 → 三栏 IDE 壳回来，史保留。
    await page.clickDom('.topbar button[aria-label="设置"]');
    await page.expectVisible(".settings-page");
    await page.click('[data-settings-tab="preferences"]');
    await page.click('button.pick:has-text("高级模式")');
    await waitFor("ui.defaultMode=advanced 落表", () => driver.settings["ui.defaultMode"] === "advanced");
    await page.click('button:has-text("返回会话")');
    await page.expectVisible(".ide", 10_000);
    await page.expectText(".entry", "简洁模式下的回复：好的，办好了", 5_000);
  });
});
