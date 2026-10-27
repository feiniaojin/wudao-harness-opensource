// 118 报障修复验收（「打开历史会话时回合收据全堆在最底部」）：读侧按文件
// 序交错——收据锚定（receiptAnchorsFromEntries）到各自回合的消息之后，经
// resumeEntriesAnchored 重建交错基座，boot IIFE 落地时前缀同一性守卫后整表
// 重发（resetHistory）。钉五件事：
//   纯层   receiptNoticeFromEntry 单条转换（非收据/畸形 → undefined）；
//          receiptAnchorsFromEntries 的 afterMessageIndex = 文件里先行的消息
//          条目数（role 携带者计数，泛型条目不计数、畸形收据不锚定）；
//          resumeEntriesAnchored 的位置断言（不是「存在于历史」）——收据在
//          其锚点回合的视图条目之后、下一回合之前；同锚点双收据保序；零锚
//          点时与 resumeEntries 逐字节同形。
//   boot   多回合多收据 resume 后位置正确 + boot notices 浮前（divider 正下
//          方、先于一切收据）+ 恰一次 reset 帧（非 append 增量）；
//   等价   无收据文件零动作——history 与旧形状逐字节一致、零帧；
//   竞态   IIFE 落地前新 run 已开跑：收据不进新 run 段、新 run 条目留在尾
//          部、读跨越的新收据按活尾文本去重不重复；
//   竞态   IIFE 落地前 /clear 或 loadHistory 换会话：前缀同一性失败 → 收据
//          弃置（不污染换上的新视图）。
// 夹具全在 os.tmpdir()（ω99-217 式样）；纯层 + boot 集成。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createJsonlSessionStore } from "@wudao/core";
import type { AgentMessage, SessionEntry, SessionStore } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import {
  resumeEntries,
  resumeEntriesAnchored,
  receiptAnchorsFromEntries,
  receiptNoticeFromEntry,
  receiptNoticesFromEntries,
} from "../src/tui/resume.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// —— 三回合夹具：收据分别锚在纯文本回合后（双收据）、折叠工具轮后、尾部 ——
const TD1_TEXT = "回合净变更 1 文件：a.ts(新建)";
const TD1_DETAIL = "diff --git a/a.ts b/a.ts\nnew file\n+one\n";
const TD1_CHANGES = [{ path: "a.ts", op: "created" as const, writes: 1 }];
const S1_TEXT = "耗时 1.2s · 模型 0.8s · 工具 0.4s (2 次)";
const TD2_TEXT = "回合净变更 2 文件：b.ts,c.ts(修改)";
const TD2_CHANGES = [
  { path: "b.ts", op: "modified" as const, writes: 2 },
  { path: "c.ts", op: "modified" as const, writes: 1 },
];
const S3_TEXT = "耗时 9.9s · 模型 5.5s · 工具 4.4s (7 次)";

function seededEntries(): SessionEntry[] {
  return [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { type: "turn_diff_receipt", data: { text: TD1_TEXT, detail: TD1_DETAIL, changes: TD1_CHANGES } },
    { type: "run_stats_receipt", data: { text: S1_TEXT } },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "b.ts", content: "x" } }] },
    { role: "tool", toolCallId: "c1", name: "write_file", content: "written" },
    { type: "turn_diff_receipt", data: { text: TD2_TEXT, changes: TD2_CHANGES } },
    { role: "user", content: "第三问" },
    { role: "assistant", content: "第三答" },
    { type: "run_stats_receipt", data: { text: S3_TEXT } },
  ];
}

function seededMessages(): AgentMessage[] {
  return seededEntries().filter((e): e is AgentMessage => "role" in e);
}

/** 位置断言的寻址键：每条视图条目的可识别文本（notice/tool 用各自的承载
 *  字段，其余用 text）。 */
function labels(entries: readonly { kind: string }[]): string[] {
  return entries.map((e) => {
    if (e.kind === "notice") return (e as { text: string }).text;
    if (e.kind === "tool") return (e as { summary: string }).summary;
    return (e as { text?: string }).text ?? "";
  });
}

describe("118 纯层 — receiptNoticeFromEntry / receiptAnchorsFromEntries", () => {
  it("converts exactly one entry: undefined for messages, generic entries and malformed receipts; exact notices for both types", () => {
    expect(receiptNoticeFromEntry({ role: "user", content: "hi" })).toBeUndefined();
    expect(receiptNoticeFromEntry({ type: "model_change", model: "m1", at: "2026-09-24T00:00:00Z" })).toBeUndefined();
    expect(receiptNoticeFromEntry({ type: "turn_diff_receipt", data: {} })).toBeUndefined(); // no text
    expect(receiptNoticeFromEntry({ type: "turn_diff_receipt", data: { text: TD1_TEXT } })).toBeUndefined(); // no changes
    expect(receiptNoticeFromEntry({ type: "turn_diff_receipt", data: { text: TD1_TEXT, changes: "junk" } })).toBeUndefined();
    expect(receiptNoticeFromEntry({ type: "run_stats_receipt", data: { text: 42 } as never })).toBeUndefined();
    expect(receiptNoticeFromEntry({ type: "turn_diff_receipt", data: { text: TD1_TEXT, detail: TD1_DETAIL, changes: TD1_CHANGES } }))
      .toEqual({ kind: "notice", text: TD1_TEXT, detail: TD1_DETAIL, changes: TD1_CHANGES });
    expect(receiptNoticeFromEntry({ type: "run_stats_receipt", data: { text: S1_TEXT } }))
      .toEqual({ kind: "notice", text: S1_TEXT });
  });

  it("anchors carry the message count PRECEDING each receipt in file order (role entries count; generic entries and malformed receipts never do)", () => {
    const entries: SessionEntry[] = [
      { type: "session_name", name: "s", source: "manual" }, // generic — not a message
      ...seededEntries().slice(0, 4), // user, assistant, TD1@2, S1@2
      { type: "turn_diff_receipt", data: { changes: "junk" } }, // malformed — dropped, shifts nothing
      { type: "model_change", model: "m2", at: "2026-09-24T00:01:00Z" }, // generic between turns
      ...seededEntries().slice(4, 8), // user2, assistant(toolCalls), tool, TD2@5
      ...seededEntries().slice(8), // user3, assistant3, S3@7
    ];
    const anchors = receiptAnchorsFromEntries(entries);
    expect(anchors.map((a) => a.afterMessageIndex)).toEqual([2, 2, 5, 7]);
    expect(anchors.map((a) => a.notice.text)).toEqual([TD1_TEXT, S1_TEXT, TD2_TEXT, S3_TEXT]);
    // 217 薄包装等价：锚定视图的 notice 序列 === receiptNoticesFromEntries 的输出。
    expect(receiptNoticesFromEntries(entries)).toEqual(anchors.map((a) => a.notice));
  });
});

describe("118 纯层 — resumeEntriesAnchored 按文件序交错（位置断言）", () => {
  const sid = "r118pure";

  it("places every receipt after its anchor turn's view entry and before the next turn's — plain turns, folded tool turns, and the tail", () => {
    const out = resumeEntriesAnchored(seededMessages(), sid, receiptAnchorsFromEntries(seededEntries()));
    // 位置断言：完整的 kind 序列（divider → …），每枚收据夹在其回合与下一回合之间。
    expect(out.map((e) => e.kind)).toEqual([
      "divider", // 已恢复视图头
      "user", "assistant", // 第一回合
      "notice", "notice", // TD1 + S1 —— 双收据同锚点，文件相对序
      "user", "tool", // 第二回合（assistant+tool 折叠为一条 tool 条目）
      "notice", // TD2 —— 折叠轮的收据在 tool 条目之后
      "user", "assistant", // 第三回合
      "notice", // S3 —— 尾部收据
    ]);
    const texts = labels(out);
    expect(texts).toEqual([
      expect.stringContaining("已恢复"),
      "第一问", "第一答",
      TD1_TEXT, S1_TEXT,
      "第二问", "1 个工具：write_file",
      TD2_TEXT,
      "第三问", "第三答",
      S3_TEXT,
    ]);
    // 逐点位置：收据索引严格大于其锚点回合的最后消息条目、小于下一回合首条目。
    const idx = (t: string): number => texts.indexOf(t);
    expect(idx(TD1_TEXT)).toBeGreaterThan(idx("第一答"));
    expect(idx(S1_TEXT)).toBeGreaterThan(idx(TD1_TEXT)); // 同锚点保序
    expect(idx(S1_TEXT)).toBeLessThan(idx("第二问"));
    expect(idx(TD2_TEXT)).toBeGreaterThan(idx("1 个工具：write_file"));
    expect(idx(TD2_TEXT)).toBeLessThan(idx("第三问"));
    expect(idx(S3_TEXT)).toBeGreaterThan(idx("第三答"));
    expect(idx(S3_TEXT)).toBe(out.length - 1); // 尾锚点收据在投影末尾
  });

  it("zero anchors → byte-identical to resumeEntries (old files keep the exact old shape)", () => {
    const msgs = seededMessages();
    expect(resumeEntriesAnchored(msgs, sid, [])).toEqual(resumeEntries(msgs, sid));
    // 收据存在但全部畸形（锚定层已弃）→ 同样零位移。
    const badOnly: SessionEntry[] = [
      { role: "user", content: "q" },
      { type: "turn_diff_receipt", data: { changes: "junk" } },
      { role: "assistant", content: "a" },
    ];
    expect(resumeEntriesAnchored(
      badOnly.filter((e): e is AgentMessage => "role" in e),
      sid,
      receiptAnchorsFromEntries(badOnly),
    )).toEqual(resumeEntries(badOnly.filter((e): e is AgentMessage => "role" in e), sid));
  });

  it("a receipt after a marker user message anchors to the previous turn's entry (skipped messages create no anchor target)", () => {
    const entries: SessionEntry[] = [
      { role: "user", content: "真问题" },
      { role: "assistant", content: "答" },
      { role: "user", content: "[system note: injected]" }, // marker — no view entry
      { type: "run_stats_receipt", data: { text: S1_TEXT } }, // anchors @3 (three messages precede)
    ];
    const msgs = entries.filter((e): e is AgentMessage => "role" in e);
    const out = resumeEntriesAnchored(msgs, sid, receiptAnchorsFromEntries(entries));
    expect(out.map((e) => e.kind)).toEqual(["divider", "user", "assistant", "notice"]);
    expect(out[3]).toEqual({ kind: "notice", text: S1_TEXT });
  });
});

describe("118 boot 集成 — 收据归位 / boot notices 最前 / 帧语义 / 竞态守卫", () => {
  it("boot replays the receipts UNDER their turns (position assertions), floats boot notices above every receipt, and sends exactly ONE reset frame", async () => {
    const ws = await mkdtemp(join(tmpdir(), "arc118-a-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const e of seededEntries()) await store.appendEntry("r118a", e);
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        sessionId: "r118a",
        initialMessages: seededMessages(),
        bootNotices: ["⚠️ 本次启动告示"],
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const frames: { reset: boolean; n: number }[] = [];
      driver.onHistory((entries, reset) => frames.push({ reset, n: entries.length }));
      await until(() => driver.getHistory().some((e) => e.kind === "notice" && e.text === TD1_TEXT), "boot interleaved replay lands");
      const hist = driver.getHistory();
      // 完整位置断言：divider、boot notice 浮前（先于一切收据）、三回合各自
      // 带自己的收据。
      expect(hist.map((e) => e.kind)).toEqual([
        "divider", "notice", // ⚠️ 本次启动告示 —— 最前（divider 正下方）
        "user", "assistant", "notice", "notice", // 第一回合 + TD1/S1
        "user", "tool", "notice", // 第二回合（折叠）+ TD2
        "user", "assistant", "notice", // 第三回合 + S3
      ]);
      const texts = labels(hist);
      const idx = (t: string): number => texts.indexOf(t);
      expect(texts[1]).toBe("⚠️ 本次启动告示");
      expect(idx(TD1_TEXT)).toBeGreaterThan(idx("第一答"));
      expect(idx(S1_TEXT)).toBeGreaterThan(idx(TD1_TEXT));
      expect(idx(S1_TEXT)).toBeLessThan(idx("第二问"));
      expect(idx(TD2_TEXT)).toBeGreaterThan(idx("第二问"));
      expect(idx(TD2_TEXT)).toBeLessThan(idx("第三问"));
      expect(idx(S3_TEXT)).toBe(hist.length - 1);
      // boot notices 先于一切收据（验收 b）。
      for (const t of [TD1_TEXT, S1_TEXT, TD2_TEXT, S3_TEXT]) expect(idx(t)).toBeGreaterThan(idx("⚠️ 本次启动告示"));
      // 帧语义：恰一次整表 reset（非 append 增量）——与 /clear、loadHistory 同机制。
      expect(frames).toEqual([{ reset: true, n: hist.length }]);
      // M24：回放只进视图，消息链原样。
      expect(driver.state.messages).toEqual(seededMessages());
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("boot of a receipt-free file replays ZERO — history keeps the exact old shape and fires no frame", async () => {
    const ws = await mkdtemp(join(tmpdir(), "arc118-b-"));
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      await store.append("r118b", { role: "user", content: "问" });
      await store.append("r118b", { role: "assistant", content: "答" });
      await store.appendEntry("r118b", { type: "session_name", name: "old", source: "manual" });
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        sessionId: "r118b",
        initialMessages: [
          { role: "user", content: "问" },
          { role: "assistant", content: "答" },
        ],
        bootNotices: ["⚠️ 本次启动告示"],
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const frames: { reset: boolean; n: number }[] = [];
      driver.onHistory((entries, reset) => frames.push({ reset, n: entries.length }));
      await wait(150); // 给 fire-and-forget IIFE 充分落地窗口
      // 与改动前逐字节同形：boot notices 留在基座之后（零动作），无 reset 帧。
      expect(driver.getHistory().map((e) => e.kind)).toEqual(["divider", "user", "assistant", "notice"]);
      expect((driver.getHistory()[3] as { text: string }).text).toBe("⚠️ 本次启动告示");
      expect(frames).toEqual([]);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("race: a run settles BEFORE the boot read lands — receipts never enter the new-run segment, the tail keeps its order, and straddled new receipts do not duplicate", async () => {
    const ws = await mkdtemp(join(tmpdir(), "arc118-c-"));
    let release: (() => void) | undefined;
    try {
      const real = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const oldEntries: SessionEntry[] = [
        { role: "user", content: "旧问" },
        { role: "assistant", content: "旧答" },
        { type: "turn_diff_receipt", data: { text: TD1_TEXT, detail: TD1_DETAIL, changes: TD1_CHANGES } },
        { type: "run_stats_receipt", data: { text: S1_TEXT } },
      ];
      for (const e of oldEntries) await real.appendEntry("r118c", e);
      // 门闩 store：第一次 loadSessionEntries（boot IIFE 的那次——工厂同步
      // 前缀即调用）停放到 release，之后才真读盘 → 读窗跨越新 run 的落盘。
      let gate: Promise<void> | null = new Promise((r) => { release = r; });
      const gated: SessionStore = {
        ...real,
        loadSessionEntries: async (id: string) => {
          const g = gate;
          gate = null;
          if (g !== null) await g;
          return real.loadSessionEntries(id);
        },
      };
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "新答" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionStore: gated,
        sessionId: "r118c",
        initialMessages: oldEntries.filter((e): e is AgentMessage => "role" in e),
        bootNotices: ["⚠️ 本次启动告示"],
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      // IIFE 仍在飞：先开新 run 并等它完整落定（UI 收据已进活尾、JSONL 已落）。
      driver.submit("新问");
      await until(
        () => driver.getStatus().busy === false
          && driver.getHistory().some((e) => e.kind === "assistant" && e.text === "新答")
          && driver.getHistory().some((e) => e.kind === "notice" && /^耗时 /.test(e.text)),
        "the fresh run settles while the boot read is parked",
      );
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text === TD1_TEXT)).toBe(false);
      // 放行：读完成（此时文件已含新 run 的 run_stats_receipt——锚在旧消息数
      // 上，属「读跨越完整 run」极端形），嫁接落地。
      release!();
      await until(() => driver.getHistory().some((e) => e.kind === "notice" && e.text === TD1_TEXT), "the interleaved replay lands after the race");
      const hist = driver.getHistory();
      const texts = labels(hist);
      const idx = (t: string): number => texts.indexOf(t);
      // 旧收据归位到旧回合之下；boot notices 仍最前。
      expect(texts[1]).toBe("⚠️ 本次启动告示");
      expect(idx(TD1_TEXT)).toBeGreaterThan(idx("旧答"));
      expect(idx(S1_TEXT)).toBeGreaterThan(idx(TD1_TEXT));
      // 验收 e：收据绝不进新 run 段——全部旧收据在新 run 的 user 条目之前。
      expect(idx("新问")).toBeGreaterThan(idx(S1_TEXT));
      // 新 run 段原样保留在其后（user → assistant → 自己的耗时收据）。
      expect(hist.slice(idx("新问")).map((e) => e.kind)).toEqual(["user", "assistant", "notice"]);
      // 读跨越的新收据不重复：除旧会话自己的 S1 外，恰一条新「^耗时 」
      // notice（活尾那条——回放侧已被活尾文本去重）。
      expect(texts.filter((t) => /^耗时 /.test(t) && t !== S1_TEXT)).toHaveLength(1);
      driver.dispose();
    } finally {
      release?.();
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("race: /clear before the read lands — the prefix-identity guard drops the receipts (the wiped view is never re-polluted)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "arc118-d-"));
    let release: (() => void) | undefined;
    try {
      const real = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const e of seededEntries()) await real.appendEntry("r118d", e);
      let gate: Promise<void> | null = new Promise((r) => { release = r; });
      const gated: SessionStore = {
        ...real,
        loadSessionEntries: async (id: string) => {
          const g = gate;
          gate = null;
          if (g !== null) await g;
          return real.loadSessionEntries(id);
        },
      };
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionStore: gated,
        sessionId: "r118d",
        initialMessages: seededMessages(),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.clear(); // 整表重建（history = []）——前缀身份必败
      release!();
      await wait(150);
      // 弃置：收据（连同其回合的旧视图）不再回来；清空态保持。
      const texts = labels(driver.getHistory());
      expect(texts).toEqual([]);
      expect(driver.getHistory().every((e) => e.kind !== "divider")).toBe(true);
      driver.dispose();
    } finally {
      release?.();
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("race: loadHistory swaps the conversation before the read lands — the abandoned boot session's receipts never appear", async () => {
    const ws = await mkdtemp(join(tmpdir(), "arc118-e-"));
    let release: (() => void) | undefined;
    try {
      const real = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      for (const e of seededEntries()) await real.appendEntry("r118e", e);
      // 换入的目标会话：无收据（loadHistory 自己的回放 IIFE 读它 → 零回放）。
      await real.append("r118other", { role: "user", content: "别的会话问" });
      await real.append("r118other", { role: "assistant", content: "别的会话答" });
      let gate: Promise<void> | null = new Promise((r) => { release = r; });
      const gated: SessionStore = {
        ...real,
        loadSessionEntries: async (id: string) => {
          const g = gate;
          gate = null;
          if (g !== null) await g;
          return real.loadSessionEntries(id);
        },
      };
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionStore: gated,
        sessionId: "r118e",
        initialMessages: seededMessages(),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.loadHistory(
        [
          { role: "user", content: "别的会话问" },
          { role: "assistant", content: "别的会话答" },
        ],
        "r118other",
      );
      release!();
      await wait(150);
      const texts = labels(driver.getHistory());
      // 换入的会话视图原样；旧 boot 会话的收据一枚都不出现。
      expect(texts.some((t) => t === TD1_TEXT || t === S1_TEXT || t === TD2_TEXT || t === S3_TEXT)).toBe(false);
      expect(texts).toContain("别的会话问");
      expect(texts).toContain("别的会话答");
      driver.dispose();
    } finally {
      release?.();
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
