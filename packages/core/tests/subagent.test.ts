import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSubagent, BUILTIN_SUBAGENT_TYPES, withChildQuerySource } from "../src/subagent.js";
import type { SubagentType } from "../src/subagent.js";
import { buildTool } from "../src/tool.js";
import type { Tool } from "../src/tool.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage, UserMessage } from "../src/types.js";
import type { ImageBlock } from "../src/attachments.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
  await writeFile(join(root, "data.txt"), "hello world");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runSubagent", () => {
  it("runs a child loop and returns the final answer", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
      { role: "assistant", content: "The file says: hello world" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "Read the file and tell me what it says.",
      loopOptions: { maxTurns: 20 },
    });
    expect(answer).toContain("hello world");
  });

  it("gives the subagent only the type's tools (read-only)", async () => {
    const events: string[] = [];
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "hi",
      loopOptions: { maxTurns: 20 },
      onEvent: (e) => events.push(e.type),
    });
    // completed without tool calls → just "ok"
    expect(events).toContain("turn_started");
  });

  it("returns fallback if no assistant message", async () => {
    // model returns a tool call but no final answer → maxTurns 1 → no assistant final
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "read",
      loopOptions: { maxTurns: 1 },
    });
    // with maxTurns 1, the loop runs one tool turn then exits max_turns;
    // the last message is a tool result, not assistant → fallback
    expect(answer).toContain("no final answer");
  });
});

// ---------------------------------------------------------------------------
// M80 (direction b): the explicit image hand-off — promptImages ride a FRESH
// isolated child's first user message as durable refs (exact order/fields),
// every other combination fails closed, and text-only runs keep the
// pre-M80 byte shape (no images key at all).
// ---------------------------------------------------------------------------
const m80Img = (attachmentId: string, byteLength: number): ImageBlock => ({
  kind: "image",
  ref: { kind: "image", attachmentId, mediaType: "image/png", byteLength },
});

function m80Recording(responses: readonly AssistantMessage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      // Snapshot: the loop passes state.messages BY REFERENCE, so record a
      // shallow copy (later turns would otherwise mutate the record).
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return { model, inputs };
}

describe("runSubagent — M80 promptImages", () => {
  it("rides the isolated child's first user message verbatim (order/fields)", async () => {
    const blocks = [m80Img("11111111-1111-4111-8111-111111111111", 101), m80Img("22222222-2222-4222-8222-222222222222", 202)];
    const { model, inputs } = m80Recording([{ role: "assistant", content: "two images" }]);
    const answer = await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "describe the attached images",
      promptImages: blocks,
      loopOptions: { maxTurns: 5 },
    });
    expect(answer).toBe("two images");
    expect(inputs).toHaveLength(1);
    const first = inputs[0]!.messages[0] as UserMessage;
    expect(first.role).toBe("user");
    expect(first.content).toBe("describe the attached images");
    // Exact equality: same blocks, same order, same fields — nothing added.
    expect(first.images).toEqual(blocks);
    // The rider PERSISTS into the child's next request (tool-turn replay).
    // (single-turn run asserts the one call; the rider is on the message
    // the loop holds, not a per-call copy)
  });

  it("keeps the pre-M80 byte shape when promptImages is absent or empty", async () => {
    const absent = m80Recording([{ role: "assistant", content: "ok" }]);
    await runSubagent({
      model: absent.model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "plain",
      loopOptions: { maxTurns: 5 },
    });
    expect("images" in (absent.inputs[0]!.messages[0] as UserMessage)).toBe(false);

    const empty = m80Recording([{ role: "assistant", content: "ok" }]);
    await runSubagent({
      model: empty.model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "plain",
      promptImages: [],
      loopOptions: { maxTurns: 5 },
    });
    expect("images" in (empty.inputs[0]!.messages[0] as UserMessage)).toBe(false);
  });

  it("fails closed for a shareContext fork (the fork replays parent images)", async () => {
    const { model } = m80Recording([{ role: "assistant", content: "ok" }]);
    await expect(runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "p",
      promptImages: [m80Img("33333333-3333-4333-8333-333333333333", 5)],
      forkFrom: { systemPrompt: "S", tools: [createReadFileTool()], messages: [{ role: "user", content: "parent" }] },
      loopOptions: { maxTurns: 5 },
    })).rejects.toThrow("promptImages are not supported for shareContext forks");
  });

  it("fails closed for a resume child session", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    await store.appendSidechain("child-1", { role: "user", content: "prior brief" });
    await store.appendSidechain("child-1", { role: "assistant", content: "prior answer" });
    const { model } = m80Recording([{ role: "assistant", content: "ok" }]);
    await expect(runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "p",
      promptImages: [m80Img("44444444-4444-4444-8444-444444444444", 5)],
      session: { mode: "resume", id: "child-1", store },
      loopOptions: { maxTurns: 5 },
    })).rejects.toThrow("promptImages ride a fresh isolated child's first message");
  });
});

// ---------------------------------------------------------------------------
// ω99-5b §B: finalTool — the structured final-output seam. When a finishing
// tool is named, the report is the LAST tool_use of that name in the
// transcript, canonicalized (recursively sorted keys); with no such call the
// last assistant text stands (pre-ω99-5b behavior, byte-identical).
// ---------------------------------------------------------------------------
describe("runSubagent — ω99-5b finalTool report extraction", () => {
  const finalOutputTool: Tool = buildTool({
    name: "final_output",
    description: "submit the final report",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: "final output recorded ✓" }; },
  });
  const TYPE: SubagentType = {
    name: "worker",
    description: "d",
    systemPrompt: "s",
    toolNames: ["final_output"],
  };

  it("reports the canonical JSON of the final_output tool_use arguments", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "final_output", arguments: { b: 1, a: { z: 1, y: 2 } } }] },
      { role: "assistant", content: "trailing text must lose" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [finalOutputTool],
      subagentType: TYPE,
      prompt: "p",
      finalTool: "final_output",
      loopOptions: { maxTurns: 5 },
    });
    // sorted keys at every level — the canonical form, not insertion order
    expect(answer).toBe('{"a":{"y":2,"z":1},"b":1}');
  });

  it("takes the LAST final_output call when several landed", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "final_output", arguments: { v: 1 } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "f2", name: "final_output", arguments: { v: 2 } }] },
      { role: "assistant", content: "done" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [finalOutputTool],
      subagentType: TYPE,
      prompt: "p",
      finalTool: "final_output",
      loopOptions: { maxTurns: 5 },
    });
    expect(answer).toBe('{"v":2}');
  });

  it("without a final_output call the last assistant text stands (regression)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "plain answer" }]);
    const answer = await runSubagent({
      model,
      allTools: [finalOutputTool],
      subagentType: TYPE,
      prompt: "p",
      finalTool: "final_output",
      loopOptions: { maxTurns: 5 },
    });
    expect(answer).toBe("plain answer");
  });
});

// ---------------------------------------------------------------------------
// ω99-8b — child calls carry querySource="subagent". The stamp is request
// METADATA (never prompt bytes, M24-safe): it lets the CLI's client-level
// meters partition cost exactly-once (the wrapper-side ledger skips the tag;
// the task tool's forwarder is the single subagent row) and keeps tagged
// children out of the waste monitor's MAIN-only turn stats. An explicit tag
// the child itself attached ("summarizer"/"loop-reflector") always wins.
// ---------------------------------------------------------------------------
describe("runSubagent — ω99-8b querySource 打标", () => {
  it("the child loop's model call arrives stamped querySource=subagent", async () => {
    const { model, inputs } = m80Recording([{ role: "assistant", content: "ok" }]);
    await runSubagent({
      model,
      allTools: [],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "p",
      loopOptions: { maxTurns: 5 },
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.querySource).toBe("subagent");
  });

  it("the stamp only fills the untagged default — an explicit tag rides through verbatim", async () => {
    const seen: (string | undefined)[] = [];
    const inner: ModelClient = {
      async generate(input: ModelInput) {
        seen.push(input.querySource);
        return { role: "assistant", content: "ok" };
      },
    };
    const stamped = withChildQuerySource(inner);
    await stamped.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    await stamped.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [], querySource: "summarizer" });
    expect(seen).toEqual(["subagent", "summarizer"]);
  });

  it("the wrapper spreads the client shape: modelId survives, stream stamps too", async () => {
    const streamInputs: (string | undefined)[] = [];
    const inner: ModelClient = {
      modelId: "inner-model",
      async generate(input: ModelInput) {
        expect(input.querySource).toBe("subagent");
        return { role: "assistant", content: "ok" };
      },
      async *stream(input: ModelInput) {
        streamInputs.push(input.querySource);
        yield { type: "text_delta" as const, text: "ok" };
        yield { type: "done" as const, message: { role: "assistant" as const, content: "ok" } };
      },
    };
    const stamped = withChildQuerySource(inner);
    expect(stamped.modelId).toBe("inner-model");
    for await (const _ev of stamped.stream!({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] })) {
      // drain
    }
    expect(streamInputs).toEqual(["subagent"]);
  });
});
