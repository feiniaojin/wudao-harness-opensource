// @vitest-environment jsdom
// ω99-247: #7 — 回望面板 observe 例 receipts（219 面板名集演进的钉：新读面
// screen.observe 进聚合集与动作短语——driver 零改动，靠名集+summarize 单源
// 自动入面板，220 panel-evolution 同范式）。夹具全内存 jsdom——零文件系统、
// 零键鼠、零截屏、零真 AX（212 既立红线：本面根本不触执行层）。播种的 tool
// 条目与 driver 落的形状同构（summary 即 log.ts summarizeToolCall 的 observe
// 例输出）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComputerActionsPanel } from "../src/components/ComputerActionsPanel.js";
import { aggregateComputerActions } from "../src/components/ComputerActionsPanel.js";
import type { HistoryEntry } from "../src/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
});

const tool = (name: string, summary: string): HistoryEntry =>
  ({ kind: "tool", name, summary, isError: false, resultPreview: "", durationMs: undefined }) as unknown as HistoryEntry;

describe("ω99-247 — 回望面板 observe 例（219 名集演进）", () => {
  it("聚合计入：screen.observe 条目进 totalSteps 与动作行（名集=面板唯一演进缝）", () => {
    const agg = aggregateComputerActions([
      { kind: "user", text: "帮我整理" } as HistoryEntry,
      tool("screen.observe", "Safari"),
      tool("computer.click", "(640, 400)"),
      tool("screen.observe", "前台窗口"),
    ]);
    expect(agg.totalSteps).toBe(3); // observe 两计 + click 一计
    expect(agg.runs).toHaveLength(1);
    expect(agg.runs[0]!.actions.map((a) => a.name)).toEqual(["screen.observe", "computer.click", "screen.observe"]);
  });

  it("连续同 (name, summary) 的 observe 折叠计数（同词重复是噪音）", () => {
    const agg = aggregateComputerActions([
      tool("screen.observe", "Safari"),
      tool("screen.observe", "Safari"),
      tool("screen.observe", "前台窗口"), // 对象不同 → 不折叠
    ]);
    expect(agg.runs[0]!.actions.map((a) => [a.name, a.count])).toEqual([
      ["screen.observe", 2],
      ["screen.observe", 1],
    ]);
  });

  it("动作行短语：观察了 + 对象（应用名 / 前台窗口）——用户词，零实现术语", () => {
    const agg = aggregateComputerActions([tool("screen.observe", "Safari"), tool("screen.observe", "前台窗口")]);
    const container = mount(<ComputerActionsPanel agg={agg} onClose={() => {}} />);
    const rows = Array.from(container.querySelectorAll(".cap-act")).map((r) => r.textContent);
    expect(rows).toEqual(["观察了Safari", "观察了前台窗口"]);
  });
});
