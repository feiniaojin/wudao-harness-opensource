// 125 项 1/项 2（the upstream project窗口链/WorldState 差分）CLI 面：
//   ① compact_boundary 条目的 additive 字段（windowIndex/worldState）——写入
//      缺省不落（老字节不变）、读取带 fail-safe；
//   ② windowChainFromEntries（receiptAnchorsFromEntries 同族读取）——老行
//      （无 windowIndex）照计数、末窗字段回读、畸形行跳过；
//   ③ driver 手动 /compact 全链：身份行进 summary、事件带 windowIndex +
//      worldState、条目落 JSONL、本进程记账前进（第二次 /compact = #2）；
//   ④ resume 重建：带窗口字段的会话续链（#3 + 差分 vs 旧快照）、老会话
//      （pre-125 条目）零行为变化（续链 #N+1、无差分、不崩）。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentDriverOptions } from "@wudao/core";
import { createJsonlSessionStore } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import {
  appendSessionEntry,
  buildCompactBoundaryEntry,
  COMPACT_BOUNDARY_TYPE,
  lastCompactBoundary,
  windowChainFromEntries,
  type CompactBoundaryData,
} from "../src/session-entry.js";

const wait = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A v7-shaped session id (the store's file-name contract). */
const sid = (n: string): string => `018f1250-0000-7000-8000-0000000000${n.padStart(2, "0")}`;

const entry = (data: unknown): CompactBoundaryData[] => [{ type: COMPACT_BOUNDARY_TYPE, data } as CompactBoundaryData];

// ---------------------------------------------------------------------------
// §1 — 条目面：additive 字段
// ---------------------------------------------------------------------------

describe("compact_boundary entry — 125 additive fields", () => {
  it("windowIndex/worldState thread into the built entry", () => {
    const e = buildCompactBoundaryEntry({
      firstKeptEntryId: "user-1-ab", reason: "threshold", tier: 2,
      windowIndex: 3,
      worldState: { goalSummary: "ship", goalBudgetUsed: 42, changedFiles: ["a.ts"], activeTools: ["edit"] },
    });
    const d = e.data as Record<string, unknown>;
    expect(d.windowIndex).toBe(3);
    expect(d.worldState).toEqual({ goalSummary: "ship", goalBudgetUsed: 42, changedFiles: ["a.ts"], activeTools: ["edit"] });
  });

  it("absent fields are OMITTED — the pre-125 bytes are unchanged", () => {
    const d = buildCompactBoundaryEntry({ firstKeptEntryId: "user-1-ab", reason: "manual", tier: 2 }).data as Record<string, unknown>;
    expect("windowIndex" in d).toBe(false);
    expect("worldState" in d).toBe(false);
    expect(Object.keys(d).sort()).toEqual(["at", "firstKeptEntryId", "reason", "tier"]);
  });

  it("lastCompactBoundary reads the additive fields back (and drops malformed ones)", () => {
    const rows = entry({ firstKeptEntryId: "x", reason: "threshold", tier: 2, at: "t", windowIndex: 4, worldState: { changedFiles: [], activeTools: [] } });
    const got = lastCompactBoundary(rows);
    expect(got?.windowIndex).toBe(4);
    expect(got?.worldState).toEqual({ changedFiles: [], activeTools: [] });
    // malformed: a non-positive/non-integer windowIndex and a junk worldState drop
    const bad = lastCompactBoundary(entry({ firstKeptEntryId: "x", reason: "", tier: 2, at: "", windowIndex: 0, worldState: { changedFiles: "nope" } }));
    expect(bad?.windowIndex).toBeUndefined();
    expect(bad?.worldState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — windowChainFromEntries（resume 重建的读取面）
// ---------------------------------------------------------------------------

describe("windowChainFromEntries — the receiptAnchorsFromEntries family read", () => {
  it("counts boundaries (pre-125 rows included — the count IS the chain)", () => {
    const rows = [
      { type: COMPACT_BOUNDARY_TYPE, data: { firstKeptEntryId: "a", reason: "threshold", tier: 2, at: "t1" } },
      { role: "user", content: "hi" },
      { type: COMPACT_BOUNDARY_TYPE, data: { firstKeptEntryId: "b", reason: "manual", tier: 2, at: "t2", windowIndex: 2 } },
    ] as never;
    const chain = windowChainFromEntries(rows);
    expect(chain.boundaryCount).toBe(2);
    expect(chain.lastWindowIndex).toBe(2);
    expect(chain.lastWorldState).toBeUndefined();
  });

  it("returns the LAST boundary's world snapshot (the next diff baseline)", () => {
    const rows = [
      { type: COMPACT_BOUNDARY_TYPE, data: { firstKeptEntryId: "a", reason: "", tier: 2, at: "", windowIndex: 1, worldState: { changedFiles: ["old.ts"], activeTools: [] } } },
      { type: COMPACT_BOUNDARY_TYPE, data: { firstKeptEntryId: "b", reason: "", tier: 2, at: "", windowIndex: 2, worldState: { changedFiles: ["new.ts"], activeTools: ["edit"] } } },
    ] as never;
    const chain = windowChainFromEntries(rows);
    expect(chain.boundaryCount).toBe(2);
    expect(chain.lastWindowIndex).toBe(2);
    expect(chain.lastWorldState).toEqual({ changedFiles: ["new.ts"], activeTools: ["edit"] });
  });

  it("malformed boundary rows never count (same guard as lastCompactBoundary); empty file → 0", () => {
    const rows = [
      { type: COMPACT_BOUNDARY_TYPE, data: { reason: "junk row without fingerprint" } },
      { role: "user", content: "hi" },
      { type: "goal_set", data: {} },
    ] as never;
    const chain = windowChainFromEntries(rows);
    expect(chain.boundaryCount).toBe(0);
    expect(chain.lastWindowIndex).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §3/§4 — driver 面：手动 /compact 全链 + resume 重建
// ---------------------------------------------------------------------------

/** The summarizer answers "S"; every run call answers a final "done". */
const compactModel = () => ({
  async generate(input: { querySource?: string }) {
    if (input.querySource === "summarizer") return { role: "assistant", content: "S" };
    return { role: "assistant", content: "done" };
  },
  modelId: "test",
});

/** A loaded chain that has a compactable span (narrative-heavy, non-digestible). */
const chainMessages = (): AgentMessage[] => [
  { role: "user", content: "[compacted summary] prior window summary\n[End of summary — respond to the user below, not to the summary]" },
  { role: "user", content: "task 0 " + "x".repeat(2000) },
  { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "src/new.ts" } }] },
  { role: "tool", toolCallId: "w1", name: "write_file", content: "wrote" },
  { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
  { role: "user", content: "go" },
];

interface Harness {
  readonly driver: AgentDriver;
  readonly boundaries: { firstKeptEntryId: string; reason: string; tier: number; windowIndex?: number; worldState?: { changedFiles: readonly string[]; activeTools: readonly string[] } }[];
  readonly sessionsDir: string;
  readonly store: ReturnType<typeof createJsonlSessionStore>;
  readonly liveSid: string;
}

async function makeHarness(seeded?: {
  readonly sid: string;
  /** Rows to seed AFTER the messages, oldest first (a real chain's row k
   *  claims windowIndex k — the count and the indices agree). */
  readonly boundaryRows: ReadonlyArray<{ windowIndex?: number; worldState?: { changedFiles: readonly string[]; activeTools: readonly string[] } }>;
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "wudao-125b-"));
  const sessionsDir = join(root, ".wudao", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const store = createJsonlSessionStore(sessionsDir);
  const liveSid = seeded?.sid ?? sid("01");
  if (seeded !== undefined) {
    // Seed the file like a compacted session looks: a frozen summary chain +
    // the boundary receipts (125-shaped or pre-125) + a compactable tail.
    for (const m of chainMessages()) await store.append(seeded.sid, m);
    for (const row of seeded.boundaryRows) {
      await appendSessionEntry(store, seeded.sid, buildCompactBoundaryEntry({
        firstKeptEntryId: "user-9-abc", reason: "threshold", tier: 2,
        ...(row.windowIndex !== undefined ? { windowIndex: row.windowIndex } : {}),
        ...(row.worldState !== undefined ? { worldState: row.worldState } : {}),
      }));
    }
  }
  const boundaries: Harness["boundaries"] = [];
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: compactModel() as never,
    tools: [],
    workspaceRoot: root,
    sessionStore: store,
    onCompacted: (m) => { void store.append(liveSid, m); },
    onCompactBoundary: (info) => {
      boundaries.push({ ...info });
      appendSessionEntry(store, liveSid, buildCompactBoundaryEntry(info)).catch(() => {});
    },
  } as Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">);
  return { driver, boundaries, sessionsDir, store, liveSid };
}

describe("driver /compact — the 125 rotation seam", () => {
  it("manual compaction lands a window boundary: identity in the summary, windowIndex + worldState on the event and the JSONL row", async () => {
    const h = await makeHarness();
    h.driver.loadHistory(chainMessages(), h.liveSid);
    expect(h.driver.submit("/compact")).toBe("notice");
    await until(() => h.driver.isIdle() && h.boundaries.length === 1, "manual compact landed");
    // 项 1: the identity line rides the NEW frozen summary (session key = sid[0:8]).
    const summary = h.driver.state.messages.filter((m) => m.role === "user" && m.content.startsWith("[compacted summary]")).at(-1)?.content ?? "";
    expect(summary).toContain(`[context window #1 | chain: #1 | first: ${h.liveSid.slice(0, 8)}#1]`);
    // 项 2: first compaction → NO diff section; the event carries the snapshot.
    expect(summary).not.toContain("[world diff");
    expect(h.boundaries[0]?.windowIndex).toBe(1);
    expect(h.boundaries[0]?.worldState?.changedFiles).toEqual(["src/new.ts"]);
    // The JSONL row carries the additive fields (file order: last boundary).
    // The entry append is fire-and-forget — poll for its landing.
    await until(async () => {
      const last = lastCompactBoundary(await h.store.loadSessionEntries(h.liveSid));
      return last?.windowIndex === 1 && JSON.stringify(last?.worldState?.changedFiles) === JSON.stringify(["src/new.ts"]);
    }, "boundary entry landed");
    h.driver.dispose();
  });

  it("the in-process chain advances: a SECOND /compact opens window #2 and diffs against #1's snapshot", async () => {
    const h = await makeHarness();
    h.driver.loadHistory(chainMessages(), h.liveSid);
    h.driver.submit("/compact");
    await until(() => h.driver.isIdle() && h.boundaries.length === 1, "first compact");
    // New file activity between the windows: an edit lands in the ledger.
    h.driver.state.messages.push(
      { role: "assistant", content: "", toolCalls: [{ id: "w2", name: "edit", arguments: { path: "src/other.ts" } }] },
      { role: "tool", toolCallId: "w2", name: "edit", content: "edited" },
      { role: "user", content: "more" },
    );
    h.driver.submit("/compact");
    await until(() => h.driver.isIdle() && h.boundaries.length === 2, "second compact");
    expect(h.boundaries[1]?.windowIndex).toBe(2);
    const summary = h.driver.state.messages.filter((m) => m.role === "user" && m.content.startsWith("[compacted summary]")).at(-1)?.content ?? "";
    expect(summary).toContain(`[context window #2 | chain: #1→#2 | first: ${h.liveSid.slice(0, 8)}#1 | prev: ${h.liveSid.slice(0, 8)}#1]`);
    // 项 2: the diff rides the header — src/other.ts joined the changed set.
    expect(summary).toContain("[world diff since window #1]");
    expect(summary).toContain("+1 changed");
    h.driver.dispose();
  });
});

describe("driver resume — the window chain rebuilds from entries", () => {
  it("a 125-shaped session continues the chain: #3 identity + the diff vs the seeded snapshot", async () => {
    const h = await makeHarness({
      sid: sid("02"),
      // A real two-window chain: row 1 (pre-125 shape — the session predates
      // 125) + row 2 (125 shape, carrying the snapshot).
      boundaryRows: [
        {},
        { windowIndex: 2, worldState: { changedFiles: ["old.ts"], activeTools: [] } },
      ],
    });
    const outcome = await h.driver.resume(sid("02"));
    expect(outcome.ok).toBe(true);
    h.driver.submit("/compact");
    await until(() => h.driver.isIdle() && h.boundaries.length === 1, "post-resume compact");
    // 项 1: count(seeded boundaries=2) + 1 = 3 — the chain CONTINUES, not restarts.
    expect(h.boundaries[0]?.windowIndex).toBe(3);
    const summary = h.driver.state.messages.filter((m) => m.role === "user" && m.content.startsWith("[compacted summary]")).at(-1)?.content ?? "";
    expect(summary).toContain(`[context window #3 | chain: #1→#2→#3 | first: ${sid("02").slice(0, 8)}#1 | prev: ${sid("02").slice(0, 8)}#2]`);
    // 项 2: the seeded snapshot is the baseline — old.ts reverted, src/new.ts changed.
    expect(summary).toContain("[world diff since window #2]");
    expect(summary).toContain("files: +1 changed, -1 reverted");
    h.driver.dispose();
  });

  it("a pre-125 session (no windowIndex, no snapshot) resumes without a scratch: chain continues at #N+1, no diff injected", async () => {
    const h = await makeHarness({
      sid: sid("03"),
      boundaryRows: [{}], // the pre-125 row shape: firstKeptEntryId/reason/tier/at only
    });
    const outcome = await h.driver.resume(sid("03"));
    expect(outcome.ok).toBe(true); // 老 session 零行为变化：resume 不崩
    h.driver.submit("/compact");
    await until(() => h.driver.isIdle() && h.boundaries.length === 1, "post-resume compact");
    expect(h.boundaries[0]?.windowIndex).toBe(2); // 1 seeded boundary + 1
    const summary = h.driver.state.messages.filter((m) => m.role === "user" && m.content.startsWith("[compacted summary]")).at(-1)?.content ?? "";
    expect(summary).toContain("[context window #2 | chain: #1→#2");
    expect(summary).not.toContain("[world diff"); // no baseline → no diff
    h.driver.dispose();
  });
});

// The JSONL rows are plain readable JSON — the additive fields serialize
// without ceremony (the durable record a future reader rebuilds from).
describe("harness sanity", () => {
  it("the world snapshot rows serialize as plain JSON (readable back)", async () => {
    const h = await makeHarness();
    h.driver.loadHistory(chainMessages(), h.liveSid);
    h.driver.submit("/compact");
    // The entry append is fire-and-forget — poll for its landing on disk.
    await until(async () => {
      const file = (await readdir(h.sessionsDir)).find((f) => f.startsWith(h.liveSid));
      if (file === undefined) return false;
      const text = await readFile(join(h.sessionsDir, file), "utf8");
      return text.includes("windowIndex") && text.includes("changedFiles");
    }, "boundary row serialized");
    h.driver.dispose();
  });
});
