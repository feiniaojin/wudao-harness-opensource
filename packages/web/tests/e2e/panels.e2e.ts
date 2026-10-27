// PB-3 E2E @e2e @slow — 文件面板（高级模式）：文件树浏览→目录展开→文件
// 查看（fileRead 渲染）→关闭；改动面板：改动 chip→面板打开→文件行→关闭。
import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import { releaseBrowser, startE2E, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "advanced",
    mainId: "wudao-e2e-main",
    mainEntries: [
      { kind: "user", text: "改一个文件" },
      {
        kind: "assistant",
        text: "改好了 README.md",
      },
      {
        kind: "notice",
        text: "本回合改了 1 个文件",
        changes: [{ path: "README.md", op: "modified", writes: 1, plus: 3, minus: 1 }],
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

describe("@e2e @slow 文件面板：文件树→文件查看→改动面板", () => {
  it("文件树浏览 + 文件查看 + 关闭", async () => {
    const { page } = fx as E2EFixture;

    // ① 高级模式左栏是文件树（boot 即拉根目录一层）。
    await page.expectVisible(".filetree", 15_000);
    await page.expectText(".ft-row .name", "README.md");
    await page.expectText(".ft-row .name", "src");

    // ② 展开目录：点 src → 子文件出现（目录点击同时开目录 tab——产品的
    //    既有行为，tab 条可见 [src]）。
    await page.click('.ft-row:has-text("src")');
    await page.expectText(".ft-row .name", "index.ts", 10_000);
    await page.expectText(".ft-row .name", "util.ts", 10_000);
    await page.expectText(".tab", "src");

    // ③ 文件查看：点 src/index.ts → 中栏 viewer 读 fileRead 渲染内容。
    await page.click('.ft-row:has-text("index.ts")');
    await page.expectVisible(".fv-file", 10_000);
    await page.expectText(".fv-file", "src/index.ts");
    await page.expectText(".ide-cell.ide-center", "wudao e2e", 10_000);

    // ④ 关闭 viewer：文件 tab 退场（目录 tab 接棒），再把目录 tab 也关掉
    //    → 中栏回空态（+占位）。
    await page.click(".fv-close");
    await page.expectNotText(".fv-file", "src/index.ts", 5_000);
    await page.expectText(".tab", "src");
    await page.clickDom(".tab .tclose"); // tab 的 × 是 hover 显形钮，DOM 点击直达
    await page.expectVisible(".tab-empty", 5_000);
  });

  it("改动面板：chip 带计数→面板打开→文件行在场→关闭", async () => {
    const { page } = fx as E2EFixture;

    // ① 历史里带 changes 收据 → 顶栏挂「改动 1 文件」chip。
    await page.expectVisible('button.tb-changes', 15_000);
    await page.expectText("button.tb-changes", "改动 1 文件");

    // ② 打开面板：会话改动对话框 + 文件行（README.md · 修改）。
    await page.clickDom('button.tb-changes');
    await page.expectVisible(".changes-panel", 10_000);
    await page.expectText(".chg-file", "README.md", 10_000);
    await page.expectText(".chg-badge", "修改");

    // ③ 关闭回会话。
    await page.click('.changes-panel button:has-text("关闭")');
    await page.expectGone(".changes-panel", 5_000);
  });
});
