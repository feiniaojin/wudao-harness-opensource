import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../src/session/store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ses-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("JsonlSessionStore", () => {
  it("append then load round-trips messages", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("s1", { role: "user", content: "hi" });
    await s.append("s1", { role: "assistant", content: "hello" });
    const loaded = await s.load("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.role).toBe("user");
    expect(loaded[1]?.content).toBe("hello");
  });
  it("load nonexistent session → []", async () => {
    expect(await createJsonlSessionStore(root).load("nope")).toEqual([]);
  });
  it("rejects an unsafe session id (path traversal)", async () => {
    const s = createJsonlSessionStore(root);
    await expect(s.append("../evil", { role: "user", content: "x" })).rejects.toThrow(/invalid session id/);
    await expect(s.load("../evil")).rejects.toThrow(/invalid session id/);
  });
  it("lists session ids", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("b", { role: "user", content: "x" });
    await new Promise((r) => setTimeout(r, 15));
    await s.append("a", { role: "user", content: "y" });
    expect(await s.list()).toEqual(["b", "a"]); // by mtime, not name
  });
  it("most recent session is last regardless of id ordering (mtime sort)", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("aaa_older", { role: "user", content: "y" });
    await new Promise((r) => setTimeout(r, 15));
    await s.append("zzz_newest", { role: "user", content: "x" });
    const ids = await s.list();
    expect(ids.at(-1)).toBe("zzz_newest"); // written LAST, id sorts first — mtime must win
  });
  it("skips structurally invalid lines on load", async () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "keep" }),
      JSON.stringify({ role: "bogus" }),
      JSON.stringify({ role: "assistant", content: "keep too" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "s2.jsonl"), jsonl, "utf8");
    const loaded = await createJsonlSessionStore(root).load("s2");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.role).toBe("user");
    expect(loaded[1]?.role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// M28: model-state session entries — model_change / thinking_level_change
// ride the same JSONL as non-message entries; load() keeps returning messages
// only (message path zero change), loadSessionEntries returns everything.
// ---------------------------------------------------------------------------

describe("JsonlSessionStore — model-state entries", () => {
  it("appendEntry round-trips model_change / thinking_level_change via loadSessionEntries", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("m1", { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-08-16T00:00:00.000Z" });
    await s.appendEntry("m1", { type: "thinking_level_change", level: "high" });
    const entries = await s.loadSessionEntries("m1");
    expect(entries).toEqual([
      { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-08-16T00:00:00.000Z" },
      { type: "thinking_level_change", level: "high" },
    ]);
  });

  it("appendEntry round-trips a session_name entry; load() filters it (M33 §3)", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("named", { type: "session_name", name: "fix-the-login-bug" });
    await s.append("named", { role: "user", content: "Fix the login bug" });
    const entries = await s.loadSessionEntries("named");
    expect(entries).toEqual([
      { type: "session_name", name: "fix-the-login-bug" },
      { role: "user", content: "Fix the login bug" },
    ]);
    expect(await s.load("named")).toEqual([{ role: "user", content: "Fix the login bug" }]);
  });

  it("load() filters out entries — the message path is unchanged by interleaved entries", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("m2", { type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-08-16T00:00:00.000Z" });
    await s.append("m2", { role: "user", content: "hi" });
    await s.appendEntry("m2", { type: "thinking_level_change", level: "low" });
    await s.append("m2", { role: "assistant", content: "hello" });
    // Message path: exactly the two messages, in order — no entries leak in.
    expect(await s.load("m2")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // Entries path: entry-message interleaving order is preserved.
    const entries = await s.loadSessionEntries("m2");
    expect(entries.map((e) => e.type ?? e.role)).toEqual(["model_change", "user", "thinking_level_change", "assistant"]);
  });

  it("a pre-M28 messages-only file loads identically through loadSessionEntries", async () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "old world" }),
      JSON.stringify({ role: "assistant", content: "old answer" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "legacy.jsonl"), jsonl, "utf8");
    const s = createJsonlSessionStore(root);
    const entries = await s.loadSessionEntries("legacy");
    expect(entries).toEqual([
      { role: "user", content: "old world" },
      { role: "assistant", content: "old answer" },
    ]);
    // Every entry is a message; load() and loadSessionEntries() agree.
    expect(await s.load("legacy")).toEqual(entries);
  });

  it("junk entry lines are skipped without aborting the session (corrupt JSON, unknown type, bad shapes)", async () => {
    const jsonl = [
      "{not json",
      JSON.stringify({ type: "model_change", model: "deepseek-v4-flash", at: "2026-08-16T00:00:00.000Z" }),
      JSON.stringify({ type: "model_change", at: "2026-08-16T00:00:00.000Z" }), // no model
      JSON.stringify({ type: "thinking_level_change", level: "high" }),
      JSON.stringify({ type: "surprise_entry", x: 1 }), // unknown entry type
      JSON.stringify({ role: "user", content: "keep" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "m3.jsonl"), jsonl, "utf8");
    const entries = await createJsonlSessionStore(root).loadSessionEntries("m3");
    expect(entries).toEqual([
      { type: "model_change", model: "deepseek-v4-flash", at: "2026-08-16T00:00:00.000Z" },
      { type: "thinking_level_change", level: "high" },
      { role: "user", content: "keep" },
    ]);
  });

  it("a fork (session file copy) inherits entries with the history — copy is inheritance", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("orig", { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-08-16T00:00:00.000Z" });
    await s.appendEntry("orig", { type: "thinking_level_change", level: "max" });
    await s.append("orig", { role: "user", content: "shared turn" });
    // A fork copies the history — entries ride along because they ARE the history.
    await copyFile(join(root, "orig.jsonl"), join(root, "fork1.jsonl"));
    const forkEntries = await createJsonlSessionStore(root).loadSessionEntries("fork1");
    expect(forkEntries).toEqual(await s.loadSessionEntries("orig"));
    const modelChanges = forkEntries.filter((e) => e.type === "model_change");
    expect(modelChanges).toHaveLength(1);
    if (modelChanges[0]?.type === "model_change") {
      expect(modelChanges[0].model).toBe("glm-4.6");
      expect(modelChanges[0].provider).toBe("glm");
    }
    // Message view identical too.
    expect(await createJsonlSessionStore(root).load("fork1")).toEqual(await s.load("orig"));
  });

  it("appendEntry rejects an unsafe session id (same guard as append)", async () => {
    const s = createJsonlSessionStore(root);
    await expect(s.appendEntry("../evil", { type: "thinking_level_change", level: "high" })).rejects.toThrow(/invalid session id/);
    await expect(s.loadSessionEntries("../evil")).rejects.toThrow(/invalid session id/);
  });

  // -------------------------------------------------------------------------
  // M35 §2 — generic non-message entries: any {type, data} rides the JSONL.
  // -------------------------------------------------------------------------

  it("appendEntry round-trips a GENERIC {type, data} entry; load() filters it", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("g1", { type: "deferred_loaded", data: { names: ["task", "agent_await"] } });
    await s.append("g1", { role: "user", content: "hi" });
    const entries = await s.loadSessionEntries("g1");
    expect(entries).toEqual([
      { type: "deferred_loaded", data: { names: ["task", "agent_await"] } },
      { role: "user", content: "hi" },
    ]);
    expect(await s.load("g1")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("a generic entry with a non-object data payload persists verbatim", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("g2", { type: "counter", data: 3 });
    expect(await s.loadSessionEntries("g2")).toEqual([{ type: "counter", data: 3 }]);
  });

  it("a {type, x} line WITHOUT data stays junk on load (the data key marks the generic shape)", async () => {
    const jsonl = [
      JSON.stringify({ type: "surprise_entry", x: 1 }), // no data — junk, as before
      JSON.stringify({ type: "no_data_entry", data: undefined }), // data: undefined serializes away → key missing
      JSON.stringify({ role: "user", content: "keep" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "g3.jsonl"), jsonl, "utf8");
    const entries = await createJsonlSessionStore(root).loadSessionEntries("g3");
    expect(entries).toEqual([{ role: "user", content: "keep" }]);
  });

  it("a generic entry with the data key but a non-string type stays junk", async () => {
    const jsonl = [
      JSON.stringify({ type: 42, data: { a: 1 } }),
      JSON.stringify({ data: { a: 1 } }), // no type at all
      JSON.stringify({ role: "user", content: "keep" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "g4.jsonl"), jsonl, "utf8");
    expect(await createJsonlSessionStore(root).loadSessionEntries("g4")).toEqual([{ role: "user", content: "keep" }]);
  });

  it("entries are stored as plain JSONL lines (one JSON object per line, verbatim shapes)", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendEntry("m4", { type: "model_change", model: "wudao-preview", provider: "wudao", at: "2026-08-16T01:02:03.000Z" });
    await s.appendEntry("m4", { type: "thinking_level_change", level: "off" });
    const text = await readFile(join(root, "m4.jsonl"), "utf8");
    // ω99-47: a file's FIRST write also stamps the format marker as line 1
    // (transport framing; stripped on every read path). Entry shapes are
    // still one verbatim JSON object per line.
    expect(text).toBe(
      '{"type":"wudao_meta","data":{"formatVersion":1}}\n' +
      '{"type":"model_change","model":"wudao-preview","provider":"wudao","at":"2026-08-16T01:02:03.000Z"}\n' +
      '{"type":"thinking_level_change","level":"off"}\n',
    );
  });
});
