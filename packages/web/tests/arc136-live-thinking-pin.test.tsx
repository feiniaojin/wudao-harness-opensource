// @vitest-environment jsdom
// 136 — 直播思考块在整轮内保持可见（2026-11-02 用户报障：思考过程看不到
// 流式输出，思考和结果一股脑出现）。钉：正文开始（thinking=false）后直播
// 思考块不自动收起；用户手动收起仍优先（ReasoningBlock 自身契约不动）。
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "./css-test-utils.js";
import { LiveArea } from "../src/components/LiveArea.js";

afterEach(() => { unmount(); });

describe("136 — LiveArea 直播思考块", () => {
  it("正文开始后（thinking=false）仍展开：思考块不因正文出现而自动收起", () => {
    const c = mount(
      <LiveArea live={{ reasoning: "先想清楚再答", thinking: false, answer: "答", busyTools: [] }} queued={[]} />,
    );
    const d = c.querySelector(".live-area details.reasoning, details.reasoning") as HTMLDetailsElement | null;
    expect(d).not.toBeNull();
    expect(d!.open).toBe(true);
    expect(d!.querySelector(".body")?.textContent).toBe("先想清楚再答");
  });

  it("只有思考、尚无正文时同样展开（流式中）", () => {
    const c = mount(
      <LiveArea live={{ reasoning: "思考中……", thinking: true, answer: "", busyTools: [] }} queued={[]} />,
    );
    const d = c.querySelector("details.reasoning") as HTMLDetailsElement | null;
    expect(d!.open).toBe(true);
  });
});
