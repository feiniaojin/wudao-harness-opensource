// 125 项 1/项 2（codex 窗口链/WorldState 差分）— the window identity chain and
// the world-diff injection: pure-function shapes, the tier-2 summary header
// seam (byte-identical status-quo when unarmed), the loop's rotation
// bookkeeping (index growth, in-run diff chaining, event fields), and the
// additive entry-read discipline.
import { describe, it, expect } from "vitest";
import {
  tier2Compact, staticTier2Compact,
  SUMMARY_MARKER, runAgentLoop, cumulativeModifiedFiles,
  windowIdentityLine, windowIdentitySection, windowId, worldStateDiff, worldDiffSection,
  parseWorldStateData, activeToolsOf, ACTIVE_TOOLS_CAP, WORLD_DIFF_CAP_CHARS,
  type AgentMessage, type AgentState, type LoopEvent, type Tool, type ModelClient,
  type WorldState,
} from "../src/index.js";
import { dualTier2Compact } from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";

// ---------------------------------------------------------------------------
// §1 — 窗口身份链：纯函数形状
// ---------------------------------------------------------------------------

describe("windowIdentityLine / windowIdentitySection (125 项 1 pure)", () => {
  it("#1: no prev, chain of one", () => {
    expect(windowIdentityLine({ index: 1, sessionKey: "a1b2c3d4" })).toBe(
      "[context window #1 | chain: #1 | first: a1b2c3d4#1]\n",
    );
  });
  it("#3: chain enumerated, first + prev named", () => {
    expect(windowIdentityLine({ index: 3, sessionKey: "a1b2c3d4" })).toBe(
      "[context window #3 | chain: #1→#2→#3 | first: a1b2c3d4#1 | prev: a1b2c3d4#2]\n",
    );
  });
  it("#11: the chain elides its middle past the full cap", () => {
    const line = windowIdentityLine({ index: 11, sessionKey: "ab" });
    expect(line).toContain("chain: #1→#2→…→#10→#11");
    expect(line).toContain("first: ab#1");
    expect(line).toContain("prev: ab#10");
  });
  it("windowId: sessionKey#index (the chain's unique id form)", () => {
    expect(windowId({ index: 2, sessionKey: "abcd1234" })).toBe("abcd1234#2");
  });
  it("section(undefined) = \"\" (the status-quo bytes escape)", () => {
    expect(windowIdentitySection(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §2 — WorldState 差分：纯函数
// ---------------------------------------------------------------------------

const ws = (over: Partial<WorldState> = {}): WorldState => ({
  changedFiles: [],
  activeTools: [],
  ...over,
});

describe("worldStateDiff (125 项 2 pure)", () => {
  it("identical snapshots → \"\" (no injection)", () => {
    const a = ws({ goalSummary: "ship it", goalBudgetUsed: 100, changedFiles: ["a.ts"], activeTools: ["edit"] });
    expect(worldStateDiff(a, { ...a })).toBe("");
  });

  it("goal change renders the quoted transition", () => {
    const out = worldStateDiff(ws({ goalSummary: "fix bug" }), ws({ goalSummary: "ship release" }));
    expect(out).toContain('  goal: "fix bug" → "ship release"');
  });
  it("goal set / cleared render the one-sided forms", () => {
    expect(worldStateDiff(ws(), ws({ goalSummary: "new goal" }))).toContain('  goal: now tracking "new goal"');
    expect(worldStateDiff(ws({ goalSummary: "old goal" }), ws())).toContain('  goal: no longer tracking "old goal"');
  });
  it("budget change renders the burn with its delta", () => {
    const out = worldStateDiff(ws({ goalBudgetUsed: 1000 }), ws({ goalBudgetUsed: 1500 }));
    expect(out).toContain("  goal budget: 1000 → 1500 tokens used (+500)");
  });
  it("a goal appearing carries its budget too (both lines)", () => {
    const out = worldStateDiff(ws(), ws({ goalSummary: "g", goalBudgetUsed: 42 }));
    expect(out).toContain('  goal: now tracking "g"');
    expect(out).toContain("  goal budget: — → 42 tokens used");
  });

  it("files: +N changed, -M reverted (set difference of the cumulative ledger)", () => {
    const prev = ws({ changedFiles: ["a.ts", "b.ts"] });
    const curr = ws({ changedFiles: ["b.ts", "c.ts", "d.ts"] });
    expect(worldStateDiff(prev, curr)).toContain("  files: +2 changed, -1 reverted");
  });
  it("tools: names per direction, capped listings", () => {
    const prev = ws({ activeTools: ["search"] });
    const curr = ws({ activeTools: ["edit", "run", "a", "b", "c", "d", "e", "f"] });
    const out = worldStateDiff(prev, curr);
    expect(out).toContain("+edit, +run, +a, +b, +c, +…(3 more)");
    expect(out).toContain("-search");
  });

  it("the diff body stays under the 500-char cap", () => {
    const prev = ws();
    const curr = ws({
      goalSummary: "x".repeat(400),
      goalBudgetUsed: 1,
      changedFiles: Array.from({ length: 100 }, (_, i) => `file-${i}.ts`),
      activeTools: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    expect(worldStateDiff(prev, curr).length).toBeLessThanOrEqual(WORLD_DIFF_CAP_CHARS);
  });
});

describe("worldDiffSection (125 项 2 composer)", () => {
  it("header names the previous window by index (identity.index - 1)", () => {
    const out = worldDiffSection("  files: +1 changed", { index: 3, sessionKey: "ab" });
    expect(out.startsWith("[world diff since window #2]\n")).toBe(true);
    expect(out).toContain("  files: +1 changed");
    expect(out.endsWith("\n")).toBe(true);
  });
  it("identity absent (or #1) → the generic previous-window header", () => {
    expect(worldDiffSection("  goal: x", undefined).startsWith("[world diff since the previous window]\n")).toBe(true);
    expect(worldDiffSection("  goal: x", { index: 1, sessionKey: "ab" }).startsWith("[world diff since the previous window]\n")).toBe(true);
  });
  it("empty/absent diff → \"\" (no section, no injection)", () => {
    expect(worldDiffSection(undefined, { index: 2, sessionKey: "ab" })).toBe("");
    expect(worldDiffSection("   ", { index: 2, sessionKey: "ab" })).toBe("");
  });
  it("the WHOLE section (header included) stays ≤500 chars", () => {
    const out = worldDiffSection(`  goal: "${"x".repeat(900)}" → "${"y".repeat(900)}"`, { index: 5, sessionKey: "ab" });
    expect(out.length).toBeLessThanOrEqual(WORLD_DIFF_CAP_CHARS);
  });
});

describe("parseWorldStateData (entry read-side fail-safe)", () => {
  it("round-trips a full snapshot", () => {
    const s = parseWorldStateData({ goalSummary: "g", goalBudgetUsed: 7, changedFiles: ["a"], activeTools: ["t"] });
    expect(s).toEqual({ goalSummary: "g", goalBudgetUsed: 7, changedFiles: ["a"], activeTools: ["t"] });
  });
  it("bad changedFiles/activeTools → the whole snapshot drops (never a half-typed lie)", () => {
    expect(parseWorldStateData({ changedFiles: "a.ts", activeTools: [] })).toBeUndefined();
    expect(parseWorldStateData({ changedFiles: [1], activeTools: [] })).toBeUndefined();
    expect(parseWorldStateData("junk")).toBeUndefined();
  });
  it("bad OPTIONAL goal fields drop individually; arrays may be empty", () => {
    expect(parseWorldStateData({ changedFiles: [], activeTools: [], goalBudgetUsed: -5 })).toEqual({ changedFiles: [], activeTools: [] });
    expect(parseWorldStateData({ changedFiles: [], activeTools: [], goalSummary: "" })).toEqual({ changedFiles: [], activeTools: [] });
  });
});

// ---------------------------------------------------------------------------
// §3 — 机械提取面
// ---------------------------------------------------------------------------

const callWith = (id: string, name: string, args: Record<string, unknown>): AgentMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});
const toolResult = (id: string, content: string): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name: "read_file",
  content,
});

describe("activeToolsOf", () => {
  it("distinct names, last-seen-first order, capped", () => {
    const msgs: AgentMessage[] = [
      callWith("c1", "search", {}),
      toolResult("c1", "r"),
      callWith("c2", "edit", {}),
      toolResult("c2", "r"),
      callWith("c3", "search", {}),
      callWith("c4", "run", {}),
    ];
    expect(activeToolsOf(msgs)).toEqual(["run", "search", "edit"]);
    const many = Array.from({ length: ACTIVE_TOOLS_CAP + 4 }, (_, i) => callWith(`c${i}`, `tool-${i}`, {}));
    expect(activeToolsOf(many)).toHaveLength(ACTIVE_TOOLS_CAP);
    expect(activeToolsOf(many)[0]).toBe(`tool-${ACTIVE_TOOLS_CAP + 3}`);
  });
});

describe("cumulativeModifiedFiles", () => {
  it("extracts write/edit ops from the span (modified only, recency order)", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      callWith("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "r"),
      callWith("c2", "write_file", { path: "b.ts" }),
      toolResult("c2", "r"),
      callWith("c3", "edit", { path: "b.ts" }),
      toolResult("c3", "r"),
      { role: "user", content: "tail" },
    ];
    expect(cumulativeModifiedFiles(msgs)).toEqual(["b.ts"]);
  });
  it("re-parses the running ledger off the last frozen summary (resume-stable)", () => {
    const priorSummary: AgentMessage = {
      role: "user",
      content: `${SUMMARY_MARKER} old\n<modified-files>\nold-a.ts\n</modified-files>`,
    };
    const msgs: AgentMessage[] = [
      priorSummary,
      callWith("c1", "edit", { path: "new-b.ts" }),
      toolResult("c1", "r"),
    ];
    expect(cumulativeModifiedFiles(msgs)).toEqual(["old-a.ts", "new-b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// §4 — tier-2 摘要头缝：身份行 + 差分区（缺省=字节不变）
// ---------------------------------------------------------------------------

/** Narrative-dense span → deterministic LLM path (over the #38 digest caps). */
const dense = (): AgentMessage[] => [
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
  { role: "user", content: "recent" },
];

describe("tier-2 composers — the 125 header seam", () => {
  it("tier2Compact: identity + diff ride the header (marker → identity → diff → task/body)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(dense(), model, {
      keepRecent: 1,
      windowIdentity: { index: 2, sessionKey: "ab12cd34" },
      worldDiff: "  files: +1 changed",
    });
    const head = out!.messages[0]!.content;
    const marker = head.indexOf(SUMMARY_MARKER);
    const identity = head.indexOf("[context window #2 | chain: #1→#2 | first: ab12cd34#1 | prev: ab12cd34#1]");
    const diff = head.indexOf("[world diff since window #1]");
    expect(identity).toBeGreaterThan(marker);
    expect(diff).toBeGreaterThan(identity);
    expect(head.indexOf("Task:")).toBeGreaterThan(diff);
  });

  it("tier2Compact: unarmed options → byte-identical status-quo summary", async () => {
    const modelA = createScriptedModel([{ role: "assistant", content: "S" }]);
    const modelB = createScriptedModel([{ role: "assistant", content: "S" }]);
    const armed = await tier2Compact(dense(), modelA, { keepRecent: 1 });
    const bare = await tier2Compact(dense(), modelB, { keepRecent: 1 });
    expect(armed!.messages[0]!.content).toBe(bare!.messages[0]!.content);
    expect(bare!.messages[0]!.content).not.toContain("[context window");
    expect(bare!.messages[0]!.content).not.toContain("[world diff");
  });

  it("staticTier2Compact carries the same header sections (the fallback is the same rotation)", () => {
    const out = staticTier2Compact(dense(), {
      keepRecent: 1,
      windowIdentity: { index: 4, sessionKey: "kk" },
      worldDiff: "  goal: \"a\" → \"b\"",
    });
    expect(out!.messages[0]!.content).toContain("[context window #4 | chain: #1→#2→#3→#4 | first: kk#1 | prev: kk#3]");
    expect(out!.messages[0]!.content).toContain("[world diff since window #3]");
  });

  it("dualTier2Compact carries the same header sections", async () => {
    const turn: AgentMessage[] = [
      { role: "user", content: "read all three" },
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a" } },
        { id: "c2", name: "read_file", arguments: { path: "b" } },
      ] },
      toolResult("c1", "x".repeat(15000)),
      toolResult("c2", "y".repeat(60000)),
    ];
    const model = createScriptedModel([
      { role: "assistant", content: "H" },
      { role: "assistant", content: "T" },
    ]);
    const out = await dualTier2Compact(turn, model, {
      keepRecent: 6,
      windowIdentity: { index: 1, sessionKey: "zz" },
    });
    expect(out!.messages[0]!.content).toContain("[context window #1 | chain: #1 | first: zz#1]");
    expect(out!.messages[0]!.content).not.toContain("[world diff");
  });
});

// ---------------------------------------------------------------------------
// §5 — loop：轮转记账（索引增长 / 事件字段 / run 内差分链 / 缺省行为不变）
// ---------------------------------------------------------------------------

const trivialTool = (name: string): Tool => ({
  name,
  description: "trivial",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: [] },
  execute: () => Promise.resolve({ content: "ok" }),
});

const drain = async (gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> => {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
};

/** A state whose occupancy crosses a tiny threshold on turn 1 → one tier-2
 *  compaction; the summarizer consumes model slot 2, the final slot 3. */
const pressurized = (): AgentState => ({
  systemPrompt: "s",
  messages: [
    { role: "user", content: "task 0 " + "x".repeat(2000) },
    { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
    { role: "user", content: "task 1 " + "x".repeat(2000) },
    { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
    { role: "user", content: "go" },
  ],
  tools: [trivialTool("echo")],
  status: "idle",
});

const scripted = (slots: string[]): ModelClient => {
  let n = 0;
  return {
    async generate() {
      const content = slots[Math.min(n, slots.length - 1)] ?? "done";
      n += 1;
      if (n === 1) return { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "echo", arguments: { command: "hi" } }] };
      return { role: "assistant", content };
    },
  };
};

describe("runAgentLoop — 125 项 1/项 2 rotation bookkeeping", () => {
  it("armed identity → the boundary's summary carries the identity line; the event carries windowIndex + worldState", async () => {
    const state = pressurized();
    const model = scripted(["SUMMARY", "done"]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false,
        windowIdentity: { sessionKey: "ab12cd34", baseWindowCount: 0 },
        worldState: {
          snapshot: () => ({ changedFiles: ["src/a.ts"], activeTools: ["edit"] }),
        },
      },
    }));
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    if (compacted === undefined) throw new Error("test premise failed: no tier-2 compaction");
    // 项 1: index = base(0) + in-run(0) + 1 = 1; first compaction → no prev.
    expect(compacted.windowIndex).toBe(1);
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).toContain("[context window #1 | chain: #1 | first: ab12cd34#1]");
    // 项 2: the snapshot rides the event; no previous → NO diff section.
    expect(compacted.worldState).toEqual({ changedFiles: ["src/a.ts"], activeTools: ["edit"] });
    expect(summary?.content).not.toContain("[world diff");
  });

  it("baseWindowCount continues a resumed chain (index = base + 1)", async () => {
    const state = pressurized();
    const model = scripted(["SUMMARY", "done"]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false,
        windowIdentity: { sessionKey: "ab12cd34", baseWindowCount: 2 },
        worldState: { snapshot: () => ws() },
      },
    }));
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    expect(compacted?.windowIndex).toBe(3);
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).toContain("[context window #3 | chain: #1→#2→#3 | first: ab12cd34#1 | prev: ab12cd34#2]");
  });

  it("a previous snapshot → the diff section rides the header", async () => {
    const state = pressurized();
    const model = scripted(["SUMMARY", "done"]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false,
        windowIdentity: { sessionKey: "ab12cd34", baseWindowCount: 1 },
        worldState: {
          previous: { goalSummary: "old goal", changedFiles: [], activeTools: [] },
          snapshot: () => ({ goalSummary: "new goal", goalBudgetUsed: 42, changedFiles: [], activeTools: [] }),
        },
      },
    }));
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    expect(compacted?.windowIndex).toBe(2);
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).toContain("[world diff since window #1]");
    expect(summary?.content).toContain('  goal: "old goal" → "new goal"');
    expect(summary?.content).toContain("  goal budget: — → 42 tokens used");
  });

  it("unarmed compaction options → no identity, no diff, no event fields (pre-125 behavior)", async () => {
    const state = pressurized();
    const model = scripted(["SUMMARY", "done"]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false },
    }));
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    if (compacted === undefined) throw new Error("test premise failed: no tier-2 compaction");
    expect(compacted.windowIndex).toBeUndefined();
    expect(compacted.worldState).toBeUndefined();
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).not.toContain("[context window");
    expect(summary?.content).not.toContain("[world diff");
  });

  it("two in-run compactions: indexes grow (#1 → #2) and the second diff chains against the FIRST snapshot", async () => {
    // The refill scenario: narrative-heavy openers keep the occupancy over the
    // 0.8×900 threshold at every turn top (arming the boundary compaction),
    // and the tiny tool results give microcompact nothing — so both
    // boundaries go TIER-2 (window rotations, not stub passes). Model slots:
    // 1 toolCall → 2 summarizer (boundary #1) → 3 toolCall → 4 summarizer
    // (boundary #2) → 5 final answer.
    const smallTool: Tool = {
      name: "echo",
      description: "trivial",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: [] },
      execute: () => Promise.resolve({ content: "ok" }),
    };
    let n = 0;
    const model: ModelClient = {
      async generate() {
        n += 1;
        if (n === 1 || n === 3) return { role: "assistant", content: "", toolCalls: [{ id: `e${n}`, name: "echo", arguments: { command: "hi" } }] };
        if (n === 2 || n === 4) return { role: "assistant", content: `S${n}` };
        return { role: "assistant", content: "done" };
      },
    };
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "task 0 " + "x".repeat(900) },
        { role: "assistant", content: "answer 0 " + "y".repeat(900) },
        { role: "user", content: "task 1 " + "x".repeat(900) },
        { role: "assistant", content: "answer 1 " + "y".repeat(900) },
        { role: "user", content: "task 2 " + "x".repeat(900) },
        { role: "assistant", content: "answer 2 " + "y".repeat(900) },
        { role: "user", content: "task 3 " + "x".repeat(900) },
        { role: "assistant", content: "answer 3 " + "y".repeat(900) },
        { role: "user", content: "go" },
      ],
      tools: [smallTool],
      status: "idle",
    };
    const snapshots: WorldState[] = [
      { changedFiles: ["a.ts"], activeTools: [] },
      { changedFiles: ["a.ts", "b.ts"], activeTools: ["edit"] },
    ];
    // The loop calls snapshot() once per landed boundary — call 0 feeds
    // boundary #1, call 1 feeds boundary #2.
    let snapshotCalls = 0;
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 8,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 900, keepRecent: 6, zeroLlmDigest: false,
        windowIdentity: { sessionKey: "cc", baseWindowCount: 0 },
        worldState: {
          snapshot: () => {
            const s = snapshots[Math.min(snapshotCalls, snapshots.length - 1)] ?? snapshots[snapshots.length - 1]!;
            snapshotCalls += 1;
            return s;
          },
        },
      },
    }));
    const boundaries = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
    expect(boundaries[0]!.windowIndex).toBe(1);
    expect(boundaries[1]!.windowIndex).toBe(2);
    // The second boundary's summary diffed against the FIRST snapshot (the
    // in-run chain): files went a.ts → a.ts+b.ts (+1 changed) and edit joined.
    const summaries = state.messages.filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    const second = summaries.at(-1)?.content ?? "";
    expect(second).toContain("[context window #2 | chain: #1→#2 | first: cc#1 | prev: cc#1]");
    expect(second).toContain("  files: +1 changed");
    expect(second).toContain("+edit");
    // and the FIRST boundary carried no diff (no baseline before it).
    expect(summaries[0]?.content).not.toContain("[world diff");
  });
});
