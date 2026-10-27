// @vitest-environment jsdom
// 133 #9（deepagents 8ea734a80 引进）— 长史 resume 渲染水合收据：尾窗起步
// 只挂 60 单元、哨兵可见/点击补水、补到全量哨兵卸载、替换收缩复位、流中
// 追加恒显最新、分组行=水合单元（一组折叠工具算一行）、简洁面同款。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryList } from "../src/components/HistoryList.js";
import { SimpleHistoryList } from "../src/components/SimpleMode.js";
import { HISTORY_TAIL_WINDOW, HISTORY_HYDRATE_CHUNK } from "../src/use-history-hydration.js";
import type { HistoryEntry } from "../src/protocol.js";
import { resetMarkdownCache } from "../src/markdown.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The fake IO: records instances; tests fire intersection manually. */
type IOCallback = (entries: { isIntersecting: boolean }[]) => void;
const ioInstances: { callback: IOCallback; disconnected: boolean }[] = [];
class FakeIntersectionObserver {
  constructor(callback: IOCallback) {
    ioInstances.push({ callback, disconnected: false });
  }
  observe(): void {}
  disconnect(): void {
    const last = ioInstances[ioInstances.length - 1];
    if (last !== undefined) last.disconnected = true;
  }
}
const fireVisible = (): void => {
  const live = [...ioInstances].reverse().find((i) => !i.disconnected);
  if (live !== undefined) act(() => live.callback([{ isIntersecting: true }]));
};

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
const rerender = (el: React.ReactElement): void => {
  act(() => {
    root?.render(el);
  });
};

beforeEach(() => {
  resetMarkdownCache();
  ioInstances.length = 0;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const user = (text: string): HistoryEntry => ({ kind: "user", text });
const entries = (n: number): HistoryEntry[] => Array.from({ length: n }, (_, i) => user(`msg ${i + 1}`));
const rows = (c: HTMLElement): number => c.querySelectorAll(".entry").length;
const sentinel = (c: HTMLElement): HTMLElement | null => c.querySelector(".history-hydrate-sentinel");

describe("133 #9 — HistoryList 尾窗水合", () => {
  it("300 条长史 → 只挂尾窗 60 行，哨兵报剩余数", () => {
    const c = mount(<HistoryList history={entries(300)} />);
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW);
    expect(sentinel(c)?.textContent).toContain("240");
    // 最新可见、最旧不挂
    expect(c.textContent).toContain("msg 300");
    expect(c.textContent).not.toContain("msg 1");
  });

  it("哨兵进入视口（IO）→ 补一个 CHUNK；连续触发补到全量、哨兵卸载", () => {
    const c = mount(<HistoryList history={entries(300)} />);
    fireVisible();
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW + HISTORY_HYDRATE_CHUNK);
    expect(sentinel(c)?.textContent).toContain("180");
    fireVisible();
    fireVisible();
    fireVisible();
    expect(rows(c)).toBe(300);
    expect(sentinel(c)).toBeNull();
    expect(c.textContent).toContain("msg 1"); // 最旧此刻可见
  });

  it("点击哨兵 = 同一补水动作（无 IO 引擎的兜底）", () => {
    // 拆掉 IO 再挂——组件必须降级不炸，点击仍补水
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const c = mount(<HistoryList history={entries(200)} />);
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW);
    act(() => {
      sentinel(c)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW + HISTORY_HYDRATE_CHUNK);
  });

  it("短史（≤窗）→ 全量挂载无哨兵", () => {
    const c = mount(<HistoryList history={entries(30)} />);
    expect(rows(c)).toBe(30);
    expect(sentinel(c)).toBeNull();
  });

  it("替换收缩（换史）→ 尾窗复位缺省", () => {
    const c = mount(<HistoryList history={entries(300)} />);
    fireVisible();
    expect(rows(c)).toBe(120);
    rerender(<HistoryList history={entries(40)} />);
    expect(rows(c)).toBe(40); // 复位后全量（40 ≤ 60 窗）
    expect(sentinel(c)).toBeNull();
    // 再换回长史：从缺省尾窗起步（不是残留的 120）
    rerender(<HistoryList history={entries(300)} />);
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW);
  });

  it("流中追加恒显最新（尾窗语义，无需水合）", () => {
    const c = mount(<HistoryList history={entries(100)} />);
    rerender(<HistoryList history={entries(101)} />);
    expect(c.textContent).toContain("msg 101");
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW);
  });

  it("分组行=水合单元：300 条折叠读 → 分组后远小于窗 → 无哨兵", () => {
    const reads: HistoryEntry[] = Array.from({ length: 300 }, (_, i) => ({
      kind: "tool",
      name: "read_file",
      summary: `f${i}.ts`,
      resultPreview: `f${i}.ts:1`,
    }));
    const c = mount(<HistoryList history={reads} />);
    // 300 reads collapse to ONE group row → no sentinel, 1 row mounted
    expect(sentinel(c)).toBeNull();
    expect(c.textContent).toContain("×300");
  });
});

describe("133 #9 — SimpleHistoryList 同款", () => {
  it("长史尾窗 + 点击补水", () => {
    const c = mount(<SimpleHistoryList history={entries(150)} onSubmit={() => {}} />);
    expect(rows(c)).toBe(HISTORY_TAIL_WINDOW);
    expect(c.textContent).toContain("msg 150");
    expect(c.textContent).not.toContain("msg 2 "); // 尾空格防子串误伤（msg 2x 不算 msg 2）
    act(() => {
      sentinel(c)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rows(c)).toBe(120); // 60+60=120 <150
    act(() => {
      sentinel(c)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rows(c)).toBe(150); // 180 夹到 150，哨兵卸载
    expect(sentinel(c)).toBeNull();
    expect(c.textContent).toContain("msg 1");
  });
});
