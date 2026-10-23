// 121 #5 — the no-progress guard (advisory-only): 跨轮无变化检测。连续 N 轮
// （缺省 5）的工具结果集 fingerprint 全部相同（不同调用返回相同结果=「换着
// 花样问同一件事」）→ 注入一条 MetaNote。只建议不阻断（沿 GoalState 语义，
// 与 verdict 车道的升级/终止机制完全独立）。钉：N-1 轮相同不触发 / 第 N 轮
// 触发并注入 / 结果变化归零 / 无工具轮不计数（reducer 级）+ 车道正交性
// （同调用复现/报错轮/全豁免轮）+ fingerprint 契约 + loop 集成（建议不阻断、
// 瞬态投影、transcript 零改写）。
import { describe, it, expect } from "vitest";
import {
  advanceNoProgress,
  noProgressNote,
  resultFingerprint,
  NO_PROGRESS_TURNS,
  NO_PROGRESS_CLEAN,
  type NoProgressTurn,
  type NoProgressState,
} from "../src/loop-safety.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** One tool turn: N distinct calls, their results (call order). */
const toolTurn = (
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown>; exempt?: boolean }>,
  resultContent: string,
  isError = false,
) => ({ calls, results: calls.map(() => ({ content: resultContent, isError })) });

/** Drive `turns` through the reducer, returning the fired notes. */
function run(turns: readonly ReturnType<typeof toolTurn>[]): string[] {
  let state: NoProgressState = NO_PROGRESS_CLEAN;
  const notes: string[] = [];
  for (const t of turns) {
    // The loop feeds answer turns as {calls: [], results: []} — same shape.
    const step = advanceNoProgress(state, t.calls.length > 0 ? t : { calls: [], results: [] });
    state = step.state;
    if (step.note !== undefined) notes.push(step.note);
  }
  return notes;
}

/** k distinct single-call turns (varying args = 不同调用), all same results. */
const varyTurns = (n: number, result = "SAME"): ReturnType<typeof toolTurn>[] =>
  Array.from({ length: n }, (_, i) => toolTurn([{ name: "probe", args: { q: `pattern-${i}` } }], result));

// ---------------------------------------------------------------------------
// the reducer — the four task pins + orthogonality
// ---------------------------------------------------------------------------

describe("advanceNoProgress — the streak discipline", () => {
  it(`N-1 (${NO_PROGRESS_TURNS - 1}) identical turns do not fire; the Nth fires with the pinned note`, () => {
    expect(run(varyTurns(NO_PROGRESS_TURNS - 1))).toEqual([]);
    const notes = run(varyTurns(NO_PROGRESS_TURNS));
    expect(notes).toEqual([
      `[system note: 你最近 ${NO_PROGRESS_TURNS} 轮的工具调用产生了完全相同的结果——你可能陷入了无进展的循环。请重新审视任务目标、换一个方法，或向用户说明你遇到的困难。]`,
    ]);
    expect(notes[0]).toBe(noProgressNote());
  });

  it("结果变化归零: a changed fingerprint resets — the old streak never carries over", () => {
    // 4×SAME (streak 4) + 1×OTHER (re-arm, streak 1) + 4×OTHER (streak 2..4)
    // — never reaches 5. Without the reset, the first batch's 4 would carry
    // into the second and fire.
    expect(run([...varyTurns(4, "SAME"), ...varyTurns(5 - 1, "OTHER")])).toEqual([]);
    // Control: 5 consecutive identical DOES fire in the same shape.
    expect(run(varyTurns(5, "OTHER"))).toHaveLength(1);
  });

  it("无工具轮不计数: an answer turn breaks the consecutive-stasis chain", () => {
    const answer = { calls: [], results: [] } as unknown as ReturnType<typeof toolTurn>;
    // 4×SAME + answer + 4×SAME — no fire (the reset is what keeps the second
    // batch below the limit; no reset would fire at its first turn).
    expect(run([...varyTurns(4, "SAME"), answer, ...varyTurns(4, "SAME")])).toEqual([]);
    // An answer turn alone never arms anything.
    expect(run([answer, answer, answer, answer, answer])).toEqual([]);
  });

  it("re-arms after firing: a further N fresh identical turns re-note (advisory, no escalation)", () => {
    expect(run([...varyTurns(5, "SAME"), ...varyTurns(5, "SAME")])).toHaveLength(2);
    expect(run([...varyTurns(5, "SAME"), ...varyTurns(4, "SAME")])).toHaveLength(1);
  });

  it("orthogonal to identical_calls: byte-identical call repeats never feed this lane", () => {
    const same = toolTurn([{ name: "probe", args: { q: "fixed" } }], "SAME");
    expect(run([same, same, same, same, same, same, same])).toEqual([]);
  });

  it("orthogonal to the failure lanes: any error result resets the streak", () => {
    const err = toolTurn([{ name: "probe", args: { q: "boom" } }], "Error: denied", true);
    expect(run([...varyTurns(4, "SAME"), err, ...varyTurns(4, "SAME")])).toEqual([]);
  });

  it("orthogonal to ω99-30 (C): an all-exempt (designed polling) turn neither advances nor breaks the chain", () => {
    const wait = toolTurn([{ name: "task_wait", args: { id: "b1" }, exempt: true }], "still running");
    // Exempt turns alone: never fires (designed waiting is not a spin).
    expect(run([wait, wait, wait, wait, wait, wait])).toEqual([]);
    // A wait between stasis turns stitches the chain (same info, no change).
    expect(run([...varyTurns(4, "SAME"), wait, ...varyTurns(1, "SAME")])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the fingerprint contract (121 §5: 长度+首尾片段的简单 hash)
// ---------------------------------------------------------------------------

describe("resultFingerprint", () => {
  it("identical contents fingerprint identically; length/edge changes differ", () => {
    const fp = (s: string): string => resultFingerprint([{ content: s }]);
    expect(fp("abc")).toBe(fp("abc"));
    expect(fp("abc")).not.toBe(fp("abd"));
    expect(fp("abc")).not.toBe(fp("abcd"));
    expect(fp("x".repeat(200) + "A")).not.toBe(fp("x".repeat(200) + "B"));
  });

  it("a middle-only change collides (documented trade-off: 头尾+长度 proxy)", () => {
    const fp = (s: string): string => resultFingerprint([{ content: s }]);
    const a = `${"h".repeat(64)}MIDDLE-ONE${"t".repeat(64)}`;
    const b = `${"h".repeat(64)}MIDDLE-TWO${"t".repeat(64)}`;
    expect(a).not.toBe(b);
    expect(fp(a)).toBe(fp(b)); // same length, same head, same tail — by design
  });

  it("order-sensitive over the turn's result set (call order = deterministic identity)", () => {
    const ab = resultFingerprint([{ content: "alpha" }, { content: "beta" }]);
    const ba = resultFingerprint([{ content: "beta" }, { content: "alpha" }]);
    expect(ab).not.toBe(ba);
  });

  it("list boundaries stay structural: [\"a b\",\"c\"] ≠ [\"a\",\"b c\"]", () => {
    expect(resultFingerprint([{ content: "a b" }, { content: "c" }]))
      .not.toBe(resultFingerprint([{ content: "a" }, { content: "b c" }]));
  });
});

// ---------------------------------------------------------------------------
// loop integration — advisory-only, transient projection, transcript-clean
// ---------------------------------------------------------------------------

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** A probe tool: DIFFERENT args, and the result flips on `mode` — the
 * different-calls-same-results shape (identical_calls cannot fire). */
const probeTool: Tool = {
  name: "probe",
  description: "constant-result probe",
  parameters: { type: "object", properties: { q: { type: "string" }, mode: { type: "string" } }, required: ["q"] },
  execute: async (args) => ({ content: (args as { mode?: string }).mode === "b" ? "OTHER RESULT" : "SAME RESULT" }),
};

const stateOf = (tools: readonly Tool[]): AgentState => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "investigate" }],
  tools: [...tools],
  status: "idle",
});

const probeTurn = (i: number, mode = "a"): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: `c${i}`, name: "probe", arguments: { q: `pattern-${i}`, mode } }],
});

describe("runAgentLoop — no-progress integration", () => {
  it("第 N 轮触发并注入: one advisory MetaNote on the next model call; the run is NEVER aborted", async () => {
    const model = recordingModel([
      probeTurn(1), probeTurn(2), probeTurn(3), probeTurn(4), probeTurn(5),
      { role: "assistant", content: "reconsidered and done" },
    ]);
    const state = stateOf([probeTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false, verify: false } }));

    // Advisory-only: completed, zero verdicts (只建议不阻断).
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
    // Exactly one no-progress note, on the tool_result channel.
    const notes = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain("无进展的循环");
    expect(notes[0]?.channel).toBe("tool_result");
    // It rode the 6th model call's LAST tool_result tail (before the model
    // ever answers the 6th time) — model-visible exactly once.
    const call6 = model.inputs[5]?.messages ?? [];
    const lastTool = [...call6].reverse().find((m) => m.role === "tool");
    expect(lastTool?.content).toContain("无进展的循环");
    // The persisted transcript keeps the ORIGINAL result bytes (零改写).
    expect(state.messages.some((m) => m.role === "tool" && m.content.includes("无进展的循环"))).toBe(false);
  });

  it(`N-1 (${NO_PROGRESS_TURNS - 1}) identical-result turns do not trigger`, async () => {
    const model = recordingModel([
      probeTurn(1), probeTurn(2), probeTurn(3), probeTurn(4),
      { role: "assistant", content: "done" },
    ]);
    const state = stateOf([probeTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 8, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
    expect(events.some((e) => e.type === "meta_note" && String((e as { text?: string }).text).includes("无进展"))).toBe(false);
  });

  it("结果变化归零: a changed result mid-sequence resets the streak (integration)", async () => {
    // 4×SAME + 1×OTHER + 4×OTHER — the second batch reaches only 4.
    const model = recordingModel([
      probeTurn(1), probeTurn(2), probeTurn(3), probeTurn(4),
      probeTurn(5, "b"), probeTurn(6, "b"), probeTurn(7, "b"), probeTurn(8, "b"),
      { role: "assistant", content: "done" },
    ]);
    const state = stateOf([probeTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 12, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "meta_note" && String((e as { text?: string }).text).includes("无进展"))).toBe(false);
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
  });

  it("clean varied runs stay note-free (regression guard for the family)", async () => {
    const varied: Tool = {
      name: "probe",
      description: "echo probe",
      parameters: probeTool.parameters,
      execute: async (args) => ({ content: `result: ${String((args as { q?: string }).q ?? "")}` }),
    };
    const model = recordingModel([
      probeTurn(1), probeTurn(2), { role: "assistant", content: "done" },
    ]);
    const state = stateOf([varied]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 6, gates: { todo: false, verify: false } }));
    expect(events.some((e) => e.type === "meta_note")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 129-3（DeepCode 1bb0c93a 引进）— 对级无进展台账（A,B,A,B 交错盲区）
// ---------------------------------------------------------------------------
describe("129-3 — the pair ledger (alternating stalls)", () => {
  const turnAB = (name: string, arg: string, out: string): { calls: NoProgressTurn["calls"]; results: NoProgressTurn["results"] } => ({
    calls: [{ name, args: { q: arg } }],
    results: [{ content: out, isError: false }],
  });

  it("A,B,A,B 交错（streak 永远 1 的盲区）→ 第 3 次同对出现时发对级 note", () => {
    let state: NoProgressState = NO_PROGRESS_CLEAN;
    const notes: string[] = [];
    for (const t of [turnAB("grep", "a", "RA"), turnAB("grep", "b", "RB"), turnAB("grep", "a", "RA"), turnAB("grep", "b", "RB"), turnAB("grep", "a", "RA")]) {
      const step = advanceNoProgress(state, t);
      state = step.state;
      if (step.note !== undefined) notes.push(step.note);
    }
    expect(notes.length).toBe(1); // 第 5 轮：A 对第 3 次出现 → 恰一条（B 才 2 次）
    expect(notes[0]).toContain("并非每轮连续");
  });

  it("结果变化了的交错不误报（A,B,A' 不累计同对）", () => {
    let state: NoProgressState = NO_PROGRESS_CLEAN;
    const notes: string[] = [];
    for (const t of [turnAB("grep", "a", "RA"), turnAB("grep", "b", "RB"), turnAB("grep", "a", "RA2"), turnAB("grep", "b", "RB2"), turnAB("grep", "a", "RA3")]) {
      const step = advanceNoProgress(state, t);
      state = step.state;
      if (step.note !== undefined) notes.push(step.note);
    }
    expect(notes).toEqual([]);
  });

  it("对级 note 后重臂：同对再三次才再发（不连环轰炸）", () => {
    let state: NoProgressState = NO_PROGRESS_CLEAN;
    const notes: string[] = [];
    for (const t of [turnAB("grep", "a", "RA"), turnAB("grep", "b", "RB"), turnAB("grep", "a", "RA")]) {
      const step = advanceNoProgress(state, t);
      state = step.state;
      if (step.note !== undefined) notes.push(step.note);
    }
    expect(notes.length).toBe(0); // A 对才第 2 次（A,B,A：A×2）——未到 3
    // 继续 B,A → B 第 2、A 第 3 → A 发
    for (const t of [turnAB("grep", "b", "RB"), turnAB("grep", "a", "RA")]) {
      const step = advanceNoProgress(state, t);
      state = step.state;
      if (step.note !== undefined) notes.push(step.note);
    }
    expect(notes.length).toBe(1);
  });

  it("台账有界：distinct 对超帽后新对不进（既有对照数）", () => {
    let state: NoProgressState = NO_PROGRESS_CLEAN;
    // 灌满 64 个不同对
    for (let i = 0; i < 64; i += 1) {
      state = advanceNoProgress(state, turnAB("grep", `q${String(i)}`, `R${String(i)}`)).state;
    }
    expect(Object.keys(state.pairCounts).length).toBeLessThanOrEqual(64);
    // 第 65 个新对不被计入（计数仍为 0 → 三次也不发）
    let notes = 0;
    for (let r = 0; r < 3; r += 1) {
      const step = advanceNoProgress(state, turnAB("grep", "fresh-pair", "RX"));
      state = step.state;
      if (step.note !== undefined) notes += 1;
    }
    expect(notes).toBe(0);
  });
});
