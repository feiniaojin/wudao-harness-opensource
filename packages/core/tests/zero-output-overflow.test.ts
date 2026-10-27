// 夜移 033 — 零输出 length-stop 分流（pi packages/ai/src/utils/overflow.ts
// Case 3 适配）：服务端把超窗输入截到窗满（Xiaomi MiMo 式），不报 413 而是回
// stop_reason:"length" + output=0 + 输入占满窗口——这不是输出被切，是上下文
// 溢出的伪装。013 的 nudge 会往已满的窗口再追加一条注记：确定性同败、烧光
// nudge 预算后落错误的 output_limit 终态。分流：判定命中 → 走 M58 reactive
// 压缩（trigger "reactive"）而非 nudge；一次性旗防死亡螺旋（压缩后仍零输出
// → 落定 output_limit，不再二次压缩）。
import { describe, it, expect } from "vitest";
import { runAgentLoop, isZeroOutputOverflow } from "../src/index.js";
import { OUTPUT_LIMIT_NUDGE } from "../src/loop.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage } from "../src/index.js";
import { SUMMARY_MARKER } from "../src/compaction.js";

type Step = { readonly content: string; readonly stopReason?: "length"; readonly usage?: ModelUsage };

/** Scripted model: fires usage (when scripted) then answers; captures inputs. */
function scriptedModel(steps: readonly Step[]): ModelClient & { calls: number; inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  return {
    get calls() { return calls; },
    get inputs() { return inputs; },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      if (step.usage !== undefined) input.onUsage?.(step.usage);
      return { role: "assistant", content: step.content, ...(step.stopReason !== undefined ? { stopReason: step.stopReason } : {}) };
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, unknown>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
}

const state = (): AgentState => ({
  systemPrompt: "s",
  messages: [...MESSAGES],
  tools: [],
  status: "idle",
});

const MESSAGES: AgentMessage[] = [
  { role: "user", content: "task one " + "x".repeat(400) },
  { role: "assistant", content: "answer one " + "y".repeat(400) },
  { role: "user", content: "go" },
];

// The disguise: window 9000, prompt 8950 ≥ 0.99×9000=8910, output 0.
const FULL_USAGE: ModelUsage = { promptTokens: 8_950, cacheHitTokens: 0, cacheMissTokens: 8_950, completionTokens: 0 };
const COMPACT: { contextWindowTokens: number; keepRecent: number } = { contextWindowTokens: 9_000, keepRecent: 1 };

describe("夜移 033 — zero-output length-stop diverts to the reactive compaction", () => {
  it("a zero-output length-stop with a full window compacts (reactive) instead of nudging, and the run completes", async () => {
    const model = scriptedModel([
      { content: "", stopReason: "length", usage: FULL_USAGE }, // the disguised overflow
      { content: "SUMMARY" },                                   // the tier-2 summary call
      { content: "final answer" },                              // the post-compact retry
    ]);
    const st = state();
    const events = await drain(runAgentLoop(st, model, { maxTurns: 5, compaction: { ...COMPACT, zeroLlmDigest: false } })); // #38: consume the scripted SUMMARY

    // The reactive compaction fired (the M58 vocabulary).
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type === "compacted") {
      expect(compacted.trigger).toBe("reactive");
      expect(compacted.reason).toBe("overflow");
    }
    // The detour is reported as its own move — NOT a nudge.
    const moves = events.filter((e) => e.type === "output_limit_recovery");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "overflow-detour" });
    // The nudge note never entered history (stuffing a full window is the bug).
    expect(st.messages.some((m) => m.role === "user" && m.content === OUTPUT_LIMIT_NUDGE)).toBe(false);
    // The rewritten prefix is in place and the run completed on the retry.
    expect(st.messages.some((m) => typeof m.content === "string" && m.content.includes(SUMMARY_MARKER))).toBe(true);
    const terminal = events.filter((e) => e.type === "turn_finished");
    expect(terminal.length).toBeGreaterThanOrEqual(1);
    expect(model.calls).toBe(3); // overflow → summary → retry, no nudge call
  });

  it("a zero-output length-stop with room left in the window takes the NORMAL nudge path", async () => {
    const usage: ModelUsage = { ...FULL_USAGE, promptTokens: 5_000, cacheMissTokens: 5_000 };
    const model = scriptedModel([
      { content: "", stopReason: "length", usage },
      { content: "completed after nudge" },
    ]);
    const { events } = { events: await drain(runAgentLoop(state(), model, { maxTurns: 5, compaction: COMPACT })) };
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toBe(true);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });

  it("an absent completionTokens count fails open to the nudge path (no number, no diagnosis)", async () => {
    const usage: ModelUsage = { promptTokens: 8_950, cacheHitTokens: 0, cacheMissTokens: 8_950 };
    const model = scriptedModel([
      { content: "", stopReason: "length", usage },
      { content: "done" },
    ]);
    const events = await drain(runAgentLoop(state(), model, { maxTurns: 5, compaction: COMPACT }));
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toBe(true);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });

  it("no compaction options (window unknown) keeps the nudge path unchanged", async () => {
    const model = scriptedModel([
      { content: "", stopReason: "length", usage: FULL_USAGE },
      { content: "done" },
    ]);
    const events = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toBe(true);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });

  it("a SECOND zero-output length-stop after the detour settles as output_limit — one compact, no spiral", async () => {
    const again: Step = { content: "", stopReason: "length", usage: FULL_USAGE };
    const model = scriptedModel([
      { content: "", stopReason: "length", usage: FULL_USAGE }, // disguised overflow
      { content: "SUMMARY" },                                   // the compact
      again,                                                    // post-compact: STILL zero-output
      { content: "never reached" },
    ]);
    const gen = runAgentLoop(state(), model, { maxTurns: 5, compaction: COMPACT });
    const events = await drain(gen);
    // Exactly ONE compaction; the second disguise settles through the typed terminal.
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    const moves = events.filter((e) => e.type === "output_limit_recovery");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "overflow-detour" });
  });
});

describe("夜移 033 — isZeroOutputOverflow (the pure predicate, pi Case 3 arithmetic)", () => {
  it("the 0.99 window-fill threshold, strict output===0, and the fail-open edges", () => {
    expect(isZeroOutputOverflow(0, 8_950, 9_000)).toBe(true);   // at/above 99%
    expect(isZeroOutputOverflow(0, 8_910, 9_000)).toBe(true);   // exactly floor(0.99*9000)
    expect(isZeroOutputOverflow(0, 8_909, 9_000)).toBe(false);  // one token short
    expect(isZeroOutputOverflow(1, 8_950, 9_000)).toBe(false);  // real output → 013's case
    expect(isZeroOutputOverflow(undefined, 8_950, 9_000)).toBe(false); // no count → fail open
    expect(isZeroOutputOverflow(0, 8_950, 0)).toBe(false);      // window unknown → fail open
  });
});
