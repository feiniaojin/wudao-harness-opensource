// @vitest-environment jsdom
// 高亮 spec §2 落点 1/3 —— DiffView 行级 token 着色（词级 wchg 外层与 token
// 内层并存）+ path chip（回调缺席退化纯文本）；围栏代码块 DOM 钉（防回归）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiffView } from "../src/components/DiffView.js";
import { Markdown } from "../src/markdown.js";

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

const OLD = "const a = 1;\nrest\n";
const NEW = "let a = 2;\nrest\n";

describe("DiffView token 着色 + chip（高亮 spec §2 落点 1）", () => {
  it(".ts 路径：del/add/ctx 行出现 tok span；wchg 与 token 并存", () => {
    const c = mount(<DiffView path="src/a.ts" oldString={OLD} newString={NEW} />);
    expect(c.querySelector(".add .tok-key")?.textContent).toBe("let");
    expect(c.querySelector(".del .tok-key")?.textContent).toBe("const");
    expect(c.querySelector(".del .wchg")).not.toBeNull(); // 词级标注仍在
    expect(c.querySelectorAll(".ctx").length).toBeGreaterThan(0);
  });

  it("语言由路径推导：.sql diff 的关键字着色", () => {
    const c = mount(<DiffView path="db/q.sql" oldString="select 1\n" newString="SELECT 2\n" />);
    expect(c.querySelector(".add .tok-key")?.textContent).toBe("SELECT");
  });

  it("onOpenFile 存在：path 头是 chip 按钮，点击回调带路径", () => {
    const spy = vi.fn();
    const c = mount(<DiffView path="src/a.ts" oldString={OLD} newString={NEW} onOpenFile={spy} />);
    const chip = c.querySelector(".diff .path button.fv-chip");
    expect(chip?.textContent).toBe("src/a.ts");
    act(() => { (chip as HTMLButtonElement).click(); });
    expect(spy).toHaveBeenCalledWith("src/a.ts");
  });

  it("onOpenFile 缺席：无按钮，纯文本路径（简洁模式退化）", () => {
    const c = mount(<DiffView path="src/a.ts" oldString={OLD} newString={NEW} />);
    expect(c.querySelector(".diff .path button")).toBeNull();
    expect(c.querySelector(".diff .path")?.textContent).toContain("src/a.ts");
  });
});

describe("会话围栏代码块 DOM 钉（高亮 spec §2 落点 3）", () => {
  it("sql 围栏渲染出 tok-key span（0.3.16 已有着色的防回归钉）", () => {
    const c = mount(<Markdown source={"```sql\nSELECT 1 FROM t;\n```"} />);
    expect(c.querySelector(".pre .tok-key")?.textContent).toBe("SELECT");
  });
});
