// 夜移 019 (#30 native-ts file-index wudao 适配切片) — the pure matcher
// behind the Ctrl+P palette: smart-case, a–z bitmap pre-reject, fused
// nucleo-style scoring (boundary/camel/consecutive/gap/first-char/short-path)
// with wudao's kept divergences (basename-bonus class separation, path-asc
// tie-break), and the time-chunked async build with a queryable ready prefix
// (the 「按时间分块建索引」 paradigm: chunk sizes are TIME-based so slow
// machines yield sooner; search works on the ready prefix while build runs).
import { describe, it, expect } from "vitest";
import { buildPathIndex, buildPathIndexAsync, searchPathIndex } from "../src/file-fuzzy.js";

const rows = (hits: readonly { path: string }[]): readonly string[] => hits.map((h) => h.path);

describe("file-fuzzy matching (smart-case + bitmap pre-reject)", () => {
  it("lowercase query is case-insensitive; uppercase flips to case-sensitive (real CC smart-case)", () => {
    const idx = buildPathIndex(["src/App.tsx", "src/fap.md", "APIRoute.tsx"]);
    // "ap" (lowercase) matches all three case-insensitively (A..p, a..p, A..P).
    // Scores: App 74 (boundary after '/' + consecutive + short-path), APIRoute
    // 73 (first-char + consecutive, one char longer), fap 66 (its 'a' follows
    // 'f', not a boundary — src/|f|a..p). Deterministic, hand-verified.
    expect(rows(searchPathIndex(idx, "ap", 10))).toEqual(["src/App.tsx", "APIRoute.tsx", "src/fap.md"]);
    // "AP" (uppercase) is case-SENSITIVE: only APIRoute.tsx carries A then P.
    // src/App.tsx's p is lowercase — the old always-lowercased matcher
    // matched it; the flip is the new contract.
    expect(rows(searchPathIndex(idx, "AP", 10))).toEqual(["APIRoute.tsx"]);
  });

  it("CJK needle chars ride through the a–z bitmap untouched (it only encodes letters)", () => {
    const idx = buildPathIndex(["src/配置.md", "docs/指南.md", "src/其他.md"]);
    expect(rows(searchPathIndex(idx, "配置", 10))).toEqual(["src/配置.md"]);
    // Mixed: the letter constrains via the bitmap, the CJK char via the scan.
    expect(rows(searchPathIndex(idx, "s配", 10))).toEqual(["src/配置.md"]);
    expect(rows(searchPathIndex(idx, "d指", 10))).toEqual(["docs/指南.md"]);
  });

  it("dedupes and drops empty paths at build time", () => {
    const idx = buildPathIndex(["a.ts", "a.ts", "", "b.ts"]);
    expect(rows(searchPathIndex(idx, "ts", 10))).toEqual(["a.ts", "b.ts"]);
  });

  it("queries past MAX_QUERY_LEN cap at 64 chars without error", () => {
    const idx = buildPathIndex(["a.ts"]);
    expect(rows(searchPathIndex(idx, "a".repeat(80), 10))).toEqual([]);
  });
});

describe("file-fuzzy scoring (fused nucleo-style + kept wudao divergences)", () => {
  it("boundary and first-char bonuses beat mid-word hits", () => {
    const idx = buildPathIndex(["length.ts", "git-helpers.ts"]);
    // 'g' starts git-helpers (first-char) and 'h' sits after '-' (boundary);
    // in length.ts both are buried mid-word — git-helpers ranks first.
    expect(rows(searchPathIndex(idx, "gh", 10))[0]).toBe("git-helpers.ts");
  });

  it("consecutive beats gapped at equal prefix (equal boundary conditions)", () => {
    const idx = buildPathIndex(["xaqwb.txt", "xab.txt"]);
    // Both anchor 'a' mid-name after the same 'x' (equal bonuses); b then
    // rides consecutive (+4) in xab vs a 2-char gap (−5) in xaqwb — xab first.
    expect(rows(searchPathIndex(idx, "ab", 10))).toEqual(["xab.txt", "xaqwb.txt"]);
  });

  it("the basename-bonus class separation survives the new scorer (ui-review-r3 pin)", () => {
    const idx = buildPathIndex(["web/happy/mapper.ts", "src/App.tsx"]);
    expect(rows(searchPathIndex(idx, "app", 10))[0]).toBe("src/App.tsx");
  });

  it("camel bonus rewards the hump in case-sensitive mode", () => {
    const idx = buildPathIndex(["src/myLongName.ts", "src/mycamel.ts"]);
    // 'LN' hits the LongName hump (camel + consecutive); in mycamel the L is
    // absent case-sensitively — only myLongName matches at all.
    expect(rows(searchPathIndex(idx, "LN", 10))).toEqual(["src/myLongName.ts"]);
  });

  it("paths containing 'test' rank below equal-shape non-test paths (mild demotion)", () => {
    // Equal length class (8 vs 10 chars both >>2 === 2 → same short-path
    // bonus) and identical match shape → only the test-penalty decides.
    const idx = buildPathIndex(["test/xx.ts", "aa/xx.ts"]);
    expect(rows(searchPathIndex(idx, "xx", 10))).toEqual(["aa/xx.ts", "test/xx.ts"]);
  });

  it("the limit caps the ranked list; ties break by path asc (wudao determinism)", () => {
    const idx = buildPathIndex(["b/m.ts", "a/m.ts", "c/m.ts"]);
    expect(rows(searchPathIndex(idx, "m", 2))).toEqual(["a/m.ts", "b/m.ts"]);
  });
});

describe("file-fuzzy async build — time-chunked, queryable prefix (#30 pattern)", () => {
  // A deterministic clock: every now() call advances 1ms, so the boundary
  // check (every 256 paths) sees a fixed elapsed and yields every 4th
  // boundary (1024 paths per chunk) regardless of machine speed.
  const fakeClock = (): { now: () => number; calls: () => number } => {
    let t = 0;
    let calls = 0;
    return { now: () => { calls += 1; return (t += 1); }, calls: () => calls };
  };

  function manualScheduler(): { schedule: () => Promise<void>; drain: () => void; pending: () => number } {
    const queue: (() => void)[] = [];
    return {
      schedule: () => new Promise<void>((resolve) => { queue.push(resolve); }),
      drain: () => { const q = queue.splice(0); for (const r of q) r(); },
      pending: () => queue.length,
    };
  }

  const manyPaths = (n: number): readonly string[] =>
    Array.from({ length: n }, (_, i) => `pkg${Math.floor(i / 50)}/file${i}.ts`);

  it("search works on the ready prefix while the build continues, and done equals the sync build", async () => {
    const paths = manyPaths(6000); // 6 chunks at 1024 paths/chunk
    const sched = manualScheduler();
    const build = buildPathIndexAsync(paths, { chunkMs: 4, now: fakeClock().now, schedule: sched.schedule });
    // First chunk must have completed synchronously enough to be queryable
    // only after we drain the scheduler once (the yield is a real boundary).
    expect(build.readyCount()).toBe(0);
    // The dedupe pass yields too — keep draining until the INDEX pass's first
    // chunk lands (that is what makes queryable resolve), then a bit more.
    while (build.readyCount() === 0) {
      sched.drain();
      await Promise.resolve();
    }
    await build.queryable;
    const partial = build.readyCount();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(paths.length);
    // Searching now only sees the ready prefix.
    const early = searchPathIndex(build.index, "file5999", 5);
    expect(early).toEqual([]);
    // Drain everything → done; the full index matches the sync build exactly.
    while (build.readyCount() < paths.length) {
      sched.drain();
      await Promise.resolve();
    }
    await build.done;
    expect(build.readyCount()).toBe(paths.length);
    const syncIdx = buildPathIndex(paths);
    expect(rows(searchPathIndex(build.index, "file5999", 3))).toEqual(rows(searchPathIndex(syncIdx, "file5999", 3)));
    expect(rows(searchPathIndex(build.index, "pkg3/file", 3))).toEqual(rows(searchPathIndex(syncIdx, "pkg3/file", 3)));
  });

  it("a small list builds in one chunk: queryable and done both resolve after a single drain", async () => {
    const sched = manualScheduler();
    const build = buildPathIndexAsync(["a.ts", "b.ts"], { chunkMs: 4, now: fakeClock().now, schedule: sched.schedule });
    sched.drain();
    await build.queryable;
    await build.done;
    expect(rows(searchPathIndex(build.index, "a", 5))).toEqual(["a.ts"]);
  });

  it("yields happen because elapsed time exceeds chunkMs, not because of a path count", async () => {
    const paths = manyPaths(4096);
    // Advancing clock: boundary checks see growing elapsed → yields happen.
    let advancingYields = 0;
    await buildPathIndexAsync(paths, {
      chunkMs: 4,
      now: fakeClock().now,
      schedule: () => { advancingYields += 1; return Promise.resolve(); },
    }).done;
    expect(advancingYields).toBeGreaterThan(0);
    // Frozen clock: elapsed is always 0 → NO yield, even at 4096 paths. A
    // count-based chunker would yield in both variants — this pins that the
    // chunk unit is TIME (slow machines get smaller chunks, per real CC).
    let frozenYields = 0;
    await buildPathIndexAsync(paths, {
      chunkMs: 4,
      now: () => 0,
      schedule: () => { frozenYields += 1; return Promise.resolve(); },
    }).done;
    expect(frozenYields).toBe(0);
  });
});
