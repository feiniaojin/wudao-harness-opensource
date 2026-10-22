// ω99-54 — UUIDv7 session ids + the list() three-tier ordering law.
// Phase 1 (this battery): the LAW side only, against hand-crafted v7 ids —
// no factory import — so every case below runs against base and is the
// independent RED. Phase 2 (factory acceptance) joins once session/id.ts
// exists.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../src/session/store.js";
import { newSessionId, createSessionIdFactory, isSessionIdV7, type SessionIdClock } from "../src/session/id.js";

// Count every stat() that flows through node:fs/promises while a store call
// runs — the "v7 files cost zero stat" acceptance's measuring instrument.
const { statPaths } = vi.hoisted(() => ({ statPaths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      statPaths.push(String(args[0]));
      return actual.stat(...args);
    },
  };
});

// Three v7 ids sharing one millisecond (ts field "018f1e2d-3c40") with a
// monotone counter in the random section — the exact shape the factory will
// emit: same-ms creation order IS lexicographic order.
const V1 = "018f1e2d-3c40-7000-8000-000000000001";
const V2 = "018f1e2d-3c40-7001-8000-000000000002";
const V3 = "018f1e2d-3c40-7002-8000-000000000003";

const T = (ms: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));

function statsUnder(dir: string): number {
  return statPaths.filter((p) => p.startsWith(dir)).length;
}

describe("ω99-54 — list() three-tier ordering law", () => {
  beforeEach(() => {
    statPaths.length = 0;
  });

  it("pure v7 set: id-ascending (creation) order, ZERO stat calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7-pure-"));
    try {
      // Files written in scrambled order; mtimes pinned in a WRONG order —
      // the legacy mtime law returns [V2, V3, V1]; the v7 tier ignores
      // mtime entirely (zero stat is what makes that honest).
      await writeFile(join(dir, `${V2}.jsonl`), "", "utf8");
      await writeFile(join(dir, `${V3}.jsonl`), "", "utf8");
      await writeFile(join(dir, `${V1}.jsonl`), "", "utf8");
      await utimes(join(dir, `${V1}.jsonl`), T(3000), T(3000));
      await utimes(join(dir, `${V2}.jsonl`), T(1000), T(1000));
      await utimes(join(dir, `${V3}.jsonl`), T(2000), T(2000));
      expect(await createJsonlSessionStore(dir).list()).toEqual([V1, V2, V3]);
      expect(statsUnder(dir)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("legacy-shaped set: stat-mtime ascending, exactly one stat per file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7-legacy-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("bbb", { role: "user", content: "x" });
      await store.append("aaa", { role: "user", content: "x" });
      await store.append("ccc", { role: "user", content: "x" });
      await utimes(join(dir, "aaa.jsonl"), T(1000), T(1000));
      await utimes(join(dir, "ccc.jsonl"), T(2000), T(2000));
      await utimes(join(dir, "bbb.jsonl"), T(3000), T(3000));
      expect(await store.list()).toEqual(["aaa", "ccc", "bbb"]);
      expect(statsUnder(dir)).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mixed set: epoch boundary — all legacy before all v7; touch laws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7-mixed-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("legacy-a", { role: "user", content: "x" });
      await store.append("legacy-b", { role: "user", content: "x" });
      await writeFile(join(dir, `${V1}.jsonl`), "", "utf8");
      await writeFile(join(dir, `${V2}.jsonl`), "", "utf8");
      await utimes(join(dir, "legacy-a.jsonl"), T(1000), T(1000));
      await utimes(join(dir, "legacy-b.jsonl"), T(2000), T(2000));
      await utimes(join(dir, `${V1}.jsonl`), T(5000), T(5000));
      await utimes(join(dir, `${V2}.jsonl`), T(6000), T(6000));
      expect(await store.list()).toEqual(["legacy-a", "legacy-b", V1, V2]);
      // Touching the OLDER legacy session (newest mtime overall): it stays
      // inside the legacy group, at the ascending end — still before v7.
      await utimes(join(dir, "legacy-a.jsonl"), T(9000), T(9000));
      expect(await store.list()).toEqual(["legacy-b", "legacy-a", V1, V2]);
      // v7 order is creation-fixed: touching V1 (or de-timing V2) never
      // moves either inside the v7 tier.
      await utimes(join(dir, `${V1}.jsonl`), T(10000), T(10000));
      await utimes(join(dir, `${V2}.jsonl`), T(3000), T(3000));
      expect(await store.list()).toEqual(["legacy-b", "legacy-a", V1, V2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("side- files stay excluded regardless of id shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7-side-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("top", { role: "user", content: "x" });
      await store.appendSidechain(V1, { role: "user", content: "child" });
      await store.appendSidechain("kid", { role: "user", content: "child" });
      expect(await store.list()).toEqual(["top"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--continue face: list() tail is the newest created session and moves on a new write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7-cont-"));
    try {
      await writeFile(join(dir, `${V1}.jsonl`), "", "utf8");
      await writeFile(join(dir, `${V2}.jsonl`), "", "utf8");
      // Mtimes deliberately hostile (V2 older than V1): under the v7 law the
      // tail is still V2 — the cli wiring is ids[ids.length-1] verbatim.
      await utimes(join(dir, `${V1}.jsonl`), T(5000), T(5000));
      await utimes(join(dir, `${V2}.jsonl`), T(1000), T(1000));
      const store = createJsonlSessionStore(dir);
      expect((await store.list()).at(-1)).toBe(V2);
      await writeFile(join(dir, `${V3}.jsonl`), "", "utf8");
      await utimes(join(dir, `${V3}.jsonl`), T(500), T(500));
      expect((await store.list()).at(-1)).toBe(V3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The 48-bit unix-ms field: first 12 hex chars (dash stripped), big-endian.
function tsOf(id: string): number {
  return parseInt(id.slice(0, 13).replace("-", ""), 16);
}

describe("ω99-54 — the v7 session id factory", () => {
  it("production singleton: v7 shape (regex pinned), unique, real-clock ms", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isSessionIdV7(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const ts = tsOf(id);
      expect(ts).toBeGreaterThan(1_600_000_000_000); // a plausible "now"
      expect(ts).toBeLessThan(4_100_000_000_000);
    }
  });

  it("injected same-millisecond clock: 1000 ids — creation order IS lexicographic order", () => {
    const MS = 1_780_000_000_000;
    const pinned: SessionIdClock = { now: () => MS };
    const next = createSessionIdFactory(pinned);
    const ids = Array.from({ length: 1000 }, () => next());
    expect(new Set(ids).size).toBe(1000);
    // The composition this acceptance is really after: list() orders the v7
    // tier by string sort, so "list order == creation order" reduces to
    // "sorted(ids) == ids" (the law battery above pins the list() side).
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => tsOf(id) === MS && isSessionIdV7(id))).toBe(true);
  });

  it("the 4097th same-ms id falls to the NEXT millisecond (waits, never throws)", () => {
    const MS = 1_780_000_000_000;
    let calls = 0;
    // Same ms for the first 5000 clock reads — the overflow spin consumes
    // reads until one advances; a real Date.now clock advances sub-ms.
    const clock: SessionIdClock = { now: () => (calls++ < 5000 ? MS : MS + 1) };
    const next = createSessionIdFactory(clock);
    const ids = Array.from({ length: 4097 }, () => next());
    expect(new Set(ids).size).toBe(4097);
    expect(ids.slice(0, 4096).every((id) => tsOf(id) === MS)).toBe(true); // 4096/ms cap
    const over = ids[4096];
    expect(tsOf(over)).toBe(MS + 1); // fell to the next millisecond
    expect([...ids].sort()).toEqual(ids); // still strictly creation-ordered
  });

  it("different milliseconds order by time; a backward wall clock never steps the ms down", () => {
    const MS = 1_780_000_000_000;
    const seq = [MS, MS, MS + 10, MS + 10, MS + 3 /* skew back — clamped */];
    let i = 0;
    const next = createSessionIdFactory({ now: () => seq[i++ % seq.length] });
    const ids = Array.from({ length: seq.length }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(ids.map(tsOf)).toEqual([MS, MS, MS + 10, MS + 10, MS + 10]);
    // And a clean forward run sorts by time, strictly.
    let t = MS;
    const fwd = createSessionIdFactory({ now: () => t++ });
    const fids = Array.from({ length: 5 }, () => fwd());
    expect([...fids].sort()).toEqual(fids);
    expect(fids.map(tsOf)).toEqual([MS, MS + 1, MS + 2, MS + 3, MS + 4]);
  });

  it("isSessionIdV7: accepts the factory's output, rejects every other shape", () => {
    expect(isSessionIdV7("018f1e2d-3c40-7000-8000-000000000001")).toBe(true);
    expect(isSessionIdV7("018f1e2d-3c40-7fff-bfff-ffffffffffff")).toBe(true);
    expect(isSessionIdV7(newSessionId())).toBe(true);
    expect(isSessionIdV7("aaa")).toBe(false); // legacy 8-hex truncation
    expect(isSessionIdV7("1a2b3c4d")).toBe(false);
    expect(isSessionIdV7("123e4567-e89b-42d3-a456-426614174000")).toBe(false); // v4
    expect(isSessionIdV7("018f1e2d-3c40-6000-8000-000000000001")).toBe(false); // ver≠7
    expect(isSessionIdV7("018f1e2d-3c40-7000-c000-000000000001")).toBe(false); // variant∉89ab
    expect(isSessionIdV7("018F1E2D-3C40-7000-8000-000000000001")).toBe(false); // uppercase → legacy tier
  });
});
