// M58 §C#5 — --fork-session: the session JSONL is byte-copied to a fresh id
// and the run resumes the FORK; the original file is never opened for write,
// so its bytes cannot change (det-44: fork 后新旧 id 并存且原文件字节不变).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import { forkSessionFile, newForkSessionId } from "../src/fork-session.js";
import { parseForkSessionFlag } from "../src/args.js";
import { stripLogFlags } from "../src/log.js";

function tmpSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wudao-fork-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return join(dir, "sessions");
}

/** A small hand-built session file with the entry mix a real one carries. */
function writeSampleSession(dir: string, id: string): void {
  const lines = [
    JSON.stringify({ type: "model_change", model: "deepseek-chat", provider: "deepseek", at: "2026-08-18T00:00:00.000Z" }),
    JSON.stringify({ role: "user", content: "fix the bug", uuid: "u1" }),
    JSON.stringify({ role: "assistant", content: "fixed", parentUuid: "u1" }),
    JSON.stringify({ type: "session_name", name: "fix-the-bug" }),
  ];
  // Deliberately NOT re-serialized: the bytes below are what the file keeps.
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

describe("parseForkSessionFlag", () => {
  it("accepts both dash forms", () => {
    expect(parseForkSessionFlag(["--resume", "abc", "--fork-session"])).toBe(true);
    expect(parseForkSessionFlag(["-fork-session"])).toBe(true);
    expect(parseForkSessionFlag(["--resume", "abc"])).toBe(false);
    expect(parseForkSessionFlag(["fix --fork-session the bug"])).toBe(false);
  });
  it("stripLogFlags drops it from the one-shot prompt", () => {
    expect(stripLogFlags(["--resume", "abc", "--fork-session", "do", "it"])).toEqual(["do", "it"]);
  });
});

describe("forkSessionFile (M58 §C#5)", () => {
  it("copies the JSONL byte-for-byte to a fresh id; both ids coexist; the original is byte-identical before/after", async () => {
    const dir = tmpSessionsDir();
    try {
      writeSampleSession(dir, "source01");
      const before = readFileSync(join(dir, "source01.jsonl"), "utf8");
      const result = await forkSessionFile(dir, "source01");
      expect(result.sourceId).toBe("source01");
      expect(result.newId).not.toBe("source01");
      expect(result.newId).toMatch(/^[A-Za-z0-9_-]+$/); // store-legal id
      expect(result.bytes).toBe(Buffer.byteLength(before, "utf8"));
      // 新旧并存
      expect(existsSync(join(dir, "source01.jsonl"))).toBe(true);
      expect(existsSync(join(dir, `${result.newId}.jsonl`))).toBe(true);
      // The fork is a byte-identical twin…
      expect(readFileSync(join(dir, `${result.newId}.jsonl`), "utf8")).toBe(before);
      // …and the original did not move a byte.
      expect(readFileSync(join(dir, "source01.jsonl"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a store-created session forks too (uuid/parentUuid links survive verbatim)", async () => {
    const dir = tmpSessionsDir();
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("orig02", { role: "user", content: "hi", uuid: "aaa", parentUuid: undefined });
      await store.append("orig02", { role: "assistant", content: "hello", uuid: "bbb", parentUuid: "aaa" });
      const before = readFileSync(join(dir, "orig02.jsonl"), "utf8");
      const { newId } = await forkSessionFile(dir, "orig02");
      expect(readFileSync(join(dir, `${newId}.jsonl`), "utf8")).toBe(before);
      // The fork loads through the same store the CLI resumes with.
      const entries = await store.loadSessionEntries(newId);
      expect(entries.filter((e) => "role" in e)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("an explicit new id is honored; a missing source throws a clean error", async () => {
    const dir = tmpSessionsDir();
    try {
      writeSampleSession(dir, "src03");
      const r = await forkSessionFile(dir, "src03", "fork03");
      expect(r.newId).toBe("fork03");
      expect(existsSync(join(dir, "fork03.jsonl"))).toBe(true);
      await expect(forkSessionFile(dir, "no-such-id")).rejects.toThrow(/cannot fork/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("review MINOR 2: an explicit target id that already exists throws (no silent clobber)", async () => {
    const dir = tmpSessionsDir();
    try {
      writeSampleSession(dir, "srcA");
      writeSampleSession(dir, "srcB");
      const before = readFileSync(join(dir, "srcB.jsonl"), "utf8");
      await expect(forkSessionFile(dir, "srcA", "srcB")).rejects.toThrow(/"srcB" already exists/);
      // And forking onto the source's own id is equally refused.
      await expect(forkSessionFile(dir, "srcA", "srcA")).rejects.toThrow(/"srcA" already exists/);
      // srcB was untouched by the refused attempts.
      expect(readFileSync(join(dir, "srcB.jsonl"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("review MINOR 2: an AUTO id colliding with an existing file regenerates to a free one", async () => {
    const dir = tmpSessionsDir();
    try {
      writeSampleSession(dir, "srcC");
      // "taken" already exists as a session; the generator offers it first.
      writeFileSync(join(dir, "taken.jsonl"), "PREVIOUS TAKEN CONTENT\n", "utf8");
      const takenBefore = readFileSync(join(dir, "taken.jsonl"), "utf8");
      const ids = ["taken", "taken", "fresh01"];
      let i = 0;
      const r = await forkSessionFile(dir, "srcC", undefined, () => ids[i++] ?? "unused");
      expect(r.newId).toBe("fresh01");
      expect(existsSync(join(dir, "fresh01.jsonl"))).toBe(true);
      expect(readFileSync(join(dir, "taken.jsonl"), "utf8")).toBe(takenBefore); // never clobbered
      expect(readFileSync(join(dir, "fresh01.jsonl"), "utf8")).toBe(readFileSync(join(dir, "srcC.jsonl"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("review MINOR 2: an exhausted id space throws instead of looping forever", async () => {
    const dir = tmpSessionsDir();
    try {
      writeSampleSession(dir, "srcD");
      writeFileSync(join(dir, "stuck.jsonl"), "x\n", "utf8");
      await expect(forkSessionFile(dir, "srcD", undefined, () => "stuck")).rejects.toThrow(/no free session id/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("newForkSessionId is url-safe and unique across calls", () => {
    const a = newForkSessionId();
    const b = newForkSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});
