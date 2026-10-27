// ω99-43 — durable child approvals, core face: the sidechain ENTRY variants
// (brief §1.1/§3). Receipts ride a child's own `side-<id>.jsonl` as M35 §2
// generic entries — the store gains an entries view + an entry append for
// SIDechains (mirroring loadSessionEntries/appendEntry), while the two
// EXISTING sidechain methods keep their return shapes byte-for-byte (old
// readers filter receipts out of the message stream — zero pollution).
// Also pins the exported loop-safety canonicalJson (single canonical
// serializer; the receipt key reuses callFingerprint's shape verbatim).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../src/session/store.js";
import { canonicalJson, callFingerprint } from "../src/loop-safety.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "o99-43-sc-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MESSAGE = { role: "user" as const, content: "child brief" };
const RECEIPT = { type: "approval-receipt", data: { tool: "shell", inputKey: "shell#abc", decision: { behavior: "allow" }, ts: "2026-09-05T00:00:00.000Z" } };

describe("sidechain entry variants (ω99-43)", () => {
  it("appendSidechainEntry lands a generic entry; loadSidechainEntries returns messages AND entries in file order", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c1", MESSAGE);
    await s.appendSidechainEntry("c1", RECEIPT);
    await s.appendSidechain("c1", { role: "assistant", content: "answer" });
    const entries = await s.loadSidechainEntries("c1");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(MESSAGE);
    expect(entries[1]).toEqual(RECEIPT);
    expect(entries[2]).toEqual({ role: "assistant", content: "answer" });
  });

  it("OLD READER: loadSidechain filters the receipt out — message stream zero pollution, return shape unchanged", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c2", MESSAGE);
    await s.appendSidechainEntry("c2", RECEIPT);
    expect(await s.loadSidechain("c2")).toEqual([MESSAGE]);
  });

  it("APPEND-ONLY: appending an entry never rewrites the prior bytes (M24)", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c3", MESSAGE);
    const before = await readFile(join(root, "side-c3.jsonl"), "utf8");
    await s.appendSidechainEntry("c3", RECEIPT);
    const after = await readFile(join(root, "side-c3.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("a receipt line that fails JSON or the generic-entry shape is skipped, not fatal (same tolerant posture)", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c4", MESSAGE);
    await s.appendSidechainEntry("c4", RECEIPT);
    // A junk tail (torn write of a receipt) — both readers skip past it.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, "side-c4.jsonl"), '{"type":"approval-receipt","dat', "utf8");
    expect(await s.loadSidechain("c4")).toEqual([MESSAGE]);
    const entries = await s.loadSidechainEntries("c4");
    expect(entries).toEqual([MESSAGE, RECEIPT]);
  });

  it("missing sidechain file → empty entries (a fresh child starts with no receipts)", async () => {
    const s = createJsonlSessionStore(root);
    expect(await s.loadSidechainEntries("never-written")).toEqual([]);
  });

  it("invalid sidechain id rejected on the entry path too (same guard as the message path)", async () => {
    const s = createJsonlSessionStore(root);
    await expect(s.appendSidechainEntry("bad/id", RECEIPT)).rejects.toThrow(/sidechain id/);
    await expect(s.loadSidechainEntries("bad/id")).rejects.toThrow(/sidechain id/);
  });
});

describe("canonicalJson export (single canonical serializer, ω99-43)", () => {
  it("recursively sorts object keys, keeps array order, drops undefined — the loop-safety shape", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([{ z: 1, a: 2 }, 3])).toBe('[{"a":2,"z":1},3]');
    expect(canonicalJson({ x: undefined, y: null })).toBe('{"y":null}');
  });

  it("callFingerprint is the receipt's inputKey shape: <tool>#<hash(canonicalJson(input))> — argument order never changes the key", () => {
    const fp = callFingerprint({ name: "shell", args: { command: "pnpm test", cwd: "/tmp" } });
    expect(fp.startsWith("shell#")).toBe(true);
    expect(fp).toBe(callFingerprint({ name: "shell", args: { cwd: "/tmp", command: "pnpm test" } }));
    expect(fp).not.toBe(callFingerprint({ name: "shell", args: { command: "pnpm test" } }));
    expect(fp).not.toBe(callFingerprint({ name: "write_file", args: { command: "pnpm test", cwd: "/tmp" } }));
  });
});
