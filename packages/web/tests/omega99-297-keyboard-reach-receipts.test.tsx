// @vitest-environment jsdom
// ω99-297 — 键盘可达收据（v5 弧3）。I4: 会话侧栏行的行内动作（✎ 重命名 /
// 归档）此前是 <span onClick> —— button 不得嵌 button 曾逼出 span，键盘与
// 读屏用户永远够不到这两个动作。修 = 行本体让位（div.sb-i 容器 + .sb-main
// div[role=button] Enter/Space 激活 + 真按钮动作，stopPropagation 语义原
// 样）。I9: select.ctl 的 :focus-visible accent 边退役 —— picker 不是打字
// 面，键盘焦点走全局唯一环，边+环双指示器不再。钉 CSSOM 配方 + DOM 结构
// + 键盘事件路 + 规则缺席。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import type { SessionRow } from "../src/protocol.js";
import "../src/styles.css";
import { decl } from "./css-test-utils.js";

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
  document.body.innerHTML = "";
});

/** A sessions-op client double — the structural slice the sidebar consumes. */
const client = (rows: readonly SessionRow[]): { sessions: () => Promise<readonly SessionRow[]> } => ({
  sessions: () => Promise.resolve(rows),
});
// 0.3.85 gate 教训：mtime 各行自取 Date.now() 时，两次调用跨毫秒界就把
// 「后构造的行」变成最新 —— 侧栏按 mtime 降序排（SessionSidebar:270），
// rows[0] 换人，序敏感断言（活跃行无归档钮 / [1] 号行 resume）在门级负载
// 下两红。夹具确定性化：按构造序严格递减 1s，插入序 == 渲染序，与墙钟
// 无关。
let rowSeq = 0;
const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000 - rowSeq++ * 1000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});

function mountSidebar(over: Partial<Parameters<typeof SessionSidebar>[0]> = {}): HTMLElement {
  const props: Parameters<typeof SessionSidebar>[0] = {
    client: client([]),
    activeSessionId: null,
    onResume: () => {},
    onNewChat: () => {},
    onOpenSettings: () => {},
    onOpenSearch: () => {},
    ...over,
  };
  return mount(<SessionSidebar {...props} />);
}

describe("ω99-297 键盘可达收据", () => {
  it("I4 (CSS): .sb-main 承标题/时间/徽标 —— flex:1 + min-width:0 保住 .sb-t 省略号链", () => {
    expect(decl(".sb-i .sb-main", "display")).toBe("flex");
    expect(decl(".sb-i .sb-main", "align-items")).toBe("center");
    expect(decl(".sb-i .sb-main", "flex")).toBe("1");
    expect(decl(".sb-i .sb-main", "min-width")).toBe("0");
  });

  it("I4 (CSS): ✎/归档 真按钮的 UA 重置三件在场（边/底/字体随行）", () => {
    expect(decl(".sb-i .sb-rename", "border")).toBe("0");
    expect(decl(".sb-i .sb-rename", "background")).toBe("transparent");
    expect(decl(".sb-i .sb-rename", "font")).toBe("inherit");
    expect(decl(".sb-i .sb-act", "border")).toBe("0");
    expect(decl(".sb-i .sb-act", "background")).toBe("transparent");
    expect(decl(".sb-i .sb-act", "font-family")).toBe("inherit");
  });

  it("I9 (CSS): select.ctl 的 accent 边焦点态退役 —— 全 CSSOM 无该规则（全局唯一环接手）", () => {
    const hits: string[] = [];
    for (const sheet of document.styleSheets) {
      const rules = [...(sheet.cssRules ?? [])];
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes("select.ctl:focus-visible")) {
          hits.push(rule.selectorText);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("I4 (DOM): 行是 div[role=listitem]，.sb-main 是键盘激活面，✎/归档 是真按钮", async () => {
    const c = mountSidebar({
      client: client([
        row({ id: "active-id-0001", name: "当前" }),
        row({ id: "other-id-0002", name: "别的" }),
      ]),
      activeSessionId: "active-id-0001",
      onRenameSession: vi.fn(),
    });
    await act(async () => {});
    const rows = [...c.querySelectorAll(".sb-i")] as HTMLElement[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.tagName).toBe("DIV");
      expect(r.getAttribute("role")).toBe("listitem");
      const main = r.querySelector(".sb-main") as HTMLElement;
      expect(main).not.toBeNull();
      expect(main.getAttribute("role")).toBe("button");
      expect(main.getAttribute("tabIndex")).toBe("0");
      expect(main.querySelector(".sb-t")).not.toBeNull();
      expect(r.querySelector(".sb-rename")?.tagName).toBe("BUTTON");
    }
    // 归档钮只在非活跃行（v1 不许归档自己正在看的会话）。
    expect(rows[0]?.querySelector(".sb-act")).toBeNull();
    expect(rows[1]?.querySelector(".sb-act")?.tagName).toBe("BUTTON");
  });

  it("I4 (键盘): Enter 与 Space 都激活行（Space 吞默认滚动）；动作钮不顺带 resume", async () => {
    const onResume = vi.fn();
    const c = mountSidebar({
      client: client([row({ id: "row-a-0001", name: "甲" }), row({ id: "row-b-0002", name: "乙" })]),
      onResume,
      onRenameSession: vi.fn(),
    });
    await act(async () => {});
    const main = c.querySelectorAll(".sb-i")[1]?.querySelector(".sb-main") as HTMLElement;
    await act(async () => {
      main.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onResume).toHaveBeenCalledWith("row-b-0002");
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => {
      main.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(true); // Space 不滚动页面
    expect(onResume).toHaveBeenCalledTimes(2);
    // 行内动作各自为政：点 ✎ 进编辑态，绝不 resume。
    const rename = c.querySelector(".sb-rename") as HTMLButtonElement;
    await act(async () => {
      rename.click();
    });
    expect(c.querySelector("input.sb-rename-in")).not.toBeNull();
    expect(onResume).toHaveBeenCalledTimes(2);
  });
});
