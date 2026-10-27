// PB-3 E2E @e2e @slow — 侧栏操作面：归档→展开归档箱→恢复→会话列表弹框
// 全文搜索→回收站式删除→回收站里恢复（完整回路）。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseBrowser, startE2E, waitFor, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainId: "wudao-e2e-main",
    mainEntries: [
      { kind: "user", text: "主会话的问题" },
      { kind: "assistant", text: "主会话的回答" },
    ],
    seeds: [
      {
        id: "wudao-e2e-archive-me",
        firstUser: "会被归档的会话",
        entries: [
          { kind: "user", text: "会被归档的会话" },
          { kind: "assistant", text: "归档前的回答：内容里有可搜索的关键词甲" },
        ],
      },
      {
        id: "wudao-e2e-to-delete",
        firstUser: "将要进回收站的会话",
        entries: [
          { kind: "user", text: "将要进回收站的会话" },
          { kind: "assistant", text: "删除前的回答" },
        ],
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

describe("@e2e @slow 侧栏操作：归档→恢复→搜索→删除→回收站恢复", () => {
  it("归档只是过滤：归档→展开→恢复，行回活跃列表", async () => {
    const { page, driver } = fx as E2EFixture;

    // ① 归档一个非活跃会话：行进归档箱（「已归档 1」折叠组挂出）。
    await page.click('.sb-i:has-text("会被归档的会话") .sb-act');
    await page.expectVisible(".sb-arch", 10_000);
    await page.expectText(".sb-arch", "已归档 1");
    // 活跃列表里它退场（归档是过滤器）。
    expect((await page.texts(".sb-list > .sb-i")).some((t) => t.includes("会被归档的会话"))).toBe(false);

    // ② 展开归档箱 → 行在场（含旧回答预览的时间梯）→ 点「恢复」回活跃列表。
    await page.click(".sb-arch-h");
    await page.expectVisible(".sb-arch-i");
    await page.click('.sb-arch-i:has-text("会被归档的会话")');
    await page.expectGone(".sb-arch", 10_000);
    await page.expectText(".sb-t", "会被归档的会话");
  });

  it("会话列表弹框：全文搜索→删除进回收站→回收站恢复", async () => {
    const { page, driver } = fx as E2EFixture;

    // ① 打开会话列表（侧栏搜索行是同一入口）。
    await page.click(".sb-search");
    await page.expectVisible(".search-pop");

    // ② 全文搜索：命中「关键词甲」的那条会话（搜索面不是列表面）。
    await page.type(".session-q", "关键词甲");
    await page.expectText(".search-item", "会被归档的会话", 10_000);
    expect((await page.texts(".search-item")).every((t) => t.includes("会被归档的会话") || t.includes("没有找到"))).toBe(true);

    // ③ 清空搜索回列表态，删除「将要进回收站的会话」：🗑 → 行内确认 → 删除。
    await page.type(".session-q", "");
    await page.expectText(".search-item", "将要进回收站的会话", 10_000);
    await page.click('.search-item:has-text("将要进回收站的会话") .session-del');
    await page.expectText(".search-item", "删除这个会话？", 5_000);
    await page.click(".session-del-ok");
    await waitFor("sessionDelete 落 fake（进回收站）", () => driver.isTrashed("wudao-e2e-to-delete"), 10_000);
    await page.expectNotText(".search-results", "将要进回收站的会话", 10_000);

    // ④ 回收站路径（读表语义的如实钉：删除 bump 的是 sessionsEpoch——回收站
    //    行集在弹框重开时重取，计数在开着的弹框里滞后一轮是产品的当前行为）：
    //    关框重开 → 回收站 (1) → 进回收站视图 → 被删行在场 → 恢复。
    await page.press(".search-pop", "Escape");
    await page.expectGone(".search-pop", 5_000);
    await page.click(".sb-search");
    await page.expectVisible(".search-pop", 10_000);
    await page.expectText(".session-trash-link", "回收站 (1)", 10_000);
    await page.click(".session-trash-link");
    await page.expectText(".search-item", "将要进回收站的会话", 10_000);
    await page.click(".session-restore");
    // 恢复成功 → 双纪元 bump：视图回主列表、行回列表、计数回 0。
    await page.expectText(".search-item", "将要进回收站的会话", 10_000);
    await page.expectNotText(".session-trash-link", "回收站 (1)", 10_000);

    // ⑤ Esc 关闭弹框，回到会话。
    await page.press(".search-pop", "Escape");
    await page.expectGone(".search-pop", 5_000);
  });
});
