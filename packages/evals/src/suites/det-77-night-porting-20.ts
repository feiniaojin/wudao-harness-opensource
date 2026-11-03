// det-77-night-porting-20 — the deterministic pins for 夜移 032 (the
// per-run net file-change ledger, ported from codex's
// turn_diff_tracker.rs). Five sequential edits to one file today leave five
// receipts and no answer to "what did THIS run actually change?" — the
// tracker collapses them to one before→after pair (first write's pre-state
// vs last write's bytes). Pinned here through the public export: the
// baseline/current algebra, created-vs-modified classification, resetRun's
// fresh baseline, path-sorted determinism, and the preview line's shape.
import type { EvalDefinition } from "../runner.js";
import { createTurnDiffTracker, formatTurnDiffPreview } from "@wudao-org/core";

export interface NightPorting20Evidence {
  // ① first write's pre-state is the baseline; later writes advance only
  //    after + writes — 3 writes, one pair
  readonly netCollapse: boolean;
  // ② a file first WRITTEN this run stays created even after later edits
  readonly createdStaysCreated: boolean;
  // ③ resetRun: the ledger empties and the next run's baseline is fresh
  readonly resetFreshBaseline: boolean;
  // ④ files() is path-sorted regardless of write order
  readonly pathSorted: boolean;
  // ⑤ the preview line: ≤3 names listed, >3 rolls up the count
  readonly previewRollup: boolean;
  // ⑥ an identical-net write is still listed (evidence, not noise)
  readonly identicalNetListed: boolean;
}

export const det77Eval: EvalDefinition<Record<string, never>, NightPorting20Evidence> = {
  name: "det-77-night-porting-20",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① three writes to one path → ONE net entry: before = v1's pre-state,
    //    after = v3, writes = 3.
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "v0", "v1");
    t.record("/w/a.ts", "v1", "v2");
    t.record("/w/a.ts", "v2", "v3");
    const collapsed = t.files();
    const netCollapse = collapsed.length === 1
      && collapsed[0]!.before === "v0"
      && collapsed[0]!.after === "v3"
      && collapsed[0]!.writes === 3
      && collapsed[0]!.op === "modified";

    // ② create then edit: before stays undefined (created), writes = 2.
    const t2 = createTurnDiffTracker();
    t2.record("/w/n.ts", undefined, "x");
    t2.record("/w/n.ts", "x", "y");
    const f = t2.files()[0]!;
    const createdStaysCreated = f.op === "created" && f.before === undefined && f.after === "y" && f.writes === 2;

    // ③ resetRun empties; the next record starts a fresh baseline.
    t2.resetRun();
    const resetEmpty = t2.files().length === 0;
    t2.record("/w/n.ts", "y", "z");
    const next = t2.files()[0]!;
    const resetFreshBaseline = resetEmpty && next.before === "y" && next.after === "z" && next.writes === 1;

    // ④ deterministic path sort regardless of insertion order.
    const t3 = createTurnDiffTracker();
    t3.record("/w/z.ts", "a", "b");
    t3.record("/w/a.ts", "a", "b");
    t3.record("/w/m.ts", "a", "b");
    const pathSorted = t3.files().map((x) => x.path).join(",") === "/w/a.ts,/w/m.ts,/w/z.ts";

    // ⑤ preview: ≤3 listed; >3 rolls up to 「… 等 N 文件」.
    const three = formatTurnDiffPreview(
      [{ path: "/w/1.ts", op: "created", before: undefined, after: "a", writes: 1 },
       { path: "/w/2.ts", op: "modified", before: "a", after: "b", writes: 2 },
       { path: "/w/3.ts", op: "modified", before: "a", after: "b", writes: 1 }],
      (p) => p.slice(3),
    );
    const five = formatTurnDiffPreview(
      [1, 2, 3, 4, 5].map((n) => ({ path: `/w/f${n}.ts`, op: "modified" as const, before: "a", after: "b", writes: 1 })),
      (p) => p.slice(3),
    );
    const previewRollup = three === "回合净变更 3 文件：1.ts(新建) · 2.ts(×2) · 3.ts(×1)"
      && five === "回合净变更 5 文件：f1.ts(×1) · f2.ts(×1) · f3.ts(×1) 等 5 文件"
      && five.includes("等 5 文件")
      && !five.includes("f4.ts");

    // ⑥ before === after still listed — a run that rewrote identical bytes
    //    is evidence, not noise (the deliberate divergence from codex's
    //    renderer, which drops left==right).
    const t4 = createTurnDiffTracker();
    t4.record("/w/same.ts", "s", "s");
    const ident = t4.files()[0]!;
    const identicalNetListed = ident.before === "s" && ident.after === "s" && ident.writes === 1;

    return { netCollapse, createdStaysCreated, resetFreshBaseline, pathSorted, previewRollup, identicalNetListed };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.netCollapse, "① three writes to one path must collapse to one net pair (first pre-state vs last bytes)");
    need(e.createdStaysCreated, "② a file first written this run stays created even after later edits");
    need(e.resetFreshBaseline, "③ resetRun must empty the ledger and start the next run's baseline fresh");
    need(e.pathSorted, "④ files() must be path-sorted regardless of write order");
    need(e.previewRollup, "⑤ the preview line must list ≤3 names and roll up the count beyond");
    need(e.identicalNetListed, "⑥ an identical-net write must still be listed (evidence, not noise — the wudao divergence from codex's renderer)");

    return errs;
  },
};
