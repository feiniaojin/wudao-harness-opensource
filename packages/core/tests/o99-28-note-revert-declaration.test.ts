// ω99-28 T2 (turn-34 bounded 定界) — the campaign's `⚠️ cache break at edit
// result (turn 34)` (:1933) was an OLD tool result whose serialized line
// changed between two adjacent calls. The rewriter is the MetaNote projection
// (loop.ts projectNotes): a drained note rides the LAST tool_result tail for
// exactly ONE model call (projection-only, never persisted), so the call
// AFTER it reverts that line to the original bytes — a one-call footprint
// that reads as a history rewrite to the byte-diffing cache detector. The
// M24 law says a by-design rewrite DECLARES its cost: this arc parks a cold
// attribution ("meta-note projection revert (tail-only)") so the row renders
// as an expected break, not an anomaly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, createReadFileTool } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage, Terminal, Tool } from "../src/index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "o28-ws-"));
  await writeFile(join(root, "note.txt"), "hello world\n", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });

/** meta-notes.test.ts's recordingModel, plus a usage row per call — the
 *  declaration lands on the usage event (where the detector and the usage
 *  line both read it). The note is queued DURING call 1 (the prober timing:
 *  after call 1's drain window, before call 2's). */
function recordingModel(responses: readonly AssistantMessage[], notes: string[], midRunNotes: readonly string[] = ["FILE-CHANGED-SENTINEL"]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (inputs.length === 1) notes.push(...midRunNotes);
      input.onUsage?.({ promptTokens: 40_000, cacheHitTokens: 39_000, cacheMissTokens: 1_000 });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const stateOf = (): AgentState => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "read it" }],
  tools: [createReadFileTool({ workspaceRoot: root }) as Tool],
  status: "idle",
});

const usageRows = (events: readonly LoopEvent[]): readonly ModelUsage[] =>
  events.filter((e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage").map((e) => e.usage);

const toolMsg = (input: ModelInput, id: string): AgentMessage | undefined =>
  input.messages.find((m) => m.role === "tool" && m.toolCallId === id);

describe("ω99-28 — the meta-note tail revert declares its cache cost", () => {
  it("the call AFTER a tool_result-tail note is stamped cold-and-expected; the note-carrying call is not; the divergent line is exactly the note carrier", async () => {
    const notes: string[] = [];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }), // call 1: no note yet
      toolCall("c2", "read_file", { path: "note.txt" }), // call 2: the note rides c1's tool_result tail
      { role: "assistant", content: "done" },            // call 3: the note is gone — c1's line REVERTS
    ], notes);
    const state = stateOf();
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      metaNotes: { take: () => notes.shift() },
    }));
    expect(model.inputs.length).toBe(3);

    // The mechanism itself (the turn-34 shape, deterministically): call 2 and
    // call 3 agree on EVERY message before c1's tool result; c1's serialized
    // line differs between them (note appended vs original bytes) — a
    // one-line divergence at an OLD message, exactly what the detector read
    // as "cache break at edit result (turn 34)".
    const call2 = model.inputs[1]!;
    const call3 = model.inputs[2]!;
    const c1of2 = toolMsg(call2, "c1");
    const c1of3 = toolMsg(call3, "c1");
    expect(c1of2?.content).toContain("<system_note>");
    expect(c1of3?.content).toBe("hello world\n"); // reverted to the original
    const idx2 = call2.messages.indexOf(c1of2!);
    const idx3 = call3.messages.indexOf(c1of3!);
    expect(call2.messages.slice(0, idx2)).toEqual(call3.messages.slice(0, idx3)); // prefix identical

    // The M24 declaration: the revert call's usage row is cold-and-expected.
    const rows = usageRows(events);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.coldTurnExpected).toBeUndefined(); // call 1: ordinary
    expect(rows[1]?.coldTurnExpected).toBeUndefined(); // call 2 (note CARRIES): the append is tail-only
    expect(rows[2]?.coldTurnExpected).toBe(true);      // call 3 (note REVERTS): declared
    expect(rows[2]?.cacheBreakAttribution).toBe("meta-note projection revert (tail-only)");
  });

  it("a SECOND note landing later re-arms the declaration for ITS revert (per-boundary, not once per run)", async () => {
    const notes: string[] = [];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }),
      toolCall("c2", "read_file", { path: "note.txt" }), // call 2: note A rides c1's tail
      toolCall("c3", "read_file", { path: "note.txt" }), // call 3: revert of A; NOTE-B queued after it
      toolCall("c4", "read_file", { path: "note.txt" }), // call 4: note B rides c3's tail
      { role: "assistant", content: "done" },            // call 5: revert of B
    ], notes, ["NOTE-A"]);
    const state = stateOf();
    // NOTE-B must be queued during call 3's window (after its usage row,
    // before call 4's drain): recordingModel only pushes on call 1.
    const gen = runAgentLoop(state, model, { maxTurns: 8, metaNotes: { take: () => notes.shift() } });
    const events: LoopEvent[] = [];
    let usageSeen = 0;
    for (;;) {
      const { done, value } = await gen.next();
      if (done) break;
      if (value.type === "usage") {
        usageSeen += 1;
        if (usageSeen === 3) notes.push("NOTE-B");
      }
      events.push(value);
    }
    expect(model.inputs.length).toBe(5);
    const rows = usageRows(events);
    const stamped = rows.filter((r) => r.coldTurnExpected === true);
    expect(stamped).toHaveLength(2); // call 3's revert AND call 5's revert
    expect(stamped.every((r) => r.cacheBreakAttribution === "meta-note projection revert (tail-only)")).toBe(true);
    expect(rows[1]?.coldTurnExpected).toBeUndefined(); // the note-carrying calls stay bare
    expect(rows[3]?.coldTurnExpected).toBeUndefined();
  });

  it("the degraded USER-channel note declares its revert too (same one-call footprint, different carrier)", async () => {
    // No tool result exists yet (the campaign's early-turn shape): the note
    // rides a projected trailing user message on call 1 — projection-only, so
    // call 2 (after the tool round-trip) reverts that line exactly like the
    // tool_result channel.
    const notes: string[] = ["EARLY-NOTE"];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }), // call 1: note degrades to a projected user message
      { role: "assistant", content: "done" },            // call 2: the projection is gone — the line reverts
    ], notes, []);
    const state = stateOf();
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      metaNotes: { take: () => notes.shift() },
    }));
    expect(model.inputs.length).toBe(2);
    const call1 = model.inputs[0]!;
    const call2 = model.inputs[1]!;
    expect(call1.messages[1]?.role).toBe("user");
    expect(String(call1.messages[1]?.content)).toContain("<system_note>");
    expect(JSON.stringify(call2.messages)).not.toContain("system_note"); // reverted
    expect(call2.messages[0]).toEqual(call1.messages[0]); // the prefix survives
    const rows = usageRows(events);
    expect(rows[0]?.coldTurnExpected).toBeUndefined(); // the carrying call is bare
    expect(rows[1]?.coldTurnExpected).toBe(true);      // the revert is declared
    expect(rows[1]?.cacheBreakAttribution).toBe("meta-note projection revert (tail-only)");
  });
});
