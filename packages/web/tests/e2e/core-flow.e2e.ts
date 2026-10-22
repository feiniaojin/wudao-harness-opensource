// PB-3 E2E @e2e @slow — 会话管理全流程：打开→读旧史→新建会话→发消息→
// 收到回复→切到其他会话（车道采纳）→切回→验证历史完整。核心钉 #1。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseBrowser, startE2E, waitFor, type E2EFixture } from "./harness.js";

let fx: E2EFixture | null = null;
beforeEach(async () => {
  fx = await startE2E({
    mode: "buddy",
    mainId: "wudao-e2e-main",
    mainEntries: [
      { kind: "user", text: "主会话的旧问题" },
      { kind: "assistant", text: "主会话的旧回答：一切就绪", reasoning: "先看看现状" },
    ],
    mainScript: [{ reply: "新会话回复：第一件事已完成", reasoning: "想一下", delayMs: 60 }],
    seeds: [
      {
        id: "wudao-e2e-old",
        firstUser: "旧会话的首个任务",
        entries: [
          { kind: "user", text: "旧会话的首个任务" },
          { kind: "assistant", text: "旧会话的旧回答：早就完成了" },
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

describe("@e2e @slow 会话管理：新建→发消息→回复→切会话→切回→历史完整", () => {
  it("全流程（核心钉 #1）", async () => {
    const { page } = fx as E2EFixture;

    // ① 打开即见主会话旧史（auth 重放）。
    await page.expectText(".entry", "主会话的旧回答");
    await page.expectText(".entry", "主会话的旧问题");

    // ② 新建会话：侧栏「新对话」→ /clear 轮转 → 视图切到全新空会话。
    await page.click("button.sb-new");
    await page.expectVisible("textarea.composer-ta");
    // 旧回答退场（视图已切到空会话），旧会话行仍在侧栏（保留可切回）。
    await page.expectNotText(".entry", "主会话的旧回答", 1200);
    await page.expectText(".sb-t", "主会话的旧问题");

    // ③ 新会话发消息 → 收到回复。
    await page.submitComposer("新会话的第一条消息");
    await page.expectText(".entry", "新会话回复：第一件事已完成", 15_000);
    await page.expectText(".entry", "新会话的第一条消息");

    // ④ 切到其他会话（车道采纳：resume 带 sid，重放旧会话史）。
    await page.click('.sb-i:has-text("旧会话的首个任务")');
    await page.expectText(".entry", "旧会话的旧回答：早就完成了", 15_000);
    // 分键渲染：新会话的内容不在旧会话视图里。
    await page.expectNotText(".entry", "新会话回复：第一件事已完成", 800);

    // ⑤ 切回新会话 → 历史完整（用户消息与回复都在）。
    await page.click('.sb-i:has-text("新会话的第一条消息")');
    await page.expectText(".entry", "新会话的第一条消息", 15_000);
    await page.expectText(".entry", "新会话回复：第一件事已完成");
    expect((await page.texts(".entry")).some((t) => t.includes("旧会话的旧回答"))).toBe(false);
  });

  it("等待回复期间的 busy 态可见且落定后退场", async () => {
    const { page, driver } = fx as E2EFixture;
    const beforeRotate = driver.mainSessionId;
    await page.click("button.sb-new");
    // 等轮转真的发生（Node 侧观察 fake 状态，避免 seed 撞上旧会话）。
    await waitFor("主车道会话轮转", () => driver.mainSessionId !== beforeRotate);
    const fresh = driver.mainSessionId;
    // hold 回合：busy 停住直到 finishTurn，期间当前会话行挂「运行中」徽标。
    driver.seed({ id: fresh, script: [{ hold: true, reply: "迟到的回复", delayMs: 40 }] });
    await page.submitComposer("一个长任务");
    await page.expectVisible(".sb-run", 10_000);
    driver.finishTurn(fresh);
    await page.expectText(".entry", "迟到的回复", 15_000);
    await page.expectGone(".sb-run", 10_000);
  });
});
