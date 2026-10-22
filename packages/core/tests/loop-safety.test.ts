// M48 §1 — loop / failure / edit-streak detectors (pure) + loop integration:
// verdict → ONE MetaNote injection (no turn consumed); a SECOND verdict in the
// same run → forced Terminal{reason:"aborted"} carrying the loop evidence;
// loop_detected events for UI/audit on every verdict.
import { describe, it, expect } from "vitest";
import {
  detectLoop, callFingerprint,
  LOOP_WINDOW, LOOP_MIN_FREQUENCY, FAILURE_STREAK_LIMIT, EDIT_STREAK_LIMIT, NO_ANSWER_RUNS,
  type LoopSafetyTurn, type LoopVerdict,
} from "../src/loop-safety.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** One tool-call turn. */
function callTurn(name: string, args: Record<string, unknown>, isError = false): LoopSafetyTurn {
  return { calls: [{ name, args, isError }] };
}

/** One no-tool answer turn. */
function answerTurn(text: string): LoopSafetyTurn {
  return { calls: [], answer: text };
}

const verdictKind = (v: LoopVerdict | undefined): string | undefined => (v === undefined ? undefined : v.kind);

// ---------------------------------------------------------------------------
// identical_calls: sliding W=6 window, tool+args fingerprint frequency,
// count ≥ W/2 AND dominance 1.5× over the second-most-frequent fingerprint.
// ---------------------------------------------------------------------------

describe("detectLoop — identical_calls", () => {
  it("fires on the same tool+args repeated to window majority", () => {
    const turns = Array.from({ length: 4 }, () => callTurn("read_file", { path: "a.txt" }));
    const v = detectLoop(turns);
    expect(v?.kind).toBe("identical_calls");
    expect(v?.evidence).toContain("read_file");
    expect(v?.evidence).toContain("×4");
  });

  it("does not fire when every call differs", () => {
    const turns = Array.from({ length: LOOP_WINDOW }, (_, i) => callTurn("read_file", { path: `f${i}.txt` }));
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("does not fire below the W/2 frequency floor", () => {
    const turns = [callTurn("t", { a: 1 }), callTurn("t", { a: 1 }), callTurn("t", { b: 2 }), callTurn("t", { c: 3 }), callTurn("t", { d: 4 })];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("dominance gate: an even alternation is not a loop", () => {
    // A B A B A B — top frequency 3 (= W/2) but NOT 1.5× the runner-up (3).
    const turns = Array.from({ length: 6 }, (_, i) => callTurn("t", i % 2 === 0 ? { a: 1 } : { b: 2 }));
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("dominance gate: 4-vs-2 inside the window fires", () => {
    const pattern = [1, 1, 2, 1, 1, 2];
    const turns = pattern.map((p) => callTurn("t", { p }));
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });

  it("the window slides: old repeats outside W=6 no longer count", () => {
    // 5 identical old turns, then 5 distinct recent ones.
    const turns = [
      ...Array.from({ length: 5 }, () => callTurn("read_file", { path: "old.txt" })),
      ...Array.from({ length: 5 }, (_, i) => callTurn("read_file", { path: `new${i}.txt` })),
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("argument order does not change the fingerprint", () => {
    expect(callFingerprint({ name: "t", args: { a: 1, b: 2 } })).toBe(callFingerprint({ name: "t", args: { b: 2, a: 1 } }));
    expect(callFingerprint({ name: "t", args: { a: 1 } })).not.toBe(callFingerprint({ name: "t", args: { a: 2 } }));
    expect(callFingerprint({ name: "t", args: { a: 1 } })).not.toBe(callFingerprint({ name: "u", args: { a: 1 } }));
  });

  it("argument-order-insensitive fingerprints still count as identical calls", () => {
    const turns = [
      callTurn("edit", { path: "a", old_string: "x", new_string: "y", reason: "r" }),
      callTurn("edit", { reason: "r", new_string: "y", old_string: "x", path: "a" }),
      callTurn("edit", { path: "a", reason: "r", old_string: "x", new_string: "y" }),
    ];
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });

  it("parallel batch of 3 identical calls in ONE turn produces NO verdict (per-turn counting)", () => {
    // One turn with 3 identical calls should count as 1, not 3.
    // Spec §1: "a turn contributes at most 1 to a fingerprint's count"
    const turns = [
      { calls: [{ name: "read", args: { path: "a.txt" }, isError: false }, { name: "read", args: { path: "a.txt" }, isError: false }, { name: "read", args: { path: "a.txt" }, isError: false }] },
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("three consecutive TURNS each with one identical call DOES produce verdict", () => {
    const turns = [
      callTurn("read", { path: "a.txt" }),
      callTurn("read", { path: "a.txt" }),
      callTurn("read", { path: "a.txt" }),
    ];
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });
});

// ---------------------------------------------------------------------------
// failure_streak: ≥4 consecutive failures of the SAME tool with varying args.
// ---------------------------------------------------------------------------

describe("detectLoop — failure_streak", () => {
  it("fires on 4 consecutive same-tool failures with varying args", () => {
    const turns = Array.from({ length: FAILURE_STREAK_LIMIT }, (_, i) => callTurn("shell", { cmd: `cmd-${i}` }, true));
    const v = detectLoop(turns);
    expect(v?.kind).toBe("failure_streak");
    expect(v?.evidence).toContain("shell");
    expect(v?.evidence).toContain(`×${FAILURE_STREAK_LIMIT}`);
  });

  it("does not fire at 3 failures", () => {
    const turns = Array.from({ length: 3 }, (_, i) => callTurn("shell", { cmd: `cmd-${i}` }, true));
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("a success in between resets the streak", () => {
    const turns = [
      callTurn("shell", { cmd: "a" }, true),
      callTurn("shell", { cmd: "b" }, true),
      callTurn("shell", { cmd: "c" }, true),
      callTurn("shell", { cmd: "ok" }, false),
      callTurn("shell", { cmd: "d" }, true),
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("all-identical failing calls belong to identical_calls, not failure_streak", () => {
    const turns = Array.from({ length: 4 }, () => callTurn("probe", { a: 1 }, true));
    expect(detectLoop(turns)?.kind).toBe("identical_calls");
  });

  it("a different tool's failure does not extend the streak", () => {
    const turns = [
      callTurn("a", { n: 1 }, true),
      callTurn("a", { n: 2 }, true),
      callTurn("a", { n: 3 }, true),
      callTurn("b", { n: 4 }, true),
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// edit_repeat: ≥3 consecutive failures with the same file + same old_string.
// ---------------------------------------------------------------------------

describe("detectLoop — edit_repeat", () => {
  const edit = (path: string, oldString: string, isError = true) =>
    callTurn("edit", { path, old_string: oldString, new_string: `new-${Math.random().toString(36).slice(2, 6)}` }, isError);

  it("fires on 3 same-file same-old_string edit failures", () => {
    const turns = [edit("a.ts", "needle"), edit("a.ts", "needle"), edit("a.ts", "needle")];
    const v = detectLoop(turns);
    expect(v?.kind).toBe("edit_repeat");
    expect(v?.evidence).toContain("a.ts");
    expect(v?.evidence).toContain("needle");
    expect(v?.evidence).toContain(`×${EDIT_STREAK_LIMIT}`);
  });

  it("does not fire when old_string differs each time", () => {
    const turns = [edit("a.ts", "one"), edit("a.ts", "two"), edit("a.ts", "three")];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("does not fire when the file differs", () => {
    const turns = [edit("a.ts", "needle"), edit("b.ts", "needle"), edit("c.ts", "needle")];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("does not fire at 2 failures", () => {
    const turns = [edit("a.ts", "needle"), edit("a.ts", "needle")];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("a successful edit resets the streak", () => {
    const turns = [edit("a.ts", "needle"), edit("a.ts", "needle"), edit("a.ts", "needle", false), edit("a.ts", "needle")];
    expect(detectLoop(turns)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// no_answer: 3 consecutive short no-tool answers that paraphrase each other.
// ---------------------------------------------------------------------------

describe("detectLoop — no_answer", () => {
  it("fires on 3 consecutive paraphrased short answers", () => {
    const turns = [
      callTurn("read_file", { path: "a" }),
      answerTurn("The sentinel phrase is ZEPHYR-MAVERICK-42."),
      answerTurn("The sentinel phrase is ZEPHYR-MAVERICK-42"),
      answerTurn("the sentinel phrase is Zephyr-Maverick-42."),
    ];
    const v = detectLoop(turns);
    expect(v?.kind).toBe("no_answer");
    expect(v?.evidence).toContain(`×${NO_ANSWER_RUNS}`);
  });

  it("a tool turn between answers breaks the run", () => {
    const turns = [
      answerTurn("The answer is 42."),
      callTurn("read_file", { path: "a" }),
      answerTurn("The answer is 42."),
      answerTurn("The answer is 42."),
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("dissimilar answers are not a loop", () => {
    const turns = [
      answerTurn("Read the config file first."),
      answerTurn("The cache hit rate was 89 percent."),
      answerTurn("Tests pass in three seconds."),
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("long expository answers are not the pathological shape", () => {
    const long = `Here is a detailed summary of everything that happened. ${"padding ".repeat(80)}`;
    const turns = [answerTurn(long), answerTurn(long), answerTurn(long)];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("empty settles are treated as identical (Jaccard special case)", () => {
    // Two empty settles "" should be considered identical for the alternation counter.
    const turns = [answerTurn(""), answerTurn(""), answerTurn("")];
    const v = detectLoop(turns);
    expect(v?.kind).toBe("no_answer");
  });
});

// ---------------------------------------------------------------------------
// priority: the most specific verdict wins.
// ---------------------------------------------------------------------------

describe("detectLoop — priority", () => {
  it("edit_repeat beats failure_streak and identical_calls", () => {
    // 3 identical failing edits also reach identical_calls frequency (3 ≥ W/2).
    const turns = [
      callTurn("edit", { path: "a.ts", old_string: "x", new_string: "y" }, true),
      callTurn("edit", { path: "a.ts", old_string: "x", new_string: "y" }, true),
      callTurn("edit", { path: "a.ts", old_string: "x", new_string: "y" }, true),
    ];
    expect(verdictKind(detectLoop(turns))).toBe("edit_repeat");
  });

  it("failure_streak beats identical_calls", () => {
    // 4 same-tool failures, two arg shapes — identical count is 2 (no fire),
    // the failure streak is 4.
    const turns = [
      callTurn("probe", { a: 1 }, true),
      callTurn("probe", { a: 2 }, true),
      callTurn("probe", { a: 1 }, true),
      callTurn("probe", { a: 2 }, true),
    ];
    expect(verdictKind(detectLoop(turns))).toBe("failure_streak");
  });

  it("returns undefined on empty and tool-free-normal input", () => {
    expect(detectLoop([])).toBeUndefined();
    expect(detectLoop([callTurn("read_file", { path: "a" })])).toBeUndefined();
    expect(detectLoop([answerTurn("All done — the file was written."), answerTurn("Done.")])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loop integration: the detectors ride the turn boundary.
// ---------------------------------------------------------------------------

const SYSTEM = "You are a deterministic test agent.";

function stateWith(tools: readonly Tool[]): AgentState {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: "do the thing" }], tools: [...tools], status: "idle" };
}

/** Scripted model that also records every ModelInput it receives. */
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

const echoTool: Tool = {
  name: "echo",
  description: "echoes its arg",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => ({ content: `echo: ${String((args as { text?: string }).text ?? "")}` }),
};

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

describe("runAgentLoop — loop-safety integration", () => {
  it("first verdict injects ONE MetaNote and does not consume the run", async () => {
    // 3 identical calls (verdict #1), then the model changes approach.
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "same" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "echo", arguments: { text: "same" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "echo", arguments: { text: "same" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c4", name: "echo", arguments: { text: "different" } }] },
      { role: "assistant", content: "recovered and done" },
    ]);
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false, verify: false } }));

    expect(terminal.reason).toBe("completed");
    const detected = events.filter((e): e is Extract<LoopEvent, { type: "loop_detected" }> => e.type === "loop_detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]?.attempt).toBe(1);
    expect(detected[0]?.kind).toBe("identical_calls");
    expect(detected[0]?.evidence).toContain("echo");
    // The note rode the MetaNote channel: projected into the NEXT model call's
    // last tool_result tail, absent from the persisted transcript.
    const note = events.find((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(note).toBeDefined();
    expect(note?.text).toContain("stuck in a loop");
    expect(note?.channel).toBe("tool_result");
    const projected = model.inputs[3]?.messages ?? [];
    const lastTool = [...projected].reverse().find((m) => m.role === "tool");
    expect(lastTool?.content).toContain("stuck in a loop");
    expect(state.messages.some((m) => m.role === "tool" && m.content.includes("stuck in a loop"))).toBe(false);
  });

  it("second verdict in the same run forces an aborted terminal with evidence", async () => {
    const sameCall = (id: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name: "echo", arguments: { text: "same" } }] });
    const model = recordingModel([sameCall("c1"), sameCall("c2"), sameCall("c3"), sameCall("c4"), sameCall("c5"), sameCall("c6")]);
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false, verify: false } }));

    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toContain("echo");
    const detected = events.filter((e): e is Extract<LoopEvent, { type: "loop_detected" }> => e.type === "loop_detected");
    expect(detected.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("a NO_ANSWER gated loop is caught (gate insists, model paraphrases)", async () => {
    // Board present + incomplete → todo gate insists; the model just
    // paraphrases the same answer instead of working the board. Verdict 1 at
    // answer 3 (note injected, history reset); answers 4-6 re-form the
    // pattern AFTER the note → verdict 2 → forced abort.
    const board = "[todo board 0/2 done]\n◐ step one\n☐ step two";
    const answer = () => ({ role: "assistant" as const, content: "I cannot update the board right now, sorry." });
    const model = recordingModel([answer(), answer(), answer(), answer(), answer(), answer()]);
    const state: AgentState = {
      systemPrompt: SYSTEM,
      messages: [
        { role: "user", content: "work the board" },
        { role: "user", content: board },
      ],
      tools: [],
      status: "idle",
    };
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 12, gates: { todo: true, verify: false, maxInsists: 6 } }));

    const detected = events.filter((e): e is Extract<LoopEvent, { type: "loop_detected" }> => e.type === "loop_detected");
    expect(detected.length).toBeGreaterThanOrEqual(1);
    expect(detected[0]?.kind).toBe("no_answer");
    // The 4th paraphrase re-verdicts inside the window → forced abort.
    expect(terminal.reason).toBe("aborted");
  });

  it("normal varied runs never verdict", async () => {
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "a" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "echo", arguments: { text: "b" } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 6, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
    expect(events.some((e) => e.type === "meta_note")).toBe(false);
  });
});
