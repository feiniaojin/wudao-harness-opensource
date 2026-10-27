import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSubagent } from "../src/subagent.js";
import type { SubagentType } from "../src/subagent.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import { createReadFileTool } from "../src/index.js";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let store: ReturnType<typeof createJsonlSessionStore>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "child-sess-"));
  await writeFile(join(root, "data.txt"), "hello world");
  store = createJsonlSessionStore(join(root, "sessions"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const TYPE: SubagentType = {
  name: "coder",
  description: "d",
  systemPrompt: "CHILD-SYSTEM-PROMPT",
  toolNames: ["read_file"],
};

function scripted(responses: readonly AssistantMessage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      // Snapshot: the loop passes state.messages BY REFERENCE (zero-copy),
      // so recording the live object would capture later mutations too.
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return { model, inputs };
}

const step1 = (path: string): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: "c1", name: "read_file", arguments: { path } }],
});

describe("session store sidechain support", () => {
  it("keeps sidechain files out of the top-level session list", async () => {
    await store.append("main", { role: "user", content: "hi" });
    await store.appendSidechain("child-1", { role: "user", content: "brief" });
    expect(await store.list()).toEqual(["main"]);
    expect(await store.loadSidechain("child-1")).toHaveLength(1);
  });

  it("reserves the side- prefix for sidechains (no file collisions)", async () => {
    await expect(store.appendSidechain("bad/id", { role: "user", content: "x" })).rejects.toThrow(/sidechain id/);
    await expect(store.append("side-main", { role: "user", content: "top-level with prefix" })).rejects.toThrow(/reserved/);
    await store.append("main", { role: "user", content: "top" });
    await store.appendSidechain("main", { role: "user", content: "child" });
    expect(await store.load("main")).toEqual([{ role: "user", content: "top" }]);
    expect(await store.loadSidechain("main")).toEqual([{ role: "user", content: "child" }]);
  });
});

describe("runSubagent child sessions", () => {
  it("mode 'new' persists the full child transcript under side-<id>.jsonl", async () => {
    const { model } = scripted([
      step1(join(root, "data.txt")),
      { role: "assistant", content: "read it: hello world" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "read data.txt",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "child-1", store },
    });
    expect(answer).toContain("hello world");
    const transcript = await store.loadSidechain("child-1");
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(transcript[0]).toEqual({ role: "user", content: "read data.txt" });
    expect(transcript[3]).toEqual({ role: "assistant", content: "read it: hello world" });
  });

  it("mode 'resume' rebuilds byte-identical prefix and injects one steering message", async () => {
    const first = scripted([
      step1(join(root, "data.txt")),
      { role: "assistant", content: "phase one done" },
    ]);
    await runSubagent({
      model: first.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "read data.txt",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "child-2", store },
    });
    const prior = await store.loadSidechain("child-2");

    const second = scripted([{ role: "assistant", content: "resumed answer" }]);
    const steered: string[] = [];
    const answer = await runSubagent({
      model: second.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "continue",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "child-2", store },
      onBeforeResume: ({ id, priorMessages }) => {
        steered.push(id, String(priorMessages.length));
        return "[steering] finish the remaining work now";
      },
    });
    expect(answer).toBe("resumed answer");
    // The seam fired with the right id and prior length.
    expect(steered).toEqual(["child-2", String(prior.length)]);
    // BYTE-IDENTICAL rebuild: same system prompt, same tool array, and the
    // message prefix is exactly the prior transcript + the steering note.
    const input = second.inputs[0]!;
    expect(input.systemPrompt).toBe(first.inputs[0]!.systemPrompt);
    expect(input.tools).toEqual(first.inputs[0]!.tools);
    expect(input.messages.slice(0, prior.length)).toEqual(prior);
    expect(input.messages[prior.length]).toEqual({
      role: "user",
      content: "[steering] finish the remaining work now",
    });
    expect(input.messages).toHaveLength(prior.length + 1);
    // Default steering when the seam returns undefined: appended, not inserted.
    // (covered next by the store check + fork test)
  });

  it("resume without a seam injects a default steering note and appends to the same file", async () => {
    const first = scripted([{ role: "assistant", content: "part one" }]);
    await runSubagent({
      model: first.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "start",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "child-3", store },
    });
    const before = (await store.loadSidechain("child-3")).length;

    const second = scripted([{ role: "assistant", content: "part two" }]);
    await runSubagent({
      model: second.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "continue",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "child-3", store },
    });
    const after = await store.loadSidechain("child-3");
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((m) => m.role === "user" && m.content.includes("resume"))).toBe(true);
  });

  it("mode 'fork' copies the transcript into a NEW sidechain and leaves the source untouched", async () => {
    const first = scripted([{ role: "assistant", content: "original" }]);
    await runSubagent({
      model: first.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "start",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "src", store },
    });
    const sourceBefore = await store.loadSidechain("src");

    const second = scripted([{ role: "assistant", content: "branched" }]);
    await runSubagent({
      model: second.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "try a different approach",
      loopOptions: { maxTurns: 20 },
      session: { mode: "fork", id: "src", store },
    });
    // Source sidechain unchanged.
    expect(await store.loadSidechain("src")).toEqual(sourceBefore);
    // A NEW sidechain file exists (fork-<uuid>) holding the copied transcript
    // + steering + the branched answer; sidechains never appear in list().
    expect(await store.list()).toEqual([]);
    const files = await readdir(join(root, "sessions"));
    const sideFiles = files.filter((n) => n.startsWith("side-"));
    expect(sideFiles.length).toBe(2); // side-src.jsonl + the fork copy
    const forkFile = sideFiles.find((n) => n.startsWith("side-fork-"))!;
    const forkTranscript = await store.loadSidechain(forkFile!.slice("side-".length, -".jsonl".length));
    expect(forkTranscript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(forkTranscript.at(-1)).toEqual({ role: "assistant", content: "branched" });
  });

  it("single-writer guard: a concurrent run on the same child id is rejected", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ModelClient = {
      async generate() { await gate; return { role: "assistant", content: "slow done" }; },
    };
    const first = runSubagent({
      model: slow,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "slow",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "busy", store },
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(runSubagent({
      model: slow,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "me too",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "busy", store },
    })).rejects.toThrow(/single writer|in flight/);
    release();
    await expect(first).resolves.toContain("slow done");
    // Guard released after completion → the id is writable again.
    const again = scripted([{ role: "assistant", content: "ok now" }]);
    await expect(runSubagent({
      model: again.model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "retry",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "busy", store },
    })).resolves.toBe("ok now");
  });

  it("resume of a nonexistent child session fails closed", async () => {
    const { model } = scripted([{ role: "assistant", content: "x" }]);
    await expect(runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "p",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "ghost", store },
    })).rejects.toThrow(/no prior child session/);
  });

  it("rejects session persistence combined with a shareContext fork", async () => {
    const { model } = scripted([{ role: "assistant", content: "x" }]);
    await expect(runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "p",
      forkFrom: { systemPrompt: "P", tools: [], messages: [] },
      session: { mode: "new", id: "f1", store },
    })).rejects.toThrow(/shareContext/);
  });

  it("a thrown child still leaves a resumable partial transcript (tail flush)", async () => {
    const { model } = scripted([
      step1(join(root, "data.txt")),
      // second generate() throws: script exhausted mid-run
    ]);
    await expect(runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "start",
      loopOptions: { maxTurns: 20 },
      session: { mode: "new", id: "crash", store },
      loopOptions: { maxTurns: 5 },
    })).rejects.toThrow();
    const transcript = await store.loadSidechain("crash");
    // The brief, the open tool call, and its result all survived — enough
    // for a resume to pick up where the crash happened.
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("repairs an orphaned trailing tool call when rebuilding for resume", async () => {
    // Hand-craft a transcript ending in an UNANSWERED tool call (crash mid-turn).
    await store.appendSidechain("orphan", { role: "user", content: "start" });
    await store.appendSidechain("orphan", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t9", name: "read_file", arguments: { path: join(root, "data.txt") } }],
    });
    const { model, inputs } = scripted([{ role: "assistant", content: "recovered" }]);
    await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "continue",
      loopOptions: { maxTurns: 20 },
      session: { mode: "resume", id: "orphan", store },
    });
    // The orphan must not be replayed UNANSWERED: a synthetic tool result
    // follows it, keeping the sequence provider-legal.
    const replayed = inputs[0]!.messages;
    const orphan = replayed.find((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.id === "t9"));
    expect(orphan).toBeDefined();
    const idx = replayed.indexOf(orphan!);
    expect(replayed[idx + 1]).toMatchObject({ role: "tool", toolCallId: "t9" });
  });
});

// ---------------------------------------------------------------------------
// M80: a child session whose first message carries the image rider round-trips
// through loadSidechain — the JSONL keeps the durable refs (validate.ts's
// validImagesField admits them), never bytes.
// ---------------------------------------------------------------------------
describe("M80 — image-rider first messages persist and round-trip", () => {
  it("loadSidechain returns the brief with its images rider verbatim", async () => {
    const blocks = [
      { kind: "image" as const, ref: { kind: "image" as const, attachmentId: "aaaaaaaa-0000-4000-8000-000000000001", mediaType: "image/png", byteLength: 11 } },
      { kind: "image" as const, ref: { kind: "image" as const, attachmentId: "aaaaaaaa-0000-4000-8000-000000000002", mediaType: "image/jpeg", byteLength: 22 } },
    ];
    const { model } = scripted([{ role: "assistant", content: "described" }]);
    await runSubagent({
      model,
      allTools: [createReadFileTool()],
      subagentType: TYPE,
      prompt: "describe these",
      promptImages: blocks,
      loopOptions: { maxTurns: 5 },
      session: { mode: "new", id: "child-img", store },
    });
    const loaded = await store.loadSidechain("child-img");
    // brief + final answer at minimum
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    expect(loaded[0]).toEqual({ role: "user", content: "describe these", images: blocks });
    expect(loaded.at(-1)).toEqual({ role: "assistant", content: "described" });
  });
});
