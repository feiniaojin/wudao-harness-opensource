// M35 §2 — the CLI appendEntry wrapper: generic non-message entries ride the
// session JSONL through one typed front door (build / append / count).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao/core";
import {
  appendSessionEntry,
  buildDeferredLoadedEntry,
  countEntriesOfType,
  DEFERRED_LOADED_TYPE,
} from "../src/session-entry.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "entry-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe("session-entry wrapper (M35 §2)", () => {
  it("buildDeferredLoadedEntry produces the generic {type, data} shape with copied names", () => {
    const names = ["task", "agent_await"];
    const entry = buildDeferredLoadedEntry(names);
    expect(entry).toEqual({ type: "deferred_loaded", data: { names: ["task", "agent_await"] } });
    // Copied, not aliased — later mutation of the source cannot rewrite history.
    names.push("agent_cancel");
    expect((entry.data as { names: string[] }).names).toEqual(["task", "agent_await"]);
  });

  it("appendSessionEntry persists through the real store; load() filters it, loadSessionEntries returns it", async () => {
    const store = createJsonlSessionStore(root);
    await appendSessionEntry(store, "s1", buildDeferredLoadedEntry(["task"]));
    await store.append("s1", { role: "user", content: "hi" });
    expect(await store.load("s1")).toEqual([{ role: "user", content: "hi" }]);
    expect(await store.loadSessionEntries("s1")).toEqual([
      { type: "deferred_loaded", data: { names: ["task"] } },
      { role: "user", content: "hi" },
    ]);
  });

  it("countEntriesOfType counts matching entries only (messages never match)", async () => {
    const store = createJsonlSessionStore(root);
    await appendSessionEntry(store, "s2", buildDeferredLoadedEntry(["task"]));
    await appendSessionEntry(store, "s2", buildDeferredLoadedEntry(["agent_await"]));
    await appendSessionEntry(store, "s2", { type: "other_kind", data: 1 });
    await store.append("s2", { role: "assistant", content: "done" });
    const entries = await store.loadSessionEntries("s2");
    expect(countEntriesOfType(entries, DEFERRED_LOADED_TYPE)).toBe(2);
    expect(countEntriesOfType(entries, "other_kind")).toBe(1);
    expect(countEntriesOfType(entries, "never_seen")).toBe(0);
  });

  it("countEntriesOfType on a hand-written file (resume path) counts entries with interleaved messages", async () => {
    const jsonl = [
      JSON.stringify({ type: "deferred_loaded", data: { names: ["task"] } }),
      JSON.stringify({ role: "user", content: "spawn an agent" }),
      JSON.stringify({ type: "deferred_loaded", data: { names: ["agent_await"] } }),
      JSON.stringify({ role: "assistant", content: "done" }),
    ].join("\n") + "\n";
    await writeFile(join(root, "resumed.jsonl"), jsonl, "utf8");
    const entries = await createJsonlSessionStore(root).loadSessionEntries("resumed");
    expect(countEntriesOfType(entries, DEFERRED_LOADED_TYPE)).toBe(2);
  });
});
