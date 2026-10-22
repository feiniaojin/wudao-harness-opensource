// M51 §2 — diagnostic baseline-diff: captureBaseline over the M46 checker
// probes, newOnly = current − baseline set-diff, caps (≤10/file, ≤30/turn),
// 5s per-file cache + LRU 50.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBaseline, createDiagnosticsLayer, BASELINE_TTL_MS, BASELINE_LRU_LIMIT } from "../src/diagnostics.js";
import type { WriteVerifyConfig, WriteVerifyOutcome } from "@wudao/core";

const CONFIG: WriteVerifyConfig = { enabled: true, tsTsc: false };

/** Real `node --check` outcomes are deterministic — but the layer's logic is
 *  what these tests pin, so the verify seam is faked with a scriptable map. */
function fakeVerify(script: (absPath: string, content: string) => WriteVerifyOutcome) {
  const calls: { path: string; content: string }[] = [];
  return {
    calls,
    async fn(args: { absPath: string; content: string; workspaceRoot: string; config: WriteVerifyConfig }): Promise<WriteVerifyOutcome> {
      calls.push({ path: args.absPath, content: args.content });
      return script(args.absPath, args.content);
    },
  };
}

const failWith = (...errors: string[]): WriteVerifyOutcome => ({ status: "fail", checker: "node --check", errors });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-diag-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

describe("captureBaseline", () => {
  it("runs the checker per path and returns Map<path, diagnostic lines>", async () => {
    await writeFile(join(dir, "ok.js"), "const a = 1;\n", "utf8");
    await writeFile(join(dir, "bad.js"), "const a = {\n", "utf8");
    const v = fakeVerify((p) => (p.endsWith("bad.js") ? failWith("bad.js:1: SyntaxError: unexpected token") : { status: "pass", checker: "node --check" }));
    const map = await captureBaseline({ paths: [join(dir, "ok.js"), join(dir, "bad.js")], workspaceRoot: dir, config: CONFIG, verify: v.fn });
    expect(map.get(join(dir, "ok.js"))).toEqual([]);
    expect(map.get(join(dir, "bad.js"))).toEqual(["bad.js:1: SyntaxError: unexpected token"]);
  });

  it("real checkers: a pre-existing syntax error lands in the baseline", async () => {
    await writeFile(join(dir, "pre.js"), "function f( {\n", "utf8");
    const map = await captureBaseline({ paths: [join(dir, "pre.js")], workspaceRoot: dir, config: CONFIG });
    const lines = map.get(join(dir, "pre.js"))!;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/pre\.js:\d+: /);
  });

  it("a missing file is an empty baseline (fresh create)", async () => {
    const map = await captureBaseline({ paths: [join(dir, "new.js")], workspaceRoot: dir, config: CONFIG });
    expect(map.get(join(dir, "new.js"))).toEqual([]);
  });
});

describe("createDiagnosticsLayer", () => {
  it("newOnly = post errors − baseline set (old errors filtered, new kept)", async () => {
    await writeFile(join(dir, "f.js"), "let x = ;\n", "utf8");
    let content = "let x = ;\n";
    const v = fakeVerify((_p, c) =>
      c === content ? failWith("f.js:1: old error") : failWith("f.js:1: old error", "f.js:5: NEW error"));
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG, verify: v.fn });
    await layer.beforeWrite(join(dir, "f.js"));
    content = "let x = ;\nmore\nmore\nmore\nbad\n";
    const lines = await layer.afterWrite({
      absPath: join(dir, "f.js"),
      outcome: failWith("f.js:1: old error", "f.js:5: NEW error"),
    });
    expect(lines).toEqual(["f.js:5: NEW error"]);
  });

  it("pass/skip outcomes return no lines", async () => {
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG });
    await layer.beforeWrite(join(dir, "a.js"));
    expect(await layer.afterWrite({ absPath: join(dir, "a.js"), outcome: { status: "pass", checker: "node --check" } })).toEqual([]);
    expect(await layer.afterWrite({ absPath: join(dir, "a.js"), outcome: { status: "skip", checker: "none" } })).toEqual([]);
  });

  it("no baseline captured (afterWrite cold) → silent, never mislabels old errors as new", async () => {
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG });
    const lines = await layer.afterWrite({ absPath: join(dir, "x.js"), outcome: failWith("x.js:1: whatever") });
    expect(lines).toEqual([]);
  });

  it("5s cache: a second beforeWrite within the TTL does NOT re-run the checker", async () => {
    await writeFile(join(dir, "f.js"), "let x = 1;\n", "utf8");
    const v = fakeVerify(() => ({ status: "pass", checker: "node --check" }));
    let t = 1_000;
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG, verify: v.fn, now: () => t });
    await layer.beforeWrite(join(dir, "f.js"));
    await layer.beforeWrite(join(dir, "f.js"));
    expect(v.calls).toHaveLength(1);
    t += BASELINE_TTL_MS; // expired → re-capture
    await layer.beforeWrite(join(dir, "f.js"));
    expect(v.calls).toHaveLength(2);
  });

  it("baseline LRU: the 51st distinct path evicts the least-recently-used entry", async () => {
    const v = fakeVerify(() => ({ status: "pass", checker: "node --check" }));
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG, verify: v.fn });
    const first = join(dir, "p00.js");
    for (let i = 0; i <= BASELINE_LRU_LIMIT; i += 1) {
      // real files — a missing file never reaches the verify seam
      await writeFile(join(dir, `p${String(i).padStart(2, "0")}.js`), "const v = 1;\n", "utf8");
      await layer.beforeWrite(join(dir, `p${String(i).padStart(2, "0")}.js`));
    }
    // LRU_LIMIT+1 paths captured; the first was evicted → touching it re-runs.
    const before = v.calls.length;
    await layer.beforeWrite(first);
    expect(v.calls.length).toBe(before + 1);
    // a still-cached path does NOT re-run
    const cached = join(dir, `p${String(BASELINE_LRU_LIMIT).padStart(2, "0")}.js`);
    await layer.beforeWrite(cached);
    expect(v.calls.length).toBe(before + 1);
  });

  it("caps new-only lines at 10 per file", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `f.js:${i + 1}: error ${i}`);
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG });
    await layer.beforeWrite(join(dir, "f.js"));
    const lines = await layer.afterWrite({ absPath: join(dir, "f.js"), outcome: failWith(...many) });
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("f.js:1: error 0");
  });

  it("turn budget: ≤30 lines within the window, then suppressed", async () => {
    const layer = createDiagnosticsLayer({ workspaceRoot: dir, config: CONFIG });
    const outcome = (p: string) => failWith(...Array.from({ length: 10 }, (_, i) => `${p}:${i}: e`));
    for (const p of ["a.js", "b.js", "c.js", "d.js"]) {
      await layer.beforeWrite(join(dir, p));
      const lines = await layer.afterWrite({ absPath: join(dir, p), outcome: outcome(p) });
      if (p !== "d.js") expect(lines).toHaveLength(10);
      else expect(lines).toEqual([]); // 30 already emitted this turn
    }
  });
});

describe("buildToolSet wiring (M51 §2 regression)", () => {
  it("writeVerify enabled → the constructed diagnostics layer rides edit/write_file (two-layer feedback)", async () => {
    const { buildToolSet } = await import("../src/tools.js");
    const model = {
      async generate() {
        return { role: "assistant" as const, content: "unused" };
      },
    };
    const tools = buildToolSet({
      workspaceRoot: dir,
      model,
      canUseTool: async () => ({ behavior: "allow" as const }),
      contextWindowTokens: 64_000,
      writeVerify: CONFIG,
    });
    const edit = tools.find((t) => t.name === "edit")!;
    await writeFile(join(dir, "w.js"), "const a = 1;\nlet PRE_BROKEN = ;\n", "utf8");
    const r = await edit.execute({ path: "w.js", old_string: "const a = 1;", new_string: "const NEW_BROKEN = ;" });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("[verified: node --check");
    expect(r.content).toContain("[diagnostics new: 1]");
    expect(r.content).toContain("NEW_BROKEN");
  });
});
