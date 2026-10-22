// M60 — the thread↔session map: key format, persistence, reuse across
// manager instances (a restart rebinds threads to their sessions), corrupt
// file recovery.
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadThreadMap, parseThreadMapBody, threadKey, threadMapPath } from "../src/threads.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wudao-slack-threads-"));
}

describe("threadKey", () => {
  it("is {channel}:{thread_ts} with fallback to the message ts", () => {
    expect(threadKey("C1", "123.456")).toBe("C1:123.456");
    expect(threadKey("C1", undefined, "999.000")).toBe("C1:999.000");
  });
});

describe("parseThreadMapBody", () => {
  it("parses, tolerates junk entries, rejects non-objects", () => {
    expect(parseThreadMapBody("")).toEqual({});
    expect(parseThreadMapBody('{"C1:1":"s1","bad":"s2"}')).toEqual({ "C1:1": "s1" }); // key without : drops
    expect(parseThreadMapBody('{"C1:1":42}')).toEqual({}); // non-string value drops
    expect(parseThreadMapBody("not json")).toBeUndefined();
    expect(parseThreadMapBody("[]")).toBeUndefined();
  });
});

describe("loadThreadMap", () => {
  it("persists and reloads bindings (restart reuse)", async () => {
    const root = tmpRoot();
    const m1 = await loadThreadMap(root);
    await m1.set("C1:111", "wudao-slack-aaa");
    await m1.set("C1:222", "wudao-slack-bbb");
    expect(m1.get("C1:111")).toBe("wudao-slack-aaa");
    expect(m1.size()).toBe(2);
    // A fresh instance (a daemon restart) sees the persisted file.
    const m2 = await loadThreadMap(root);
    expect(m2.get("C1:222")).toBe("wudao-slack-bbb");
    await m2.delete("C1:111");
    expect((await loadThreadMap(root)).get("C1:111")).toBeUndefined();
  });

  it("writes a readable JSON object at .wudao/slack-threads.json", async () => {
    const root = tmpRoot();
    const m = await loadThreadMap(root);
    await m.set("C1:333", "sess-1");
    const text = await readFile(threadMapPath(root), "utf8");
    expect(JSON.parse(text)).toEqual({ "C1:333": "sess-1" });
  });

  it("a corrupt file warns once and starts fresh", async () => {
    const root = tmpRoot();
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(join(root, ".wudao", "slack-threads.json"), "{corrupt", "utf8");
    const warnings: string[] = [];
    const m = await loadThreadMap(root, (w) => warnings.push(w));
    expect(m.size()).toBe(0);
    expect(warnings.length).toBe(1);
    await m.set("C1:1", "s");
    expect(existsSync(threadMapPath(root))).toBe(true);
  });

  it("concurrent sets serialize (no interleaved writes)", async () => {
    const root = tmpRoot();
    const m = await loadThreadMap(root);
    await Promise.all(Array.from({ length: 25 }, (_, i) => m.set(`C:${i}`, `s${i}`)));
    const text = await readFile(threadMapPath(root), "utf8");
    expect(Object.keys(JSON.parse(text) as Record<string, string>).length).toBe(25);
    expect(m.size()).toBe(25);
  });
});
