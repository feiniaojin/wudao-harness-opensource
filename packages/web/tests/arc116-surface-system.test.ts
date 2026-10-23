// @vitest-environment jsdom
// 116 弧 A「材质升级」的收据套件——去廉价化第一弧（surface 质感体系）。
//   ① hair 阶梯：每主题一组黑白 alpha 三档（发丝线），CSSOM 解析值钉死；
//   ② 背景阶梯：每主题 bg/surface/surface-2 的冷灰（B−R≥3）+ 层间 HSL-L
//      步进 3~5（dsh 配方；算值同 scripts/arc116-ladder.mjs）；
//   ③ elevation 三件套：描边入影 + 两层 .02~.05 柔光，双主题值钉死；
//   ④ accent 收权：四主题组合（dark/light × green/blue/black）下——
//      用户气泡中性且与 accent 无关、芯片选中中性、选中行/CTA/focus 环
//      保留 accent、进度条语义化（todo=ok / wiz=onboarding 仪式例外）；
//   ⑤ 退役令牌零出现：var(--line)/var(--line-2)/var(--shadow-2) 在
//      styles 里零消费（防复制复活，ω99-295 A 同款 raw 文本执法）；
//   ⑥ 「边框与投影不同用」：每个 elevation 消费面声明 border:0。
import { afterEach, describe, expect, it } from "vitest";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import "../src/tokens.css";
import { applyAccent, applyTheme } from "../src/theme.js";
import { decl, mount, unmount } from "./css-test-utils.js";
import { createElement } from "react";
import { InputBox } from "../src/components/InputBox.js";
import { TodoBoard } from "../src/components/TodoBoard.js";

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prop = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// —— HSL 亮度（与 scripts/arc116-ladder.mjs 同式）——
const hslL = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255) * 100;
};
const bMinusR = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (n & 255) - ((n >> 16) & 255);
};

// ---------------------------------------------------------------------------
// ①②④ —— 四主题组合下的令牌值断言（CSSOM 解析值，不是源文本）。
// ---------------------------------------------------------------------------
describe("116 弧 A — the surface system across the four theme combos", () => {
  // 四组合 = 任务裁定的「四主题都要过」：dark(绿缺省) / light / black+light /
  // blue+light（blue 另有 dark 抬升档，由 tokens-contrast 六组合门覆盖）。
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

  for (const [name, setup] of COMBOS) {
    it(`${name}: the hair ladder resolves as black/white alpha tiers`, () => {
      setup();
      const dark = name === "dark";
      // jsdom CSSOM returns the DECLARED literal form (no normalization).
      expect(prop("--hair-1")).toBe(dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.08)");
      expect(prop("--hair-2")).toBe(dark ? "rgba(255,255,255,.13)" : "rgba(0,0,0,.14)");
      expect(prop("--hair-3")).toBe(dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)");
      // alpha 单调升：hair-1 < hair-2 < hair-3（档位化，不是散值）。
      const alpha = (v: string): number => Number.parseFloat(v.slice(v.lastIndexOf(",") + 1, -1));
      expect(alpha(prop("--hair-1"))).toBeLessThan(alpha(prop("--hair-2")));
      expect(alpha(prop("--hair-2"))).toBeLessThan(alpha(prop("--hair-3")));
    });

    it(`${name}: the bg ladder is COOL (B−R≥3) with tight 3~5 HSL-L steps (dark rungs)`, () => {
      // 119 用户反馈修正注记：阶梯令牌值不动——但 3~5 步进的消费面自 119 起
      // 收敛为「浮起小卡/浮层/嵌面」（arc119 收据钉大区全部归 --bg 画布），
      // 本钉继续守令牌几何（卡面语言的基底），页级大区不再消费阶梯。
      setup();
      const dark = name === "dark";
      const bg = prop("--bg");
      const surface = prop("--surface");
      const surface2 = prop("--surface-2");
      // 冷调：非纯白档必须 B−R≥3（暖灰 #171716 是 116 §3.a 差距 3 的病灶）。
      if (surface !== "#FFFFFF") expect(bMinusR(surface)).toBeGreaterThanOrEqual(3);
      expect(bMinusR(bg)).toBeGreaterThanOrEqual(3);
      expect(bMinusR(surface2)).toBeGreaterThanOrEqual(3);
      // 暗色阶梯的层间步进落在 3~5（dsh 配方；浅色的 surface=纯白锚不适用）。
      if (dark) {
        const s1 = hslL(surface) - hslL(bg);
        const s2 = hslL(surface2) - hslL(surface);
        expect(s1).toBeGreaterThanOrEqual(3);
        expect(s1).toBeLessThanOrEqual(5);
        expect(s2).toBeGreaterThanOrEqual(3);
        expect(s2).toBeLessThanOrEqual(5);
      }
    });

    it(`${name}: the elevation trio resolves (stroke-in-shadow, both soft layers ≤ .05)`, () => {
      setup();
      for (const tier of ["--elev-1", "--elev-2", "--elev-3"]) {
        const v = prop(tier);
        expect(v.startsWith("0 0 0 .5px"), `${tier} leads with the hairline stroke`).toBe(true);
        // 浅色的描边也是黑 alpha（首个 rgba）——其后才是两层柔光。
        const blacks = [...v.matchAll(/rgba\(0,0,0,(\.\d+)\)/g)].map((m) => Number.parseFloat(m[1] as string));
        const alphas = prop("--hair-1").startsWith("rgba(0,0,0") ? blacks.slice(1) : blacks;
        expect(alphas).toHaveLength(2); // 两层柔光
        for (const a of alphas) expect(a).toBeLessThanOrEqual(0.05); // dsh 配方带
      }
    });

    it(`${name}: the user bubble is NEUTRAL and accent-independent (气泡去品牌色)`, () => {
      setup();
      const dark = name === "dark";
      expect(prop("--bubble-user-bg")).toBe(dark ? "rgba(255,255,255,.09)" : "#E9EAEF");
      expect(prop("--bubble-user-ink")).toBe(dark ? "#EAEAE6" : "#1B1C22");
    });
  }

  // 气泡与 accent 无关的「组合间」证明：同主题不同 accent 解析值逐字节同。
  it("the bubble does not re-key with the accent picker (dark: green≡blue≡black)", () => {
    applyTheme("dark");
    const green = [prop("--bubble-user-bg"), prop("--bubble-user-ink")];
    for (const a of ["blue", "black"] as const) {
      applyAccent(a);
      expect([prop("--bubble-user-bg"), prop("--bubble-user-ink")]).toEqual(green);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ —— accent 角色抽查钉（保留的 4 类配额 + 被收权的角色）。
// ---------------------------------------------------------------------------
describe("116 弧 A — accent role spot pins", () => {
  it("CTA keeps accent: the send circle rides the accent pair", () => {
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
    expect(decl(".send", "background")).toBe("var(--accent)");
    expect(decl(".send", "color")).toBe("var(--accent-ink)");
  });

  it("selection keeps accent: the pop menu's .on row + the sidebar's .on row", () => {
    expect(decl(".pop .mi.on", "background")).toBe("var(--accent-weak)");
    expect(decl(".pop .mi.on", "color")).toBe("var(--accent)");
    expect(decl(".sb-i.on", "background")).toBe("var(--accent-weak)");
    // 选中竖条 = 选中态语义（0.3.28 用户明示保留侧栏竖条）。decl() 的子串
    // 首匹配会先撞上设置页的豁免覆写（.settings-tabs .sb-i.on{box-shadow:
    // none}），故侧栏本规则钉原文（shell-visual 的 raw-sheet 先例）。
    expect(stylesCss).toMatch(/^\.sb-i\.on \{ background: var\(--accent-weak\); color: var\(--text-1\); box-shadow: inset 2px 0 0 var\(--accent\); \}/m);
  });

  it("chips are NEUTRAL when selected (芯片底→中性): global + composer scoped", () => {
    expect(decl(".chip.on", "background")).toBe("var(--surface-2)");
    expect(decl(".chip.on", "border-color")).toBe("var(--hair-2)");
    expect(decl(".composer .chip.sel", "background")).toBe("var(--surface-2)");
    expect(decl(".composer .chip.sel", "border-color")).toBe("var(--hair-2)");
    // hover 不再借品牌色（探查=中性，提交/选中才有 accent）。
    expect(decl(".chip:hover:not(:disabled):not(.on):not(.sel)", "border-color")).toBe("var(--hair-2)");
  });

  it("progress bars re-audited: todo=ok semantic; the wizard keeps accent (onboarding ceremony)", () => {
    mount(createElement(TodoBoard, { done: 1, total: 2, lines: [] }));
    expect(decl(".todo-bar", "background")).toBe("var(--ok)");
    expect(decl(".wiz-bar", "background")).toBe("var(--accent)");
    // 任务板 done 态 = ok 语义弱染（.diff .add 同族），不是品牌绿。
    expect(decl(".todo-box.done", "background")).toBe("rgb(var(--ok-rgb) / .12)");
  });

  it("the focus ring keeps accent (the global :focus-visible pair)", () => {
    expect(decl(":focus-visible", "outline")).toBe("1px solid var(--accent)");
    expect(decl(":focus-visible", "box-shadow")).toBe("0 0 0 2px var(--accent-weak)");
  });
});

// ---------------------------------------------------------------------------
// ⑤⑥ —— 退役令牌零出现 + 边框/投影不同用（raw 文本 census）。
// ---------------------------------------------------------------------------
describe("116 弧 A — retired tokens & the border/elevation exclusivity law", () => {
  it("no styles/ consumer references the retired tokens (var(--line)/var(--line-2)/var(--shadow-2))", () => {
    expect(stylesCss).not.toContain("var(--line)");
    expect(stylesCss).not.toContain("var(--line-2)");
    expect(stylesCss).not.toContain("var(--shadow-2)");
  });

  // 每个 elevation 消费面必须 border:0——描边已在影里，双轮廓即 116 的
  // 廉价感来源 #2（dsh 成文律：neutral 边框与 elevation 投影禁止同用）。
  it("every elevation surface declares border:0 (边框与投影不同用)", () => {
    const ELEV_SURFACES = [
      ".composer", // elev-2（focus/dragover 态换 accent 环，不带回边框）
      ".menu", // elev-2（浮层菜单基座）
      ".ws-menu", // elev-2
      ".mcm-drop", // elev-2
      ".settings-toast", // elev-2
      ".ctxmeter-legend", // elev-1
      ".fv-selchip", // elev-1
      ".connect-card", // elev-2
      ".search-pop", // elev-3
      ".modal-card", // elev-3
      ".wiz", // elev-3
    ] as const;
    for (const sel of ELEV_SURFACES) {
      const rule = stylesCss.slice(stylesCss.indexOf(`${sel} {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body, `${sel} must retire its border`).toMatch(/border:\s*0/);
      expect(body, `${sel} rides an elevation tier`).toMatch(/box-shadow:\s*var\(--elev-/);
    }
  });

  it("the composer's focus/dragover states swap the stroke for the accent ring (no border return)", () => {
    expect(decl(".composer:focus-within", "box-shadow")).toBe("0 0 0 1px rgb(var(--accent-rgb) / .55), var(--elev-2-soft)");
    expect(decl(".composer.dragover", "box-shadow")).toBe("0 0 0 1px rgb(var(--accent-rgb) / .8), var(--elev-2-soft)");
  });
});
