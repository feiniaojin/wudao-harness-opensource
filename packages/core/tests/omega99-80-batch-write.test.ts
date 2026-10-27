// ω99-80 — the batch write seam's two PROPERTY tests (brief §2.2/§2.3):
//  (1) BYTE EQUIVALENCE (the arc's constitution): the same N entries written
//      through the batch seam (adoptSessionEntries / appendEntries) leave the
//      file BYTE-IDENTICAL to writing them one appendEntry at a time — the
//      batch is a performance shape, never a semantics change.
//  (2) WRITE COUNT: an N-entry adoption bounds whole-file reads (≤2; in fact
//      1) instead of N — O(N·filesize) → O(filesize+N) — counted by wrapping
//      readFile/appendFile for the watched session file only, while the
//      per-entry path keeps its one-read-per-write shape unchanged.
// JSONL byte face only (the memory backend has no bytes); the
// backend-agnostic batch law lives in the conformance suite's face 2.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, SessionStore } from "../src/session/store.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { adoptSessionEntries } from "../src/session/adopt.js";
import { formatMarkerLine, UnsupportedSessionFormatException } from "../src/session/format-version.js";

// The fs probe: count whole-file reads / appends on the WATCHED session file
// only. vi.hoisted keeps the holder alive across the hoisted vi.mock factory;
// the wrappers delegate to the real fs for everything else.
const fsProbe = vi.hoisted(() => ({ watched: [] as string[], reads: 0, appends: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      const p = args[0];
      if (typeof p === "string" && fsProbe.watched.includes(p)) fsProbe.reads += 1;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    appendFile: ((...args: Parameters<typeof actual.appendFile>) => {
      const p = args[0];
      if (typeof p === "string" && fsProbe.watched.includes(p)) fsProbe.appends += 1;
      return actual.appendFile(...args);
    }) as typeof actual.appendFile,
  };
});

const USER1 = { role: "user" as const, content: "turn 1", uuid: "u1" };
const ANSWER1 = { role: "assistant" as const, content: "answer 1", uuid: "u2", parentUuid: "u1" };
const MODEL_STATE: SessionEntry = { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" };
const RECEIPT: SessionEntry = { type: "deferred_loaded", data: { n: 3 } };
const ROWS: readonly SessionEntry[] = [USER1, MODEL_STATE, ANSWER1, RECEIPT];
const JUNK: readonly unknown[] = ["not json {{{", 42, null, { type: "future_thing", payload: 1 }, { role: "user" }];
const TAIL: readonly SessionEntry[] = [
  { role: "user" as const, content: "turn 2", uuid: "u3", parentUuid: "u2" },
  { type: "provider_change", provider: "deepseek", model: "deepseek-chat", at: "2026-09-05T00:01:00.000Z" },
];

interface Fixture {
  readonly root: string;
  readonly store: SessionStore;
  file(id: string): string;
}
async function makeStore(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "om80-batch-"));
  return { root, store: createJsonlSessionStore(root), file: (id: string) => join(root, `${id}.jsonl`) };
}

describe("ω99-80 byte equivalence — batch product === per-entry product (JSONL byte face)", () => {
  let f: Fixture;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    f = await makeStore();
    fsProbe.watched = [];
    cleanup = () => rm(f.root, { recursive: true, force: true });
  });
  afterEach(async () => {
    await cleanup();
  });

  it("fresh file: adopting N entries byte-equals N appendEntry calls (marker + body + trailing newline)", async () => {
    await adoptSessionEntries(f.store, "batched", ROWS);
    for (const r of ROWS) await f.store.appendEntry("one", r);
    const a = await readFile(f.file("batched"), "utf8");
    const b = await readFile(f.file("one"), "utf8");
    expect(a).toBe(b);
    expect(a.startsWith(formatMarkerLine())).toBe(true);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("junk-interleaved adoption byte-equals the filtered per-entry control (isolate-and-continue, receipt unchanged)", async () => {
    const mixed: readonly unknown[] = [ROWS[0], JUNK[0], ROWS[1], JUNK[1], ROWS[2], JUNK[2], ROWS[3], JUNK[3], JUNK[4]];
    const receipt = await adoptSessionEntries(f.store, "mx", mixed);
    expect(receipt).toEqual({ sessionId: "mx", adopted: 4, skipped: 5 });
    for (const r of ROWS) await f.store.appendEntry("ctl", r);
    expect(await readFile(f.file("mx"), "utf8")).toBe(await readFile(f.file("ctl"), "utf8"));
  });

  it("appendEntries onto a healthy existing file welds exactly like N appends (no marker re-stamp)", async () => {
    await f.store.appendEntry("ext", USER1);
    await f.store.appendEntry("ctl", USER1);
    await f.store.appendEntries("ext", TAIL);
    for (const t of TAIL) await f.store.appendEntry("ctl", t);
    expect(await readFile(f.file("ext"), "utf8")).toBe(await readFile(f.file("ctl"), "utf8"));
  });

  it("appendEntries onto a torn tail heals once and lands the whole batch (equivalent to per-entry heals, no welding)", async () => {
    await f.store.appendEntry("torn", USER1);
    await f.store.appendEntry("ctl", USER1);
    const fragment = '{"role":"user","content":"tor';
    await writeFile(f.file("torn"), (await readFile(f.file("torn"), "utf8")) + fragment, "utf8");
    await writeFile(f.file("ctl"), (await readFile(f.file("ctl"), "utf8")) + fragment, "utf8");
    await f.store.appendEntries("torn", TAIL);
    for (const t of TAIL) await f.store.appendEntry("ctl", t);
    const a = await readFile(f.file("torn"), "utf8");
    const b = await readFile(f.file("ctl"), "utf8");
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    for (const line of a.split("\n")) {
      if (line.trim() === "") continue;
      expect(() => JSON.parse(line), "no welded lines after the batch heal").not.toThrow();
    }
  });

  it("appendEntries composes with the write gate: a newer-format file refuses, bytes untouched", async () => {
    const v99 = `{"type":"wudao_meta","data":{"formatVersion":99}}\n${JSON.stringify(USER1)}\n`;
    await writeFile(f.file("v99"), v99, "utf8");
    await expect(f.store.appendEntries("v99", TAIL)).rejects.toBeInstanceOf(UnsupportedSessionFormatException);
    expect(await readFile(f.file("v99"), "utf8")).toBe(v99);
  });
});

describe("ω99-80 write count — the O(filesize+N) seam (counted on the watched session file)", () => {
  let f: Fixture;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    f = await makeStore();
    cleanup = () => rm(f.root, { recursive: true, force: true });
    fsProbe.watched = [f.file("big")];
    fsProbe.reads = 0;
    fsProbe.appends = 0;
  });
  afterEach(async () => {
    await cleanup();
  });

  it("adopting N=50 entries: whole-file reads ≤ 2 (one batch slot), never 50", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    await adoptSessionEntries(f.store, "big", rows);
    expect(rows).toHaveLength(50);
    expect(fsProbe.reads).toBeLessThanOrEqual(2);
    expect(fsProbe.appends).toBeLessThanOrEqual(2);
    expect(await f.store.loadSessionEntries("big")).toHaveLength(50);
  });

  it("the per-entry path keeps its one-read-per-write shape (single write path unchanged)", async () => {
    for (let i = 0; i < 10; i += 1) await f.store.appendEntry("big", { role: "user", content: `p${i}` });
    expect(fsProbe.reads).toBe(10);
    expect(fsProbe.appends).toBe(10);
  });

  it("the batched product byte-equals the per-entry product for the same 50 rows", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    await adoptSessionEntries(f.store, "big", rows);
    for (const r of rows) await f.store.appendEntry("ctl", r);
    expect(await readFile(f.file("big"), "utf8")).toBe(await readFile(f.file("ctl"), "utf8"));
  });
});
