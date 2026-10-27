// @vitest-environment jsdom
// M64-visual §1 — the two-theme token sheet: dark resolves with NO
// data-theme attribute (the :root block), [data-theme="light"] overrides it,
// and theme.ts's readTheme/applyTheme drive documentElement.dataset.theme.
// M64-visual §5 — component token snapshots: each visual-upgrade surface
// (composer/send, activity, approval, hero, statusline) rendered ONCE, its
// key rules read through the same CSSOM decl() seam as
// flow-visual/shell-visual (jsdom does not resolve var()), chained to the
// resolved custom property on <html> — so the full derivation, rule → token
// → concrete browser value, is pinned (send = var(--accent) → #12A874 →
// rgb(18, 168, 116)); plus the Tauri shell's launch background tracks the
// dark --bg (the white-flash kill lives in the same invariant).
// vitest's css:true (vite.config.ts) mounts the imported sheet in jsdom, so
// getComputedStyle resolves custom properties exactly like a browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync, existsSync } from "node:fs";
import tauriConfRaw from "../../../apps/desktop/src-tauri/tauri.conf.json?raw";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import "../src/tokens.css";
import { applyAccent, applyTheme, readTheme, stampPersistedAppearance } from "../src/theme.js";
import type { DriverStatus } from "../src/protocol.js";
import { InputBox } from "../src/components/InputBox.js";
import { SimpleActivityCard } from "../src/components/SimpleActivityCard.js";
import { SimpleApprovalCard } from "../src/components/SimpleApprovalCard.js";
import { EmptyHero } from "../src/components/EmptyHero.js";
import { StatusBar } from "../src/components/StatusBar.js";
// F9: the shared visual-suite seams (mount/unmount/decl/prop).
import { decl, mount, prop, unmount } from "./css-test-utils.js";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

describe("tokens.css (M64-visual §1)", () => {
  it("dark is the default: no data-theme resolves the :root block", () => {
    expect(prop("--accent")).toBe("#12A874");
    // 116 弧 A: the cool-gray ladder — bg #171716(暖) → #141519(蓝调).
    expect(prop("--bg")).toBe("#141519");
  });

  it("light overrides via [data-theme=\"light\"]", () => {
    applyTheme("light");
    expect(prop("--bg")).toBe("#F5F6F8");
    expect(prop("--text-1")).toBe("#1A1A18");
  });

  it("[data-accent] variants re-key the accent triad", () => {
    // ω99-303: blue 在无 theme 属性（=dark，:root 约定）下解析抬升后的
    // 深色档 #6C8CFA；light 明示后回落浅色档。
    document.documentElement.dataset.accent = "blue";
    expect(prop("--accent")).toBe("#6C8CFA");
    applyTheme("light");
    expect(prop("--accent")).toBe("#2F54EB");
  });

  // ω99-303 收据：主题分裂块——green/blue 各自的深/浅档位与 ink 翻转。
  // 对比度面（4.5 地板）由 tokens-contrast 的六组合门执法；这里钉的是
  // 级联形状本身（哪个块在哪个主题下赢）。
  it("ω99-303: green/blue accents split per theme (dark lift / light deepen + ink flip)", () => {
    applyAccent("green");
    expect(prop("--accent")).toBe("#12A874"); // dark: :root lift
    expect(prop("--accent-ink")).toBe("#141519"); // 116 弧 A: tracks the new bg
    applyTheme("light");
    expect(prop("--accent")).toBe("#0B7A55"); // light: own deeper green
    expect(prop("--accent-ink")).toBe("#FFFFFF"); // …and white ink
    applyTheme("dark");
    applyAccent("blue");
    expect(prop("--accent")).toBe("#6C8CFA"); // dark: lifted indigo
    expect(prop("--accent-ink")).toBe("#141519"); // near-black ink idiom
    applyTheme("light");
    expect(prop("--accent")).toBe("#2F54EB"); // light: the stock triad
    expect(prop("--accent-ink")).toBe("#FFFFFF");
  });

  // ω99-295 (I5): --mono 单一事实源 —— 更全栈（ui-monospace 打头）从
  // styles.css 的覆写行收编进 tokens.css（该覆写本就是级联赢家，渲染字节
  // 零变化）。resolved-value 钉：解析值仍含 ui-monospace 与 Menlo —— 收编
  // 后的赢家还是全栈，不是旧 tokens 侧的三面短栈。
  it("ω99-295: --mono resolves to the fuller stack, single-sourced in tokens.css", () => {
    expect(prop("--mono")).toContain("ui-monospace");
    expect(prop("--mono")).toContain("Menlo");
  });
});

describe("theme.ts (M64-visual §1)", () => {
  it("readTheme defaults to dark when the attribute is absent", () => {
    expect(readTheme()).toBe("dark");
  });

  it("applyTheme switches documentElement.dataset.theme", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(readTheme()).toBe("light");
    applyTheme("dark");
    expect(readTheme()).toBe("dark");
  });

  // M64-visual §5: the round-trip the §1 pair left implicit — BOTH themes'
  // --bg resolves on the root through applyTheme, in sequence, so a
  // light→dark session flip can never land on a stale sheet.
  it("both themes' --bg resolves on the root across an applyTheme round-trip", () => {
    expect(prop("--bg")).toBe("#141519"); // dark (no attribute, 116 弧 A cool ladder)
    applyTheme("light");
    expect(prop("--bg")).toBe("#F5F6F8");
    applyTheme("dark");
    expect(prop("--bg")).toBe("#141519");
  });

  // Final-review F6: the localStorage mirrors — every apply writes them, and
  // the first-paint stamp (main.tsx's stampPersistedAppearance) resolves
  // BOTH attributes from them so a persisted light/blue user never flashes
  // the factory dark/green before the first settingsStatus reply.
  describe("persistence mirrors + the first-paint stamp (final-review F6)", () => {
    afterEach(() => {
      localStorage.clear();
    });

    it("applyTheme/applyAccent write the wudao.ui.* mirrors", () => {
      applyTheme("light");
      applyAccent("blue");
      expect(localStorage.getItem("wudao.ui.theme")).toBe("light");
      expect(localStorage.getItem("wudao.ui.accent")).toBe("blue");
      applyTheme("dark");
      applyAccent("green");
      expect(localStorage.getItem("wudao.ui.theme")).toBe("dark");
      expect(localStorage.getItem("wudao.ui.accent")).toBe("green");
    });

    it("the stamp uses seeded mirrors (the main-stamp's first paint)", () => {
      localStorage.setItem("wudao.ui.theme", "light");
      localStorage.setItem("wudao.ui.accent", "black");
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.accent;
      stampPersistedAppearance();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.accent).toBe("black");
      expect(prop("--bg")).toBe("#F5F6F8"); // the light sheet is live at once
    });

    it("absent or unknown mirrors resolve the factory dark/green", () => {
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.accent;
      stampPersistedAppearance();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.accent).toBe("green");
      localStorage.setItem("wudao.ui.theme", "sepia");
      localStorage.setItem("wudao.ui.accent", "pink");
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.accent;
      stampPersistedAppearance();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.accent).toBe("green");
    });
  });

  it("the Tauri shell's launch face stays dark (the white-flash kill after 117 vibrancy)", () => {
    // 117 玻璃化：主窗 conf 的 backgroundColor 已删（探针 §1b——实底会盖死
    // vibrancy 材质），白闪防线随之搬家：① conf visible:false + Rust 在
    // sidecar 握手后才 show（首帧即真实内容）；② 握手期的 splash 页
    // （frontend/index.html）仍画深底。本收据钉两件事：主窗不再声明
    // backgroundColor（透明交材质），splash 的深底字面量仍在。
    const conf = JSON.parse(tauriConfRaw) as {
      app: { windows: { label?: string; backgroundColor?: string; transparent?: boolean }[] };
    };
    const win = conf.app.windows.find((w) => w.label === "main");
    expect(win && "backgroundColor" in win).toBe(false); // 117: 透明交材质
    expect(win?.transparent).toBe(true);
    const splash = readFileSync(
      // jsdom 环境的 import.meta.url 不可靠（178/203 两证）——process.cwd()
      // 候选位锚（omega99-275 同款）。
      [`${process.cwd()}/../../apps/desktop/frontend/index.html`, `${process.cwd()}/apps/desktop/frontend/index.html`].find(
        (p) => existsSync(p),
      ) ?? "",
      "utf8",
    );
    // splash 深底（握手期短暂且透明窗上无碍——探针 §6.6 不动它）。
    expect(splash).toMatch(/background:\s*#111318/);
  });
});

// ---------------------------------------------------------------------------
// M65-space §1 — the Tauri window conf: native macOS traffic lights
// (titleBarStyle Overlay = the hiddenInset look in Tauri's enum, hiddenTitle,
// trafficLightPosition 14/14) instead of the fake web-drawn dots. Shape-only:
// the WKWebView behavior itself is the native layer.
// ---------------------------------------------------------------------------
describe("M65-space §1 — Tauri window conf (native traffic lights)", () => {
  it("the main window embeds the bar: Overlay style + hidden title + lights at 14,14", () => {
    const conf = JSON.parse(tauriConfRaw) as {
      app: { windows: { titleBarStyle?: string; hiddenTitle?: boolean; trafficLightPosition?: { x: number; y: number } }[] };
    };
    const win = conf.app.windows[0];
    expect(win?.titleBarStyle).toBe("Overlay");
    expect(win?.hiddenTitle).toBe(true);
    expect(win?.trafficLightPosition).toEqual({ x: 14, y: 14 });
  });
});

// ---------------------------------------------------------------------------
// M64-visual §5 — component token snapshots: one render per surface, the
// key declared derivations + their resolved token values.
// ---------------------------------------------------------------------------
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

/** #0E9F6E → rgb(14, 159, 110): the value a browser COMPUTES for a 6-digit
 *  hex token — jsdom returns the declared hex, so the snapshot chains the
 *  conversion itself to pin what the user actually sees. */
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) throw new Error(`not a 6-digit hex: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("M64-visual §5 — composer/send token snapshot", () => {
  it("the composer input card (119: --radius-md + elevation 中档, border retired) + the 34px circular send ride the tokens; .off = opacity .4; the accent resolves rgb(18, 168, 116)", () => {
    // createElement, not JSX: this file is .ts (the §1 suite's home), and
    // esbuild only parses JSX in .tsx.
    const c = mount(
      createElement(InputBox, {
        busy: false,
        mode: "workspace" as const,
        commands: [],
        connected: true,
        onSubmit: vi.fn(),
        onInterrupt: vi.fn(),
        onCycleMode: vi.fn(),
        onShield: vi.fn(),
      }),
    );
    expect(c.querySelector(".composer")).not.toBeNull();
    expect(decl(".composer", "background")).toBe("var(--surface)");
    // 116 弧 A: the card is an ELEVATION surface — --elev-2 (hairline stroke
    // drawn INTO the box-shadow), border retired (边框与投影不同用 — the old
    // 1px-edge + heavy-shadow double outline was 116's #2 cheapness source).
    // 119 用户反馈修正（圆角统一）：输入条从 22px 胶囊归卡片族 8px。
    expect(decl(".composer", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".composer", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".composer", "border")).toBe("0");
    // The send (fix round 1): the 34px accent CIRCLE, `.off` on an empty
    // draft (markup seam — a fresh InputBox renders it .off right away).
    const send = c.querySelector("button.send") as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.className).toContain("off");
    expect(decl(".send", "background")).toBe("var(--accent)");
    expect(decl(".send", "color")).toBe("var(--accent-ink)");
    expect(decl(".send", "width")).toBe("34px");
    expect(decl(".send", "height")).toBe("34px");
    expect(decl(".send", "border-radius")).toBe("50%");
    expect(decl(".send.off", "opacity")).toBe(".4");
    // The full chain: var(--accent) → the green default's hex → the browser
    // value the mockup specced. ω99-303: the green default lifted
    // #0E9F6E→#12A874 (4.25→4.71 on surface-2 as text); dark blue re-keys
    // to the lifted indigo, not the light-theme #2F54EB.
    expect(prop("--accent")).toBe("#12A874");
    expect(hexToRgb(prop("--accent"))).toBe("rgb(18, 168, 116)");
    // The accent is swappable: blue re-keys the same derivation.
    applyAccent("blue");
    expect(hexToRgb(prop("--accent"))).toBe("rgb(108, 140, 250)");
  });
});

describe("M64-visual §5 — activity card token snapshot", () => {
  it("the .act card is a surface card on the line/card-radius tokens; ok glyph = --ok", () => {
    const c = mount(
      createElement(SimpleActivityCard, { entry: { kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1" } }),
    );
    expect(c.querySelector(".act")).not.toBeNull();
    expect(decl(".act", "background")).toBe("var(--surface)");
    expect(decl(".act", "border-color")).toBe("var(--hair-1)"); // 116 弧 A: alpha hairline
    expect(decl(".act", "border-radius")).toBe("var(--radius-md)");
    expect(decl('.act-row[data-status="ok"] .act-st', "color")).toBe("var(--ok)");
    expect(prop("--surface")).toBe("#1C1D21"); // 116 弧 A: cool ladder rung 2
  });
});

describe("M64-visual §5 — approval card token snapshot", () => {
  it("the warn-tinted card mixes from tokens; allow = accent, deny stays quiet, deny:hover = the one red hover", () => {
    const c = mount(
      createElement(SimpleApprovalCard, {
        ask: { toolName: "shell", summary: "跑一次只读测试", input: { command: "pnpm test" } },
        onChoose: () => {},
      }),
    );
    expect(c.querySelector(".approval")).not.toBeNull();
    expect(decl(".approval", "background")).toBe("rgb(var(--warn-rgb) / .07)");
    // jsdom's CSSOM does not expand the `border` shorthand into longhands,
    // so the assertion reads the shorthand itself (the exact declared mix).
    expect(decl(".approval", "border")).toBe("1px solid rgb(var(--warn-rgb) / .3)");
    expect(decl(".approval .strip", "color")).toBe("var(--warn)");
    // Final-review F7: the caution line is the amber strip's sibling —
    // var(--warn), off the --danger roster (the carried error indicators
    // below stay red by design).
    expect(decl(".approval .warn", "color")).toBe("var(--warn)");
    expect(decl(".dot.missing-key", "background")).toBe("var(--danger)");
    expect(decl(".test-result.fail", "color")).toBe("var(--danger)");
    expect(decl(".approval .allow", "background")).toBe("var(--accent)");
    expect(decl(".approval .deny", "background")).toBe("var(--surface)");
    expect(decl(".approval .deny:hover:not(:disabled)", "color")).toBe("var(--danger)");
    expect(prop("--warn")).toBe("#FBBF24");
  });
});

describe("M64-visual §5 — hero token snapshot", () => {
  it("the 52px 悟 logo rides accent/accent-ink; the ink is the near-black AA pair", () => {
    const c = mount(createElement(EmptyHero)); // ω99-167: hero 零 props（chips 退役）
    expect(c.querySelector(".hero .logo")).toBeNull(); // 品牌弧补丁：欢迎页 logo 整体退役（用户令）
    expect(decl(".hero p", "color")).toBe("var(--text-3)");
    // ui-review-r1 I2: white on the green accent was 3.39:1 — the near-black
    // ink (the black-accent variant's own idiom) clears AA; 116 弧 A: the
    // near-black tracks the new cool bg (#141519).
    expect(prop("--accent-ink")).toBe("#141519");
  });
});

describe("M64-visual §5 — statusline token snapshot", () => {
  it("the 28px strip rides mono caption/text-3 (T10: no surface band); cache% + board read on --ok; the single-line clip holds", () => {
    const status: DriverStatus = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false,
      queued: [],
      boardProgress: { done: 2, total: 3 },
      ctxTokens: { used: 400, window: 1000, nearLimit: false },
      mode: "workspace",
      cachePercent: 91,
      bg: { active: 0, spawned: 0 },
      pendingPermission: null,
      planBoard: null,
      sessionId: "wudao-test-0001",
      sidecar: null,
      model: null,
    };
    const c = mount(createElement(StatusBar, { status }));
    expect(c.querySelector(".statusline")).not.toBeNull();
    expect(c.querySelector(".statusline .cache")?.textContent).toContain("91%");
    expect(decl(".statusline", "height")).toBe("28px");
    // 墨线 T10 收编: the surface band is GONE — the bottom edge row sits on
    // the window bg (pinned off the raw sheet; decl() cannot express absence).
    expect(stylesCss).not.toMatch(/\.statusline\s*\{[^}]*background/s);
    expect(decl(".statusline", "border-top")).toContain("var(--hair-1)");
    expect(decl(".statusline", "font-family")).toBe("var(--mono)");
    expect(decl(".statusline", "font-size")).toBe("var(--fs-caption)"); // 墨线五档 caption 档
    expect(decl(".statusline", "color")).toBe("var(--text-3)");
    expect(decl(".statusline .cache", "color")).toBe("var(--ok)");
    expect(decl(".statusline .board", "color")).toBe("var(--ok)");
    expect(prop("--ok")).toBe("#4ADE80");
    // The narrow-clip acceptance (Task-4 ledger): the strip is single-line
    // BY SPEC and clips ITSELF (overflow:hidden), so a long segment set can
    // never spill a horizontal page scroll — jsdom has no layout engine, so
    // these declarations are the checkable guarantee.
    expect(decl(".statusline", "white-space")).toBe("nowrap");
    expect(decl(".statusline", "overflow")).toBe("hidden");
  });
});
