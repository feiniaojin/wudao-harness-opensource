// ω-long-2 — 用户令「希望可以无限跑下去，可以无限重置而不会退出」。
// 弧 C 的切片续跑此前从未被 CLI 装备：撞 maxTurns 就是 run 的死刑。本文件
// 钉住三条契约：
//   1. 装备 continuation 后，撞上限 ≠ 死——run 继续跑，max_turns 不出现；
//   2. maxSlices: Infinity 时真的无上限（跑过一个完整片仍继续）；
//   3. 收工信号仍然有效——模型 end_turn 时立即正常结束，切片不会把它拖住。
// 第 3 条是这次改动的安全边界：无限必须是有出口的无限。
import { describe, expect, it } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import type {
  AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool,
} from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
}

/** A model that keeps working (tool calls, varying args → varying results,
 *  i.e. real progress) and answers after `until` calls. `until: Infinity`
 *  means it never stops — that is what the finite-slice test needs, and
 *  exactly what an unbounded run would do if nothing else stopped it. */
function countingModel(until = Number.POSITIVE_INFINITY): ModelClient & { calls: number } {
  const m = {
    calls: 0,
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      const n = m.calls;
      m.calls += 1;
      if (m.calls > until) return { role: "assistant", content: "done" };
      return { role: "assistant", content: "", toolCalls: [{ id: `c${n}`, name: "noop", arguments: { n } }] };
    },
  };
  return m;
}

const noopTool = (): Tool =>
  buildTool({
    name: "noop",
    description: "no-op",
    parameters: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
    // The result VARIES with the argument: a constant "ok" would make every
    // turn look like stasis and the unlimited brake (rightly) stops the run.
    execute: async (args) => ({ content: `tick ${String((args as { n?: number }).n ?? 0)}` }),
  });

const stateOf = (): AgentState => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "go" }],
  tools: [noopTool()],
  status: "idle",
});

describe("unlimited slicing (撞上限不再等于退出)", () => {
  it("without continuation the fuse still kills the run at maxTurns (baseline)", async () => {
    const model = countingModel();
    const term = await drain(runAgentLoop(stateOf(), model, { maxTurns: 3 }));
    expect(term.reason).toBe("max_turns");
    expect(model.calls).toBe(3);
  });

  it("with unlimited continuation the run does NOT die at maxTurns", async () => {
    // The model works well past several slice boundaries before answering.
    const model = countingModel(13);
    const term = await drain(
      runAgentLoop(stateOf(), model, {
        maxTurns: 3,
        continuation: { maxSlices: Number.POSITIVE_INFINITY },
      }),
    );
    // It crossed FOUR slice boundaries (13 > 3 × 4) and still finished on
    // its own terms — never on "max_turns".
    expect(model.calls).toBe(14); // 13 tool turns + the final answer
    expect(term.reason).toBe("completed");
  });

  it("a finite maxSlices still bounds the resets (the escape hatch works)", async () => {
    const model = countingModel(Number.POSITIVE_INFINITY);
    const term = await drain(
      runAgentLoop(stateOf(), model, { maxTurns: 3, continuation: { maxSlices: 2 } }),
    );
    // 3 turns × (1 original + 2 slices) = 9 model calls, then the fuse wins.
    expect(term.reason).toBe("max_turns");
    expect(model.calls).toBe(9);
  });

  it("a STASIS slice finalizes instead of resetting — unlimited is not a blank cheque", async () => {
    // The model keeps calling tools but every result is byte-identical: no
    // progress evidence. Without the brake this run would reset forever
    // (each slice looks like "still working"), which is exactly the runaway
    // an unlimited fuse would otherwise permit.
    let calls = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        const n = calls;
        calls += 1;
        return { role: "assistant", content: "", toolCalls: [{ id: `c${n}`, name: "same", arguments: { n } }] };
      },
    };
    const stasisTool = buildTool({
      name: "same",
      description: "constant result",
      parameters: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
      execute: async () => ({ content: "ok" }),
    });
    const state: AgentState = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [stasisTool],
      status: "idle",
    };
    const term = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        continuation: { maxSlices: Number.POSITIVE_INFINITY },
      }),
    );
    // It stops at the FIRST boundary instead of resetting forever. Which
    // terminal wins (max_turns vs the loop-safety abort) is not the point —
    // the point is that it TERMINATES.
    expect(["max_turns", "aborted"]).toContain(term.reason);
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("a SHORT budget window (maxTurns=1) still detects stasis across boundaries", async () => {
    // The regression this pins: progress was tracked per slice, but a
    // maxTurns=1 slice has exactly one turn — the fingerprint reset at every
    // boundary, so nothing was ever compared and every run looked like
    // stasis (the brake then killed runs that were making progress). The
    // fingerprint must carry across boundaries.
    const model = countingModel(5);
    const term = await drain(
      runAgentLoop(stateOf(), model, {
        maxTurns: 1,
        continuation: { maxSlices: Number.POSITIVE_INFINITY },
      }),
    );
    // A progressing model crosses every boundary and finishes on its own.
    expect(model.calls).toBe(6);
    expect(term.reason).toBe("completed");
  });

  it("the model's own end_turn still ends the run — unlimited is not a trap", async () => {
    let calls = 0;
    const model: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        calls += 1;
        if (calls >= 4) return { role: "assistant", content: "done" };
        return { role: "assistant", content: "", toolCalls: [{ id: `c${calls}`, name: "noop", arguments: { n: calls } }] };
      },
    };
    const term = await drain(
      runAgentLoop(stateOf(), model, {
        maxTurns: 3,
        continuation: { maxSlices: Number.POSITIVE_INFINITY },
      }),
    );
    expect(term.reason).toBe("completed");
    expect(calls).toBe(4);
  });
});
