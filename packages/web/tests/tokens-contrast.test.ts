// tokens-contrast — ui-review-r1 I2: WCAG AA as a permanent gate. The ratios
// are computed from the hex literals in tokens.css (parsed with a regex — no
// CSSOM round trip, the sheet's text IS the source of truth), so a future
// token edit that drops any text pair below 4.5:1 fails HERE, not in a review
// pass. Scope: the text ladder (text-1/2/3) on the three surfaces it actually
// renders over (bg / surface / surface-2) in BOTH themes, plus every accent
// variant's ink-on-accent pair (the 14px user bubble is small text — AA
// normal, 4.5:1, not the 3:1 large-text relax).
// ω99-303 (第五轴): the matrix is now COMPLETE — the semantic status colors
// (ok/warn/danger — statusline marks, error text, warn hints, diff +/-),
// the accent AS TEXT (links, selected menu rows, seg-busy, pickrow ranks —
// six variant×theme combos after the blue-dark/green-light split), and the
// syntax palette (the five --tok-* roles on .pre's surface) all clear 4.5:1
// on the surfaces they render over. The fixes this arc pinned: dark green
// #0E9F6E→#12A874 (was 4.25 on surface-2 — hovered chips/sig-glyph), light
// green got its own darker #0B7A55 (the factory green was 3.0-3.4 on light
// surfaces), dark blue got the lifted #6C8CFA with near-black ink (the light
//-theme indigo #2F54EB was 2.46-3.07 as text on dark), light ok/danger
// darkened one step for surface-2, and the light syntax palette (One Light's
// stock comments sat at 2.58) was darkened to readable counterparts.
import { describe, expect, it } from "vitest";
import tokensCss from "../src/tokens.css?raw";

/** hex → [r,g,b] (the composite helper's operand form). */
const hex = (h: string): number[] => {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** `--name: #AABBCC;` → name→hex for ONE rule block's body. */
function blockVars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    out.set(m[1] as string, m[2] as string);
  }
  return out;
}

/** The sheet's blocks by selector prefix — the FIRST match wins, mirroring
 *  the cascade for the :root defaults the later blocks override. */
function ruleBlock(selectorPrefix: string): string {
  const m = tokensCss.match(new RegExp(`${selectorPrefix}[^{]*\\{([\\s\\S]*?)\\}`, "m"));
  if (m === null) throw new Error(`no block for ${selectorPrefix}`);
  return m[1] as string;
}

const dark = blockVars(ruleBlock(":root,"));
const light = blockVars(ruleBlock('\\[data-theme="light"\\]'));
const accents = new Map<string, Map<string, string>>([
  ["green (default)", dark], // :root carries the factory green triad
  ["black/dark", blockVars(ruleBlock('\\[data-accent="black"\\]\\[data-theme="dark"\\]'))],
  ["black/light", blockVars(ruleBlock('\\[data-accent="black"\\]\\[data-theme="light"\\]'))],
  ["blue", blockVars(ruleBlock('\\[data-accent="blue"\\]'))],
]);

// WCAG 2.x relative luminance over sRGB.
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** Contrast ratio, always ≥1 (the divisor is the darker side). */
export const contrast = (fg: string, bg: string): number => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi !== undefined && lo !== undefined ? (hi + 0.05) / (lo + 0.05) : 1);
};

describe("ui-review-r1 I2 — WCAG AA contrast gate (tokens.css)", () => {
  for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
    it(`${theme}: text-1/2/3 clear 4.5:1 on bg, surface AND surface-2`, () => {
      const misses: string[] = [];
      for (const fg of ["text-1", "text-2", "text-3"]) {
        for (const bg of ["bg", "surface", "surface-2"]) {
          const r = contrast(vars.get(fg) as string, vars.get(bg) as string);
          if (r < 4.5) misses.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
        }
      }
      expect(misses, misses.join("; ")).toEqual([]);
    });
  }

  it("every accent variant's ink-on-accent clears 4.5:1 (the 14px user bubble)", () => {
    const misses: string[] = [];
    for (const [name, vars] of accents) {
      const r = contrast(vars.get("accent-ink") as string, vars.get("accent") as string);
      if (r < 4.5) misses.push(`${name}: ${r.toFixed(2)}`);
    }
    expect(misses, misses.join("; ")).toEqual([]);
  });

  // 116 弧 A「accent 收权」：用户气泡去品牌色 → 中性灰。浅色对单一源自
  // light 块（#E9EAEF/#1B1C22 ≈14.1:1）；三个 accent 块不再覆写气泡——
  // 气泡从此与主色选择无关（a ref：气泡从不用品牌色）。暗色气泡 = 白 alpha
  // 叠层（对 --bg 合成后校对比，非裸 hex）。
  it("the LIGHT user-bubble pair is NEUTRAL, single-sourced, and clears 4.5:1; no accent block overrides it (116 弧 A)", () => {
    const ink = light.get("bubble-user-ink");
    const bg = light.get("bubble-user-bg");
    expect(ink).toBe("#1B1C22");
    expect(bg).toBe("#E9EAEF");
    expect(contrast(ink as string, bg as string)).toBeGreaterThanOrEqual(4.5);
    // The per-accent light overrides retired with the tint — the bubble must
    // not re-key with the accent picker.
    for (const sel of ['\\[data-accent="black"\\]\\[data-theme="light"\\]', '\\[data-accent="blue"\\]']) {
      const block = blockVars(ruleBlock(sel));
      expect(block.has("bubble-user-bg"), `${sel} still overrides the bubble`).toBe(false);
      expect(block.has("bubble-user-ink"), `${sel} still overrides the bubble ink`).toBe(false);
    }
  });

  // 116 弧 A: the DARK bubble is a white-alpha overlay — the gate must check
  // the COMPOSITE over --bg (what WKWebView paints), not a bare hex. Ink
  // #EAEAE6 over bg + 9% white ≈ 11.9:1.
  it("the DARK user-bubble alpha composite clears 4.5:1 (116 弧 A neutral bubble)", () => {
    const m = tokensCss.match(/--bubble-user-bg:\s*rgba\(255,255,255,(\.\d+)\);\s*--bubble-user-ink:\s*(#[0-9a-fA-F]{6})/);
    expect(m).not.toBeNull();
    const alpha = Number.parseFloat(m![1] as string);
    const ink = m![2] as string;
    const base = dark.get("bg") as string;
    const composite = hex(base).map((c) => c + (255 - c) * alpha);
    const compositeHex = `#${composite.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    expect(contrast(ink, compositeHex)).toBeGreaterThanOrEqual(4.5);
  });

  it("the text ladder stays a LADDER — text-1 > text-2 > text-3 in contrast against the theme bg", () => {
    // Direction-agnostic on purpose: dark dims DOWN the ladder, light dims
    // UP it — what must hold in both is the CONTRAST ORDER (text-1 the
    // strongest, text-3 the quietest).
    for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
      const bg = vars.get("bg") as string;
      expect(contrast(vars.get("text-1") as string, bg)).toBeGreaterThan(contrast(vars.get("text-2") as string, bg));
      expect(contrast(vars.get("text-2") as string, bg)).toBeGreaterThan(contrast(vars.get("text-3") as string, bg));
    }
  });

  // ω99-303: the semantic status colors are TEXT roles — statusline cache%/
  // board marks (on bg), toolcard/act-row status marks (surface, and
  // surface-2 while hovered), .entry-error/.settings-receipts warn lines,
  // and the diff +/− rows (a 10% self-tinted surface — the tint shifts the
  // effective bg a hair toward the fg, so the PLAIN surface bar here is the
  // slightly generous side; the chosen values keep the tinted pair ≥4.5 too
  // by measurement: light danger-on-tint 4.89, ok-on-tint 5.60).
  for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
    it(`ω99-303: ${theme} ok/warn/danger clear 4.5:1 on bg, surface AND surface-2`, () => {
      const misses: string[] = [];
      for (const fg of ["ok", "warn", "danger"]) {
        for (const bg of ["bg", "surface", "surface-2"]) {
          const r = contrast(vars.get(fg) as string, vars.get(bg) as string);
          if (r < 4.5) misses.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
        }
      }
      expect(misses, misses.join("; ")).toEqual([]);
    });
  }

  // ω99-303: the accent AS TEXT — .md links, .pop .mi.on selected rows,
  // statusline seg-busy, pickrow ranks, toolcard running marks — across all
  // six variant×theme combos the app can compose. The two new blocks close
  // the gap the factory triad left: green/light and blue/dark each get a
  // theme-tuned accent; black already had its split.
  it("ω99-303: accent-as-text clears 4.5:1 on all three surfaces, all six variant×theme combos", () => {
    const combos: Array<[string, string, Map<string, string>, Map<string, string>]> = [
      ["green", "dark", dark, dark],
      ["green", "light", blockVars(ruleBlock('\\[data-accent="green"\\]\\[data-theme="light"\\]')), light],
      ["black", "dark", blockVars(ruleBlock('\\[data-accent="black"\\]\\[data-theme="dark"\\]')), dark],
      ["black", "light", blockVars(ruleBlock('\\[data-accent="black"\\]\\[data-theme="light"\\]')), light],
      ["blue", "dark", blockVars(ruleBlock('\\[data-accent="blue"\\]:not\\(')), dark],
      ["blue", "light", blockVars(ruleBlock('\\[data-accent="blue"\\]')), light],
    ];
    const misses: string[] = [];
    for (const [name, theme, accentVars, themeVars] of combos) {
      const accent = accentVars.get("accent");
      if (accent === undefined) {
        misses.push(`${name}/${theme}: no --accent in block`);
        continue;
      }
      for (const bg of ["bg", "surface", "surface-2"]) {
        const r = contrast(accent, themeVars.get(bg) as string);
        if (r < 4.5) misses.push(`${name}/${theme} accent on ${bg}: ${r.toFixed(2)}`);
      }
    }
    expect(misses, misses.join("; ")).toEqual([]);
  });

  // ω99-303: the theme-split's ink side — green/light flips to white ink on
  // the deeper green, blue/dark to near-black on the lifted blue (the
  // black-accent dark idiom). The existing ink-on-accent gate covers the
  // factory triads; these two pin the NEW pairs.
  it("ω99-303: the split accents' ink-on-accent clears 4.5:1 (green/light white, blue/dark near-black)", () => {
    const gl = blockVars(ruleBlock('\\[data-accent="green"\\]\\[data-theme="light"\\]'));
    const bd = blockVars(ruleBlock('\\[data-accent="blue"\\]:not\\('));
    expect(contrast(gl.get("accent-ink") as string, gl.get("accent") as string)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(bd.get("accent-ink") as string, bd.get("accent") as string)).toBeGreaterThanOrEqual(4.5);
  });

  // ω99-303: the syntax palette — .pre renders on --surface in both themes
  // (styles.css:415), 13px mono body text, so AA normal applies to every
  // role including comments (AI-written code leans on its comments).
  for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
    it(`ω99-303: ${theme} syntax roles (tok-key/str/com/num/fn) clear 4.5:1 on --surface`, () => {
      const misses: string[] = [];
      for (const role of ["tok-key", "tok-str", "tok-com", "tok-num", "tok-fn"]) {
        const r = contrast(vars.get(role) as string, vars.get("surface") as string);
        if (r < 4.5) misses.push(`${role}: ${r.toFixed(2)}`);
      }
      expect(misses, misses.join("; ")).toEqual([]);
    });
  }
});
