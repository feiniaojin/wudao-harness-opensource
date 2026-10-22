// PB-3 E2E @e2e @slow — 设置页：打开→切 tab→改语言偏好→关闭→重开→持久化
// 在（写面 settingsSet 落 fake 的设置表，读面 settingsStatus 回读）。核心钉 #2。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseBrowser, startE2E, waitFor, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({ mode: "buddy" });
  await fx.page.expectAppReady();
});
afterEach(async () => {
  await fx?.dispose();
  fx = null;
});
afterAll(async () => {
  await releaseBrowser();
});

const openSettings = async (p: E2EFixture["page"]): Promise<void> => {
  await p.clickDom('.topbar button[aria-label="设置"]');
  await p.expectVisible(".settings-page");
};
const closeSettings = async (p: E2EFixture["page"]): Promise<void> => {
  await p.click('button:has-text("返回会话")');
  await p.expectGone(".settings-page");
};

describe("@e2e @slow 设置页：tab 切换 + 语言偏好持久化", () => {
  it("打开→切 tab→改语言→关闭→重开→持久化在（核心钉 #2）", async () => {
    const { page, driver } = fx as E2EFixture;

    await openSettings(page);
    // 默认落「供应商」tab；走一圈 tab（权限→偏好），每个 tabpanel 挂载。
    await page.click('[data-settings-tab="permissions"]');
    await page.expectVisible("#settings-panel-permissions");
    await page.click('[data-settings-tab="preferences"]');
    await page.expectVisible("#settings-panel-preferences");

    // 语言 chip：菜单开→「回答 · 中文」→ settingsSet(language.reply, on) 落库。
    // （chip 的标签读 App 的 gateStatus——关设置页时才重取，所以「立即变中文」
    //  的断言放在重开之后；此刻钉写面真实落库。）
    await page.click(".chip.lang");
    await page.expectVisible(".lang-menu");
    // 菜单浮层与顶栏拖拽区重叠（Chromium 里 app-region:drag 吞指针命中，
    // WKWebView 才是产品形态）——菜单行走 DOM 点击。
    await page.clickDom('.lang-menu [data-knob="reply"][data-mode="on"]');
    await waitFor(
      "语言偏好落 fake 设置表",
      () => driver.settings["language.reply"] === "on",
    );

    await closeSettings(page);
    // 重开：关页时 App 重取 gateStatus，重开后语言段回读持久值——chip 标签
    // 从「语言」变「中文」，持久化在。
    await openSettings(page);
    await page.click('[data-settings-tab="preferences"]');
    await page.expectVisible("#settings-panel-preferences");
    await page.expectText(".chip.lang", "中文");
    await closeSettings(page);
  });

  it("设置写面的服务端持久化（settingsSet 的 key/value 原样落表）", async () => {
    const { page, driver } = fx as E2EFixture;
    await openSettings(page);
    await page.click('[data-settings-tab="preferences"]');
    // 切默认界面到「高级模式」—— ui.defaultMode 的另一条写车道。
    await page.click('button.pick:has-text("高级模式")');
    await waitFor("ui.defaultMode 落表", () => driver.settings["ui.defaultMode"] === "advanced");
    await closeSettings(page);
  });
});
