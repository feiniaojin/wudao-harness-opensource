// M32 §3 — the MetaNote channel: system-class notes land in the LAST
// tool_result tail of the model's view (projection-only), never in the
// persisted transcript; degrade to a projected user message when no
// tool_result exists; an empty queue changes nothing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, createReadFileTool } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
  await writeFile(join(root, "note.txt"), "hello world\n", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Records a snapshot of every ModelInput and pushes `midRunNotes` into the
 *  queue DURING call 1 (i.e. after call 1's drain, before call 2's) — the
 *  timing of a prober that discovers a change in turn 0's window. */
function recordingModel(
  responses: readonly AssistantMessage[],
  notes: string[],
  midRunNotes: readonly string[] = ["FILE-CHANGED-SENTINEL"],
): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (inputs.length === 1) notes.push(...midRunNotes);
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

const toolCall = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });

const toolsOf = (dir: string): Tool[] => [createReadFileTool({ workspaceRoot: dir })];

const stateOf = (messages: AgentMessage[], tools: readonly Tool[]): AgentState => ({
  systemPrompt: "sys",
  messages,
  tools: [...tools],
  status: "idle",
});

describe("MetaNote channel", () => {
  it("appends drained notes into the LAST tool_result tail — model-visible, transcript-clean", async () => {
    const notes: string[] = [];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }),
      { role: "assistant", content: "done" },
    ], notes);
    const state = stateOf([{ role: "user", content: "read it" }], toolsOf(root));
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      metaNotes: { take: () => notes.shift() },
    }));
    expect(model.inputs.length).toBe(2);
    // Call 2's projection: the trailing message is the tool_result with the
    // note appended to its tail.
    const call2 = model.inputs[1]?.messages ?? [];
    const last = call2[call2.length - 1];
    expect(last?.role).toBe("tool");
    expect(last?.content).toContain("hello world");
    expect(last?.content.endsWith("\n<system_note>\nFILE-CHANGED-SENTINEL\n</system_note>")).toBe(true);
    // Everything before the amended tool_result is untouched.
    expect(call2.length).toBe(3);
    // The PERSISTED transcript keeps the ORIGINAL tool_result bytes.
    const persisted = state.messages.find((m) => m.role === "tool");
    expect(persisted?.content).toBe("hello world\n");
    expect(JSON.stringify(state.messages)).not.toContain("system_note");
    // Observability: exactly one meta_note event, on the tool_result channel.
    const metaEvents = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(metaEvents.length).toBe(1);
    expect(metaEvents[0]?.channel).toBe("tool_result");
    expect(metaEvents[0]?.text).toContain("FILE-CHANGED-SENTINEL");
  });
  it("degrades to a projected user message when no tool_result exists", async () => {
    const notes: string[] = ["EARLY-NOTE"];
    const model = recordingModel([{ role: "assistant", content: "ok" }], notes);
    const state = stateOf([{ role: "user", content: "hi" }], toolsOf(root));
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      metaNotes: { take: () => notes.shift() },
    }));
    const call1 = model.inputs[0]?.messages ?? [];
    expect(call1.length).toBe(2);
    expect(call1[1]?.role).toBe("user");
    expect(call1[1]?.content).toBe("<system_note>\nEARLY-NOTE\n</system_note>");
    // Projection-only: the state never saw the degraded message.
    expect(state.messages.length).toBe(2); // user + assistant
    const metaEvents = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(metaEvents[0]?.channel).toBe("user");
  });
  it("an empty (or absent) queue leaves the ModelInput byte-identical", async () => {
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }),
      { role: "assistant", content: "done" },
    ], []);
    const state = stateOf([{ role: "user", content: "read it" }], toolsOf(root));
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      metaNotes: { take: () => undefined },
    }));
    expect(model.inputs.length).toBe(2);
    // No copy: the projection IS state.messages (same reference), and the
    // transcript equals what the model saw.
    expect(model.inputs[1]?.messages).toEqual(state.messages.slice(0, 3));
    expect(events.some((e) => e.type === "meta_note")).toBe(false);
  });
  it("beforeModelCall runs once per model call (after compaction), before the note drain", async () => {
    const notes: string[] = [];
    const seenTurns: number[] = [];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }),
      { role: "assistant", content: "done" },
    ], notes);
    const state = stateOf([{ role: "user", content: "read it" }], toolsOf(root));
    const beforeModelCall = (turn: number): void => {
      seenTurns.push(turn);
      // Pushed AFTER the turn-0 drain? No: beforeModelCall runs BEFORE the
      // drain of the SAME call — so a turn-0 push would ride call 1 (user
      // degrade). The mid-run note (pushed during call 1) rides call 2.
      if (turn === 0) notes.push("SAME-CALL-NOTE");
    };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      beforeModelCall,
      metaNotes: { take: () => notes.shift() },
    }));
    expect(seenTurns).toEqual([0, 1]);
    // Call 1: the turn-0 push drained into the SAME call — no tool_result
    // yet, so it degraded to a projected user message.
    expect(model.inputs[0]?.messages.length).toBe(2);
    expect(model.inputs[0]?.messages[1]?.content).toBe("<system_note>\nSAME-CALL-NOTE\n</system_note>");
    // Call 2: the mid-run note (pushed during call 1) is in the tool_result tail.
    const last = model.inputs[1]?.messages.at(-1);
    expect(last?.content).toContain("<system_note>\nFILE-CHANGED-SENTINEL\n</system_note>");
    const metaEvents = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(metaEvents.length).toBe(2);
    expect(metaEvents[0]?.channel).toBe("user");
    expect(metaEvents[1]?.channel).toBe("tool_result");
  });
  it("a throwing beforeModelCall is isolated — the run proceeds", async () => {
    const model = recordingModel([{ role: "assistant", content: "ok" }], []);
    const state = stateOf([{ role: "user", content: "hi" }], toolsOf(root));
    const { terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      beforeModelCall: () => { throw new Error("probe exploded"); },
    }));
    expect(terminal.reason).toBe("completed");
  });
  it("multiple notes join into one tail append", async () => {
    const notes: string[] = [];
    const model = recordingModel([
      toolCall("c1", "read_file", { path: "note.txt" }),
      { role: "assistant", content: "done" },
    ], notes, ["NOTE-1", "NOTE-2"]);
    const state = stateOf([{ role: "user", content: "read it" }], toolsOf(root));
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      metaNotes: { take: () => notes.shift() },
    }));
    const last = model.inputs[1]?.messages.at(-1);
    expect(last?.content.endsWith("\n<system_note>\nNOTE-1\n</system_note>\n<system_note>\nNOTE-2\n</system_note>")).toBe(true);
    const metaEvents = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(metaEvents.length).toBe(1);
    expect(metaEvents[0]?.text).toContain("NOTE-1");
    expect(metaEvents[0]?.text).toContain("NOTE-2");
  });
});
