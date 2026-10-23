// #48 (hermes#4 turn-lease slice) — the cross-process session RUN lease.
// The store's promise-tail (夜移 031) serializes writers IN one process; two
// OS processes on the same `<workspace>/.wudao/sessions` had nothing —
// interleaved appends, a heal-rename racing a live append (rename swaps the
// dirent; the other process's fd keeps writing the orphaned inode — silent
// data loss), and two live drivers forking one history. The lease gives a
// session file exactly ONE live run-writer process:
//   - acquire = wx-create `<root>/.leases/<id>.json` {pid, at, gen}
//   - EEXIST → live holder refuses; dead holder (kill(pid,0) ESRCH) is
//     stolen via rename + read-back verify (the steal race's loser sees
//     the winner's live pid and refuses)
//   - release is GENERATION-SCOPED: a holder that lost its lock to a steal
//     (revived after a crash) must never unlink the successor's lock
//   - in-process registry: re-acquiring what this process already holds is
//     idempotent (the engine and the driver share one lease)
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { acquireSessionLease, sessionLeaseBoxFor, createMultiSlotLeaseBox } from "../src/session/lease.js";

/** Fire-and-forget rotate test helper: poll until cond() (bounded). */
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const newRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "wudao-lease-"));

/** Hand-write a foreign lock (the module only creates .leases on acquire). */
const seedLock = async (root: string, id: string, body: string): Promise<void> => {
  await mkdir(join(root, ".leases"), { recursive: true });
  await writeFile(lockPath(root, id), body, "utf8");
};

/** A genuinely dead pid: spawn a real short-lived process and keep its id —
 *  hand-picking a "probably free" number is flaky by construction. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000 });
  expect(r.status).toBe(0);
  return r.pid as number;
}

const lockPath = (root: string, id: string): string => join(root, ".leases", `${id}.json`);

describe("acquireSessionLease — #48 cross-process run lease", () => {
  it("acquires a fresh session: lock file carries pid/at/gen; release unlinks it", async () => {
    const root = await newRoot();
    try {
      const r = await acquireSessionLease(root, "sess-a");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const raw = JSON.parse(await readFile(lockPath(root, "sess-a"), "utf8")) as { pid: number; at: string; gen: string };
      expect(raw.pid).toBe(process.pid);
      expect(typeof raw.at).toBe("string");
      expect(typeof raw.gen).toBe("string");
      await r.lease.release();
      await expect(readFile(lockPath(root, "sess-a"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when a LIVE foreign process holds the lease (holder pid reported)", async () => {
    const root = await newRoot();
    try {
      // Our own pid in a hand-written lock: alive, and NOT in this module's
      // in-process registry — indistinguishable from a foreign holder.
      await seedLock(root, "sess-b", JSON.stringify({ pid: process.pid, at: "soon", gen: "g1" }));
      const r = await acquireSessionLease(root, "sess-b");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.holder.pid).toBe(process.pid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("steals a STALE lease (dead holder): acquire succeeds and the lock's generation changes", async () => {
    const root = await newRoot();
    try {
      await seedLock(root, "sess-c", JSON.stringify({ pid: deadPid(), at: "soon", gen: "stale" }));
      const r = await acquireSessionLease(root, "sess-c");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const raw = JSON.parse(await readFile(lockPath(root, "sess-c"), "utf8")) as { gen: string };
      expect(raw.gen).not.toBe("stale");
      await r.lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("steals a CORRUPT lock file (unreadable holder = fail-safe as stale)", async () => {
    const root = await newRoot();
    try {
      await seedLock(root, "sess-d", "{not json");
      const r = await acquireSessionLease(root, "sess-d");
      expect(r.ok).toBe(true);
      if (r.ok) await r.lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("release is generation-scoped: a superseded lease cannot unlink the successor's lock", async () => {
    const root = await newRoot();
    try {
      const first = await acquireSessionLease(root, "sess-e");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // Simulate the steal: the successor's rename lands while `first`'s
      // process was presumed dead and revived. Its release must no-op.
      await writeFile(lockPath(root, "sess-e"), JSON.stringify({ pid: process.pid, at: "later", gen: "successor" }), "utf8");
      await first.lease.release();
      const raw = JSON.parse(await readFile(lockPath(root, "sess-e"), "utf8")) as { gen: string };
      expect(raw.gen).toBe("successor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("in-process re-acquire of the held id is idempotent (one lock, one release)", async () => {
    const root = await newRoot();
    const id = `idem-${randomUUID().slice(0, 8)}`;
    try {
      const a = await acquireSessionLease(root, id);
      const b = await acquireSessionLease(root, id);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      await b.lease.release();
      await expect(readFile(lockPath(root, id), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("two DIFFERENT sessions lease independently (the box swaps, not blocks)", async () => {
    const root = await newRoot();
    try {
      const a = await acquireSessionLease(root, "sess-f1");
      const b = await acquireSessionLease(root, "sess-f2");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      await a.lease.release();
      await b.lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("concurrent acquires of the same id coalesce — no self-refusal, one lock (M53 regression)", async () => {
    // rotate's fire-and-forget acquire and the run-gate's awaited acquire
    // race: without coalescing, the loser hit EEXIST, read back its OWN pid
    // before the winner registered, and the fail-safe refused against
    // itself — the driver's next run never reached the model.
    const root = await newRoot();
    const id = `conc-${randomUUID().slice(0, 8)}`;
    try {
      const [a, b] = await Promise.all([acquireSessionLease(root, id), acquireSessionLease(root, id)]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      // ONE lock, shared generation: releasing either end of the coalesced
      // pair unlinks it (they are the same lease).
      if (b.ok) await b.lease.release();
      await expect(readFile(lockPath(root, id), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("box-level concurrent acquires never self-release: both ok, one held lease, heldNow clears", async () => {
    const root = await newRoot();
    const id = `boxc-${randomUUID().slice(0, 8)}`;
    try {
      const box = sessionLeaseBoxFor(join(root, "sessions"));
      const [a, b] = await Promise.all([box.acquire(id), box.acquire(id)]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(box.heldNow(id)).toBeUndefined();
      expect(existsSync(join(root, "sessions", ".leases", `${id}.json`))).toBe(true);
      await box.release();
      expect(existsSync(join(root, "sessions", ".leases", `${id}.json`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid ids (spaces, traversal, the reserved side- prefix)", async () => {
    const root = await newRoot();
    try {
      await expect(acquireSessionLease(root, "has space")).rejects.toThrow();
      await expect(acquireSessionLease(root, "../escape")).rejects.toThrow();
      await expect(acquireSessionLease(root, "side-x")).rejects.toThrow(/side-/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// 多 driver 并发弧 A（2026-09-16）— the multi-slot box. The single-slot box
// models ONE rotating driver (acquire(new) releases prev); the lane manager
// holds N drivers at once, so the box must KEEP every slot and release them
// explicitly per id. The single-slot face above stays byte-identical — its
// regression pin is the very first describe below this block.
describe("createMultiSlotLeaseBox — 多 driver 并发弧 A", () => {
  it("holds MULTIPLE ids concurrently: no ping-pong, one lock file per id", async () => {
    const root = await newRoot();
    try {
      const box = createMultiSlotLeaseBox(join(root, "sessions"));
      const a = await box.acquire("lane-a");
      const b = await box.acquire("lane-b");
      const c = await box.acquire("lane-c");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;
      // The single-slot box would have UNLINKED lane-a/lane-b's locks by now
      // (rotation semantics). The multi-slot box keeps all three on disk.
      expect(existsSync(join(root, "sessions", ".leases", "lane-a.json"))).toBe(true);
      expect(existsSync(join(root, "sessions", ".leases", "lane-b.json"))).toBe(true);
      expect(existsSync(join(root, "sessions", ".leases", "lane-c.json"))).toBe(true);
      expect(box.heldIds()).toEqual(["lane-a", "lane-b", "lane-c"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releaseId(id) frees ONLY that slot — siblings' locks stand untouched", async () => {
    const root = await newRoot();
    try {
      const box = createMultiSlotLeaseBox(join(root, "sessions"));
      await box.acquire("lane-a");
      await box.acquire("lane-b");
      await box.releaseId("lane-a");
      expect(existsSync(join(root, "sessions", ".leases", "lane-a.json"))).toBe(false);
      expect(existsSync(join(root, "sessions", ".leases", "lane-b.json"))).toBe(true);
      expect(box.heldIds()).toEqual(["lane-b"]);
      // Idempotent: an already-released (never-held) id is a no-op.
      await box.releaseId("lane-a");
      await box.releaseId("never-held");
      expect(box.heldIds()).toEqual(["lane-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rotate keeps the previous slot held (no rotation release — the multi-slot contract)", async () => {
    const root = await newRoot();
    try {
      const box = createMultiSlotLeaseBox(join(root, "sessions"));
      await box.acquire("lane-x");
      box.rotate("lane-y");
      // rotate is fire-and-forget; wait for its slot to land.
      await until(() => box.heldIds().includes("lane-y"), "rotate's acquire lands");
      expect(box.heldIds().sort()).toEqual(["lane-x", "lane-y"]);
      expect(existsSync(join(root, "sessions", ".leases", "lane-x.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("laneView: the engine's no-arg release() frees ONLY that lane's id — siblings survive session close", async () => {
    const root = await newRoot();
    try {
      const box = createMultiSlotLeaseBox(join(root, "sessions"));
      const laneA = box.laneView();
      const laneB = box.laneView();
      await laneA.acquire("lane-a");
      await laneB.acquire("lane-b");
      // A lane's session close (session-engine's `sessionLeases.release()`).
      await laneA.release();
      expect(existsSync(join(root, "sessions", ".leases", "lane-a.json"))).toBe(false);
      expect(existsSync(join(root, "sessions", ".leases", "lane-b.json"))).toBe(true);
      // The box's own heldIds reflects the survivor only.
      expect(box.heldIds()).toEqual(["lane-b"]);
      // heldNow refusal memory is shared through the view (the sync fast path).
      const dir = join(root, "sessions", ".leases");
      await writeFile(join(dir, "occupied-x.json"), JSON.stringify({ pid: process.pid, at: "now", gen: "g9" }), "utf8");
      const refused = await laneB.acquire("occupied-x");
      expect(refused.ok).toBe(false);
      expect(laneB.heldNow("occupied-x")?.pid).toBe(process.pid);
      expect(box.heldNow("occupied-x")?.pid).toBe(process.pid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("box.release() frees every held slot (graceful shutdown)", async () => {
    const root = await newRoot();
    try {
      const box = createMultiSlotLeaseBox(join(root, "sessions"));
      await box.acquire("lane-a");
      await box.acquire("lane-b");
      await box.release();
      expect(existsSync(join(root, "sessions", ".leases", "lane-a.json"))).toBe(false);
      expect(existsSync(join(root, "sessions", ".leases", "lane-b.json"))).toBe(false);
      expect(box.heldIds()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("memoized per root: the same box instance serves every lane (one coalescing/refusal surface)", async () => {
    const root = await newRoot();
    try {
      const a = createMultiSlotLeaseBox(join(root, "sessions"));
      const b = createMultiSlotLeaseBox(join(root, "sessions"));
      expect(b).toBe(a);
      // A different root gets a different box.
      const c = createMultiSlotLeaseBox(join(root, "other"));
      expect(c).not.toBe(a);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SINGLE-SLOT regression pin: sessionLeaseBoxFor still releases the previous lease on acquire (byte-unchanged face)", async () => {
    const root = await newRoot();
    try {
      const box = sessionLeaseBoxFor(join(root, "sessions"));
      await box.acquire("first-id");
      expect(existsSync(join(root, "sessions", ".leases", "first-id.json"))).toBe(true);
      await box.acquire("second-id");
      // The rotation semantics the whole single-driver world rides on: the
      // previous id's lock is GONE the moment a new one lands.
      expect(existsSync(join(root, "sessions", ".leases", "first-id.json"))).toBe(false);
      expect(existsSync(join(root, "sessions", ".leases", "second-id.json"))).toBe(true);
      // And the multi-slot box did NOT leak into this root's single-slot box.
      expect((box as unknown as { heldIds?: unknown }).heldIds).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
