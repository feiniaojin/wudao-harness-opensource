// @vitest-environment jsdom
// M64-visual §3 — the conversation-flow restyle: user bubbles (.msg-user
// .bub), the assistant signature row (墨线 §2/task-6: .msg-a = 悟徽标 +
// 「悟道」署名 + .msg-body, no bubble), the .act activity
// cards (墨线 spec §2: a 32px .act-row collapsed line = status glyph + verb
// + mono file + right-edge tail + rotating chevron; typed .act-body capped
// at 8 lines / 132px inline with internal scroll; .act.err danger border +
// row text), the token-derived diff red/green, and the hero
// (52px accent 悟 logo + task chips).
//
// jsdom does not resolve var()/color-mix in getComputedStyle, so color
// assertions read the MOUNTED stylesheet (css:true) through the CSSOM —
// `decl()` returns a rule's declared value, which pins the token derivation
// (var(--accent), color-mix on tokens) exactly; custom properties on <html>
// resolve through getComputedStyle like a browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { stylesCss } from "./styles-source.js";
import tokensCss from "../src/tokens.css?raw";
import "../src/styles.css";
import "../src/tokens.css";
import { applyTheme } from "../src/theme.js";
import type { DriverStatus, LiveState } from "../src/protocol.js";
import { HistoryItem } from "../src/components/HistoryList.js";
import { StatusBar } from "../src/components/StatusBar.js";
import { SimpleActivityCard, CARD_LINE_CAP } from "../src/components/SimpleActivityCard.js";
import { LiveArea, ReasoningBlock } from "../src/components/LiveArea.js";
import { EmptyHero } from "../src/components/EmptyHero.js";
import { DiffView } from "../src/components/DiffView.js";
// F9: the shared visual-suite seams (mount/unmount/decl/prop).
import { decl, mount, prop, unmount } from "./css-test-utils.js";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

/** The raw sheet text — the no-raw-color regression guard reads the source,
 *  not the CSSOM (which silently drops what it cannot parse). */
const STYLES_CSS = stylesCss;
const TOKENS_CSS = tokensCss;

// ---------------------------------------------------------------------------
// §3.1 — user bubbles: accent bg, accent-ink text, 16/16/4/16 radii (fix
// round 1: mockup-v2 的精确值回归——墨线 14px 的中间态退役; padding 10px 14px
// is the sheet's whitelisted optical exception), right-aligned, max-width 78%.
// ---------------------------------------------------------------------------
describe("M64-visual §3 — user bubble (.msg-user .bub)", () => {
  it("renders the text inside .msg-user .bub; the prompt-marker chrome is gone", () => {
    const c = mount(<HistoryItem entry={{ kind: "user", text: "帮我修登录页的 bug" }} />);
    const bub = c.querySelector(".msg-user .bub") as HTMLElement;
    expect(bub).not.toBeNull();
    expect(bub.textContent).toContain("帮我修登录页的 bug");
    expect(c.querySelector(".entry-user")).toBeNull();
    expect(c.querySelector(".prompt")).toBeNull();
  });

  it("keeps the first-line echo for multi-line user text (pre-existing behavior)", () => {
    const c = mount(<HistoryItem entry={{ kind: "user", text: "fix the bug\nsecond line" }} />);
    const bub = c.querySelector(".msg-user .bub") as HTMLElement;
    expect(bub.textContent).toContain("fix the bug …");
    expect(bub.textContent).not.toContain("second line");
  });

  // ω99-275: #13 — 气泡底/字改走专用 token（浅色=accent 淡染形；decl 读声明
  // 值不解析 var()——实际色值的对比度由 omega99-275 测试的直算门守）。
  it("rides the tokens: bubble-user bg/ink, the bubble composed tier, 78% cap, right-aligned", () => {
    mount(<HistoryItem entry={{ kind: "user", text: "x" }} />);
    expect(decl(".msg-user .bub", "background")).toBe("var(--bubble-user-bg)");
    expect(decl(".msg-user .bub", "color")).toBe("var(--bubble-user-ink)");
    // 119 用户反馈修正（圆角统一）: 气泡角改 8px 均匀角（旧 16px 复合角
    // 与整体 6/8 语言不搭，「会话区直角/会话框圆角不统一」主源）——语义档
    // --radius-bubble 保留，与 --radius-md 同值同族。
    expect(decl(".msg-user .bub", "border-radius")).toBe("var(--radius-bubble)");
    expect(prop("--radius-bubble")).toBe("8px");
    expect(decl(".msg-user .bub", "padding")).toBe("10px 14px"); // spec §2 2px-offset optical exception
    expect(decl(".msg-user .bub", "max-width")).toBe("78%");
    expect(decl(".msg-user", "justify-content")).toBe("flex-end");
  });
});

// ---------------------------------------------------------------------------
// §3.2 — assistant: NO bubble; the 墨线 §2/task-6 signature row (16px 小精灵
// 头像 + 「悟道」name); inline code on var(--surface-2).
// ---------------------------------------------------------------------------
describe("墨线 §2 — assistant (.msg-a)", () => {
  it("renders the pet-sprite avatar mount + 悟道 signature above the markdown; no bubble", () => {
    const c = mount(<HistoryItem entry={{ kind: "assistant", text: "修好了 `src/a.ts`" }} />);
    // ω99-275（续，标记见上）— 悟字徽标退役为 .sig-avatar 空挂点（肤图由
    // html[data-pet-skin] 的 CSS 规则给；.sig-glyph 规则保留给「注」徽标，
    // 下方 CSSOM 断言照旧绿）。
    expect(c.querySelector(".msg-a .sig-avatar")).not.toBeNull();
    expect(c.querySelector(".msg-a .sig-glyph")).toBeNull();
    expect(c.querySelector(".msg-a .sig-name")?.textContent).toBe("悟道Harness");
    expect(c.querySelector(".msg-a .bub")).toBeNull();
    // 2026-08-26 §3.1 → 116 弧 B 去框化：正文入 .reply-card 容器（平铺裸底，
    // 卡壳退役——DOM 不变、容器零 border）。
    const card = c.querySelector(".msg-a .reply-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(decl(".reply-card", "border-radius")).toBe("0");
    expect(decl(".reply-card", "background")).toBe("none");
    expect(decl(".reply-card", "padding")).toBe("0");
    expect(c.querySelector(".msg-a code.inline")?.textContent).toBe("src/a.ts");
  });

  it("the signature row is fs-ui/600 on --text-2; inline code rides var(--surface-2), not the accent", () => {
    mount(<HistoryItem entry={{ kind: "assistant", text: "`x`" }} />);
    expect(decl(".msg-sig", "font-size")).toBe("var(--fs-ui)");
    expect(decl(".msg-sig", "font-weight")).toBe("var(--fw-strong)"); // P2 §2.5 字重令牌化
    expect(decl(".msg-sig", "color")).toBe("var(--text-2)");
    expect(decl(".sig-glyph", "background")).toBe("var(--surface-2)");
    expect(decl(".sig-glyph", "color")).toBe("var(--accent)");
    expect(decl("code.inline", "background-color")).toBe("var(--surface-2)");
  });
});

// ---------------------------------------------------------------------------
// §3.3 — activity cards (.act), 墨线 spec §2: a 32px .act-row collapsed
// line (svg status glyph + verb + mono file + right-edge tail + rotating
// chevron; data-status drives the glyph color), typed .act-body capped 8
// lines / 132px inline with internal scroll, .act.err danger border + row.
// ---------------------------------------------------------------------------
describe("M64-visual §3 — activity card (.act)", () => {
  it("collapsed = the 32px row contract: ok svg glyph (sr-only 完成) + verb + mono file + tail + chevron; no body", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2" }} />,
    );
    const row = c.querySelector(".act .act-row") as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.getAttribute("data-status")).toBe("ok");
    expect(row.querySelector(".act-st.st-ok svg")).not.toBeNull(); // IconCheck replaced the ✓ text glyph
    expect(row.querySelector(".sr-only")?.textContent).toBe("完成");
    expect(row.textContent).toContain("读取");
    expect(row.querySelector(".act-file")?.textContent).toBe("src/a.ts");
    expect(row.querySelector(".act-tail")).not.toBeNull(); // right-edge tail (empty note still right-aligns the chevron)
    expect(row.querySelector("svg.act-chev")).not.toBeNull(); // IconChevronDown; [data-open] rotates it
    expect(c.querySelector(".act .act-body")).toBeNull();
    expect(c.querySelector(".act")?.getAttribute("data-kind")).toBe("read");
    expect(c.querySelector(".act")?.getAttribute("data-open")).toBe("false");
  });

  it("expanding reveals the typed body; the inline cap stays 132px, the CSS ceiling is 8·1.65em with INTERNAL scroll", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2" }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body.textContent).toContain("line1");
    expect(body.style.maxHeight).toBe("132px"); // the inline cap stays jsdom-assertable
    expect(decl(".act-body", "max-height")).toBe("calc(8 * 1.65em)");
    expect(decl(".act-body", "overflow-y")).toBe("auto");
    expect(c.querySelector(".act")?.getAttribute("data-open")).toBe("true"); // drives the chevron rotate
  });

  it("the status glyph colors ride data-status: ok → --ok, run → --accent, err → --danger (all sr-only'd)", () => {
    mount(<SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "a", resultPreview: "x" }} />);
    expect(decl('.act-row[data-status="ok"] .act-st', "color")).toBe("var(--ok)");
    expect(decl('.act-row[data-status="run"] .act-st', "color")).toBe("var(--accent)");
    expect(decl('.act-row[data-status="err"] .act-st', "color")).toBe("var(--danger)");
    expect(decl(".sr-only", "position")).toBe("absolute");
    expect(STYLES_CSS).toMatch(/\.sr-only\s*\{/);
  });

  // UI-5 C7-A re-pin: this fixture (a TOOL entry with no resultPreview) is a
  // COMMITTED event on the wire — tool entries only land at
  // tool_call_finished, so the old `preview === "" → run` reading pinned a
  // state the wire cannot produce and spun a successful empty result ◐
  // forever. The HistoryList M3 rule now governs here too: completed reads
  // ✓ ok (err stays ✕); the RUN glyph belongs to the busy rows and the
  // running edit card (pinned in simple-mode.test.tsx's C7-A suite).
  it("a tool entry without a result reads as COMPLETED ✓ (the M3 rule — run is the live surface's state)", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "shell", summary: "npm t" }} />,
    );
    expect(c.querySelector(".act .act-row")?.getAttribute("data-status")).toBe("ok");
    expect(c.querySelector(".act .act-row .act-st.st-run svg.spin")).toBeNull();
    expect(c.querySelector(".act .act-row .sr-only")?.textContent).toBe("完成");
    // cssstyle drops var()-bearing `animation:` shorthands — pin the raw sheet
    // (the suite's no-raw-color guard precedent) for name/duration/iteration.
    expect(STYLES_CSS).toMatch(/\.spin\s*\{\s*animation:\s*spin var\(--dur-slow\) linear infinite;\s*\}/);
    expect(STYLES_CSS).toMatch(/@keyframes spin\s*\{/);
  });

  it("the err variant: ✕ + .act.err danger border and row text; the error's first line stays the collapsed tail", () => {
    const c = mount(
      <SimpleActivityCard
        entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "exit 1: tests failed\nat spec:42" }}
      />,
    );
    expect(c.querySelector(".act.err")).not.toBeNull();
    expect(c.querySelector(".act .act-row")?.getAttribute("data-status")).toBe("err");
    expect(c.querySelector(".act .act-row .act-st.st-err")?.textContent).toBe("✕"); // the deliberate text glyph
    const tail = c.querySelector(".act .act-row .act-tail") as HTMLElement;
    expect(tail?.textContent).toContain("exit 1: tests failed");
    expect(decl(".act.err", "border-color")).toBe("rgb(var(--danger-rgb) / .4)");
    expect(decl('.act-row[data-status="err"]', "color")).toBe("var(--danger)");
    expect(decl('.act-row[data-status="err"] .act-tail', "color")).toBe("var(--danger)");
  });

  // 墨线 T15 终门 — the row speaks ONE class in all three states: `.act-row`
  // stays bare; the state rides data-status (ok/run/err) — no per-state class
  // ever leaks onto the row (the st-ok/st-run/st-err suffixes live on the
  // glyph span, pinned in the tests above).
  it("T15 gate — .act-row stays exactly `act-row` across ok/run/err (state rides data-status)", () => {
    const ok = mount(<SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "a", resultPreview: "x" }} />);
    const okRow = ok.querySelector(".act .act-row") as HTMLElement;
    expect(okRow.className).toBe("act-row");
    expect(okRow.getAttribute("data-status")).toBe("ok");
    // UI-5 C7-A: the run arm rides the RUNNING edit card (a real in-flight
    // state) — the old no-preview tool fixture pinned the retired heuristic.
    const run = mount(
      <SimpleActivityCard entry={{ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }} running={true} />,
    );
    const runRow = run.querySelector(".act .act-row") as HTMLElement;
    expect(runRow.className).toBe("act-row");
    expect(runRow.getAttribute("data-status")).toBe("run");
    const err = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "exit 1" }} />,
    );
    const errRow = err.querySelector(".act .act-row") as HTMLElement;
    expect(errRow.className).toBe("act-row");
    expect(errRow.getAttribute("data-status")).toBe("err");
  });

  // 0.3.82（0.3.81 凌乱反馈）: the ADVANCED face's edit entries ride the SAME
  // card — HistoryItem's edit case renders the shared EditCard (a collapsed
  // 「修改 <path> 查看改动」 row), retiring the bare always-open DiffView that
  // dumped loose diffs into the conversation. The running flag (the App's
  // identity-stable path set) spins the row ◐ until the write lands.
  it("0.3.82: a HistoryItem edit entry renders the collapsed shared EditCard; running spins ◐", async () => {
    const entry = { kind: "edit", path: "car3d.html", oldString: "makeWheel(-1.42, .86);", newString: "makeWheel(-1.42, .8);" } as const;
    const settled = mount(<HistoryItem entry={{ ...entry }} />);
    const card = settled.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-open")).toBe("false"); // collapsed by default — no loose diff
    expect(card.getAttribute("data-status")).toBe("ok"); // no running flag → settled ✓
    expect(settled.querySelector(".diff")).toBeNull(); // the diff body is folded away
    expect(settled.querySelector(".act-row .act-verb")?.textContent).toBe("修改");
    expect(settled.querySelector(".act-row .act-file")?.textContent).toBe("car3d.html");
    expect(settled.querySelector(".act-row .act-tail")?.textContent).toContain("查看改动");
    // The running arm: the in-flight write reads ◐, the tail names the phase.
    const live = mount(<HistoryItem entry={{ ...entry }} running={true} />);
    const liveCard = live.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(liveCard.getAttribute("data-status")).toBe("run");
    expect(live.querySelector(".act-row[data-status='run'] .act-st.st-run svg.spin")).not.toBeNull();
    expect(live.querySelector(".act-row .act-tail")?.textContent).toContain("正在写入…");
    // One click opens the folded diff (the 查看改动 contract).
    await act(async () => {
      (live.querySelector(".act-row") as HTMLButtonElement).click();
    });
    expect(live.querySelector(".act[data-kind='diff']")?.getAttribute("data-open")).toBe("true");
    expect(live.textContent).toContain("- makeWheel(-1.42, .86);");
    expect(live.textContent).toContain("+ makeWheel(-1.42, .8);");
  });

  it("the card chrome rides the tokens: surface card, hairline border, card radius, the 32px mono row", () => {
    expect(decl(".act", "background")).toBe("var(--surface)");
    expect(decl(".act", "border-color")).toBe("var(--hair-1)");
    expect(decl(".act", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".act-row", "height")).toBe("32px");
    expect(decl(".act-row", "font-size")).toBe("var(--fs-ui)");
    expect(decl(".act-file", "color")).toBe("var(--text-1)");
    expect(decl(".act-file", "font-size")).toBe("var(--fs-caption)");
  });

  it("the 8-line content cap still holds (behavior, unchanged)", async () => {
    const preview = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "big.ts", resultPreview: preview }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body.textContent).toContain(`line-${CARD_LINE_CAP}`);
    expect(body.textContent).not.toContain(`line-${CARD_LINE_CAP + 1}`);
    // M76-ux2 §2: the truncation notice is the 展开 toggle now.
    expect(c.querySelector(".activity-toggle")?.textContent).toBe(`展开 ▾ (12 行)`);
  });
});

// ---------------------------------------------------------------------------
// §3.4 — DiffView: deleted-line tint derived from --danger, added-line from
// --ok (readable in both themes by construction).
// ---------------------------------------------------------------------------
describe("M64-visual §3 — diff red/green on the tokens", () => {
  it("row tints + word-level highlights are channel-token alpha forms on --danger/--ok, no raw rgba", () => {
    expect(decl(".diff .del", "color")).toBe("var(--danger)");
    expect(decl(".diff .del", "background")).toBe("rgb(var(--danger-rgb) / .1)");
    expect(decl(".diff .add", "color")).toBe("var(--ok)");
    expect(decl(".diff .add", "background")).toBe("rgb(var(--ok-rgb) / .1)");
    expect(decl(".diff .del .wchg", "background")).toBe("rgb(var(--danger-rgb) / .3)");
    expect(decl(".diff .add .wchg", "background")).toBe("rgb(var(--ok-rgb) / .3)");
  });

  it("the view still marks rows (behavior unchanged) through the act card's diff body", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "edit", path: "src/a.ts", oldString: "a\nb", newString: "a\nB" }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    expect(c.textContent).toContain("- b");
    expect(c.textContent).toContain("+ B");
  });
});

// ---------------------------------------------------------------------------
// §3.5 — the empty hero: 52px rounded accent 悟 logo, headline, subtitle,
// three task chips with the SAME prefill wiring.
// ---------------------------------------------------------------------------
describe("M64-visual §3 — EmptyHero", () => {
  it("renders the pet-frame logo (64×40, transparent sprite — 品牌弧 09-15 悟字退役) + welcome headline + intro", () => {
    const c = mount(<EmptyHero />);
    // 品牌弧补丁（09-15 用户令「这段文本上面的小精灵图标去掉」）：欢迎页
    // logo 整体退役——问候语直接领衔（连接卡 logo 是另一景保留）。
    expect(c.querySelector(".hero .logo")).toBeNull();
    // ω99-167: the hero introduces the buddy (用户令「搞点友好的欢迎或者自我介绍」).
    expect(c.querySelector(".hero h1")?.textContent).toContain("你好呀，我是悟道Harness");
    expect(c.querySelector(".hero p")?.textContent).not.toBe("");
  });

  it("ω99-167: NO preset chips of any kind — zero .hero buttons (anti-resurrection)", () => {
    const c = mount(<EmptyHero />);
    expect(c.querySelectorAll(".hero .task").length).toBe(0);
    expect(c.querySelectorAll(".hero .hero-ask").length).toBe(0);
    expect(c.querySelectorAll(".hero button").length).toBe(0); // 修个 bug/写个页面/常用吩咐 一颗都不许回来
    expect(c.querySelector(".hero .hero-hint")?.textContent).toContain("直接打字吩咐我");
  });
});

// ---------------------------------------------------------------------------
// §3.6 — Task 1's deferred raw-color migration: styles.css carries NO raw
// hex/rgba (everything is token-derived — channel-token alpha forms included), the syntax
// palette + overlay live as per-theme tokens, and the red-discipline sweep
// holds: --danger on INTERACTIVE HOVER only at the three enumerated
// destructive sites.
// ---------------------------------------------------------------------------
describe("M64-visual §3 — deferred hex migration + red-discipline sweep", () => {
  // ui-review-r1 I6: the full CSS named-color roster. transparent and
  // currentcolor are DELIBERATELY absent — they are the sheet's sanctioned
  // alpha/inheriting idioms, not raw-color escapes.
  const NAMED_COLORS = [
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
    "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
    "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
    "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
    "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
    "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia",
    "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink",
    "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
    "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
    "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey",
    "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
    "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen",
    "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
    "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
    "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue",
    "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown",
    "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow",
    "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
    "whitesmoke", "yellow", "yellowgreen",
  ];

  it("styles.css declares no raw hex, rgb()/hsl()/hwb() literals, or bare named-color keywords (tokens only)", () => {
    expect(STYLES_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // rgb( is legal ONLY as the channel-token alpha form rgb(var(--X-rgb) / a):
    // the old desktop WKWebView cannot compute color-mix, so every tint in the
    // sheet must reduce to this engine-safe form; a raw rgb(a,b,c) literal
    // with numeric channels stays banned.
    expect(STYLES_CSS).not.toMatch(/rgba?\((?!var\()/);
    expect(STYLES_CSS).not.toMatch(/\bhsla?\(/);
    expect(STYLES_CSS).not.toMatch(/\bhwb\(/);
    // I6: the keyword sweep scans DECLARATION VALUES only — a color word in
    // a comment, a property name (white-space), or a pseudo-class selector
    // segment (`:hover[data-accent="black"]`) is not a color. Comments are
    // stripped first, then only rule BODIES ({...} interiors) are scanned,
    // so selector/at-rule preludes never feed the roster.
    const noComments = STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleBodies = noComments.match(/\{[^{}]*\}/g) ?? [];
    const declarations = ruleBodies.flatMap((b) => [...b.matchAll(/:\s*[^;{}]+/g)].map((m) => m[0] as string));
    const used = new Set<string>();
    for (const d of declarations) {
      for (const k of NAMED_COLORS) {
        if (new RegExp(`\\b${k}\\b`, "i").test(d)) used.add(k);
      }
    }
    expect([...used].sort(), "bare named-color keywords leaked into styles.css").toEqual([]);
    // The wizard scrim is an alpha form on the bg channel token now (the
    // legacy --shade operand stays archived in tokens.css, unreferenced).
    expect(decl(".wizard-overlay", "background")).toBe("rgb(var(--bg-rgb) / .86)");
    expect(TOKENS_CSS).toMatch(/--shade\s*:\s*#/);
  });

  it("the .tok-* syntax palette rides per-theme tokens", () => {
    expect(decl(".tok-key", "color")).toBe("var(--tok-key)");
    expect(decl(".tok-str", "color")).toBe("var(--tok-str)");
    expect(decl(".tok-com", "color")).toBe("var(--tok-com)");
    expect(decl(".tok-num", "color")).toBe("var(--tok-num)");
    expect(decl(".tok-fn", "color")).toBe("var(--tok-fn)");
    // Dark default resolves; light overrides with its own readable palette.
    expect(prop("--tok-key")).toBe("#c678dd");
    applyTheme("light");
    expect(prop("--tok-key")).not.toBe("#c678dd");
    expect(prop("--tok-key")).not.toBe("");
  });

  it("banner + overlay + simple-error tints are token-derived", () => {
    expect(decl(".banner", "background")).toBe("rgb(var(--warn-rgb) / .12)");
    // ω99-301: the legacy .overlay rule is retired — the family scrim carries
    // the same per-theme token.
    expect(decl(".scrim", "background")).toBe("var(--overlay)");
    expect(decl(".simple-error", "border-color")).toBe("rgb(var(--danger-rgb) / .4)");
    expect(prop("--overlay")).not.toBe("");
    applyTheme("light");
    expect(prop("--overlay")).not.toBe("");
    expect(TOKENS_CSS).toContain("--overlay");
  });

  it("red discipline: --danger on interactive :hover ONLY at the enumerated destructive sites", () => {
    const dangerHovers = new Set<string>();
    for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
      for (const rule of [...sheet.cssRules]) {
        // The channel form rgb(var(--danger-rgb) / a) is the same discipline
        // (danger-tinted hover) — the sweep recognizes both spellings.
        if (rule instanceof CSSStyleRule && rule.selectorText.includes(":hover") && (rule.style.cssText.includes("var(--danger)") || rule.style.cssText.includes("var(--danger-rgb)"))) {
          dangerHovers.add(rule.selectorText);
        }
      }
    }
    expect([...dangerHovers].sort()).toEqual([
      ".approval .deny:hover:not(:disabled)",
      ".composer .chip.interrupt:hover:not(:disabled)",
      // ω99-55: the file-rail × — the image-rail ×'s file-lane twin.
      ".file-card .rm:hover",
      // M79b: the image-rail × — same family as the parked-chip drop (a
      // small destructive affordance inside a chip/thumb).
      ".img-thumb .rm:hover",
      // round 6: the ModelConfigModal's row × — the 0.3.24 model-table ×
      // moved into the modal (the page read row has no delete).
      ".mcm-row .mcm-del:hover:not(:disabled)",
      ".parked-chip .drop:hover",
      // 借鉴弧 α2: the queued steer's recall — the parked-chip drop's
      // server-queue sibling (same small destructive affordance family).
      ".recall:hover",
      // ω99-317: the schedules panel's row delete — the enumerated family's
      // breaker-panel member (same channel-token danger form).
      ".sch-act.sch-del:hover",
      // ω99-279 (516daab9): the search-pop session list's delete × and its
      // confirm-OK state — session deletion is the enumerated family's
      // newest member (del-cancel hover stays surface-2, not danger).
      ".search-pop .session-item .session-del-ok:hover",
      ".search-pop .session-item .session-del:hover",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Final-review F1 — the mockup's .col discipline: the conversation column
// caps to the SAME content width the composer/approval card centers on, so
// messages never misalign with the 752px card on wide windows.
// ---------------------------------------------------------------------------
describe("final-review F1 — the .chat column cap", () => {
  it(".chat's max-width IS the composer's (both center on --content-max + 32px)", () => {
    expect(decl(".chat", "max-width")).toBe(decl(".composer", "max-width"));
    expect(decl(".chat", "max-width")).toBe("calc(var(--content-max) + 32px)");
    // The column fills that cap and centers in the shell, like the card.
    expect(decl(".chat", "width")).toBe("100%");
    expect(decl(".chat", "margin")).toBe("0 auto");
  });
});

// ---------------------------------------------------------------------------
// M65-space §2 — edge-to-edge: the app shell fills the window (no 64rem cap
// — the topbar/statusbar strips span the full width and the body bg IS the
// window bg, no second band beside a capped shell), the conversation flow
// hugs the window edge (6px 16px, was .8rem 1rem), and the composer wrap
// sits 12px off the bottom (was 1rem).
// ---------------------------------------------------------------------------
describe("M65-space §2 — edge-to-edge flow", () => {
  it(".chat (the flow) rides the window edge: computed padding 8px 16px", () => {
    // ω99-300: 间距字面归队令牌（零视觉漂移——var 值即原 8px/16px）。
    expect(decl(".chat", "padding")).toBe("var(--sp-2) var(--sp-4)"); // 墨线间距:6→8 (4 的倍数)
  });

  it(".inputarea (the composer wrap) keeps a 12px bottom inset off the window edge", () => {
    expect(decl(".inputarea", "padding")).toBe("var(--sp-1) 0 var(--sp-1)"); // 09-27: 侧撤+底收紧（同宽+底对齐）
  });

  it(".app fills the window: no shell cap, no centering margin — the strips span the full width", () => {
    // The absence is pinned off the raw sheet (decl() throws on an undeclared
    // property, and jsdom cannot express "not declared" through the CSSOM).
    expect(STYLES_CSS).not.toMatch(/\.app\s*\{[^}]*max-width/s);
    expect(STYLES_CSS).not.toMatch(/\.app\s*\{[^}]*margin/s);
    expect(decl(".app", "display")).toBe("flex"); // the rule itself stays live
  });
});

// ---------------------------------------------------------------------------
// 墨线 T10 (spec §5) — the tool-flow timeline panel: LiveArea's list is a
// hairline-separated TIMELINE (.panel > .panel-head[.panel-title +
// .panel-count] + .panel-list), rows REUSING the Task-5 .act/.act-row
// contract (no forked CSS — the card chrome yields to the list seams via a
// scoped strip); the statusline is absorbed as the shell's bottom edge row
// (.statusline, 28px caption mono, NO surface band — 墨线下它就是底缘行).
// ---------------------------------------------------------------------------
describe("墨线 T10 — tool-flow timeline panel (.panel) + statusline skin", () => {
  /** The busy-turn snapshot the panel renders — three in-flight tools (one
   *  gating) are the "events" the head counts and the rows timelines. */
  const live: LiveState = {
    reasoning: "l1\nl2\nl3\nthinking hard about it",
    answer: "partial ans",
    busyTools: [
      { name: "read_file", summary: "src/a.ts", gating: false },
      { name: "grep", summary: "panel", gating: false },
      { name: "shell", summary: "npm t", gating: true },
    ],
  };

  it("tool panel: head carries title + mono count; rows share .act-row", () => {
    const c = mount(<LiveArea live={live} queued={[]} />);
    expect(c.querySelector(".panel-head .panel-title")?.textContent).toBe("工具流");
    // ω99-160: 计数词随源中文化——钉的是计数与「工具流」标题同现，文案随源走。
    expect(c.querySelector(".panel-count")?.textContent).toMatch(/\d+ 项/);
    expect(c.querySelector(".panel-count")?.textContent).toBe(`${live.busyTools.length} 项`);
    expect(c.querySelectorAll(".act-row").length).toBe(live.busyTools.length);
  });

  it("#451: no ghost panel — a tool-less turn renders NO 工具流 box", () => {
    // A pure answering turn (the 0.3.81 clutter report): no tools, no
    // reasoning block, nothing queued → the panel must not appear at all
    // (a 「工具流 0 项」head above a bare streaming answer is noise).
    const c = mount(<LiveArea live={{ reasoning: "", answer: "只有回答", busyTools: [] }} queued={[]} />);
    expect(c.querySelector(".panel")).toBeNull();
    expect(c.querySelector(".live-answer")).not.toBeNull(); // the answer still streams
    // …and each real content source alone still opens the panel.
    const withReasoning = mount(<LiveArea live={{ reasoning: "想", answer: "", busyTools: [] }} queued={[]} />);
    expect(withReasoning.querySelector(".panel")).not.toBeNull();
    const withQueued = mount(<LiveArea live={{ reasoning: "", answer: "", busyTools: [] }} queued={["等"]} />);
    expect(withQueued.querySelector(".panel")).not.toBeNull();
  });

  it("busy rows reuse the Task-5 contract: .act root[data-kind][data-status] > .act-row (st-run spin + verb + mono file + gating tail), no chevron/body", () => {
    const c = mount(<LiveArea live={live} queued={[]} />);
    const roots = [...c.querySelectorAll(".panel-list > .act")] as HTMLElement[];
    expect(roots.length).toBe(live.busyTools.length);
    expect(roots.map((r) => r.getAttribute("data-status"))).toEqual(["run", "run", "run"]);
    expect(roots[0]?.getAttribute("data-kind")).toBe("read"); // the same kind table the cards read
    expect(roots[2]?.getAttribute("data-kind")).toBe("inout");
    expect(c.querySelector(".act-row[data-status='run'] .act-st.st-run .spin")).not.toBeNull();
    expect(c.querySelector(".act-row .act-verb")?.textContent).toBe("读取");
    expect(c.querySelector(".act-row .act-file")?.textContent).toBe("src/a.ts");
    // ω99-160: gating 尾随源中文化——钉的是 gating 尾在场，文案随源走。
    expect(c.querySelector(".act-tail.gating")?.textContent).toContain("检查中");
    expect(c.querySelector(".act-row .act-chev")).toBeNull(); // nothing to expand while busy
    expect(c.querySelector(".act .act-body")).toBeNull();
  });

  // T5 寄存项 (controller r1, T11 scope): the braille .spin surface converts
  // to IconSpinner — the same static-arc-plus-.spin-rotation idiom the
  // history cards use (SimpleActivityCard), not a forked animation.
  it("the busy spinner is IconSpinner's static arc: svg.spin, the slot carries no braille frames", () => {
    const c = mount(<LiveArea live={live} queued={[]} />);
    expect(c.querySelector(".act-row[data-status='run'] .act-st.st-run svg.spin")).not.toBeNull();
    // The glyph is the svg alone — the braille text frames are gone.
    expect(c.querySelector(".act-row[data-status='run'] .act-st.st-run")?.textContent).toBe("");
  });

  it("the reasoning head / answer / steering queue ride the same timeline (hairline children of .panel-list)", () => {
    const c = mount(<LiveArea live={live} queued={["steer this"]} />);
    expect(c.querySelector(".panel-list > details.reasoning")).not.toBeNull();
    // 2026-08-26 §3.2: the answer moved OUT of the timeline — it rides below
    // the panel in the same AssistantReply card the history commits.
    expect(c.querySelector(".panel-list .live-answer")).toBeNull();
    const ans = c.querySelector(".live-answer") as HTMLElement;
    expect(ans.closest(".panel-list")).toBeNull();
    expect(ans.querySelector(".reply-card")).not.toBeNull();
    expect(ans.querySelector(".reply-card")?.textContent).toBe("partial ans▌"); // byline excluded
    // ω99-160: steering 行随源中文化（前缀镜像简洁面词表）——钉的是 .steer 队列行在场，文案随源走。
    expect(c.querySelector(".panel-list > .steer")?.textContent).toContain("将在下一步前注入:steer this");
  });

  it("panel chrome: border-left hairline, 34px head, mono count; separators are the adjacent-sibling rule (no dangling last border)", () => {
    // (border in LONGHANDs — the .act precedent: cssstyle drops var()-bearing
    // border-left: shorthands, so the pins read the longhands.)
    expect(decl(".panel", "border-left-width")).toBe("1px");
    expect(decl(".panel", "border-left-color")).toBe("var(--hair-1)");
    expect(decl(".panel-head", "height")).toBe("34px");
    expect(decl(".panel-head", "padding-left")).toBe("var(--sp-3)");
    // The head's border-bottom keeps the brief's shorthand form (cssstyle
    // drops var()-bearing shorthands) — pin it off the raw sheet.
    expect(STYLES_CSS).toMatch(/\.panel-head\s*\{[^}]*border-bottom:\s*1px solid var\(--hair-1\);/s);
    expect(decl(".panel-title", "font-size")).toBe("var(--fs-ui)");
    expect(decl(".panel-title", "font-weight")).toBe("var(--fw-medium)"); // P2 §2.5 字重令牌化
    expect(decl(".panel-title", "color")).toBe("var(--text-1)");
    expect(decl(".panel-count", "font-family")).toBe("var(--mono)");
    expect(decl(".panel-count", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".panel-count", "color")).toBe("var(--text-3)");
    expect(decl(".panel-list", "overflow-y")).toBe("auto");
    // Controller r1: the CSS-block form (adjacent-sibling border-top) beats the
    // prose's per-row border-bottom — no dangling hairline after the last row.
    expect(STYLES_CSS).toMatch(/\.panel-list > \* \+ \*\s*\{\s*border-top:\s*1px solid var\(--hair-1\);\s*\}/);
    // Reuse, not fork: the .act card chrome yields to the list seams via a
    // SCOPED strip (no copied declarations, the card rules stay one source).
    expect(decl(".panel-list > .act", "border-width")).toBe("0");
    expect(decl(".panel-list > .act", "border-radius")).toBe("0");
    expect(decl(".panel-list > .act", "background")).toBe("none");
  });

  it("statusline lives at panel bottom (28px, mono caption, no surface band)", () => {
    // The brief's own regex: the caption tier precedes the mono stack.
    expect(STYLES_CSS).toMatch(/\.statusline\s*\{[^}]*var\(--fs-caption\)[^}]*var\(--mono\)/s);
    expect(decl(".statusline", "height")).toBe("28px");
    expect(decl(".statusline", "color")).toBe("var(--text-3)");
    expect(decl(".statusline", "border-top")).toContain("var(--hair-1)");
    // 去surface底色: the bottom edge row sits on the window bg — no band.
    expect(STYLES_CSS).not.toMatch(/\.statusline\s*\{[^}]*background/s);
  });
});

// ---------------------------------------------------------------------------
// UI-3 — 流式 pending 质感：C3 the statusline's right-edge busy segment
// (`▌思考中 · Ns`, mockup P4), C4 the live-answer typing cursor (one blink
// keyframes, accent, reduced-motion collapses to static), and the C1 scoped
// cursor pin for the simple face's busy rows (a busy tool has no body).
// ---------------------------------------------------------------------------
describe("UI-3 — streaming pending polish (C3 busy segment + C4 caret)", () => {
  const live: (over: Partial<{ reasoning: string; answer: string; busyTools: { name: string; summary: string }[] }>) => LiveState = (
    over,
  ) => ({ reasoning: "", answer: "", busyTools: [], ...over });

  const status: (over: Partial<DriverStatus>) => DriverStatus = (over) => ({
    live: live({}),
    busy: false,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "wudao-test-0001",
    sidecar: null,
    ...over,
  });

  it("C4: the caret is LiveAnswer's tail — one aria-hidden ▌ span on the streaming text", () => {
    const c = mount(<LiveArea live={live({ answer: "流式中" })} queued={[]} />);
    const caret = c.querySelector(".live-answer .caret") as HTMLElement;
    expect(caret).not.toBeNull();
    expect(caret.textContent).toBe("▌");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    // The cursor rides INSIDE the answer element (padding unaffected), after the text.
    expect(caret.previousSibling?.textContent).toBe("流式中");
  });

  it("C4 pin: accent color, the ONE blink keyframes, hard steps — and no global blink utility", () => {
    expect(decl(".live-answer .caret", "color")).toBe("var(--accent)");
    expect(STYLES_CSS).toMatch(/\.live-answer \.caret\s*\{[^}]*color:\s*var\(--accent\);[^}]*animation:\s*blink 1s steps\(1\) infinite;/s);
    expect(STYLES_CSS).toMatch(/@keyframes blink\s*\{[^}]*50%\s*\{\s*opacity:\s*0;\s*\}/s);
    // 动画只此一处：exactly one consumer rule and one keyframes block, sheet-wide.
    expect(STYLES_CSS.match(/animation:[^;]*\bblink\b/g)?.length).toBe(1);
    expect(STYLES_CSS.match(/@keyframes blink\b/g)?.length).toBe(1);
    // prefers-reduced-motion keeps its global collapse (one iteration → static).
    expect(STYLES_CSS).toMatch(/prefers-reduced-motion[\s\S]*animation-iteration-count:\s*1\s*!important/);
  });

  it("C1 pin: the simple face's busy rows keep the pointer honest — .turnlive .act-row never promises a body", () => {
    expect(decl(".turnlive .act-row", "cursor")).toBe("default");
  });

  it("C3: busy (no ask) shows the right-edge segment after the 1s throttle; the label follows the phase; idle and asked turns stay quiet", async () => {
    vi.useFakeTimers();
    try {
      const c = mount(<StatusBar status={status({ busy: true, live: live({ reasoning: "想" }) })} />);
      expect(c.querySelector(".seg-busy")).toBeNull(); // the 1s throttle: nothing at t=0
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const seg = c.querySelector(".statusline > .seg-busy") as HTMLElement;
      expect(seg).not.toBeNull();
      expect(seg.textContent).toBe("▌思考中 · 1s");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect((c.querySelector(".statusline > .seg-busy") as HTMLElement).textContent).toBe("▌思考中 · 3s");
      // It rides OUTSIDE the sep chain — the strip's last child (a trailing
      // sep would dangle mid-gap; the clock never emits one).
      expect(seg.nextElementSibling).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // The label follows the SAME phase derivation the simple turn status reads.
    vi.useFakeTimers();
    try {
      const tools = mount(<StatusBar status={status({ busy: true, live: live({ busyTools: [{ name: "grep", summary: "x" }] }) })} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(tools.querySelector(".seg-busy")?.textContent).toBe("▌执行中 · 1s");
      const answering = mount(<StatusBar status={status({ busy: true, live: live({ answer: "a" }) })} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(answering.querySelector(".seg-busy")?.textContent).toBe("▌回复中 · 1s");
      const working = mount(<StatusBar status={status({ busy: true })} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(working.querySelector(".seg-busy")?.textContent).toBe("▌处理中 · 1s");
    } finally {
      vi.useRealTimers();
    }

    // Idle: no segment, ever; a parked ASK hides it too — the turn waits on
    // the user, and the amber card owns the attention.
    vi.useFakeTimers();
    try {
      const idle = mount(<StatusBar status={status({})} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(idle.querySelector(".seg-busy")).toBeNull();
      const asked = mount(
        <StatusBar
          status={status({
            busy: true,
            live: live({ reasoning: "想" }),
            pendingPermission: { toolName: "shell", summary: "s", input: {} },
          })}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(asked.querySelector(".seg-busy")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("C3 pin: the busy segment's geometry — right-edge auto margin, accent, flex-none", () => {
    expect(decl(".statusline .seg-busy", "margin-left")).toBe("auto");
    expect(decl(".statusline .seg-busy", "color")).toBe("var(--accent)");
    expect(decl(".statusline .seg-busy", "flex")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 0.3.8 — thinking 可见化（用户反馈：think 过程要展示）：思考中自动展开、
// 正文开始自动收起、用户手动开合优先；落定回复卡携带思考流。
// ---------------------------------------------------------------------------
describe("0.3.8 — ReasoningBlock: the thought is visible while it streams", () => {
  it("streaming: auto-expanded with the 思考中 label; the full text rides the body", () => {
    const c = mount(<ReasoningBlock text={"第一步\n第二步"} streaming={true} />);
    const d = c.querySelector("details.reasoning") as HTMLDetailsElement;
    expect(d.open).toBe(true);
    expect(d.getAttribute("data-streaming")).toBe("true");
    expect(d.querySelector("summary")?.textContent).toContain("思考中");
    expect(d.querySelector(".body")?.textContent).toBe("第一步\n第二步");
    // 0.3.81 精修: NO ▌ in the streaming summary — the fake cursor is gone
    // (a ▌ that never blinks reads as a glyph, not a caret; the real one
    // lives on the streaming answer, the phase motion on the status row).
    expect(d.querySelector("summary")?.textContent).not.toContain("▌");
  });

  it("concluded (default): collapsed with the char-count label — old-server frames without the flag render identically", () => {
    const c = mount(<ReasoningBlock text="想了很多" />);
    const d = c.querySelector("details.reasoning") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector("summary")?.textContent).toContain("思考过程");
    expect(d.querySelector("summary")?.textContent).toContain("4 字");
    expect(d.querySelector(".body")?.textContent).toBe("想了很多");
  });

  it("user toggles win: a user-collapsed thought stays collapsed across re-renders (no forced reopen mid-thought)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = createRoot(container);
    act(() => r.render(<ReasoningBlock text="思考流" streaming={true} />));
    const d = container.querySelector("details.reasoning") as HTMLDetailsElement;
    expect(d.open).toBe(true);
    act(() => { (d.querySelector("summary") as HTMLElement).click(); });
    expect(d.open).toBe(false); // the details element toggled itself off
    // Same streaming=true re-render with more text: the user's choice holds —
    // the auto-open effect must not force it back open.
    act(() => r.render(<ReasoningBlock text="思考流变长" streaming={true} />));
    expect(d.open).toBe(false);
    act(() => r.unmount());
    container.remove();
  });

  it("the committed reply card carries its thought — OPEN block above the body (10-27 产品原则：LLM 返回的任何内容都展示；用户可收起)；reasoning-less replies unchanged", () => {
    const c = mount(<HistoryItem entry={{ kind: "assistant", text: "答案", reasoning: "思考全文" }} />);
    const d = c.querySelector(".reply-card > details.reasoning") as HTMLDetailsElement;
    expect(d).not.toBeNull();
    expect(d.open).toBe(true);
    expect(d.querySelector(".body")?.textContent).toBe("思考全文");
    expect(c.querySelector(".reply-card")?.textContent).toContain("答案");
    // The pre-0.3.8 shape (no reasoning field) renders no block — zero change.
    const c2 = mount(<HistoryItem entry={{ kind: "assistant", text: "plain" }} />);
    expect(c2.querySelector("details.reasoning")).toBeNull();
  });

  it("css pins: the thought body is viewport-bounded (220px internal scroll) with a seam inside the reply card", () => {
    expect(decl("details.reasoning .body", "max-height")).toBe("220px");
    expect(decl("details.reasoning .body", "overflow-y")).toBe("auto");
    expect(decl(".reply-card > details.reasoning", "margin-bottom")).toBe("var(--sp-2)");
  });
});

// ---------------------------------------------------------------------------
// 0.3.9 — 注入上下文卡（meta_note card:true）：回复卡形态（署名「注 ·
// 系统注入」+ .reply-card），非居中胶囊；detail 展开机制照搬；胶囊专属
// harness 内部状态（用户裁定边界）。
// ---------------------------------------------------------------------------
describe("0.3.9 — InjectedCard: the model-visible context rides a reply card, not a capsule", () => {
  it("card notice renders the byline + reply-card preview row — no capsule", () => {
    const c = mount(
      <HistoryItem entry={{ kind: "notice", text: "You have superpowers. Below is the full content", card: true, detail: "full injected text" }} />,
    );
    expect(c.querySelector(".msg-inject .sig-glyph")?.textContent).toBe("注");
    expect(c.querySelector(".msg-inject .sig-name")?.textContent).toBe("系统注入");
    const card = c.querySelector(".msg-inject .reply-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector(".inject-line")?.textContent).toContain("You have superpowers");
    expect(c.querySelector(".notice-bub")).toBeNull(); // 胶囊专属 harness 状态
    expect(c.querySelector(".entry-notice")).toBeNull();
  });

  it("clicking the head expands the full text inside the card; clicking again collapses", () => {
    const c = mount(
      <HistoryItem entry={{ kind: "notice", text: "preview", card: true, detail: "full injected text" }} />,
    );
    const head = c.querySelector("button.inject-head") as HTMLButtonElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".notice-detail")).toBeNull();
    act(() => { head.click(); });
    const detail = c.querySelector(".reply-card .notice-detail") as HTMLElement;
    expect(detail?.textContent).toBe("full injected text");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    act(() => { head.click(); });
    expect(c.querySelector(".notice-detail")).toBeNull();
  });

  it("a detail-less card is a static row (div, not a button — nothing to expand)", () => {
    const c = mount(<HistoryItem entry={{ kind: "notice", text: "short injection", card: true }} />);
    expect(c.querySelector("button.inject-head")).toBeNull();
    expect(c.querySelector("div.inject-head")).not.toBeNull();
    expect(c.querySelector(".inject-chev")).toBeNull();
  });

  it("css pins: neutral byline glyph (no accent), single-line ellipsis preview, full-width detail in card", () => {
    expect(decl(".msg-inject .sig-glyph", "color")).toBe("var(--text-2)");
    expect(decl(".inject-head .inject-line", "text-overflow")).toBe("ellipsis");
    expect(decl(".inject-head .inject-line", "white-space")).toBe("nowrap");
    expect(decl(".reply-card .notice-detail", "max-width")).toBe("none");
  });

  // 0.3.10（用户反馈：「系统注入」太潦草，是什么钩子就标注清楚）：
  // source 字段渲染为卡的署名——具体机制名替代笼统回退。
  it("source label rides the byline — the card names its hook; fallback unchanged when absent", () => {
    const c = mount(
      <HistoryItem entry={{ kind: "notice", text: "You have superpowers…", card: true, source: "SessionStart 钩子（startup）" }} />,
    );
    expect(c.querySelector(".msg-inject .sig-name")?.textContent).toBe("SessionStart 钩子（startup）");
    // append-only：老条目（无 source）回退「系统注入」，形态不变。
    const c2 = mount(<HistoryItem entry={{ kind: "notice", text: "legacy injection", card: true }} />);
    expect(c2.querySelector(".msg-inject .sig-name")?.textContent).toBe("系统注入");
  });

  // 0.3.10（用户反馈：思考过程左侧两个三角）：WebKit 原生披露三角必须显式
  // 关闭——list-style:none 在 WKWebView 管不到 ::-webkit-details-marker，
  // 自绘 ▸/▾ 是唯一三角。
  it("css pin: the WebKit native disclosure marker is hidden (one triangle, not two)", () => {
    expect(decl("details.reasoning > summary::-webkit-details-marker", "display")).toBe("none");
  });
});
