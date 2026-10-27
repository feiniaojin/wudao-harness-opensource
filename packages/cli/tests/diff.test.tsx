import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { computeDiff, DiffView, escapeForReplace, DIFF_SCAN_BUDGET_MS } from "../src/tui/diff.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("computeDiff", () => {
  it("marks the changed middle with del/add and keeps common context", () => {
    const hunk = computeDiff("a\nb\nc", "a\nX\nc");
    expect(hunk).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "X" },
      { kind: "ctx", text: "c" },
    ]);
  });
  it("handles pure insertion and pure deletion", () => {
    expect(computeDiff("a", "a\nb")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(computeDiff("a\nb", "a")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
    ]);
  });
});

describe("DiffView", () => {
  it("renders the path header and +/- lines", () => {
    const { lastFrame } = render(<DiffView path="src/a.ts" oldString={"const a = 1;"} newString={"const a = 2;"} />);
    const f = stripAnsi(lastFrame() ?? "");
    expect(f).toContain("src/a.ts");
    expect(f).toContain("- const a = 1;");
    expect(f).toContain("+ const a = 2;");
  });
});

// ---------------------------------------------------------------------------
// M51 §4 (A7) — diff edge hardening: replacement-escape safety + the 5s scan
// guard. No live template-replace bug existed (the view interpolates via
// template literals); these tests pin the invariant and the exported escape
// helper any future replace()-consumer must use.
// ---------------------------------------------------------------------------

describe("M51 A7: $/& escape safety", () => {
  it("diff text containing $&, $1, $', $$ survives computeDiff verbatim", () => {
    const oldS = "const price = \"$& $1 $' $$ $`\";";
    const newS = "const price = 'cost $& $1';";
    const hunk = computeDiff(oldS, newS);
    const del = hunk.filter((l) => l.kind === "del").map((l) => l.text).join("\n");
    const add = hunk.filter((l) => l.kind === "add").map((l) => l.text).join("\n");
    expect(del).toContain('$& $1 $\' $$ $`');
    expect(add).toContain("$& $1");
  });

  it("escapeForReplace doubles $ so a replacement slot stays literal", () => {
    expect(escapeForReplace("$& $1")).toBe("$$& $$1");
    // the canonical proof: replace with the ESCAPED text yields the original
    expect("x".replace(/x/, escapeForReplace("$& $1"))).toBe("$& $1");
  });

  it("a FUNCTION replacer never expands $-sequences (the recommended pattern)", () => {
    expect("x".replace(/x/, () => "$&")).toBe("$&");
  });
});

describe("M51 A7: 5s scan guard", () => {
  it("degrades to the whole-replace hunk when the scan budget is exceeded", () => {
    // 6k distinct lines: the guard checks every 0x1000 steps, so stub the
    // clock past the deadline right after the first check window.
    const lines = Array.from({ length: 6_000 }, (_, i) => `line-${i}`);
    const a = [...lines];
    const b = [...lines.slice(0, 100), ...lines.slice(100).map((l, i) => `${l}-changed-${i}`)];
    const realNow = Date.now;
    let call = 0;
    Date.now = () => {
      call += 1;
      return call <= 1 ? realNow() : realNow() + DIFF_SCAN_BUDGET_MS + 1;
    };
    try {
      const hunk = computeDiff(a.join("\n"), b.join("\n"));
      // degraded: NO ctx lines claimed — everything old deleted, everything new added
      expect(hunk.every((l) => l.kind === "del" || l.kind === "add")).toBe(true);
      expect(hunk.filter((l) => l.kind === "del")).toHaveLength(6_000);
      expect(hunk.filter((l) => l.kind === "add")).toHaveLength(6_000);
    } finally {
      Date.now = realNow;
    }
  });
});
