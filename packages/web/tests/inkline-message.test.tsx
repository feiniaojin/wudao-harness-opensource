// @vitest-environment jsdom
// inkline-message — 消息排版契约（墨线 spec §2 → 2026-08-26 容器化）。CSSOM
// 断言沿用 css-test-utils seam（decl 读的是声明值：var() 不被 jsdom 解析，
// 故字号按档位 var 名 pin）。两个面：
//   1. 助手消息 = 署名行在卡外 + .reply-card 卡身（fs-body/1.55 正文），
//      行内 code 走五件套 chip（surface-2 底 + line 边 + 5px 圆角 + mono
//      + tok-str 色）。
//   2. 代码块 = `.pre` 卡 + mono 头（.pre-file/.pre-ln）——头只在 meta
//      带 file 时渲染，缺省不渲染（向后兼容的纯增量 prop）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, decl, unmount } from "./css-test-utils.js";
import { HistoryItem } from "../src/components/HistoryList.js";
import { Markdown, StreamingMarkdown } from "../src/markdown.js";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(unmount);

describe("墨线 §2 — 消息排版", () => {
  // ω99-275: #14 — 悟字徽标退役为 .sig-avatar 空挂点（小精灵头像；肤图由
  // html[data-pet-skin] 的 CSS 规则给，规则/URL 一致性由 omega99-275 测试钉）。
  it("assistant message: 16px pet-avatar mount + signature + 14px/1.55 body (HistoryItem)", () => {
    const c = mount(<HistoryItem entry={{ kind: "assistant", text: "两层根因。" }} />);
    expect(c.querySelector(".sig-avatar")).not.toBeNull();
    expect(c.querySelector(".sig-glyph")).toBeNull();
    expect(c.querySelector(".sig-name")?.textContent).toBe("悟道Harness"); // 品牌弧随迁
    expect(decl(".reply-card", "font-size")).toBe("var(--fs-body)");
    expect(decl(".msg-a code", "background-color")).toContain("var(--surface-2)"); // 行内 code 五件套
  });
  it("2026-08-26 §3.2 — tables render as <table>; headings drop the `#` prefix (level rides data-level)", () => {
    const c = mount(<Markdown source={"## ✅ 修复验证结果\n| 检查项 | 结果 |\n| --- | --- |\n| 构建 | 通过 |"} />);
    const h = c.querySelector(".md-heading") as HTMLElement;
    expect(h.textContent).toBe("✅ 修复验证结果");
    expect(h.getAttribute("data-level")).toBe("2");
    expect([...c.querySelectorAll(".md-table th")].map((x) => x.textContent)).toEqual(["检查项", "结果"]);
    expect([...c.querySelectorAll(".md-table td")].map((x) => x.textContent)).toEqual(["构建", "通过"]);
  });
  it("code block renders the mono head when meta is provided", () => {
    const c = mount(<Markdown source={"```rs\nlet x = 1;\n```"} meta={{ file: "main.rs", line: 276 }} />);
    expect(c.querySelector(".pre-file")?.textContent).toBe("main.rs");
    const bare = mount(<Markdown source={"```rs\nlet x = 1;\n```"} />);
    expect(bare.querySelector(".pre-head")).toBeNull();
  });
});

// ω99-155 — markdown 链接可点（消息排版契约第三面：链接即正文排版）。
// Inline 的 href 分支渲染 <a target="_blank" rel="noopener noreferrer">，
// onLinkClick 恒 preventDefault（绝不许 webview 内导航，WKWebView 默认行为
// 不可托付）→ tauriOpenUrl → false（非 Tauri/拒绝）则 window.open 回退。
// CSS：accent 令牌现成不新造色 + 下划线 2px 偏移免贴字。
describe("ω99-155 — markdown 链接可点", () => {
  it("[文档](https://example.com/x) 渲染为 anchor：href 逐字 + label 文本 + target=_blank + rel", () => {
    const c = mount(<Markdown source={"见 [文档](https://example.com/x) 详述"} />);
    const a = c.querySelector(".md a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.textContent).toBe("文档");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(c.querySelector(".md-para")?.textContent).toBe("见 文档 详述"); // 方括号原文不再露出
  });

  it("arr[0] 纯文本不误染（探针 `\\[` 误命中只多走一次解析、输出不变）", () => {
    const c = mount(<Markdown source={"取 arr[0] 的首元素"} />);
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector(".md-para")?.textContent).toBe("取 arr[0] 的首元素");
  });

  it("**bold** 与 `code` 与链接同行共存零漂移（顺序即 spans 序）", () => {
    const c = mount(<Markdown source={"**粗** 与 [链接](https://example.com) 与 `码`"} />);
    // .md-para 每行一个 div，行内才是 Inline 的 spans。
    const parts = [...c.querySelectorAll(".md-para > div > *")].map((x) => `${x.tagName}:${x.textContent}`);
    expect(parts).toEqual(["SPAN:粗", "SPAN: 与 ", "A:链接", "SPAN: 与 ", "CODE:码"]);
  });

  it("非 http(s) scheme 渲染侧拒（fail-closed：javascript: 永不入 DOM——桌面 open_url 门的 web 镜像）", () => {
    // url 无括号（保守语法 url 不含 `)`），令整链完整匹配后整条降级。
    const c = mount(<Markdown source={"[点我](javascript:x) 与 [ftp](ftp://example.com/f)"} />);
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector(".md-para")?.textContent).toBe("点我 与 ftp");
  });

  it("StreamingMarkdown 尾块链接同渲染（直播态与定稿同构）", () => {
    const c = mount(<StreamingMarkdown source={"段落一\n\n尾块 [文档](https://example.com/x)"} />);
    const a = c.querySelector(".md a");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.textContent).toBe("文档");
  });

  it("点击恒 preventDefault → 非 Tauri 走 window.open(href,_blank,noopener) 回退", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const c = mount(<Markdown source={"[文档](https://example.com/x)"} />);
    const a = c.querySelector(".md a")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      a.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true); // 绝不 webview 内导航
    expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener");
    open.mockRestore();
  });

  it("CSS：链接走 accent 令牌 + 下划线 2px 偏移", () => {
    expect(decl(".md a", "color")).toBe("var(--accent)");
    expect(decl(".md a", "text-decoration")).toContain("underline");
    expect(decl(".md a", "text-underline-offset")).toBe("2px");
  });
});
