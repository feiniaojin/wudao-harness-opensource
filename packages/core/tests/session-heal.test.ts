// 夜移 031 — torn-tail JSONL self-heal + serialized session writes (pi
// session/jsonl/storage.ts port). A crash mid-append leaves a junk tail line
// that today is silently skipped on EVERY load forever — and a file whose
// last line lost its trailing newline gets its next append WELDED onto that
// line, an unhealable mid-file corruption. The port: (a) every append goes
// through a per-store promise tail (strictly ordered even with concurrent
// writers — CLI + WS server + cron/monitor tools); (b) on load, a syntax
// error on the LAST non-empty line only is diagnosed as a torn write and
// healed by atomically re-publishing the valid prefix (temp + rename,
// re-verified inside the write queue so a concurrent append can't be lost
// to a stale verdict); a missing trailing newline alone is repaired the same
// way; (c) mid-file corruption does NOT heal — wudao keeps its deliberate
// fail-open skip (pi throws), so resume resilience is unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../src/session/store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "heal-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const raw = async (name: string): Promise<string> => readFile(join(root, name), "utf8");
const line = (role: string, content: string): string => JSON.stringify({ role, content });

describe("夜移 031 torn-tail heal", () => {
  it("heals a torn final fragment: load returns the valid prefix and the file loses the fragment", async () => {
    await writeFile(join(root, "s1.jsonl"), `${line("user", "one")}\n${line("assistant", "two")}\n{"role":"user","content":"tor`, "utf8");
    const s = createJsonlSessionStore(root);
    const loaded = await s.load("s1");
    expect(loaded.map((m) => m.content)).toEqual(["one", "two"]);
    // the heal is durable: the fragment is gone from the file
    expect(await raw("s1.jsonl")).toBe(`${line("user", "one")}\n${line("assistant", "two")}\n`);
    // and a re-load + append work on the healed file
    await s.append("s1", { role: "user", content: "three" });
    expect((await s.load("s1")).map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("repairs a missing trailing newline before it can weld the next append", async () => {
    await writeFile(join(root, "s2.jsonl"), line("user", "solo"), "utf8"); // no trailing \n
    const s = createJsonlSessionStore(root);
    expect((await s.load("s2")).map((m) => m.content)).toEqual(["solo"]);
    expect(await raw("s2.jsonl")).toBe(`${line("user", "solo")}\n`);
    await s.append("s2", { role: "user", content: "next" });
    const after = await raw("s2.jsonl");
    expect(after.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
    expect((await s.load("s2")).map((m) => m.content)).toEqual(["solo", "next"]);
  });

  it("a single torn line as the whole file heals to an empty session", async () => {
    await writeFile(join(root, "s3.jsonl"), `{"role":"user","cont`, "utf8");
    const s = createJsonlSessionStore(root);
    expect(await s.load("s3")).toEqual([]);
    expect(await raw("s3.jsonl")).toBe("");
  });

  it("mid-file corruption does NOT heal — skip semantics and file bytes unchanged", async () => {
    const tornMid = `${line("user", "one")}\n{"role":"user\n${line("assistant", "three")}\n`;
    await writeFile(join(root, "s4.jsonl"), tornMid, "utf8");
    const s = createJsonlSessionStore(root);
    const loaded = await s.load("s4");
    expect(loaded.map((m) => m.content)).toEqual(["one", "three"]); // fail-open skip, as today
    expect(await raw("s4.jsonl")).toBe(tornMid); // untouched — healing a mid-file break would lie about history
  });

  it("heals the sidechain path too", async () => {
    await writeFile(join(root, "side-sc1.jsonl"), `${line("assistant", "sub")}\n{"role":"to`, "utf8");
    const s = createJsonlSessionStore(root);
    const loaded = await s.loadSidechain("sc1");
    expect(loaded.map((m) => m.content)).toEqual(["sub"]);
    expect(await raw("side-sc1.jsonl")).toBe(`${line("assistant", "sub")}\n`);
  });

  it("loadSessionEntries heals and returns the entry prefix", async () => {
    await writeFile(
      join(root, "s5.jsonl"),
      `${line("user", "one")}\n${JSON.stringify({ type: "model_change", model: "m", at: "t" })}\n{"type":"session_n`,
      "utf8",
    );
    const s = createJsonlSessionStore(root);
    const entries = await s.loadSessionEntries("s5");
    expect(entries).toHaveLength(2);
    expect(await raw("s5.jsonl")).toBe(`${line("user", "one")}\n${JSON.stringify({ type: "model_change", model: "m", at: "t" })}\n`);
  });
});

describe("夜移 031 serialized writes", () => {
  it("concurrent appends land strictly in call order (one line each)", async () => {
    const s = createJsonlSessionStore(root);
    const writes = Array.from({ length: 25 }, (_, i) =>
      s.append("s6", { role: "user", content: `m${String(i).padStart(2, "0")}` }));
    await Promise.all(writes);
    const text = await raw("s6.jsonl");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    // ω99-47: the file's first write stamps the format marker as line 1;
    // the 25 appends then land one line each, strictly in issue order.
    expect(lines[0]).toBe('{"type":"wudao_meta","data":{"formatVersion":1}}');
    expect(lines).toHaveLength(26);
    // every line parses and the file order matches the issue order
    const contents = lines.slice(1).map((l) => (JSON.parse(l) as { content: string }).content);
    expect(contents).toEqual(Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, "0")}`));
  });

  it("an append issued after a load that detected a torn tail lands on the healed file", async () => {
    await writeFile(join(root, "s7.jsonl"), `${line("user", "one")}\n{"role":"user","cont`, "utf8");
    const s = createJsonlSessionStore(root);
    await s.load("s7"); // heals
    await s.append("s7", { role: "user", content: "two" });
    expect((await s.load("s7")).map((m) => m.content)).toEqual(["one", "two"]);
    const lines = (await raw("s7.jsonl")).split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
  });
});
