// @vitest-environment jsdom
// M76-ux2 §6 — the right-click context menus. The reusable ContextMenu
// overlay first (geometry, click-outside, Esc, item dispatch), then the two
// wiring sites: FileTree's per-node menus (file: 复制路径 / @-mention 到输入 /
// 在 viewer 打开 / 在访达中显示; dir: 复制路径 / 在 viewer 打开目录列表 /
// 在访达中显示) and the chat messages' 复制文本. The native menu never opens
// (preventDefault on the contextmenu event) — browser and Tauri render native
// menus differently, so the surface is self-drawn (spec §6).
// ω99-163: both FileTree menus append the Finder-reveal item LAST — the
// reveal_path command + capability landed with ω99-125 (the file card);
// the tree rides the same null-safe seam with the panel root joined on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stylesCss } from "./styles-source.js";
import { ContextMenu } from "../src/components/ContextMenu.js";
import { FileTree } from "../src/components/FileTree.js";
import { HistoryList } from "../src/components/HistoryList.js";
import type { FileOpsClient } from "../src/file-ops.js";
import { tauriInvokeCommand } from "../src/tauri-invoke.js";

// ω99-163: the seam stays real except the one command the reveal item fires
// (jsdom has no bridge; the real seam would read null and swallow — here we
// SPY the call). Same shape as omega99-125-file-card.test.tsx.
vi.mock("../src/tauri-invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tauri-invoke.js")>();
  return {
    ...actual,
    tauriInvokeCommand: vi.fn(async (): Promise<unknown | null> => null),
  };
});

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
const flush = async (): Promise<void> => {
  await act(async () => {});
};
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};
/** Right-click the way a real browser does: a cancelable contextmenu
 *  MouseEvent carrying the viewport coordinates the menu positions at. */
const rightClick = (el: Element, x = 20, y = 30): boolean => {
  let prevented = false;
  act(() => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
    prevented = !el.dispatchEvent(ev);
  });
  return prevented;
};
const pressEsc = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
};

// jsdom ships no clipboard API — the tests supply the writeText double the
// menu items call (spec §6: 复制路径 / 复制文本).
const writeText = vi.fn((): Promise<void> => Promise.resolve());
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  writeText.mockClear();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

const ROOT = "~/xdev/github/wudao-harness";

// 墨线 T14: the menu family's raw-sheet pins (cssstyle drops var()-bearing
// shorthands, so surface/radius/height ride regexes off the source).
const STYLES_CSS = stylesCss;

function treeClient(listing: Record<string, { name: string; type: "file" | "dir" }[]>): FileOpsClient {
  return {
    fileTree: (path: string) => Promise.resolve({ entries: listing[path] ?? [] }),
    fileRead: () => Promise.reject(new Error("never")),
  };
}

// 墨线 T14: the menu rides the shared .menu family (surface-2 pop, 26px
// .menu-item rows) — the pins walk .menu/.menu-item, not .ctx-menu/.ctx-item.
const menuLabels = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".menu .menu-item")].map((b) => b.textContent ?? "");

describe("ContextMenu overlay (M76-ux2 §6)", () => {
  // The overlay is always mounted THROUGH an owner that drops it on close
  // (FileTree/HistoryList hold the open state) — mirror that shape here.
  function MenuHost({ items, onClose }: { items: { label: string; kbd?: string; onSelect(): void }[]; onClose(): void }): React.JSX.Element | null {
    const [open, setOpen] = React.useState(true);
    return open ? (
      <ContextMenu x={120} y={40} items={items} onClose={() => { onClose(); setOpen(false); }} />
    ) : null;
  }

  // 墨线 T14 — the menu family contract: 26px rows, the optional right-aligned
  // mono kbd hint per item. 119 用户反馈修正（surface 归口 + 圆角统一）：
  // 浮层菜单底归 --surface（旧 surface-2 是借用高档底）、圆角归浮层档 lg 12。
  it("context menu: surface pop + radius-lg (119), 26px items, mono kbd hints right-aligned", () => {
    const c = mount(<MenuHost items={[{ label: "复制", kbd: "⌘C", onSelect: vi.fn() }]} onClose={vi.fn()} />);
    expect(c.querySelector(".menu")).toBeTruthy();
    expect(c.querySelector(".menu-kbd")?.textContent).toBe("⌘C");
    expect(STYLES_CSS).toMatch(/\.menu\s*{[^}]*var\(--surface\)[^}]*var\(--radius-lg\)/s);
    expect(STYLES_CSS).toMatch(/\.menu-item\s*{[^}]*height:\s*26px/s);
    expect(STYLES_CSS).toMatch(/\.menu-kbd\s*{[^}]*margin-left:\s*auto[^}]*var\(--mono\)[^}]*var\(--fs-caption\)/s);
  });

  it("renders the items at the pointer position; a click dispatches the item then closes", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const c = mount(<MenuHost items={[{ label: "复制路径", onSelect }]} onClose={onClose} />);
    const menu = c.querySelector(".menu") as HTMLElement;
    // fix round 2 (M2): the anchor rides --ctx-x/--ctx-y custom props (the
    // sheet clamps each axis into the viewport) — re-pinned off the props.
    expect(menu.style.getPropertyValue("--ctx-x")).toBe("120px");
    expect(menu.style.getPropertyValue("--ctx-y")).toBe("40px");
    expect(menuLabels(c)).toEqual(["复制路径"]);
    click(c.querySelector(".menu-item"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closed = unmounted by the owner: the overlay is gone from the tree.
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("click-outside (the transparent backdrop) and Esc close without dispatching", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const c = mount(<MenuHost items={[{ label: "复制路径", onSelect }]} onClose={onClose} />);
    click(c.querySelector(".ctx-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(c.querySelector(".menu")).toBeNull();

    const c2 = mount(<MenuHost items={[{ label: "复制路径", onSelect }]} onClose={onClose} />);
    pressEsc();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(c2.querySelector(".menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // ui-review-r1 I1: a pointer-opened menu manages no focus of its own, but
  // its close must still return focus to the trigger (the right-clicked row).
  it("unmounting returns focus to the element the menu opened on", () => {
    const trigger = document.createElement("div");
    trigger.tabIndex = 0;
    document.body.appendChild(trigger);
    trigger.focus();
    const c = mount(<MenuHost items={[{ label: "复制路径", onSelect: vi.fn() }]} onClose={vi.fn()} />);
    expect(c.querySelector(".menu")).not.toBeNull();
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("FileTree context menus (M76-ux2 §6)", () => {
  // ω99-163: 3→4 items — 在访达中显示 appends last (append-last keeps the
  // existing index clicks below drift-free).
  it("a FILE row opens the 4-item menu at the pointer; 复制路径 writes the workspace-relative path", async () => {
    const onSelect = vi.fn();
    const onAtMention = vi.fn();
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "src", type: "dir" }, { name: "README.md", type: "file" }] })}
        workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={onAtMention} refreshKey={0} />,
    );
    await flush();
    const prevented = rightClick(c.querySelector('.tree-node[data-path="README.md"] > .ft-row') as Element, 20, 30);
    expect(prevented).toBe(true); // the native menu stays hidden
    // ω99-163: 在访达中显示 appended last.
    expect(menuLabels(c)).toEqual(["复制路径", "@-mention 到输入", "在 viewer 打开", "在访达中显示"]);
    expect((c.querySelector(".menu") as HTMLElement).style.getPropertyValue("--ctx-x")).toBe("20px");

    click(c.querySelectorAll(".menu-item")[0]); // 复制路径
    expect(writeText).toHaveBeenCalledWith("README.md");
    expect(c.querySelector(".menu")).toBeNull(); // closed after the action
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAtMention).not.toHaveBeenCalled();
  });

  // ω99-163: renamed — "other two" is false under the 4-item menu.
  it("the file menu's @-mention 到输入 and 在 viewer 打开 items", async () => {
    const onSelect = vi.fn();
    const onAtMention = vi.fn();
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "src", type: "dir" }], src: [{ name: "App.tsx", type: "file" }] })}
        workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={onAtMention} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row')); // expand src (left-click)
    await flush();
    rightClick(c.querySelector('.tree-node[data-path="src"] .tree-node[data-path="src/App.tsx"] > .ft-row') as Element);

    click(c.querySelectorAll(".menu-item")[1]); // @-mention 到输入
    expect(onAtMention).toHaveBeenCalledWith("src/App.tsx");
    expect(writeText).not.toHaveBeenCalled();
    expect(c.querySelector(".menu")).toBeNull();

    rightClick(c.querySelector('.tree-node[data-path="src"] .tree-node[data-path="src/App.tsx"] > .ft-row') as Element);
    click(c.querySelectorAll(".menu-item")[2]); // 在 viewer 打开
    expect(onSelect).toHaveBeenCalledWith("src/App.tsx", false);
  });

  // ω99-163: 2→3 items — 在访达中显示 appends last (dirs locate too).
  it("a DIR row opens the 3-item menu; 打开目录列表 reports (path, true)", async () => {
    const onSelect = vi.fn();
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "src", type: "dir" }] })}
        workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    rightClick(c.querySelector('.tree-node[data-path="src"] > .ft-row') as Element);
    // ω99-163: 在访达中显示 appended last.
    expect(menuLabels(c)).toEqual(["复制路径", "在 viewer 打开目录列表", "在访达中显示"]);

    click(c.querySelectorAll(".menu-item")[1]); // 在 viewer 打开目录列表
    expect(onSelect).toHaveBeenCalledWith("src", true);

    rightClick(c.querySelector('.tree-node[data-path="src"] > .ft-row') as Element);
    click(c.querySelectorAll(".menu-item")[0]); // 复制路径 (dir flavor)
    expect(writeText).toHaveBeenCalledWith("src");
  });

  it("Esc closes the tree menu without any action", async () => {
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "a.ts", type: "file" }] })}
        workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    rightClick(c.querySelector('.tree-node[data-path="a.ts"] > .ft-row') as Element);
    expect(c.querySelector(".menu")).not.toBeNull();
    pressEsc();
    expect(c.querySelector(".menu")).toBeNull();
  });

  // ω99-163 — the reveal item's contract, RED-first:
  it("在访达中显示 invokes reveal_path with the panel root joined path", async () => {
    vi.mocked(tauriInvokeCommand).mockClear();
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "README.md", type: "file" }] })}
        workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    rightClick(c.querySelector('.tree-node[data-path="README.md"] > .ft-row') as Element);
    const items = c.querySelectorAll(".menu-item");
    click(items[items.length - 1]); // 末项 = 在访达中显示 (appended last)
    expect(vi.mocked(tauriInvokeCommand)).toHaveBeenCalledWith("reveal_path", { path: `${ROOT}/README.md` });
  });

  // ω99-163 — pre-connection placeholder root: the item stays visible
  // (browser parity with the card's 打开 button) but is a silent no-op.
  it("在访达中显示 under the 工作区 placeholder root never reaches the seam", async () => {
    vi.mocked(tauriInvokeCommand).mockClear();
    const c = mount(
      <FileTree client={treeClient({ "": [{ name: "a.ts", type: "file" }] })}
        workspaceRoot="工作区" selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    rightClick(c.querySelector('.tree-node[data-path="a.ts"] > .ft-row') as Element);
    const reveal = Array.from(c.querySelectorAll(".menu-item")).find((b) => b.textContent === "在访达中显示");
    expect(reveal).toBeTruthy(); // shown even without a real root — deliberate
    click(reveal);
    expect(vi.mocked(tauriInvokeCommand)).not.toHaveBeenCalled();
  });
});

describe("HistoryList context menu (M76-ux2 §6)", () => {
  it("a user message opens the 1-item 复制文本 menu; the click copies the full text", async () => {
    const c = mount(
      <HistoryList history={[{ kind: "user", text: "fix the whole bug now" }, { kind: "assistant", text: "done" }]} />,
    );
    const prevented = rightClick(c.querySelectorAll(".entry")[0] as Element);
    expect(prevented).toBe(true);
    expect(menuLabels(c)).toEqual(["复制文本"]);
    click(c.querySelector(".menu-item"));
    expect(writeText).toHaveBeenCalledWith("fix the whole bug now");
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("assistant messages carry the same 复制文本 menu; tool/notice rows do not", async () => {
    const c = mount(
      <HistoryList
        history={[
          { kind: "tool", name: "read_file", summary: "a.ts", resultPreview: "ok" },
          { kind: "notice", text: "n" },
          { kind: "assistant", text: "# Done" },
        ]}
      />,
    );
    // The tool and notice rows open nothing (no menu state).
    rightClick(c.querySelectorAll(".entry")[0] as Element);
    rightClick(c.querySelectorAll(".entry")[1] as Element);
    expect(c.querySelector(".menu")).toBeNull();
    // The assistant row opens the copy menu with ITS text.
    rightClick(c.querySelectorAll(".entry")[2] as Element);
    expect(menuLabels(c)).toEqual(["复制文本"]);
    click(c.querySelector(".menu-item"));
    expect(writeText).toHaveBeenCalledWith("# Done");
  });
});
