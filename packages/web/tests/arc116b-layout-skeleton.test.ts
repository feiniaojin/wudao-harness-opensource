// @vitest-environment jsdom
// 116 弧 B「骨架升级」的收据套件——去廉价化第二弧（布局骨架，116 报告 §3.e
// + 廉价感来源 #1 对话面 / #5 宽度面）。三面钉：
//   ① 自适应内容宽：--content-max 从 720px 死宽改 dsh 配方 clamp(680px,64%,
//      920px)（CSSOM 解析值钉死），六个消费点（.chat/.composer/.approval/
//      .permission-card/.ask-card/.set-body）全量 census 在册、公式同源；
//      styles 里不得再有 720px 内容定宽残留（视口断点不在此列）；
//   ② 对话区去框化：assistant 回复 .reply-card 平铺裸底（零 border/零底/零
//      radius/零 padding，显式退役声明）；用户气泡中性形不动；工具卡/回执卡
//      （.toolcard/.act）保留 hair-1 框——框是机器回执的语言；回合分隔改由
//      留白（.msg-user 上方加档）+ 卡尾时间戳细线（.reply-meta 的 hair-1
//      上缘）承担；
//   ③ 回合信息层级：顶栏 34px 高度不动、实底 surface 带退役（透明画布 +
//      hair-1 底缘），为第三弧玻璃化铺路；
//   ④ 审计红线——信息结构不变：折叠/全文能力（展开/收起 toggle、注入卡
//      展开、edit 卡「查看改动」）与 216 改动面板数据源（notice.changes 过境）
//      在去框化容器里行为原样（只动视觉容器，不动信息结构）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import "../src/tokens.css";
import { applyAccent, applyTheme } from "../src/theme.js";
import { resetMarkdownCache } from "../src/markdown.js";
import { decl, mount, unmount } from "./css-test-utils.js";
import { act, createElement } from "react";
import { HistoryItem } from "../src/components/HistoryList.js";

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});
beforeEach(() => {
  resetMarkdownCache();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prop = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------------------
// ① —— 自适应内容宽（dsh 配方 clamp + 消费点 census）。
// ---------------------------------------------------------------------------
describe("116 弧 B — adaptive content width (the dsh clamp recipe)", () => {
  it("--content-max is the dsh clamp, in BOTH themes (the token lives in :root)", () => {
    applyTheme("dark");
    applyAccent("green");
    expect(prop("--content-max")).toBe("clamp(680px, 64%, 920px)");
    applyTheme("light");
    expect(prop("--content-max")).toBe("clamp(680px, 64%, 920px)");
  });

  it("every var(--content-max) consumer is in the census (6 sites, one formula family)", () => {
    // census（随钉列出）：六位点两族——「+32px 派生」（.chat/.composer/.set-body
    // 的 max-width）与「+32px 且让位 2.5rem 边距」的列内卡族（.approval/
    // .permission-card/.ask-card 的 width）。
    const sites = [...stylesCss.matchAll(/var\(--content-max\)/g)];
    expect(sites).toHaveLength(6);
    expect(decl(".chat", "max-width")).toBe("calc(var(--content-max) + 32px)");
    expect(decl(".composer", "max-width")).toBe("calc(var(--content-max) + 32px)");
    expect(decl(".set-body", "max-width")).toBe("calc(var(--content-max) + 32px)");
    // 列内卡族的 min() 让位形（与 .chat 同源派生，窗口再窄也不贴边）。
    const inline = "min(calc(var(--content-max) + 32px), calc(100% - 2.5rem))";
    expect(decl(".approval", "width")).toBe(inline);
    expect(decl(".permission-card", "width")).toBe(inline);
    expect(decl(".ask-card", "width")).toBe(inline);
  });

  it("the settings body column follows the SAME cap and centers (设置页正文列同步自适应)", () => {
    expect(decl(".set-body", "max-width")).toBe("calc(var(--content-max) + 32px)");
    expect(decl(".set-body", "margin")).toBe("0 auto");
  });

  it("no bare 720px content width survives in the sheet (viewport breakpoints excluded)", () => {
    // 死宽退役的守门：内容列上不得再有 720px 字面量。@media (max-width:720px)
    // 是视口断点（80-provider/90-provider-rounds 的 <720 竖排降级），量的是窗
    // 口不是内容舒适宽，不在退役范围。两道护栏：@media( 负向后顾 + 词首锚
    // （否则 alternation 的 width 分支会命中 max-width 的后半段）。
    expect(stylesCss).not.toMatch(/(?<!@media \()(?<![-\w])(?:max-width|width)\s*:\s*720px/);
  });
});

// ---------------------------------------------------------------------------
// ② —— 对话区去框化（assistant 平铺 + 工具卡留框 + 回合分隔=留白+细线）。
// ---------------------------------------------------------------------------
describe("116 弧 B — the de-framed conversation surface", () => {
  it("the assistant reply is FLAT: .reply-card declares the full retirement (零 border/底/radius/padding)", () => {
    // 显式退役声明（同弧 A elevation 面的 border:0 惯例）——不是删规则，
    // 是把「无框」写进档，收据按声明钉。
    expect(decl(".reply-card", "background")).toBe("none");
    expect(decl(".reply-card", "padding")).toBe("0");
    expect(decl(".reply-card", "border-radius")).toBe("0");
    expect(stylesCss).toMatch(/\.reply-card\s*\{[^}]*border:\s*0;/s);
    // 排版职责保留（fs-body/1.55 正文——墨线 §2 的正文档不动）。
    expect(decl(".reply-card", "font-size")).toBe("var(--fs-body)");
    expect(decl(".reply-card", "line-height")).toBe("var(--lh-body)");
    expect(decl(".reply-card", "color")).toBe("var(--text-1)");
  });

  it("tool/receipt cards KEEP their frames on the arc-A hairline tokens (工具卡留框)", () => {
    // 框是机器回执的语言（dsh：工具卡保留卡面）——hair-1 描边 + surface 底
    // 是弧 A 令牌，本弧零改。longhand 声明（cssstyle 读不了带 var() 的
    // border shorthand）。
    expect(decl(".toolcard", "border-color")).toBe("var(--hair-1)");
    expect(decl(".toolcard", "background")).toBe("var(--surface)");
    expect(decl(".act", "border-color")).toBe("var(--hair-1)");
    expect(decl(".act", "background")).toBe("var(--surface)");
  });

  it("the user bubble keeps its neutral arc-A form untouched (用户消息保留中性气泡)", () => {
    expect(decl(".msg-user .bub", "background")).toBe("var(--bubble-user-bg)");
    // 119 用户反馈修正（圆角统一）：--radius-bubble 的值在本弧后改 8px 均匀角
    // （旧 16px 复合角退役）——本钉按语义档（var 引用）执法故不动，值的
    // 重钉在 arc119-visual-unification.test.ts（气泡 8px 均匀角钉）。
    expect(decl(".msg-user .bub", "border-radius")).toBe("var(--radius-bubble)");
    // 零 border（radius 不算——圆角是气泡形不是框）：以 border: 三长手执法。
    expect(stylesCss).not.toMatch(/\.msg-user \.bub\s*\{[^}]*\bborder(?:\s*:|-width|-style|-color)/s);
  });

  it("the turn seam is whitespace + the timestamp hairline (回合分隔=留白+时间戳细线)", () => {
    // 卡尾 meta 行（· 2.1s / 换腿回执）升格为回合收尾：hair-1 上缘细线。
    // border-top 带 var() → raw-sheet 钉原文（.sb-i.on 的先例）。
    expect(stylesCss).toMatch(/\.reply-card \.reply-meta\s*\{[^}]*border-top:\s*1px solid var\(--hair-1\);/s);
    expect(decl(".reply-card .reply-meta", "color")).toBe("var(--text-3)");
    expect(decl(".reply-card .reply-meta", "font-size")).toBe("var(--fs-caption)");
    // 用户气泡行 = 回合首行：上方加档留白（回合间 > 回合内），非首回合也同形
    // （margin 在行本体上，与位置无关——不依赖 :has()，WKWebView macOS 12 安全）。
    expect(decl(".msg-user", "margin-top")).toBe("var(--sp-3)");
  });
});

// ---------------------------------------------------------------------------
// ③ —— 回合信息层级：顶栏去实底。
// ---------------------------------------------------------------------------
describe("116 弧 B — the topbar sheds its solid band", () => {
  it("34px height kept; the surface band is GONE — transparent canvas + hair-1 bottom edge", () => {
    expect(decl(".topbar", "height")).toBe("34px");
    expect(decl(".topbar", "background")).toBe("none");
    expect(decl(".topbar", "border-bottom")).toContain("var(--hair-1)");
  });
});

// ---------------------------------------------------------------------------
// ④ —— 审计红线：信息结构不变（折叠/全文/改动面在无框容器里行为原样）。
// ---------------------------------------------------------------------------
describe("116 弧 B — the red line: information structure unchanged", () => {
  it("the long-output 展开/收起 toggle still rides the toolcard (272/274 折叠能力)", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const c = mount(
      createElement(HistoryItem, { entry: { kind: "tool", name: "read_file", summary: "a.ts", resultPreview: long } }),
    );
    const card = c.querySelector(".toolcard") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.dataset.status).toBe("ok"); // 回执卡仍在（留框），状态原样
    const toggle = c.querySelector<HTMLButtonElement>(".activity-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("展开");
    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.textContent).toContain("收起");
  });

  it("the injected-context card keeps its expand/collapse INSIDE the now-flat reply-card (全文能力)", () => {
    const c = mount(
      createElement(HistoryItem, { entry: { kind: "notice", text: "钩子注入", detail: "全文内容", card: true, source: "SessionStart 钩子（startup）" } }),
    );
    // 署名「注」+ 容器仍在（容器视觉平铺，DOM 结构零变化）。
    expect(c.querySelector(".msg-inject .sig-glyph")?.textContent).toBe("注");
    const flat = c.querySelector(".msg-inject .reply-card");
    expect(flat).not.toBeNull();
    const head = c.querySelector<HTMLButtonElement>(".inject-head");
    expect(head).not.toBeNull();
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".notice-detail")).toBeNull(); // 收起态全文不渲染
    act(() => {
      head?.click();
    });
    // act 重渲后重查（React 可能重建节点，旧引用是陈旧属性）。
    expect(c.querySelector(".inject-head")?.getAttribute("aria-expanded")).toBe("true");
    expect(c.querySelector(".reply-card .notice-detail")?.textContent).toBe("全文内容");
  });

  it("the edit receipt keeps 查看改动 + the ω99-216 changes payload still transits the notice entry", () => {
    const c = mount(
      createElement(HistoryItem, {
        entry: { kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" },
      }),
    );
    expect(c.querySelector(".act")?.querySelector(".act-row")).not.toBeNull();
    expect(c.textContent).toContain("查看改动"); // 折叠态回执行（改动面板的行内形态）
    // 216 数据源：notice.changes 的过境字段在类型层 append-only（本弧零触碰）；
    // 渲染锚——带 changes 的通知展开走 DiffText 分色（.notice-detail 容器仍在）。
    const c2 = mount(
      createElement(HistoryItem, {
        entry: {
          kind: "notice",
          text: "已修改 2 个文件",
          detail: "- a\n+ b",
          changes: [{ path: "src/a.ts", op: "modified", writes: 1, plus: 1, minus: 1 }],
        },
      }),
    );
    const exp = c2.querySelector<HTMLButtonElement>(".notice-exp");
    expect(exp).not.toBeNull();
    act(() => {
      exp?.click();
    });
    expect(c2.querySelector(".notice-detail")).not.toBeNull();
  });

  it("the assistant turn still renders the timestamp meta line (0.3.15 耗时回执)", () => {
    const c = mount(
      createElement(HistoryItem, { entry: { kind: "assistant", text: "答案", durationMs: 2100 } }),
    );
    expect(c.querySelector(".msg-a .reply-card")).not.toBeNull();
    const meta = c.querySelector(".reply-card .reply-meta");
    expect(meta?.textContent).toBe("· 2.1s");
  });
});
