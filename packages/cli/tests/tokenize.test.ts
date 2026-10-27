// M49 §3/§1 — shared tokenizer: word-runs for latin, bigrams for CJK.
import { describe, it, expect } from "vitest";
import { tokenizeText, hasCjk, tokenSet, jaccard } from "../src/tokenize.js";

describe("tokenizeText", () => {
  it("lowercases latin words and drops single letters", () => {
    expect(tokenizeText("Fix the Login BUG")).toEqual(["fix", "the", "login", "bug"]);
  });
  it("CJK runs become consecutive bigrams", () => {
    expect(tokenizeText("修复登录页面")).toEqual(["修复", "复登", "登录", "录页", "页面"]);
    expect(tokenizeText("修")).toEqual(["修"]);
  });
  it("mixed zh/en tokenizes both ways", () => {
    expect(tokenizeText("修复 login bug")).toEqual(["修复", "login", "bug"]);
  });
  it("digits ride latin words; punctuation separates", () => {
    expect(tokenizeText("pnpm eval 2026, done.")).toEqual(["pnpm", "eval", "2026", "done"]);
  });
  it("empty stays empty", () => {
    expect(tokenizeText("!!! ???")).toEqual([]);
  });
});

describe("hasCjk / tokenSet / jaccard", () => {
  it("detects CJK anywhere", () => {
    expect(hasCjk("fix 修复")).toBe(true);
    expect(hasCjk("plain latin")).toBe(false);
  });
  it("tokenSet dedupes; jaccard is the set ratio", () => {
    const a = tokenSet("run pnpm eval before merging");
    const b = tokenSet("run pnpm eval before shipping");
    // shared {run,pnpm,eval,before}=4, union=6 → 0.666…
    expect(jaccard(a, b)).toBeCloseTo(4 / 6, 5);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(a, a)).toBe(1);
  });
});
