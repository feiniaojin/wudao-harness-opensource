// ω99-217: #R — 收据持久化 receipts：settle 收据（216 turn-diff 净变更 +
// 0.3.15 run-stats 耗时）落进 session JSONL 的 M35 §2 泛型车道
// （turn_diff_receipt / run_stats_receipt），resume/boot 时按文件序重建为
// notice 并入 history——改动面板/胶囊/chip 重启后还在。钉四件事：
//   落盘   run 落定 → JSONL 含两枚泛型条目（type/data 形状恰、载荷精确）；
//          （消息交错位不钉：宿主消息持久化时序在测外，回放按尾端并入对其免疫）
//   回放   resume/boot 后 history 含重建 notice（text/detail/changes 精确、
//          面板数据源活、在「↪ 已恢复」notice 之前）；
//   等价   老会话（无收据条目）零回放——history 与改动前完全一致；
//   韧性   落盘失败 fire-and-forget 不破坏 run；畸形 data 弃条不崩。
// 夹具全在 os.tmpdir()（turn-diff-driver.test.ts 式样）；纯层 3 + 集成 6。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScriptedModel,
  createTurnDiffTracker,
  createWriteFileTool,
  createJsonlSessionStore,
} from "@wudao/core";
import type { AgentMessage, SessionEntry, SessionStore } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { receiptNoticesFromEntries } from "../src/tui/resume.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface NoticeEntry {
  kind: "notice";
  text: string;
  detail?: string;
  changes?: readonly { path: string; op: "created" | "modified"; writes: number }[];
}

function notices(d: ReturnType<typeof createAgentDriver>): NoticeEntry[] {
  return d.getHistory().filter((e): e is NoticeEntry => e.kind === "notice");
}

// The writer's exact payloads, shared by the pure-layer and replay pins.
const TD_TEXT = "回合净变更 1 文件：out.ts(新建)";
const TD_DETAIL = "diff --git a/out.ts b/out.ts\nnew file\n+one\n";
const TD_CHANGES = [{ path: "out.ts", op: "created" as const, writes: 1 }];
const STATS_TEXT = "耗时 1.2s · 模型 0.8s · 工具 0.4s (2 次)";

function receiptEntries(): SessionEntry[] {
  return [
    { type: "turn_diff_receipt", data: { text: TD_TEXT, detail: TD_DETAIL, changes: TD_CHANGES } },
    { type: "run_stats_receipt", data: { text: STATS_TEXT } },
  ];
}

describe("ω99-217 纯层 — receiptNoticesFromEntries", () => {
  it("round-trips both receipt types in file order with exact fields", () => {
    const entries: SessionEntry[] = [
      { role: "user", content: "do it" },
      ...receiptEntries(),
      { role: "assistant", content: "done" },
    ];
    expect(receiptNoticesFromEntries(entries)).toEqual([
      { kind: "notice", text: TD_TEXT, detail: TD_DETAIL, changes: TD_CHANGES },
      { kind: "notice", text: STATS_TEXT },
    ]);
  });

  it("old sessions (no receipt entries) replay ZERO notices — messages and other entry types never contribute", () => {
    const entries: SessionEntry[] = [
      { role: "user", content: "hi" },
      { type: "model_change", model: "m1", at: "2026-09-08T00:00:00Z" },
      { type: "session_name", name: "my-session" },
      { role: "assistant", content: "hello" },
    ];
    expect(receiptNoticesFromEntries(entries)).toEqual([]);
  });

  it("drops malformed receipt payloads without touching well-formed neighbors", () => {
    const bad: SessionEntry[] = [
      // prettier-ignore
      { type: "turn_diff_receipt", data: "not an object" } as unknown as SessionEntry,
      { type: "turn_diff_receipt", data: {} }, // no text
      { type: "turn_diff_receipt", data: { text: "" } }, // empty text
      { type: "turn_diff_receipt", data: { text: TD_TEXT } }, // no changes
      { type: "turn_diff_receipt", data: { text: TD_TEXT, changes: [] } }, // empty changes
      { type: "turn_diff_receipt", data: { text: TD_TEXT, changes: "nope" } }, // changes not array
      { type: "turn_diff_receipt", data: { text: TD_TEXT, changes: [{ path: "a", op: "deleted", writes: 1 }] } }, // bad op
      { type: "turn_diff_receipt", data: { text: TD_TEXT, changes: [{ path: "a", op: "created", writes: -1 }] } }, // negative writes
      { type: "turn_diff_receipt", data: { text: TD_TEXT, detail: 7, changes: TD_CHANGES } }, // detail not string
      { type: "run_stats_receipt", data: { text: 42 } } as unknown as SessionEntry, // text not string
    ];
    const good = receiptEntries();
    const out = receiptNoticesFromEntries([...bad.slice(0, 5), good[0]!, ...bad.slice(5), good[1]!]);
    expect(out).toEqual([
      { kind: "notice", text: TD_TEXT, detail: TD_DETAIL, changes: TD_CHANGES },
      { kind: "notice", text: STATS_TEXT },
    ]);
  });

  it("v7 γ3 — servedBy 随 run_stats_receipt 回放：换腿作答的注记折进回放文本；畸形 servedBy 弃注记不弃行", () => {
    const withServed: SessionEntry[] = [
      { role: "user", content: "go" },
      { type: "run_stats_receipt", data: { text: STATS_TEXT, servedBy: { model: "deepseek-v4-flash", from: "deepseek-v4" } } },
      { role: "assistant", content: "done" },
    ];
    expect(receiptNoticesFromEntries(withServed)).toEqual([
      { kind: "notice", text: `${STATS_TEXT}；本轮由 deepseek-v4-flash（降级）作答` },
    ]);
    // 无 servedBy 的旧收据照旧逐字节回放（零噪音缺席臂）。
    const withoutServed: SessionEntry[] = [
      { type: "run_stats_receipt", data: { text: STATS_TEXT } },
    ];
    expect(receiptNoticesFromEntries(withoutServed)).toEqual([{ kind: "notice", text: STATS_TEXT }]);
    // 畸形 servedBy（model 非串）→ 弃注记不弃行。
    const malformed: SessionEntry[] = [
      { type: "run_stats_receipt", data: { text: STATS_TEXT, servedBy: { model: 42 } } } as unknown as SessionEntry,
    ];
    expect(receiptNoticesFromEntries(malformed)).toEqual([{ kind: "notice", text: STATS_TEXT }]);
  });
});

describe("ω99-217 落盘 — settle receipts onto the JSONL generic lane", () => {
  it("a settled write run persists turn_diff_receipt + run_stats_receipt (exact payloads on the generic lane)", async () => {
    // realpath: macOS tmpdir is a symlink — the write tool resolves the
    // canonical target, so the receipt's relative paths need the same root.
    const ws = await realpath(await mkdtemp(join(tmpdir(), "td217-a-")));
    try {
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "out.ts", content: "one\n" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      // No onRunComplete wiring here — the driver-side receipts still land on
      // the JSONL at settle (that is the seam under test); message
      // interleaving is pinned in the resume tests below via seeded files.
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      driver.submit("make it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => n.text.includes("耗时")), "run settled");
      await wait(50); // fire-and-forget persistence flush
      const entries = await store.loadSessionEntries(sid);
      const td = entries.filter((e) => e.type === "turn_diff_receipt");
      const st = entries.filter((e) => e.type === "run_stats_receipt");
      expect(td).toHaveLength(1);
      expect(st).toHaveLength(1);
      // exact writer payloads — the replay's rebuild contract
      // ω99-288: #8 — lockstep 同形演进：changes 行带数据层补齐的每文件
      // +M/−K（created "one\n" vs 空 → +1/−0）；回放侧成对透传（本文件回放
      // 钉的种子夹具无计数，仍缺省——append-only 两形都在）。
      expect(td[0]).toEqual({ type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：out.ts(新建)", detail: expect.stringContaining("diff --git a/out.ts b/out.ts"), changes: [{ path: "out.ts", op: "created", writes: 1, plus: 1, minus: 0 }] } });
      expect(st[0]).toEqual({ type: "run_stats_receipt", data: { text: expect.stringMatching(/^耗时 /) } });
      // M24 side-pin: the MESSAGE view filters the generic lane — zero
      // receipts reach load(), so state.messages/request bytes never move.
      const msgs = await store.load(sid);
      expect(msgs.every((m) => "role" in m)).toBe(true);
      expect(JSON.stringify(msgs)).not.toContain("turn_diff_receipt");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a rejecting store never breaks the run — the UI receipts still land (fire-and-forget)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-b-"));
    try {
      const real = createJsonlSessionStore(join(ws, "sessions"));
      const failing: SessionStore = {
        ...real,
        appendEntries: async () => { throw new Error("disk exploded"); },
      };
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionStore: failing,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("hello");
      await until(() => driver.getStatus().busy === false, "run settles");
      await wait(50);
      // the run settled AND the stats receipt is in the UI history
      expect(notices(driver).some((n) => /^耗时 /.test(n.text))).toBe(true);
      expect(driver.getStatus().busy).toBe(false);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-217 回放 — resume / boot rebuild the notices", () => {
  function seedMessages(): AgentMessage[] {
    return [
      { role: "user", content: "make it" },
      { role: "assistant", content: "done" },
    ];
  }

  it("resume(id) replays the receipts as notices before the ↪ 已恢复 notice (panel data source alive)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-c-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const m of seedMessages()) await store.append("r217a", m);
      for (const e of receiptEntries()) await store.appendEntry("r217a", e);
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      expect(await driver.resume("r217a")).toEqual({ ok: true });
      const ns = notices(driver);
      // exact rebuild — text/detail/changes verbatim, file order preserved
      expect(ns[0]).toEqual({ kind: "notice", text: TD_TEXT, detail: TD_DETAIL, changes: TD_CHANGES });
      expect(ns[1]).toEqual({ kind: "notice", text: STATS_TEXT });
      // the replayed receipts sit BEFORE the resume receipt notice
      const resumeIdx = ns.findIndex((n) => n.text.includes("已恢复"));
      expect(resumeIdx).toBe(2);
      // messages NEVER gain the receipts (M24 — replay is view-only)
      expect(driver.state.messages).toHaveLength(2);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resume of a receipt-free session replays ZERO — history is byte-equivalent to the old shape", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-d-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const m of seedMessages()) await store.append("r217b", m);
      await store.appendEntry("r217b", { type: "session_name", name: "old", source: "manual" });
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      expect(await driver.resume("r217b")).toEqual({ ok: true });
      await wait(50);
      // exactly ONE notice (the resume receipt) and the message entries are
      // the plain resumeEntries shape — no replay, no extra entries
      const ns = notices(driver);
      expect(ns).toHaveLength(1);
      expect(ns[0]?.text).toContain("已恢复");
      const kinds = driver.getHistory().map((e) => e.kind);
      expect(kinds).toEqual(["divider", "user", "assistant", "notice"]);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resume drops malformed persisted receipts without crashing (弃条不崩)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-e-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const m of seedMessages()) await store.append("r217c", m);
      await store.appendEntry("r217c", { type: "turn_diff_receipt", data: { changes: "junk" } });
      await store.appendEntry("r217c", { type: "run_stats_receipt", data: { text: STATS_TEXT } });
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      expect(await driver.resume("r217c")).toEqual({ ok: true });
      const ns = notices(driver);
      expect(ns[0]).toEqual({ kind: "notice", text: STATS_TEXT });
      expect(ns.filter((n) => n.text === TD_TEXT)).toHaveLength(0);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("boot with initialMessages replays the receipts (fire-and-forget, after the boot notices)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-f-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const m of seedMessages()) await store.append("r217d", m);
      for (const e of receiptEntries()) await store.appendEntry("r217d", e);
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        sessionId: "r217d",
        initialMessages: seedMessages(),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      await until(() => notices(driver).some((n) => n.text === TD_TEXT), "boot replay lands");
      const ns = notices(driver);
      expect(ns[0]).toEqual({ kind: "notice", text: TD_TEXT, detail: TD_DETAIL, changes: TD_CHANGES });
      expect(ns[1]).toEqual({ kind: "notice", text: STATS_TEXT });
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("loadHistory (the picker's load) replays the receipts too", async () => {
    const ws = await mkdtemp(join(tmpdir(), "td217-g-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const m of seedMessages()) await store.append("r217e", m);
      for (const e of receiptEntries()) await store.appendEntry("r217e", e);
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.loadHistory(seedMessages(), "r217e");
      await until(() => notices(driver).some((n) => n.text === TD_TEXT), "picker-load replay lands");
      const ns = notices(driver);
      expect(ns[0]?.changes).toEqual(TD_CHANGES);
      expect(ns[1]?.text).toBe(STATS_TEXT);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
