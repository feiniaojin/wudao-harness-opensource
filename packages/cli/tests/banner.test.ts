// M42 §1 — the startup banner: hand-drawn WUDAO glyph art (zero deps),
// the info line, and the narrow-terminal single-line fallback. Pure module:
// every decision (width, fallback, quiet/non-TTY skip) is testable without a
// terminal.
import { describe, it, expect } from "vitest";
import {
  BANNER_GLYPH_LINES,
  BANNER_MAX_COLS,
  BANNER_MIN_COLS,
  buildBanner,
  printBanner,
} from "../src/tui/banner.js";

describe("banner glyph art", () => {
  it("every line fits the 72-column budget", () => {
    for (const line of BANNER_GLYPH_LINES) {
      expect(line.length).toBeLessThanOrEqual(BANNER_MAX_COLS);
    }
  });

  it("all lines are the same width (no ragged right edge)", () => {
    const widths = new Set(BANNER_GLYPH_LINES.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("is block-letter art, not empty or a plain word", () => {
    expect(BANNER_GLYPH_LINES.length).toBeGreaterThanOrEqual(4);
    expect(BANNER_GLYPH_LINES.join("\n")).toMatch(/█|▓|#|@/);
  });
});

describe("buildBanner", () => {
  const info = { version: "0.2.0", model: "deepseek-v4-flash", session8: "060dc142", mode: "ask" };

  it("wide terminal: glyph art, a blank line, then the info line", () => {
    const lines = buildBanner(info, 120);
    expect(lines.length).toBe(BANNER_GLYPH_LINES.length + 2);
    expect(lines.slice(0, BANNER_GLYPH_LINES.length)).toEqual([...BANNER_GLYPH_LINES]);
    expect(lines[BANNER_GLYPH_LINES.length]).toBe("");
    expect(lines[lines.length - 1]).toBe("悟道Harness v0.2.0 · deepseek-v4-flash · 060dc142 · 模式 ask"); // ω99-190: 钉随源演进
  });

  it("exactly at the threshold stays wide; one column below degrades", () => {
    expect(buildBanner(info, BANNER_MIN_COLS).length).toBeGreaterThan(1);
    const narrow = buildBanner(info, BANNER_MIN_COLS - 1);
    expect(narrow.length).toBe(1);
  });

  it("narrow terminal: one fallback line carrying the identity fields", () => {
    const [line] = buildBanner(info, 40);
    expect(line).toContain("WUDAO");
    expect(line).toContain("v0.2.0");
    expect(line).toContain("deepseek-v4-flash");
    expect(line).toContain("060dc142");
    expect(line).toContain("模式 ask"); // ω99-190: 钉随源演进
    expect((line ?? "").length).toBeLessThanOrEqual(BANNER_MAX_COLS);
  });

  it("undefined columns (no winsize) renders the wide banner", () => {
    expect(buildBanner(info, undefined).length).toBe(BANNER_GLYPH_LINES.length + 2);
  });

  it("a provider·model label flows through unsplit", () => {
    const lines = buildBanner({ ...info, model: "glm · glm-5.2" }, 120);
    expect(lines[lines.length - 1]).toBe("悟道Harness v0.2.0 · glm · glm-5.2 · 060dc142 · 模式 ask"); // ω99-190: 钉随源演进；品牌弧 09-15 前缀
  });
});

describe("printBanner", () => {
  const info = { version: "0.2.0", model: "m", session8: "s", mode: "ask" };
  const collect = (): { out: string[]; write: (t: string) => void } => {
    const out: string[] = [];
    return { out, write: (t) => out.push(t) };
  };

  it("writes the banner lines plus one trailing blank separator, returns true", () => {
    const { out, write } = collect();
    const printed = printBanner(info, { columns: 120, tty: true }, write);
    expect(printed).toBe(true);
    const text = out.join("");
    expect(text).toContain("v0.2.0 · m · s · 模式 ask"); // ω99-190: 钉随源演进
    expect(text.endsWith("\n\n")).toBe(true); // info line + trailing blank
  });

  it("quiet skips the banner entirely", () => {
    const { out, write } = collect();
    expect(printBanner(info, { columns: 120, quiet: true, tty: true }, write)).toBe(false);
    expect(out).toEqual([]);
  });

  it("non-TTY never prints (piped/CI output stays clean)", () => {
    const { out, write } = collect();
    expect(printBanner(info, { columns: 120, tty: false }, write)).toBe(false);
    expect(out).toEqual([]);
  });
});
