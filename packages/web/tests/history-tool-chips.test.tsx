// @vitest-environment jsdom
// 高亮 spec §2 落点 2/4 —— 工具卡参数行着色（TOOL_ARG_LANG 命中）+ 路径 chip
// （write_file/read_file 卡 + edit 条目头；回调缺席退化纯文本）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryList, TOOL_ARG_LANG } from "../src/components/HistoryList.js";
import type { HistoryEntry } from "../src/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root?.render(el); });
  return container;
};
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

const HISTORY: readonly HistoryEntry[] = [
  { kind: "tool", name: "shell", summary: "grep -rn foo src/" },
  { kind: "tool", name: "write_file", summary: "src/a.ts" },
  { kind: "edit", path: "src/b.ts", oldString: "x", newString: "y" },
];

describe("TOOL_ARG_LANG 常量", () => {
  it("shell → shell；不含路径型工具（裸路径着色是噪音）", () => {
    expect(TOOL_ARG_LANG["shell"]).toBe("shell");
    expect(TOOL_ARG_LANG["write_file"]).toBeUndefined();
    expect(TOOL_ARG_LANG["read_file"]).toBeUndefined();
  });
});

describe("工具卡参数行 + chip（高亮 spec §2 落点 2/4）", () => {
  it("shell 参数行 shell 着色（tok span 出现在 .args 内）", () => {
    const c = mount(<HistoryList history={HISTORY} />);
    expect(c.querySelector(".toolcard .args .tok-key")?.textContent).toBe("grep");
  });

  it("write_file summary 是 chip：点击回调路径；onOpenFile 缺席退化纯文本", () => {
    const spy = vi.fn();
    const c = mount(<HistoryList history={HISTORY} onOpenFile={spy} />);
    const chip = c.querySelectorAll(".toolcard .args .fv-chip")[0] ?? null;
    expect(chip?.textContent).toBe("src/a.ts");
    act(() => { (chip as HTMLButtonElement).click(); });
    expect(spy).toHaveBeenCalledWith("src/a.ts");
    // T3 审查修复钉：chip 点击不得冒泡到头部按钮翻转折叠态（默认展开，
    // 头部 .head 带 aria-expanded；误冒泡会把它翻成 "false"）。同样要按
    // write_file 卡定位 —— `.toolcard .head` first-match 是 shell 卡。
    const wfHead = [...c.querySelectorAll(".toolcard")]
      .find((el) => el.querySelector(".name")?.textContent === "write_file")
      ?.querySelector(".head") ?? null;
    expect(wfHead?.getAttribute("aria-expanded")).toBe("true");
    const c2 = mount(<HistoryList history={HISTORY} />);
    expect(c2.querySelector(".toolcard .args .fv-chip")).toBeNull();
    // brief fix: `.toolcard .args` first-matches shell's colored line
    // (test 1 pins that card) — scope to the write_file card for the
    // plain-text fallback assertion.
    const wfArgs = [...c2.querySelectorAll(".toolcard")]
      .find((el) => el.querySelector(".name")?.textContent === "write_file")
      ?.querySelector(".args")?.textContent ?? "";
    expect(wfArgs).toContain("src/a.ts");
  });

  it("edit 条目：折叠卡内 diff path 头的 chip 点击回调；缺席时无按钮", () => {
    const spy = vi.fn();
    const c = mount(<HistoryList history={HISTORY} onOpenFile={spy} />);
    // 0.3.82: the edit entry rides the shared collapsed EditCard — expand the
    // row first, the path chip lives inside the folded diff body (高亮 spec
    // §2 落点 4 contract unchanged, one extra click to reach it).
    act(() => { (c.querySelector(".act[data-kind='diff'] .act-row") as HTMLButtonElement).click(); });
    const chip = c.querySelector(".diff .path .fv-chip");
    act(() => { (chip as HTMLButtonElement).click(); });
    expect(spy).toHaveBeenCalledWith("src/b.ts");
    const c2 = mount(<HistoryList history={HISTORY} />);
    // The no-callback arm needs the body OPEN to discriminate (a collapsed
    // card has no .diff at all — the assert would pass vacuously).
    act(() => { (c2.querySelector(".act[data-kind='diff'] .act-row") as HTMLButtonElement).click(); });
    expect(c2.querySelector(".diff .path button")).toBeNull(); // no callback → plain text path head
  });
});
