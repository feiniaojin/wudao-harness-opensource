import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readStyles } from "./styles-source.js";

const css = readStyles();

// 墨线全局态（spec §1.3/1.4）：键盘焦点环一条规则全覆盖 + reduced-motion 降级。
describe("inkline global states", () => {
  it("has the one :focus-visible ring rule", () => {
    expect(css).toMatch(/:focus-visible\s*{[^}]*--accent-weak[^}]*outline[^}]*--accent/s);
  });
  // #456 (0.3.83 报障「胶囊外面加一个难看的大黑框」): the ring is KEYBOARD-only.
  // Selector capsules and menu rows get programmatic .focus() after a pick —
  // WKWebView drew the UA default outline OUTSIDE the capsule. The
  // :not(:focus-visible) guard suppresses exactly that, and can never eat the
  // keyboard ring (a keyboard focus matches :focus-visible, so the :not
  // clause excludes it — specificity never even comes into play).
  it("#456: non-keyboard focus draws no UA outline (the ring stays keyboard-only)", () => {
    expect(css).toMatch(/:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none[^}]*\}/s);
  });
  it("reduces all motion when the user asks", () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)\n}/);
    expect(m?.[1]).toMatch(/animation-duration:\s*\.01ms/);
    expect(m?.[1]).toMatch(/transition-duration:\s*\.01ms/);
  });
  it("uses token durations everywhere it transitions (no raw ms)", () => {
    const raws = [...css.matchAll(/transition:[^;]*\b(\d+)ms/g)].map((m) => m[1]);
    expect(raws).toEqual([]);
  });
  // Review fix r1: the global ring is (0,1,0) — the palette input's own
  // (0,2,0) outline:none would out-rank it, leaving the near-invisible
  // halo as the only indicator. The stale outline:none must stay gone.
  it("the palette search-input rides the global ring (no outline:none override)", () => {
    const m = css.match(/\.search-pop \.search-input\s*\{([^}]*)\}/);
    expect(m).toBeDefined();
    expect(m![1]).not.toMatch(/outline:\s*none/);
  });
  // T8 墨线 §3 — the sidebar: date-group headers are 11px mono (the
  // caption tier, three type steps off the 12.5px rows), and the selected
  // row is accent-weak + the 2px INSET accent left bar (左缘条 — an inset
  // edge, not a 投影; the no-shadow law targets drop shadows).
  it("sidebar date-group headers are caption-tier mono", () => {
    expect(css).toMatch(/\.sb-g\s*{[^}]*var\(--fs-caption\)[^}]*var\(--mono\)/s);
  });
  it("the selected session row = accent-weak bg + the inset 2px accent left bar", () => {
    // 品牌弧补丁10+多driver弧C 随迁：.settings-tabs .sb-i.on 是 scoped override
    // （box-shadow:none，排在前面的 40-settings.css），正则锚定完整基规则。
    const m = css.match(/\.sb-i\.on\s*\{[^}]*background:\s*var\(--accent-weak\)[^}]*\}/);
    expect(m).toBeDefined();
    expect(m![0]).toMatch(/background:\s*var\(--accent-weak\)/);
    expect(m![0]).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--accent\)/);
  });
  // T8 fix-r1 I-1: `.sb-new` takes its width from flex stretch (like every
  // other sidebar row) — `width: 100%` + margins resolved against the
  // container's content box and pushed the right edge 8px past the inset
  // (clipped at the panel seam, the hairline never rendered).
  it(".sb-new rides flex-stretch + margins, never width:100% (no right-edge overflow)", () => {
    const m = css.match(/\.sb-new\s*\{([^}]*)\}/);
    expect(m).toBeDefined();
    expect(m![1]).not.toMatch(/width:\s*100%/);
    expect(m![1]).toMatch(/margin:\s*var\(--sp-3\) var\(--sp-2\) 0/);
  });
  // T8 fix-r1 M-2: the retired unscoped .session-item base rule also fed
  // the picker's rows (12.5px + 8px radius); the scoped rule now carries
  // both so the rows keep their type tier against their own 12.5px header.
  it("picker session rows keep their ui-tier font + radius (the scoped rule carries them)", () => {
    const m = css.match(/\.search-pop \.session-item\s*\{([^}]*)\}/);
    expect(m).toBeDefined();
    expect(m![1]).toMatch(/font-size:\s*var\(--fs-ui\)/);
    expect(m![1]).toMatch(/border-radius:\s*var\(--radius-md\)/);
  });
  // T8 fix-r1 M-3: the .sb-search div is not covered by the button-only
  // baseline — its hover surface+hairline must ride the same fast tier.
  it("the .sb-search div rides the global motion baseline selector list", () => {
    const baseline = css.match(/^button,[^{]*\{/m)?.[0] ?? "";
    expect(baseline).not.toBe("");
    expect(baseline).toMatch(/\.sb-search/);
  });
});
