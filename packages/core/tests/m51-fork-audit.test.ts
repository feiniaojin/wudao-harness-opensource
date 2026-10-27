// M51 §4 (A11) — fork record audit: a shareContext fork must carry the
// parent's CONTENT ELISION / COMPACTION REPLACEMENT records. The elided stub
// and the compaction-stub forms live in state.messages themselves (they were
// what the provider saw), so a fork replaying the parent conversation must
// replay the STUBS, not un-freeze the full contents (which would both miss
// the parent's KV prefix and re-inflate the context past the compaction).
import { describe, it, expect } from "vitest";
import { runSubagent } from "../src/subagent.js";
import { COMPACTION_STUB_PREFIX } from "../src/compaction.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { buildTool } from "../src/tool.js";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, Tool } from "../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FULL_CONTENT = "FILE-BODY-" + "x".repeat(2000);

function recordingModel(finalText: string): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return { role: "assistant", content: finalText };
    },
  };
}

const noopTool: Tool = buildTool({
  name: "read_file",
  description: "stub",
  parameters: { type: "object", properties: {} },
  async execute() { return { content: "unused" }; },
});

const baseMessages = (toolContent: string): AgentMessage[] => [
  { role: "user", content: "read the file" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "big.txt" } }] },
  { role: "tool", toolCallId: "c1", name: "read_file", content: toolContent },
  { role: "assistant", content: "ok" },
];

async function runFork(toolContent: string): Promise<{ inputs: ModelInput[] }> {
  const model = recordingModel("fork answer");
  await runSubagent({
    model,
    allTools: [noopTool],
    subagentType: { name: "fork", description: "d", systemPrompt: "s", toolNames: ["read_file"] },
    prompt: "continue from here",
    forkFrom: { systemPrompt: "parent prompt", tools: [noopTool], messages: baseMessages(toolContent) },
    loopOptions: { maxTurns: 2 },
  });
  return { inputs: model.inputs };
}

describe("M51 A11 — fork carries elision/replacement records", () => {
  it("a fork replays the [elided] read stub VERBATIM — no un-freeze of the full content", async () => {
    const stub = "[elided] big.txt unchanged — identical content already in your context (pass force=true to re-read; sha256:abcd1234)";
    const { inputs } = await runFork(stub);
    const sent = JSON.stringify(inputs[0]?.messages ?? []);
    expect(sent).toContain("[elided] big.txt unchanged");
    expect(sent).not.toContain(FULL_CONTENT.slice(0, 50));
  });

  it("a fork replays the microcompact-replaced form (COMPACTION_STUB_PREFIX), not the original bytes", async () => {
    const replaced = `${COMPACTION_STUB_PREFIX} big.txt (cleared — content removed by context compaction)`;
    const { inputs } = await runFork(replaced);
    const sent = JSON.stringify(inputs[0]?.messages ?? []);
    expect(sent).toContain(COMPACTION_STUB_PREFIX);
    expect(sent).not.toContain(FULL_CONTENT.slice(0, 50));
  });

  it("an un-elided parent still replays its full content (control)", async () => {
    const { inputs } = await runFork(FULL_CONTENT);
    const sent = JSON.stringify(inputs[0]?.messages ?? []);
    expect(sent).toContain(FULL_CONTENT.slice(0, 50));
  });

  it("fork + child session is refused — a shareContext fork has no transcript to resume", async () => {
    const model = recordingModel("x");
    const root = await mkdtemp(join(tmpdir(), "fork-audit-"));
    const store = createJsonlSessionStore(join(root, "sessions"));
    try {
      await expect(runSubagent({
        model,
        allTools: [noopTool],
        subagentType: { name: "fork", description: "d", systemPrompt: "s", toolNames: ["read_file"] },
        prompt: "p",
        forkFrom: { systemPrompt: "s", tools: [noopTool], messages: baseMessages("body") },
        loopOptions: { maxTurns: 1 },
        session: { mode: "new", store },
      })).rejects.toThrow(/shareContext forks/);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
