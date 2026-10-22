// PB-3 E2E @e2e @slow — 断点续跑/失败重试横幅退役（09-17 用户令「鸡肋且
// 易误触，全部让用户自己决定」）：已完成任务的会话→切走→切回→横幅绝不
// 复现，看到的就是会话本身的实时状态。核心钉 #5。
import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import { releaseBrowser, startE2E, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainId: "wudao-e2e-main",
    mainEntries: [
      { kind: "user", text: "主会话的日常问题" },
      { kind: "assistant", text: "主会话的日常回答：任务已完成" },
    ],
    mainScript: [{ reply: "又完成了一件事", delayMs: 40 }],
    seeds: [
      {
        id: "wudao-e2e-done",
        firstUser: "已完成任务的老会话",
        entries: [
          { kind: "user", text: "已完成任务的老会话" },
          { kind: "assistant", text: "这个任务早就跑完了" },
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

describe("@e2e @slow 断点续跑横幅退役：已完成会话切回不弹横幅（核心钉 #5）", () => {
  it("切到已完成任务的会话：横幅不出现，看到的就是该会话的史", async () => {
    const { page } = fx as E2EFixture;

    // ① 切到「已完成任务」的会话（车道采纳路径，正是旧横幅的触发场景）。
    await page.click('.sb-i:has-text("已完成任务的老会话")');
    await page.expectText(".entry", "这个任务早就跑完了", 15_000);

    // ② 退役横幅的字样绝不复现（「继续跑上次没完成的任务」/「重试上次失败
    //    的任务」都已退役；给一个稳定窗口确认不是渲染竞态）。
    await page.expectNotText("body", "继续跑上次没完成的任务", 1_500);
    await page.expectNotText("body", "重试上次失败的任务", 800);
    await page.expectNotText("body", "上次有任务没跑成", 800);

    // ③ 切回主会话（同样已完成过任务）→ 同样零横幅，史完整。
    await page.click('.sb-i:has-text("主会话的日常问题")');
    await page.expectText(".entry", "主会话的日常回答：任务已完成", 15_000);
    await page.expectNotText("body", "继续跑上次没完成的任务", 1_200);

    // ④ 该会话真要继续，用户发消息即可（横幅的职能由正常输入承接）。
    await page.submitComposer("接着刚才继续");
    await page.expectText(".entry", "又完成了一件事", 15_000);
  });
});
