// 夜移 032 — the cli-side net-diff renderer (codex's git-style unified
// output over the core tracker's ledger; LCS reuse from M32's
// file-changes.ts). The preview rides the run's notice text, the full diff
// rides the notice detail.
import { describe, it, expect } from "vitest";
import { renderTurnDiff } from "../src/turn-diff-render.js";
import type { TurnDiffFile } from "@wudao/core";

const WS = "/w";
const rel = (p: string): string => p.slice(WS.length + 1);
const file = (path: string, before: string | undefined, after: string, writes = 1): TurnDiffFile =>
  ({ path, op: before === undefined ? "created" : "modified", before, after, writes });

describe("夜移 032 renderTurnDiff", () => {
  it("renders a modified file as git-style headers + hunks", () => {
    const r = renderTurnDiff([file(`${WS}/a.ts`, "one\ntwo\n", "one\nTWO\n")], rel);
    expect(r.text).toContain("a.ts");
    expect(r.detail).toContain("--- a/a.ts");
    expect(r.detail).toContain("+++ b/a.ts");
    expect(r.detail).toContain("-two");
    expect(r.detail).toContain("+TWO");
  });

  it("a created file carries the new-file marker and no deletions", () => {
    const r = renderTurnDiff([file(`${WS}/new.ts`, undefined, "hello\n")], rel);
    expect(r.detail).toContain("new file");
    expect(r.detail).toContain("+hello");
    expect(r.detail).not.toContain("--- a/new.ts");
  });

  it("an identical-net file is listed in the preview but renders no hunks", () => {
    const r = renderTurnDiff([file(`${WS}/same.ts`, "x\n", "x\n")], rel);
    expect(r.text).toContain("same.ts");
    expect(r.detail).not.toContain("same.ts");
  });

  it("files render in tracker order with a blank line between them", () => {
    const r = renderTurnDiff([
      file(`${WS}/a.ts`, "a\n", "b\n"),
      file(`${WS}/c.ts`, "c\n", "d\n"),
    ], rel);
    const aIdx = r.detail.indexOf("--- a/a.ts");
    const cIdx = r.detail.indexOf("--- a/c.ts");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThan(aIdx);
    // two file blocks separated by exactly one blank line
    expect(r.detail).toMatch(/\n\ndiff --git a\/c\.ts/);
  });

  it("caps the detail at maxBytes with an explicit truncation marker", () => {
    const big = `${"x\n".repeat(500)}`;
    const r = renderTurnDiff([file(`${WS}/big.ts`, "", big)], rel, { maxBytes: 512 });
    expect(Buffer.byteLength(r.detail, "utf8")).toBeLessThanOrEqual(512 + 200); // marker allowance
    expect(r.truncated).toBe(true);
    expect(r.detail).toContain("截断");
  });

  it("empty ledger renders nothing (no notice at all)", () => {
    const r = renderTurnDiff([], rel);
    expect(r.text).toBe("");
    expect(r.detail).toBe("");
    expect(r.fileCount).toBe(0);
  });

  it("preview lists up to three files then rolls up the count", () => {
    const files = [1, 2, 3, 4, 5].map((n) => file(`${WS}/f${n}.ts`, "a\n", "b\n"));
    const r = renderTurnDiff(files, rel);
    expect(r.text).toContain("5 文件");
    expect(r.text).toContain("f1.ts");
    expect(r.text).toContain("f3.ts");
    expect(r.text).not.toContain("f4.ts");
  });
});
