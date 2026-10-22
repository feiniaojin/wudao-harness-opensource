// ω99-30 (C) — loopExempt: a tool whose repeated identical calls are polling
// semantics (the mission state machine's designed cadence:
// mission_next → work → mission_complete → mission_next …) opts out of the
// identical_calls lane's counting. The exemption is a Tool annotation
// (self-description, same family as isReadOnly), stamped onto the turn's
// safety calls by the loop. Fail-closed everywhere: annotation absent =
// counted exactly as today (byte-identical evidence); isError calls are
// NEVER exempt (a polling tool failing the same way is itself a stuck
// signal); failure_streak / edit_repeat keep their unfiltered window.
import { describe, it, expect } from "vitest";
import { detectLoop, type LoopSafetyTurn } from "../src/loop-safety.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

/** One tool-call turn; `exempt` stamps the annotation the loop would stamp. */
function callTurn(name: string, args: Record<string, unknown>, isError = false, exempt = false): LoopSafetyTurn {
  return { calls: [{ name, args, isError, ...(exempt ? { exempt: true } : {}) }] };
}

// The ω99-26 campaign shape (:2080 live round): t1..t5 walked one by one —
// every mission_next({}) is the SAME fingerprint, while the interleaved work
// differs per task (grep ×2 same shape here = the runner-up the dominance
// gate saw). In window W=6: next ×3 vs runner-up ×2 → frequency 3 ≥ 3 AND
// 3 ≥ 1.5×2 → identical_calls verdict. This is the exact shape the false
// positive fired on.
function campaignTurns(nextExempt: boolean): LoopSafetyTurn[] {
  return [
    callTurn("mission_next", {}, false, nextExempt),
    callTurn("grep", { pattern: "mission_next" }),
    callTurn("mission_next", {}, false, nextExempt),
    callTurn("grep", { pattern: "mission_next" }),
    callTurn("mission_next", {}, false, nextExempt),
  ];
}

describe("ω99-30 T1 — loopExempt × identical_calls (pure detectLoop)", () => {
  it("① fires WITHOUT the exemption (the bug, replayed) and stays silent WITH it", () => {
    // 修前 (no stamp honored): the designed cadence is misjudged as a loop.
    expect(detectLoop(campaignTurns(false))?.kind).toBe("identical_calls");
    // 修后 (loop stamps exempt:true on mission_next's non-error calls): silent.
    expect(detectLoop(campaignTurns(true))).toBeUndefined();
  });

  it("② an UNANNOTATED tool's identical ×3 still fires (fail-closed, tool face arbitrary)", () => {
    const turns = [
      callTurn("read_file", { path: "a.txt" }),
      callTurn("read_file", { path: "a.txt" }),
      callTurn("read_file", { path: "a.txt" }),
    ];
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });

  it("③ an exempt tool FAILING ×3 same-shape still counts (isError exempts nothing)", () => {
    const turns = [
      callTurn("mission_next", {}, true, true),
      callTurn("mission_next", {}, true, true),
      callTurn("mission_next", {}, true, true),
    ];
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });

  it("④ failure_streak and edit_repeat still judge exempt tools (other lanes unfiltered)", () => {
    // failure_streak: ≥4 consecutive same-tool failures with VARYING args —
    // stamped exempt, still verdicts.
    const failing = Array.from({ length: 4 }, (_, i) => callTurn("mission_next", { probe: i }, true, true));
    expect(detectLoop(failing)?.kind).toBe("failure_streak");
    // edit_repeat: ≥3 same-file same-old_string failed edits — stamped
    // exempt, still verdicts.
    const edits = Array.from({ length: 3 }, () =>
      callTurn("edit", { path: "a.ts", old_string: "x", new_string: "y" }, true, true),
    );
    expect(detectLoop(edits)?.kind).toBe("edit_repeat");
  });

  it("⑤ annotation absent = today's verdict, byte for byte", () => {
    // No exempt field anywhere (not even false) — the exact turns shape the
    // loop produced before ω99-30 — pins the evidence string unchanged.
    const v = detectLoop(campaignTurns(false));
    expect(v?.evidence).toBe("identical mission_next ×3 in last 6 turns (args hidden)"); // T005 F7：evidence 不再插值参数（注入卫生，与 failure_streak 同姿态）
  });
});

// ---------------------------------------------------------------------------
// Wiring: the loop must actually STAMP the annotation (name lookup against
// the execution tools table) — otherwise the pure detector honors a flag
// nobody sets.
// ---------------------------------------------------------------------------

const SYSTEM = "You are a deterministic test agent.";

function stateWith(tools: readonly Tool[]): AgentState {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: "run the campaign" }], tools: [...tools], status: "idle" };
}

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

/** The campaign's advance cadence as scripted model turns: next, complete,
 * next, complete, next — every mission_next({}) identical, completes differ
 * per task (different fingerprints). Each next claims a DIFFERENT task, so
 * the results vary (no result-repetition machinery involved). */
function campaignScript(): AssistantMessage[] {
  const next = (id: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name: "mission_next", arguments: {} }] });
  const complete = (id: string, taskId: string) => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id, name: "mission_complete", arguments: { taskId, result: `done ${taskId}` } }],
  });
  return [next("c1"), complete("c2", "t2"), next("c3"), complete("c4", "t3"), next("c5"), { role: "assistant" as const, content: "campaign complete" }];
}

function missionTools(nextExempt: boolean): Tool[] {
  let claimed = 0;
  const nextTool: Tool = {
    name: "mission_next",
    description: "claims the next ready task",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    ...(nextExempt ? { loopExempt: () => true } : {}),
    execute: async () => ({ content: `claimed t${(claimed += 1) + 1}` }),
  };
  const completeTool: Tool = {
    name: "mission_complete",
    description: "completes a task",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, result: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "completed" }),
  };
  return [nextTool, completeTool];
}

describe("ω99-30 T1 — loop wiring (runAgentLoop stamps the annotation)", () => {
  it("an loopExempt-annotated poll tool runs the campaign cadence with NO verdict", async () => {
    const model = recordingModel(campaignScript());
    const { events, terminal } = await drain(runAgentLoop(stateWith(missionTools(true)), model, { maxTurns: 10, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
    expect(events.some((e) => e.type === "meta_note")).toBe(false);
  });

  it("the same cadence WITHOUT the annotation still verdicts (fail-closed wiring)", async () => {
    const model = recordingModel(campaignScript());
    const { events, terminal } = await drain(runAgentLoop(stateWith(missionTools(false)), model, { maxTurns: 10, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    const detected = events.filter((e): e is Extract<LoopEvent, { type: "loop_detected" }> => e.type === "loop_detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]?.kind).toBe("identical_calls");
    expect(detected[0]?.evidence).toContain("mission_next");
  });
});
