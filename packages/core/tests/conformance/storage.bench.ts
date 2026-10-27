// ω99-52 — session lifecycle benchmarks (vitest bench mode: `npx vitest bench`
// from packages/core; NOT matched by `vitest run`, so benchmarks stay out of
// the CI gate by construction). The numbers are recorded in
// docs/research/107-storage-bench-2026-09.md and exist to inform a future
// SQLite decision — pi decided sharding on exactly this shape (94108a1ac);
// wudao will need the same data when that question arrives.
// Tiers: JSONL is the real backend; the memory tier is a reference point for
// what pure scheduling overhead looks like. Fork is a FILESYSTEM byte-copy
// (the CLI's fork mechanism, outside the SessionStore interface), so it has
// no memory-tier twin — an in-memory fork would be an entries replay, not a
// comparable operation.
import { bench, describe, afterAll } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../../src/session/store.js";
import { createMemorySessionStore } from "../../src/session/memory-store.js";
import { adoptSessionEntries } from "../../src/session/adopt.js";

const USER = { role: "user" as const, content: "benchmark message body" };

/** The list() fixture: seeded once, read-only afterwards — iterations must
 *  measure the enumeration, not the seeding. */
let listRoot: string | undefined;
async function ensureListRoot(): Promise<string> {
  if (listRoot === undefined) {
    listRoot = await mkdtemp(join(tmpdir(), "bench-j-list-"));
    const s = createJsonlSessionStore(listRoot);
    for (let i = 0; i < 100; i += 1) await s.append(`s${i}`, USER);
  }
  return listRoot;
}
afterAll(async () => {
  if (listRoot !== undefined) await rm(listRoot, { recursive: true, force: true });
});

describe("session lifecycle — JSONL backend (real tier)", () => {
  bench("open: fresh root + first append + load", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-j-open-"));
    const s = createJsonlSessionStore(root);
    await s.append("s1", USER);
    await s.load("s1");
    await rm(root, { recursive: true, force: true });
  });
  bench("append ×50 then load (serialized writes)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-j-app-"));
    const s = createJsonlSessionStore(root);
    for (let i = 0; i < 50; i += 1) await s.append("s1", { role: "user", content: `m${i}` });
    await s.load("s1");
    await rm(root, { recursive: true, force: true });
  });
  bench("fork ×20: byte-copy a 100-entry session (CLI /fork mechanism)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-j-fork-"));
    const s = createJsonlSessionStore(root);
    for (let i = 0; i < 100; i += 1) await s.append("src", { role: "user", content: `m${i}` });
    for (let i = 0; i < 20; i += 1) await copyFile(join(root, "src.jsonl"), join(root, `f${i}.jsonl`));
    await rm(root, { recursive: true, force: true });
  });
  bench("list: 100 sessions in the root", async () => {
    const s = createJsonlSessionStore(await ensureListRoot());
    await s.list();
  });
  // ω99-80: the batch write seam's headline case — adopting a 1000-entry
  // external transcript is O(filesize+N) (one whole-file read), where the
  // pre-seam per-entry loop was O(N·filesize). Records the number the arc
  // was cut for, in bench mode (never in the CI gate).
  bench("adopt 1000 entries (ω99-80 batch seam) then load", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-j-adopt-"));
    const s = createJsonlSessionStore(root);
    await adoptSessionEntries(s, "seeded", Array.from({ length: 1000 }, (_, i) => ({ role: "user" as const, content: `m${i}` })));
    await s.load("seeded");
    await rm(root, { recursive: true, force: true });
  });
});

describe("session lifecycle — memory backend (reference tier)", () => {
  bench("open: fresh store + first append + load", async () => {
    const s = createMemorySessionStore();
    await s.append("s1", USER);
    await s.load("s1");
  });
  bench("append ×50 then load", async () => {
    const s = createMemorySessionStore();
    for (let i = 0; i < 50; i += 1) await s.append("s1", { role: "user", content: `m${i}` });
    await s.load("s1");
  });
  bench("list: 100 sessions", async () => {
    const s = createMemorySessionStore();
    for (let i = 0; i < 100; i += 1) await s.append(`s${i}`, USER);
    await s.list();
  });
  bench("adopt 1000 entries then load (ω99-80 twin)", async () => {
    const s = createMemorySessionStore();
    await adoptSessionEntries(s, "seeded", Array.from({ length: 1000 }, (_, i) => ({ role: "user" as const, content: `m${i}` })));
    await s.load("seeded");
  });
});
