// ω99-47 — session file version gate (the upstream projectC4 soft marker + the upstream formatcandidate 3
// read/write gate). The store's first write stamps a `wudao_meta` generic
// entry as line 1 (append-only friendly: old binaries skip it as an unknown
// entry, forks byte-copy it); a file whose marker names a NEWER format
// version opens read-only (reads return everything, writes throw a typed
// error); and the "unknown entry = skip" posture is contracted observable
// via `store.lastLoadSkipped`. Six deterministic acceptances, tmpdir real
// files, zero network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "../src/session/store.js";
import { isValidAgentMessage } from "../src/session/validate.js";
import {
  SUPPORTED_FORMAT_VERSION,
  formatMarkerLine,
  UnsupportedSessionFormatException,
} from "../src/session/format-version.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "o99-47-vg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MARKER_V1 = '{"type":"wudao_meta","data":{"formatVersion":1}}';
const USER = { role: "user" as const, content: "hi" };
const ASSISTANT = { role: "assistant" as const, content: "hello" };

/** The pre-ω99-47 reader: parse each line, keep valid messages, silently
 *  skip everything else. This is the code path every OLD binary runs over
 *  a marked file — the compatibility contract it must uphold. */
function oldReader(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidAgentMessage(parsed)) out.push(parsed);
    } catch {
      // corrupt line — skipped
    }
  }
  return out;
}

describe("ω99-47 A1 — first write stamps the soft marker (byte-pinned)", () => {
  it("main chain: first append's line 1 is the wudao_meta marker, line 2 the entry", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("s1", USER);
    const lines = (await readFile(join(root, "s1.jsonl"), "utf8")).split("\n");
    expect(lines[0]).toBe(MARKER_V1); // byte pin, key order included
    expect(lines[1]).toBe(JSON.stringify(USER));
    // the constant and the supported version agree
    expect(formatMarkerLine()).toBe(
      `{"type":"wudao_meta","data":{"formatVersion":${SUPPORTED_FORMAT_VERSION}}}\n`,
    );
    expect(SUPPORTED_FORMAT_VERSION).toBe(1);
  });
  it("sidechain same law: appendSidechain AND appendSidechainEntry stamp line 1", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c1", USER);
    await s.appendSidechainEntry("c2", { type: "approval-receipt", data: { tool: "shell" } });
    expect((await readFile(join(root, "side-c1.jsonl"), "utf8")).split("\n")[0]).toBe(MARKER_V1);
    expect((await readFile(join(root, "side-c2.jsonl"), "utf8")).split("\n")[0]).toBe(MARKER_V1);
  });
  it("second write does NOT stamp again — exactly one marker per file", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("s1", USER);
    await s.append("s1", ASSISTANT);
    const text = await readFile(join(root, "s1.jsonl"), "utf8");
    expect(text.match(/wudao_meta/g)).toHaveLength(1);
    expect(text.split("\n")[2]).toBe(JSON.stringify(ASSISTANT));
  });
});

describe("ω99-47 A2 — old-reader parity: the marker costs zero messages", () => {
  it("marked file vs unmarked twin: old reader extracts the SAME messages", async () => {
    const msgs = [
      USER,
      ASSISTANT,
      { role: "tool" as const, toolCallId: "t1", name: "read_file", content: "body" },
    ];
    const s = createJsonlSessionStore(root);
    for (const m of msgs) await s.append("marked", m);
    // the unmarked twin: identical content, hand-written without a marker
    await writeFile(
      join(root, "plain.jsonl"),
      msgs.map((m) => JSON.stringify(m)).join("\n") + "\n",
      "utf8",
    );
    const markedText = await readFile(join(root, "marked.jsonl"), "utf8");
    const plainText = await readFile(join(root, "plain.jsonl"), "utf8");
    const fromMarked = oldReader(markedText);
    expect(fromMarked).toEqual(oldReader(plainText)); // 逐条相等
    expect(fromMarked).toEqual(msgs); // and nothing was lost
    // the new load() agrees on both files — and so does the ENTRY view:
    // the marker is transport framing and never leaks into ANY read path,
    // so a file this build wrote reads byte-for-byte like a pre-ω99-47 one
    expect(await s.load("marked")).toEqual(await s.load("plain"));
    expect(await s.loadSessionEntries("marked")).toEqual(await s.loadSessionEntries("plain"));
  });
  it("sidechain parity: old reader over a marked side- file keeps the messages", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("c9", USER);
    await s.appendSidechainEntry("c9", { type: "approval-receipt", data: { tool: "x" } });
    await s.appendSidechain("c9", ASSISTANT);
    const text = await readFile(join(root, "side-c9.jsonl"), "utf8");
    expect(oldReader(text)).toEqual([USER, ASSISTANT]);
    expect(await s.loadSidechain("c9")).toEqual([USER, ASSISTANT]); // receipt + marker filtered
  });
});

describe("ω99-47 A3 — newer format version: reads pass, writes refuse", () => {
  const MSGS = [USER, ASSISTANT];
  const V99_TEXT =
    '{"type":"wudao_meta","data":{"formatVersion":99}}\n' +
    MSGS.map((m) => JSON.stringify(m)).join("\n") +
    "\n";
  it("load/loadSessionEntries return everything; append throws the typed error", async () => {
    await writeFile(join(root, "v99.jsonl"), V99_TEXT, "utf8");
    const s = createJsonlSessionStore(root);
    expect(await s.load("v99")).toEqual(MSGS); // data not lost
    expect(await s.loadSessionEntries("v99")).toEqual(MSGS); // marker stripped: just the data entries
    const err = await s.append("v99", USER).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedSessionFormatException);
    expect((err as UnsupportedSessionFormatException).fileVersion).toBe(99);
    expect((err as Error).message).toMatch(/99/); // carries the file's version
    expect((err as Error).message).toMatch(/newer version of wudao/i); // names the cause
    expect((err as Error).message).toMatch(/upgrade/i); // upgrade guidance
    // the refused write left the file byte-identical
    expect(await readFile(join(root, "v99.jsonl"), "utf8")).toBe(V99_TEXT);
  });
  it("the refused write does not poison the queue — later appends land", async () => {
    await writeFile(join(root, "v99.jsonl"), V99_TEXT, "utf8");
    const s = createJsonlSessionStore(root);
    await expect(s.appendEntry("v99", USER)).rejects.toBeInstanceOf(UnsupportedSessionFormatException);
    await s.append("ok", USER); // must not hang or drop
    expect(await s.load("ok")).toEqual([USER]);
  });
  it("sidechain same law: appendSidechain/appendSidechainEntry refuse, reads pass", async () => {
    await writeFile(
      join(root, "side-v99.jsonl"),
      `{"type":"wudao_meta","data":{"formatVersion":99}}\n${JSON.stringify(USER)}\n`,
      "utf8",
    );
    const s = createJsonlSessionStore(root);
    expect(await s.loadSidechain("v99")).toEqual([USER]);
    expect(await s.loadSidechainEntries("v99")).toEqual([USER]); // marker stripped
    await expect(s.appendSidechain("v99", USER)).rejects.toBeInstanceOf(
      UnsupportedSessionFormatException,
    );
    await expect(s.appendSidechainEntry("v99", USER)).rejects.toBeInstanceOf(
      UnsupportedSessionFormatException,
    );
  });
});

describe("ω99-47 A4 — legacy unmarked file: readable, writable, NOT retro-stamped", () => {
  it("append onto a pre-marker file succeeds and inserts no marker (history untouched)", async () => {
    await writeFile(join(root, "legacy.jsonl"), `${JSON.stringify(USER)}\n`, "utf8");
    const s = createJsonlSessionStore(root);
    expect(await s.load("legacy")).toEqual([USER]);
    await s.append("legacy", ASSISTANT);
    expect(await readFile(join(root, "legacy.jsonl"), "utf8")).toBe(
      `${JSON.stringify(USER)}\n${JSON.stringify(ASSISTANT)}\n`, // exact bytes — no marker
    );
    expect(await s.load("legacy")).toHaveLength(2);
  });
});

describe("ω99-47 A5 — fork byte-copy inherits the marker and stays writable", () => {
  it("copyFile twin keeps line 1 marker; reads and writes work on the copy", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("orig", USER);
    // fork-session.ts is a raw copyFile — same mechanism, byte-for-byte
    await copyFile(join(root, "orig.jsonl"), join(root, "fork1.jsonl"));
    const text = await readFile(join(root, "fork1.jsonl"), "utf8");
    expect(text.split("\n")[0]).toBe(MARKER_V1);
    expect(await s.load("fork1")).toEqual([USER]);
    await s.append("fork1", ASSISTANT); // v1 ≤ supported → writable
    expect(await s.load("fork1")).toHaveLength(2);
    expect(text.match(/wudao_meta/g)).toHaveLength(1);
  });
});

describe("ω99-47 A6 — skip contract: unknown types and corrupt lines are counted", () => {
  it("2 unknown-type entries + 3 messages → load returns 3, lastLoadSkipped == 2", async () => {
    const m1 = { role: "user" as const, content: "1" };
    const m2 = { role: "assistant" as const, content: "2" };
    const m3 = { role: "user" as const, content: "3" };
    // unknown ENTRY TYPES: parse as JSON but no validator recognizes them
    // (no `data` key → not even a generic M35 entry)
    const u1 = '{"type":"future_thing","payload":{"a":1}}';
    const u2 = '{"totally":"unrecognized"}';
    await writeFile(
      join(root, "skips.jsonl"),
      [JSON.stringify(m1), u1, u2, JSON.stringify(m2), JSON.stringify(m3)].join("\n") + "\n",
      "utf8",
    );
    const s = createJsonlSessionStore(root);
    expect(await s.load("skips")).toEqual([m1, m2, m3]);
    expect(s.lastLoadSkipped).toBe(2);
    // entry view: same skips counted, messages returned
    expect(await s.loadSessionEntries("skips")).toEqual([m1, m2, m3]);
    expect(s.lastLoadSkipped).toBe(2);
  });
  it("a corrupt (unparseable) line rides the same counter — mid-file, so heal keeps hands off", async () => {
    await writeFile(
      join(root, "corrupt.jsonl"),
      [JSON.stringify(USER), "{torn json", JSON.stringify(ASSISTANT)].join("\n") + "\n",
      "utf8",
    );
    const s = createJsonlSessionStore(root);
    expect(await s.load("corrupt")).toEqual([USER, ASSISTANT]);
    expect(s.lastLoadSkipped).toBe(1);
  });
  it("KNOWN non-message entries are an intentional filter, NOT skips (counter stays 0)", async () => {
    const s = createJsonlSessionStore(root);
    await s.append("known", USER);
    await s.appendEntry("known", { type: "model_change", model: "m", at: "2026-09-05T00:00:00.000Z" });
    await s.appendEntry("known", { type: "deferred_loaded", data: { n: 1 } });
    await s.append("known", ASSISTANT);
    expect(await s.load("known")).toEqual([USER, ASSISTANT]); // filtered, not counted
    expect(s.lastLoadSkipped).toBe(0);
    // entry view (marker stripped): user + model_change + generic + assistant
    expect(await s.loadSessionEntries("known")).toHaveLength(4);
    expect(s.lastLoadSkipped).toBe(0);
  });
  it("counter resets per load call — a clean file zeroes it, a missing file zeroes it", async () => {
    const s = createJsonlSessionStore(root);
    await writeFile(
      join(root, "skips.jsonl"),
      [JSON.stringify(USER), '{"type":"future","nope":1}'].join("\n") + "\n",
      "utf8",
    );
    await s.load("skips");
    expect(s.lastLoadSkipped).toBe(1);
    await s.append("clean", USER);
    await s.load("clean");
    expect(s.lastLoadSkipped).toBe(0); // reset by a clean load
    await s.load("missing-file");
    expect(s.lastLoadSkipped).toBe(0); // reset by the early-return path too
  });
  it("sidechain skip counting works the same (side- files, one law)", async () => {
    await writeFile(
      join(root, "side-sk.jsonl"),
      [JSON.stringify(USER), '{"type":"future","nope":1}', JSON.stringify(ASSISTANT)].join("\n") + "\n",
      "utf8",
    );
    const s = createJsonlSessionStore(root);
    expect(await s.loadSidechain("sk")).toEqual([USER, ASSISTANT]);
    expect(s.lastLoadSkipped).toBe(1);
    await s.loadSidechainEntries("sk");
    expect(s.lastLoadSkipped).toBe(1);
  });
});

describe("ω99-47 — red-line pin: the version gate is core-exported surface, not config", () => {
  it("SUPPORTED_FORMAT_VERSION / marker / typed error are core exports", async () => {
    const core = await import("../src/session/format-version.js");
    expect(core.SUPPORTED_FORMAT_VERSION).toBe(1);
    expect(core.formatMarkerLine()).toBe(`{"type":"wudao_meta","data":{"formatVersion":1}}\n`);
    expect(typeof core.UnsupportedSessionFormatException).toBe("function");
  });
  it("marker coexists with ω99-43 receipts — same generic channel, different types", async () => {
    const s = createJsonlSessionStore(root);
    await s.appendSidechain("cx", USER);
    await s.appendSidechainEntry("cx", {
      type: "approval-receipt",
      data: { tool: "shell", inputKey: "shell#abc", decision: { behavior: "allow" }, ts: "2026-09-05T00:00:00.000Z" },
    });
    const entries = await s.loadSidechainEntries("cx");
    // marker is transport framing — stripped; the RECEIPT is data and rides
    expect(entries[0]).toEqual(USER);
    expect((entries[1] as { type: string }).type).toBe("approval-receipt");
    expect(entries).toHaveLength(2);
    expect(await s.loadSidechain("cx")).toEqual([USER]); // message stream unpolluted
  });
});
