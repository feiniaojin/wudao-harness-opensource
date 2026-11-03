// 136 — 终端面历史条目要渲染分段思考（2026-11-02：分段思考进转录后，
// TUI 的 HistoryItem 此前完全不读 entry.reasoning，思考在终端里仍然消失）。
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { HistoryItem } from "../src/tui/app-panels.js";

describe("136 — TUI 历史思考行", () => {
  it("assistant 条目带 reasoning 时渲染 dim 思考行（多行折叠为末行）", () => {
    const r = render(
      <HistoryItem entry={{ kind: "assistant", text: "答", reasoning: "第一步\n第二步：读文件" }} />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("第二步：读文件");
    expect(frame).not.toContain("第一步");
    expect(frame).toContain("答");
    r.unmount();
  });

  it("无 reasoning 的 assistant 条目字节不变（零噪音）", () => {
    const r = render(<HistoryItem entry={{ kind: "assistant", text: "答" }} />);
    expect(r.lastFrame()).toContain("答");
    r.unmount();
  });
});
