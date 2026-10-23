// @vitest-environment jsdom
// 119 弧 — 0.4.2 用户视觉反馈修正的收据套件（大区统一画布 + 圆角单一 scale）。
// 用户原话：「现在的样式更丑了，尤其是背景和工作区域的颜色，感觉对比有点过于
// 强烈；此外，会话区域的边角是直角，会话框的边角是圆角，不统一。请使用同一种
// 设计规范」。
//   ① 大区统一画布：页面级大区（body 画布 / 侧栏 .sb / 文件树域 .filetree /
//      标签条 .tabbar / 查看器 .fileviewer / 面包屑条 .breadcrumb）全部落在
//      --bg 同色上，区域分界只靠 hair-1 发丝线（topbar「去实底」律推广到
//      全部页面级条带）；arc116 的 3~5 HSL-L 大区阶梯自 page 尺度退役——
//      阶梯令牌本身不动（dsh 的步进是给浮起小卡的，卡片/浮层照旧消费）。
//   ② surface 归口：--surface=浮层与卡面专用；--surface-2=卡内嵌面（菜单行
//      hover / chip 选中 / 警示卡内 cmd 嵌条）；画布上的 hover=+1 档
//      （surface）——旧「画布 surface-2 双步 hover」是大区阶梯的遗留。
//   ③ 圆角 census（零裸值零越族）：全站 radius 消费点逐选择器归档——
//      lg 12=浮层（菜单/弹窗/toast/命令面板/向导）、md 8=卡片·工具卡·
//      输入条·系统气泡、sm 6=chip·小件·徽标·按钮、bubble 8=用户气泡语义档
//      （均匀角，旧 16px 复合角退役）、0=无缝并合成员、50%=圆。
//      --radius-pill(22px) 与 999px 胶囊帽全量退役（消费形态零出现）。
// 四主题（dark/light × green/blue/black 组合）下 ①② 的令牌解析同步钉。
import { afterEach, describe, expect, it } from "vitest";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import "../src/tokens.css";
import { applyAccent, applyTheme } from "../src/theme.js";
import { decl, mount, unmount } from "./css-test-utils.js";
import { createElement } from "react";
import { InputBox } from "../src/components/InputBox.js";

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prop = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 注释剥离（census 不数注释里的示例——tokens-conformance 同立场）。 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 全站 radius census：selector（空白归一）→ 档位 的映射。
 *  与 tokens-conformance 的逐值执法互补：那道门管「值合法」，本 census 管
 *  「族对位」——每个选择器必须恰落在它的族里（零越族），族清单即收据。 */
function radiusCensus(cssRaw: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const block of stripComments(cssRaw).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1]!.replace(/\s+/g, " ").trim();
    for (const r of block[2]!.matchAll(
      /(?:border-(?:top|bottom)-(?:left|right)-radius|border-radius)\s*:\s*([^;{}]+)/g,
    )) {
      const v = r[1]!.trim();
      const tier = v.includes("pill")
        ? "pill"
        : v.includes("bubble")
          ? "bubble"
          : v.includes("--radius-lg")
            ? "lg"
            : v.includes("--radius-md")
              ? "md"
              : v.includes("--radius-sm")
                ? "sm"
                : v === "0"
                  ? "zero"
                  : v === "50%"
                    ? "circle"
                    : "bare";
      if (!out.has(selector)) out.set(selector, new Set());
      out.get(selector)!.add(tier);
    }
  }
  return out;
}

const tiersOf = (css: string, tier: string): string[] =>
  [...radiusCensus(css)].filter(([, t]) => t.has(tier)).map(([s]) => s).sort();

// ---------------------------------------------------------------------------
// ① —— 大区统一画布（四主题）。
// ---------------------------------------------------------------------------
describe("119 ① — page regions ride ONE canvas (--bg), seams are hairlines only", () => {
  const COMBOS: ReadonlyArray<readonly [string, () => void]> = [
    ["dark", () => {
      applyTheme("dark");
      applyAccent("green");
    }],
    ["light", () => {
      applyTheme("light");
      applyAccent("green");
    }],
    ["black-light", () => {
      applyTheme("light");
      applyAccent("black");
    }],
    ["blue-light", () => {
      applyTheme("light");
      applyAccent("blue");
    }],
  ];

  // 大区清单：body 画布 + 四个页面级面板/条带。每个都声明 var(--bg)——同一
  // 令牌在同一主题下解析为同一色（CSS 构造即证明「同色画布」），大区之间
  // 再无实底色块分界。
  const REGIONS = [
    "body",
    ".sb",
    ".filetree",
    ".tabbar",
    ".fileviewer",
    ".fileviewer .breadcrumb",
  ] as const;

  for (const [name, setup] of COMBOS) {
    it(`${name}: every page region declares var(--bg) — one canvas, hairline seams`, () => {
      setup();
      for (const sel of REGIONS) {
        expect(decl(sel, "background"), `${sel} rides the canvas`).toBe("var(--bg)");
      }
      // 分界只靠发丝线：区域条带仍带 hair-1 边（.filetree 右缘/.tabbar 底缘/
      // .breadcrumb 底缘——arc116 的 hair 令牌承担全部分隔职责）。
      expect(decl(".filetree", "border-right")).toContain("var(--hair-1)");
      expect(decl(".tabbar", "border-bottom")).toContain("var(--hair-1)");
      expect(decl(".fileviewer .breadcrumb", "border-bottom")).toContain("var(--hair-1)");
      expect(decl(".sb", "border-right")).toContain("var(--hair-1)");
      // 画布色按主题解析（accent 不改画布）：暗 #141519 / 浅 #F5F6F8。
      const dark = name === "dark";
      expect(prop("--bg")).toBe(dark ? "#141519" : "#F5F6F8");
    });
  }

  it("the transparent strips stay transparent (topbar 116 precedent; chat/set columns declare no fill)", () => {
    expect(decl(".topbar", "background")).toBe("none");
    // .chat/.set-body 本就不声明底色（透出 body 画布）——按块内零 background
    // 执法（decl 对未声明属性会 throw，这里用原文块钉）。117 玻璃层
    // （05-glass.css 的 html.glass 前缀）在桌面玻璃形态给内容列补 var(--bg)
    // 实底是另一层的架构职责（WindowServer 税隔离），与本画布律不冲突：
    // 浏览器/非玻璃形态 = 本律的裸画布；玻璃形态 = 同一 --bg 令牌的实底。
    for (const sel of [".chat", ".set-body", ".set-nav"]) {
      // 行首锚定：05-glass.css 的 html.glass 前缀规则（如 html.glass
      // .set-body）也是 ".set-body {" 的子串——必须钉本 sheet 的裸基座规则。
      const rule = stylesCss.slice(stylesCss.indexOf(`\n${sel} {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body, `${sel} declares no background (canvas shows through)`).not.toMatch(
        /(^|[^-])background\s*:/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ② —— surface 归口：浮层= surface+elev；嵌面= surface-2；画布 hover=+1 档。
// ---------------------------------------------------------------------------
describe("119 ② — the surface re-allocation (floats/cards vs insets vs canvas hovers)", () => {
  it("float layers keep --surface + their elevation tier + radius-lg (浮层专用)", () => {
    const FLOATS: ReadonlyArray<readonly [string, string]> = [
      [".menu", "var(--elev-2)"],
      [".ws-menu", "var(--elev-2)"],
      [".pop .menu", "var(--elev-2)"],
      [".mcm-drop", "var(--elev-2)"],
      [".settings-toast", "var(--elev-2)"],
      [".ctxmeter-legend", "var(--elev-1)"],
      [".connect-card", "var(--elev-2)"],
      [".search-pop", "var(--elev-3)"],
      [".modal-card", "var(--elev-3)"],
    ];
    for (const [sel, elev] of FLOATS) {
      expect(decl(sel, "background"), `${sel} is a float: surface fill`).toBe("var(--surface)");
      expect(decl(sel, "box-shadow"), `${sel} keeps its elevation tier`).toBe(elev);
      expect(decl(sel, "border-radius"), `${sel} rides the float tier`).toBe("var(--radius-lg)");
    }
    // .slashmenu：浮层菜单（历史原因保留 hair-1 边、无 elev）——底与角仍归口。
    expect(decl(".slashmenu", "background")).toBe("var(--surface)");
    expect(decl(".slashmenu", "border-radius")).toBe("var(--radius-lg)");
    // .wiz：decl() 的子串首匹配会先撞 .wizard-overlay（bg 调光 scrim），
    // 故按 raw-sheet 块钉（arc116 ELEV_SURFACES 的 .wiz 同款手法）。
    const wizBlock = stylesCss.slice(stylesCss.indexOf(".wiz {"), stylesCss.indexOf("}", stylesCss.indexOf(".wiz {")));
    expect(wizBlock).toContain("background: var(--surface)");
    expect(wizBlock).toContain("var(--elev-3)");
    expect(wizBlock).toContain("var(--radius-lg)");
    // .menu 家族本弧双修：底 surface-2 → surface，行 hover 倒置回 surface-2。
    expect(decl(".menu-item:hover", "background")).toBe("var(--surface-2)");
  });

  it("in-flow cards keep the lift (surface + hairline) — the ladder lives on cards, not regions", () => {
    for (const sel of [".toolcard", ".act", ".toolgroup", ".pre", ".provider-card"]) {
      expect(decl(sel, "background"), `${sel} stays a lifted card`).toBe("var(--surface)");
    }
    // 警示卡族（.approval/.permission-card）= 语义染色卡（warn 通道 tint），
    // 不是 surface 卡——但同为「浮起小卡」，卡内嵌面走 surface-2（下钉）。
    expect(decl(".approval", "background")).toBe("rgb(var(--warn-rgb) / .07)");
    expect(decl(".permission-card", "background")).toBe("rgb(var(--warn-rgb) / .07)");
    // 卡内嵌面 = surface-2（+1 档）：活动行 hover / cmd 嵌条 / chip 选中。
    expect(decl(".act-row:hover", "background")).toBe("var(--surface-2)");
    expect(decl(".approval .cmd", "background")).toBe("var(--surface-2)");
    expect(decl(".chip.on", "background")).toBe("var(--surface-2)");
  });

  it("canvas hovers lift ONE tier (surface) — the old two-step surface-2 band is gone", () => {
    const CANVAS_HOVERS = [
      ".icobtn:hover",
      ".sb-i:hover",
      ".sb-arch-i:hover",
      ".sb-search:hover",
      ".sb-f .settings-link:hover",
      ".ft-row:hover",
      ".filetree .ws-switcher:hover",
      ".filetree .tree-toggle:hover",
      ".filetree .tree-err[role=\"button\"]:hover",
      ".sb .tree-err[role=\"button\"]:hover",
      ".tabbar .tab:hover",
      ".tabbar .tabbar-collapse:hover",
      ".fileviewer .crumb[role=\"button\"]:hover",
      ".fileviewer .mdmode:hover",
      ".fv-close:hover",
      ".tb-changes:hover",
      ".sch-act:hover",
      ".pickrow:hover",
    ] as const;
    for (const sel of CANVAS_HOVERS) {
      expect(decl(sel, "background"), `${sel} lifts one tier off the canvas`).toBe("var(--surface)");
    }
  });

  it("the composer: float input-card language — surface + elev-2 + md 8 (119 radius scale)", () => {
    mount(
      createElement(InputBox, {
        busy: false,
        mode: "workspace" as const,
        commands: [],
        connected: true,
        onSubmit: () => {},
        onInterrupt: () => {},
        onCycleMode: () => {},
        onShield: () => {},
      }),
    );
    expect(decl(".composer", "background")).toBe("var(--surface)");
    expect(decl(".composer", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".composer", "border-radius")).toBe("var(--radius-md)");
  });
});

// ---------------------------------------------------------------------------
// ③ —— 圆角 census：零裸值、零退役档、零越族（族清单即收据）。
// ---------------------------------------------------------------------------
describe("119 ③ — the radius census (one scale, every consumer classified)", () => {
  it("zero bare values and zero retired tiers anywhere in the sheet", () => {
    const census = radiusCensus(stylesCss);
    for (const [, ts] of census) {
      expect([...ts], "no bare (non-token, non-primitive) radius").not.toContain("bare");
      expect([...ts], "--radius-pill is retired (119)").not.toContain("pill");
    }
    // 999px 胶囊帽：消费形态零出现（含滚动条圆帽——6px 条上 sm=6px 渲染等价）。
    expect(stripComments(stylesCss)).not.toContain("999px");
  });

  it("the FLOAT tier (lg 12) is exactly the overlay family — bidirectional", () => {
    expect(tiersOf(stylesCss, "lg")).toEqual([
      ".connect-card",
      ".ctxmeter-legend",
      ".mcm-drop",
      ".menu",
      ".modal-card",
      ".pop .menu",
      ".search-pop",
      ".settings-toast",
      ".slashmenu",
      ".wiz",
      ".ws-menu",
      ".ws-open-other",
    ]);
  });

  it("the CARD tier (md 8) is exactly the card/input/bubble family — bidirectional", () => {
    expect(tiersOf(stylesCss, "md")).toEqual([
      ".act",
      ".approval",
      ".approval .cmd, .permission-card .cmd",
      ".armed-branch",
      ".ask-card",
      ".branch-panel",
      ".cap-run",
      ".chat",
      ".chg-cmdgroup",
      ".chg-detail",
      ".chg-run",
      ".composer",
      ".fileviewer .viewer-binary",
      ".fileviewer .viewer-err",
      ".installed-row",
      ".market-row",
      ".memory-review-card",
      ".notice-bub",
      ".notice-detail",
      ".noticegroup > .grp-head",
      ".permission-card",
      ".persona-row",
      ".persona-wire-tabs",
      ".planboard",
      ".plugin-entry",
      ".pre",
      ".provider-card",
      ".provider-detail",
      ".recap-banner",
      ".recovery-banner",
      ".revert-warn",
      ".sb-toast",
      ".sch-row",
      ".search-pop .session-item",
      ".segctl",
      ".sideqa",
      ".simple-error",
      ".toolcard",
      ".toolgroup",
      ".wizard-provider-card",
    ]);
  });

  it("the bubble tier is the semantic alias pinned at 8px uniform (气泡与卡片同族)", () => {
    expect(tiersOf(stylesCss, "bubble")).toEqual([".msg-user .bub"]);
    expect(decl(".msg-user .bub", "border-radius")).toBe("var(--radius-bubble)");
    // 均匀角：令牌是单值（旧 16px 16px 4px 16px 复合角退役）。
    expect(prop("--radius-bubble")).toBe("8px");
    expect(prop("--radius-bubble")).not.toContain(" ");
  });

  it("square corners survive only as seamless members (0) and circles as 50%", () => {
    expect(tiersOf(stylesCss, "zero")).toEqual([
      ".mcm-opt",
      ".panel-list > .act",
      ".pop .menu.model-menu .mi.mrec",
      ".reply-card",
      ".toolgroup .toolcard",
    ]);
    expect(tiersOf(stylesCss, "circle")).toEqual([
      ".dot",
      ".filetree .tree-spin",
      ".jump-bottom",
      ".segctl-dot",
      ".send",
      "input.wudao-switch::before",
    ]);
  });

  it("no selector straddles two tiers (零越族：每选择器恰属一族)", () => {
    for (const [selector, ts] of radiusCensus(stylesCss)) {
      expect(ts.size, `${selector} belongs to exactly one tier`).toBe(1);
    }
  });

  it("the chip tier (sm 6) stays off the card/float families (spot invariants)", () => {
    // sm 是最大的族（chip/小件/徽标/按钮/行——逐选择器全列在族表外另有
    // tokens-conformance 的值门）；这里钉跨族不变量：卡片族与浮层族永不落 sm。
    const sm = new Set(tiersOf(stylesCss, "sm"));
    for (const card of tiersOf(stylesCss, "md")) expect(sm.has(card), `${card} must not be sm`).toBe(false);
    for (const float of tiersOf(stylesCss, "lg")) expect(sm.has(float), `${float} must not be sm`).toBe(false);
    // 全站 chip 基座与按钮基座钉在 sm（胶囊帽退役后的归位形态）。
    expect(decl(".chip", "border-radius")).toBe("var(--radius-sm)");
    expect(decl("button.wudao", "border-radius")).toBe("var(--radius-sm)");
  });
});
