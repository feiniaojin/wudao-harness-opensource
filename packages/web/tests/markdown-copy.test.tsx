// @vitest-environment jsdom
// ω99-149 — 代码块一键复制覆盖层。写代码/改代码是产品核心场景,LLM 回答里
// 的 fenced block 此前在 web 端零复制入口(只能手动框选)。本套钉覆盖层契约:
//   1. 每个 `.pre` 恰一个复制钮,有 meta 无 meta 同款,不经由 `.pre-head`
//      (inkline-message.test.tsx:40 钉死无 meta 不渲染头,钮必须是覆盖层);
//   2. 点击 → navigator.clipboard.writeText 收到逐字 lines.join("\n")(不
//      trim),瞬态「已复制 ✓」1200ms 回落,连点即再复制并重启瞬态;
//   3. 流式共享同一块渲染器(StreamingMarkdown)同款钮在位,增长中的尾块
//      复制当前已到内容(M72 committed-prefix append-only,瞬态 state 安全);
//   4. CSS 层:`.pre` 定位锚、默认隐匿、hover/focus-visible/done 三路显影、
//      done accent 色、时长走 --dur-fast 令牌(执法门禁裸字面量)。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, decl, unmount } from "./css-test-utils.js";
import { stylesCss } from "./styles-source.js";
import { Markdown, StreamingMarkdown } from "../src/markdown.js";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no clipboard API — the same writeText double context-menu.test.tsx
// injects (the only other writeText consumer suite; same helper underneath).
const writeText = vi.fn((): Promise<void> => Promise.resolve());
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  unmount();
  writeText.mockClear();
  vi.useRealTimers();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};
const copyBtn = (c: HTMLElement, i = 0): HTMLButtonElement =>
  c.querySelectorAll<HTMLButtonElement>(".pre .pre-copy")[i]!;

describe("ω99-149 — 代码块复制覆盖层", () => {
  it("每个 .pre 恰一钮:无 meta 零头(inkline :40 钉不破)+ 钮在;有 meta 头在、钮是头外兄弟且随容器类下移避让", () => {
    const bare = mount(<Markdown source={"```js\nlet x = 1;\n```"} />);
    expect(bare.querySelectorAll(".pre")).toHaveLength(1);
    expect(bare.querySelector(".pre-head")).toBeNull(); // inkline :40 钉不破
    expect(bare.querySelectorAll(".pre .pre-copy")).toHaveLength(1);
    expect(bare.querySelector(".pre")?.className).toBe("pre"); // 无头形不带避让类
    const withMeta = mount(<Markdown source={"```rs\nlet y = 2;\n```"} meta={{ file: "main.rs", line: 276 }} />);
    expect(withMeta.querySelector(".pre-head")).not.toBeNull();
    expect(withMeta.querySelectorAll(".pre .pre-copy")).toHaveLength(1);
    expect(withMeta.querySelector(".pre-head .pre-copy")).toBeNull(); // 覆盖层,不是头内钮
    expect(withMeta.querySelector(".pre")?.className).toContain("has-pre-head"); // 头存在时钮下移避让 L-n
    const b = copyBtn(bare);
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("复制代码");
    expect(b.textContent).toBe("复制");
  });

  it("两个代码块的文档每块各恰一钮(钮随块不随文,DOM 序在 pre 之前)", () => {
    const c = mount(<Markdown source={"```js\na\n```\n\npara\n\n```py\nb\n```"} />);
    expect(c.querySelectorAll(".pre")).toHaveLength(2);
    expect(c.querySelectorAll(".pre .pre-copy")).toHaveLength(2);
    for (const pre of [...c.querySelectorAll(".pre")]) {
      expect(pre.querySelectorAll(":scope > .pre-copy")).toHaveLength(1); // 恰一,直属 .pre
      expect(pre.querySelector(":scope > .pre-copy")!.nextElementSibling?.tagName).toBe("PRE"); // 先钮后码
    }
  });

  it("点击 → writeText 收到逐字 join(不 trim);瞬态「已复制 ✓」1200ms 回落;连点即再复制并重启瞬态", () => {
    vi.useFakeTimers();
    const body = "  let x = 1;\n\nconst y = 2;  "; // 首尾空白 + 中空行都逐字
    const c = mount(<Markdown source={"```js\n" + body + "\n```"} />);
    click(copyBtn(c));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(body);
    expect(copyBtn(c).textContent).toBe("已复制 ✓");
    expect(copyBtn(c).className).toContain("done");
    click(copyBtn(c)); // 连点即再复制(fire-and-forget 幂等)+ 重启瞬态
    expect(writeText).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(copyBtn(c).textContent).toBe("已复制 ✓"); // 重启后 600ms 仍在瞬态
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(copyBtn(c).textContent).toBe("复制"); // 满 1200ms 回落
    expect(copyBtn(c).className).not.toContain("done");
  });

  it("1199ms 仍在瞬态;unmount 清 timer(瞬态中途卸载再走钟不残留)", () => {
    vi.useFakeTimers();
    const c = mount(<Markdown source={"```js\nx\n```"} />);
    click(copyBtn(c));
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(copyBtn(c).textContent).toBe("已复制 ✓"); // 未满 1200ms 不回落
    unmount(); // 提前卸载 — effect cleanup 必须摘掉 pending timer
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(1200);
      });
    }).not.toThrow();
  });

  it("流式渲染器同款钮:完整文本与增长中的尾块都在位,尾块复制当前已到内容", () => {
    const done = mount(<StreamingMarkdown source={"```js\nlet x = 1;\n```"} />);
    expect(done.querySelectorAll(".pre .pre-copy")).toHaveLength(1);
    vi.useFakeTimers();
    const growing = mount(<StreamingMarkdown source={"```js\npartial tail"} />);
    click(copyBtn(growing));
    expect(writeText).toHaveBeenCalledWith("partial tail"); // 复制当前已到内容
    expect(copyBtn(growing).textContent).toBe("已复制 ✓");
  });

  it("CSS 层:.pre 定位锚 + 钮默认隐匿 + hover/focus-visible/done 三路显影 + done ok + 令牌时长", () => {
    expect(decl(".pre", "position")).toBe("relative");
    expect(decl(".pre-copy", "opacity")).toBe("0");
    expect(decl(".pre:hover .pre-copy", "opacity")).toBe("1");
    expect(decl(".pre-copy:focus-visible", "opacity")).toBe("1");
    expect(decl(".pre-copy.done", "opacity")).toBe("1");
    expect(decl(".pre-copy.done", "color")).toBe("var(--ok)"); // 116 弧 A: done 回执走 ok 语义色
    expect(decl(".pre.has-pre-head .pre-copy", "top")).toBe("var(--sp-8)"); // 头存在时下移避让
    // 时长走 --dur-fast(=120ms)令牌 — 执法门禁裸字面量(jsdom 不序列化 transition 简写,故 raw 锚)
    expect(stylesCss).toMatch(/\.pre-copy\s*\{[^}]*transition:\s*opacity var\(--dur-fast\)/);
  });
});
