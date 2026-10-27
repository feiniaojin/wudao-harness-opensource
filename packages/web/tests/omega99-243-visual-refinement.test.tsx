// @vitest-environment jsdom
// ω99-243: #6 — UI 精修弧的结构断言面（一致性令牌 / 状态完备 / 微交互）。
// 超越点「设计规则即测试」：视觉一致性不再靠人眼复查，落成本文件的
// 可回归结构断言——令牌门（C1-C4）、状态面（S1-S3）、微交互（M1-M4）。
// 全局 focus-visible 环与 prefers-reduced-motion 灭灯块已有专属全局钉
// （tests/inkline-global.test.ts / ui4-motion / ui5-polish），本文件不
// 重复铸钉，只在报告 §一 记引用。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { stylesCss } from "./styles-source.js";
import tokensCss from "../src/tokens.css?raw";
import "../src/styles.css";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import { WorkspaceChip } from "../src/components/WorkspaceChip.js";
import { mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  window.localStorage.removeItem("wudao.ui.v1");
});

/** 注释剥离后的原表文本（cssstyle 丢弃带 var() 的 shorthand，raw 钉更稳）。 */
const STYLES = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** The sidebar mount seam (buddy-mode 的同款最小 props 集)。 */
function mountSidebar(client: unknown): HTMLElement {
  return mount(
    <SessionSidebar
      client={client as Parameters<typeof SessionSidebar>[0]["client"]}
      activeSessionId={null}
      onResume={() => {}}
      onNewChat={() => {}}
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// C1 — recap 卡的边线令牌修复：`var(--border)` 是从未定义过的令牌（未定义
// 自定义属性 → invalid at computed-value time → currentColor 兜底 = 文字
// 色亮边），横幅的边线在两主题下都应是 --line 发丝线。
// ---------------------------------------------------------------------------
describe("ω99-243 C1 — recap banner border token", () => {
  it("the banner's border rides the hairline tier; the undefined --border name is gone from the sheet", () => {
    // 116 弧 A: --line 已退役，发丝线三档（--hair-1/2/3）接管中性边框。
    expect(STYLES).toMatch(/\.recap-banner\s*\{[^}]*border:\s*1px solid var\(--hair-1\);/s);
    expect(STYLES).not.toContain("var(--border)");
    expect(TOKENS).not.toContain("--border"); // 不是「补定义」是「改消费」
  });
});

// ---------------------------------------------------------------------------
// C2 — 缓动统一：tokens.css 立了 `--ease`（快出慢停）为唯一交互缓动，但表
// 里漂着裸 `ease` 的同族声明。统一后：交互 transition/animation 的缓动只
// 经 var(--ease)；三个装饰循环（spin 线性旋转 / tree-spin-pulse / blink）
// 保留自己的节拍曲线（时长门既有白名单同款豁免，按动画名锚定）。
// ---------------------------------------------------------------------------
describe("ω99-243 C2 — one easing family (var(--ease))", () => {
  const easingViolations = (css: string): string[] => {
    const out: string[] = [];
    for (const m of css.matchAll(/(?:transition|animation)\s*:\s*([^;{}]+)/g)) {
      const v = m[1]!;
      // 装饰循环按名豁免（时长门 durationViolations 的同款名字锚定）。
      if (/\b(?:spin|tree-spin-pulse|blink)\b/.test(v)) continue;
      // 剥掉令牌本体后再查裸曲线关键词——var(--ease) 里的 "ease" 不是漂移。
      const stripped = v.replace(/var\(--ease\)/g, "");
      if (/\bease(?:-in|-out|-in-out)?\b|\blinear\b|cubic-bezier\(|steps\(/.test(stripped)) {
        out.push(`${m[0].trim()}`);
      }
    }
    return out;
  };

  it("no bare easing curve remains on interactive transitions/animations", () => {
    expect(easingViolations(STYLES)).toEqual([]);
  });
  it("the gate machinery sees its own violations (判别测试，不是只测存量通过)", () => {
    expect(easingViolations(".a { transition: opacity var(--dur-fast) ease; }")).toEqual([
      "transition: opacity var(--dur-fast) ease",
    ]);
    expect(easingViolations(".a { animation: fade var(--dur-med) var(--ease); }")).toEqual([]);
    expect(easingViolations(".a { animation: tree-spin-pulse 1s ease-in-out infinite; }")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C3 — z-index 层级表进令牌：18 处散落字面量（4~61）收编为 tokens.css 的
// 九档 --z-* 层级表；styles.css 的 z-index 声明只消费令牌（backdrop =
// calc(主层 - 1)，主层间不再靠裸数字维持秩序）。
// ---------------------------------------------------------------------------
describe("ω99-243 C3 — the z-index ladder is tokens", () => {
  const LADDER = [
    "--z-jump", "--z-float", "--z-toggle", "--z-legend", "--z-ws-menu",
    "--z-modal", "--z-ctx-menu", "--z-palette", "--z-wizard",
  ] as const;

  it("tokens.css declares every ladder tier as an integer literal", () => {
    for (const t of LADDER) {
      expect(TOKENS, t).toMatch(new RegExp(`${t.replace(/-/g, "\\-")}\\s*:\\s*\\d+\\s*;`));
    }
    // 层级表有序声明（jump < float < toggle < legend < ws-menu < modal < ctx < palette < wizard）
    const vals = LADDER.map((t) => Number(TOKENS.match(new RegExp(`${t.replace(/-/g, "\\-")}\\s*:\\s*(\\d+)`))?.[1]));
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
  });

  it("styles.css z-index declarations ride the ladder exclusively (no bare integers)", () => {
    const decls = [...STYLES.matchAll(/z-index\s*:\s*([^;{}]+);/g)].map((m) => m[1]!.trim());
    // ω99-301 evolution: the legacy .overlay/.modal pair retired onto the
    // one .scrim > .modal-card family — one z-carrying rule fewer, 18 → 17.
    expect(decls.length).toBeGreaterThanOrEqual(17); // 消费面一枚不丢
    for (const d of decls) {
      expect(d, d).toMatch(/^(?:var\(--z-[\w-]+\)|calc\(var\(--z-[\w-]+\)\s*[-+]\s*\d+\))$/);
    }
  });
});

// ---------------------------------------------------------------------------
// C4 — recap 卡的间距归档：最新落成的面是唯一没上 sp 网格的面（12/16/4/8px
// 字面量）；同族 .chg-*/.cap-* 全走令牌。间距归档后 conformance 门的
// 「4 倍数」之上再叠一层「走令牌」钉（声明级）。
// ---------------------------------------------------------------------------
describe("ω99-243 C4 — recap spacing joins the sp grid", () => {
  it("margin/padding/gap ride the sp tokens (declaration-level pins)", () => {
    expect(STYLES).toMatch(
      /\.recap-banner\s*\{[^}]*margin:\s*var\(--sp-3\) var\(--sp-4\) var\(--sp-1\);[^}]*padding:\s*var\(--sp-3\) var\(--sp-4\);[^}]*gap:\s*var\(--sp-2\);/s,
    );
    expect(STYLES).toMatch(/\.recap-label\s*\{[^}]*margin-right:\s*var\(--sp-1\);/s);
    expect(STYLES).toMatch(/\.recap-close\s*\{[^}]*margin-top:\s*var\(--sp-1\);/s);
  });
});

// ---------------------------------------------------------------------------
// S1 — 侧栏首载骨架：加载中不再是「暂无会话」的谎言，而是 3 行 CSS 骨架
// （tree-spin-pulse 透明度脉冲，零闪烁文本）；数据落定后空态照旧。
// ---------------------------------------------------------------------------
describe("ω99-243 S1 — sidebar first-load skeleton", () => {
  it("while sessions() is in flight: 3 skeleton rows, no 暂无会话 lie", () => {
    const never = { sessions: () => new Promise<never>(() => {}) };
    const c = mountSidebar(never);
    expect(c.querySelectorAll(".sb-skeleton")).toHaveLength(3);
    expect(c.querySelector(".sb-list .tree-empty")).toBeNull();
    // 可达性：骨架容器是 role=status（读屏知道在等），骨架行本身 aria-hidden。
    expect(c.querySelector(".sb-skels")?.getAttribute("role")).toBe("status");
  });

  it("a settled empty list still says 暂无会话 (空态语义零改)", async () => {
    const c = mountSidebar({ sessions: () => Promise.resolve([]) });
    await act(async () => {});
    expect(c.querySelector(".sb-list .tree-empty")?.textContent).toBe("暂无会话");
    expect(c.querySelector(".sb-skeleton")).toBeNull();
  });

  it("CSS: the skeleton is a surface pulse on the row geometry (token language only)", () => {
    expect(STYLES).toMatch(
      /\.sb-skeleton\s*\{[^}]*height:\s*32px;[^}]*border-radius:\s*var\(--radius-sm\);[^}]*background:\s*var\(--surface\);[^}]*animation:\s*tree-spin-pulse 1s ease-in-out infinite;/s,
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — 侧栏失败态可行动：裸「加载失败」升为 FileTree 同款「加载失败 ·
// 点击重试」行（role=button + Enter/Space；epoch 重取，重取期间骨架回位）。
// buddy-mode.test.tsx:271 的旧钉随源同形演进（census：先红后绿，报告 §二）。
// ---------------------------------------------------------------------------
describe("ω99-243 S2 — sidebar failed load is actionable", () => {
  it("the failed row reads 加载失败 · 点击重试 and rides the tree-err button idiom", async () => {
    const c = mountSidebar({ sessions: () => Promise.reject(new Error("boom")) });
    await act(async () => {});
    const row = c.querySelector(".sb-list .tree-err") as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.textContent).toBe("加载失败 · 点击重试");
  });

  it("clicking retry re-fetches (sessions called twice) and the skeleton returns while refetching", async () => {
    let calls = 0;
    const sessions = vi.fn((): Promise<never> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : new Promise<never>(() => {});
    });
    const c = mountSidebar({ sessions });
    await act(async () => {});
    const row = c.querySelector(".sb-list .tree-err") as HTMLElement;
    await act(async () => {
      row.click();
    });
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(c.querySelectorAll(".sb-skeleton")).toHaveLength(3); // 重取期间骨架回位
  });

  it("Enter on the retry row refetches too (keyboard parity, FileTree TreeError seam)", async () => {
    const sessions = vi.fn(() => Promise.reject(new Error("boom")));
    const c = mountSidebar({ sessions });
    await act(async () => {});
    const row = c.querySelector(".sb-list .tree-err") as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sessions).toHaveBeenCalledTimes(2);
  });

  it("a retry that succeeds lands the rows (失败 → 行动 → 恢复 全链)", async () => {
    let calls = 0;
    const rows = [{ id: "r1", mtime: new Date().toISOString(), messages: 1, firstUser: "hi", model: "m" }];
    const sessions = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve(rows);
    });
    const c = mountSidebar({ sessions });
    await act(async () => {});
    await act(async () => {
      (c.querySelector(".sb-list .tree-err") as HTMLElement).click();
    });
    expect(c.querySelector(".sb-i")?.textContent).toContain("hi");
    expect(c.querySelector(".tree-err")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S3 — 工作空间菜单首取失败诚实降级：recentWorkspaces 首取失败时菜单不再
// 永远挂着「加载中…」（加载谎言），落定为空列表——「打开其他目录…」行动
// 道常在；已加载过的列表在刷新失败时照旧保留（last-known 语义零改）。
// ---------------------------------------------------------------------------
describe("ω99-243 S3 — recents menu failure honesty", () => {
  const CHIP_PROPS = { root: "/w/demo", connected: true, onPick: () => {}, onOpenOther: () => {} };

  it("a failed FIRST fetch settles empty: no eternal 加载中…, the action lane stands", async () => {
    const c = mount(<WorkspaceChip client={{ recentWorkspaces: () => Promise.reject(new Error("down")) } as never} {...CHIP_PROPS} />);
    await act(async () => {
      (c.querySelector("button.chip") as HTMLElement).click();
    });
    await act(async () => {});
    expect(c.querySelector(".ws-loading")).toBeNull();
    expect(c.querySelector(".ws-open-other")?.textContent).toBe("打开其他目录…");
    expect(c.querySelectorAll(".ws-item")).toHaveLength(1); // 只剩行动道
  });

  it("an in-flight fetch keeps the 加载中… row (statecover C9 契约零改)", () => {
    const c = mount(<WorkspaceChip client={{ recentWorkspaces: () => new Promise<never>(() => {}) } as never} {...CHIP_PROPS} />);
    act(() => {
      (c.querySelector("button.chip") as HTMLElement).click();
    });
    expect(c.querySelector(".ws-loading")?.textContent).toBe("加载中…");
  });

  it("a REFRESH failure keeps the last-known list standing (既有语义零改)", async () => {
    let first = true;
    const recentWorkspaces = () =>
      first ? ((first = false), Promise.resolve({ workspaces: [{ path: "/w/a" }] })) : Promise.reject(new Error("down"));
    const c = mount(<WorkspaceChip client={{ recentWorkspaces } as never} {...CHIP_PROPS} />);
    await act(async () => {
      (c.querySelector("button.chip") as HTMLElement).click(); // 首开：加载并落定
    });
    await act(async () => {
      (c.querySelector(".ws-backdrop") as HTMLElement).click(); // 收起
    });
    await act(async () => {
      (c.querySelector("button.chip") as HTMLElement).click(); // 再开：刷新失败
    });
    await act(async () => {});
    const items = [...c.querySelectorAll(".ws-item")].filter((el) => !el.classList.contains("ws-open-other"));
    expect(items).toHaveLength(1); // 旧列表站着，不是空态也不是加载谎言
    expect(c.querySelector(".ws-loading")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M1 — 悬停显影执行器的 focus-visible 显影：.sb-rename/.sb-act 是
// opacity:0 悬停显影钮——键盘聚焦时它们必须显影（at-btn/tclose/model-use/
// model-star 四处既有先例，侧栏两处是漏网）。可达性硬要求。
// ---------------------------------------------------------------------------
describe("ω99-243 M1 — hover-revealed sidebar actuators reveal on focus-visible", () => {
  it("the ✎ rename button reveals on :focus-visible", () => {
    expect(STYLES).toMatch(/\.sb-i \.sb-rename:focus-visible[^\{]*\{[^}]*opacity:\s*1;/s);
  });
  it("the 归档/恢复 row act reveals on :focus-visible (both row families)", () => {
    expect(STYLES).toMatch(/\.sb-i \.sb-act:focus-visible[^\{]*,/s);
    expect(STYLES).toMatch(/\.sb-arch-i \.sb-act:focus-visible[^\{]*\{[^}]*opacity:\s*1;/s);
  });
});

// ---------------------------------------------------------------------------
// M2 — .overlay/.modal 家族进出场过渡：scrim 家族（.scrim fade + .modal-card
// pop-in）有入场动效，.overlay 家族（会话改动/电脑回望/ClearConfirm/内联
// 新对话确认）硬切——两家族一个手势语言：fade 180ms + pop 180ms（≤200ms
// 档，reduced-motion 全局块收编）。
// ---------------------------------------------------------------------------
describe("ω99-243 M2 — the overlay family enters like the scrim family", () => {
  it("the scrim fades in on the med tier; the modal card pops in (both via tokens)", () => {
    // ω99-301 evolution: the legacy .overlay/.modal pair retired onto the
    // one family — the entrance contract is unchanged, it lives on the
    // family's own two rules now (.scrim fades, .pop-in pops).
    expect(STYLES).toMatch(/\.scrim\s*\{[^}]*animation:\s*fade var\(--dur-med\) var\(--ease\);/s);
    expect(STYLES).toMatch(/\.pop-in\s*\{[^}]*animation:\s*pop var\(--dur-med\) var\(--ease\);/s);
  });
});

// ---------------------------------------------------------------------------
// M3 — recap 卡入场淡入：回来摘要横幅在会话流顶部弹现，硬切改 fade
// （settings-toast 的 toast-in 同语言家族，卡片级 180ms）。
// ---------------------------------------------------------------------------
describe("ω99-243 M3 — the recap banner fades in", () => {
  it(".recap-banner carries the med-tier fade entry", () => {
    expect(STYLES).toMatch(/\.recap-banner\s*\{[^}]*animation:\s*fade var\(--dur-med\) var\(--ease\);/s);
  });
});

// ---------------------------------------------------------------------------
// M4 — 主操作钮按压反馈：hover 亮 / active 暗 / focus-visible 环三态齐。
// 发送、跳底、允许/拒绝、wudao 按钮、icobtn、改动 chip 的 active 态走
// brightness 压暗（零新色令牌，filter 即时态不经动效）。
// ---------------------------------------------------------------------------
describe("ω99-243 M4 — primary buttons carry an active press state", () => {
  it("the press rule covers send/jump-bottom/allow/wudao/icobtn/tb-changes at brightness(<1)", () => {
    const m = STYLES.match(/\.send:active:not\(:disabled\)[^{]*\{([^}]*)\}/s);
    expect(m).toBeDefined();
    expect(m?.[1]).toMatch(/filter:\s*brightness\(\.88\)/);
    for (const sel of [".jump-bottom:active", ".approval .allow:active", "button.wudao:active", ".icobtn:active", ".tb-changes:active"]) {
      expect(m?.[0], sel).toContain(sel);
    }
  });
});
