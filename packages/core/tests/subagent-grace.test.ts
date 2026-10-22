import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSubagent } from "../src/subagent.js";
import type { ModelClient, ModelInput, ModelUsage } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import type { SubagentRunInfo } from "../src/subagent.js";
import { createReadFileTool, createTodoTool } from "../src/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "grace-"));
  await writeFile(join(root, "data.txt"), "hello world");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A scripted model that records every ModelInput (the stock scripted model
// ignores its input, so it cannot prove what the child actually sent).
function recordingModel(responses: readonly AssistantMessage[]): {
  readonly model: ModelClient;
  readonly inputs: ModelInput[];
} {
  const inputs: ModelInput[] = [];
  let calls = 0;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const response = responses[calls];
      calls += 1;
      if (!response) throw new Error("scripted responses exhausted");
      return response;
    },
  };
  return { model, inputs };
}

const readTool = () => createReadFileTool();
const tools = () => [createReadFileTool(), createTodoTool({ workspaceRoot: root })];

describe("runSubagent grace iteration (graceTools)", () => {
  it("flips a max_turns fuse into one final grace turn instead of dying silently", async () => {
    const { model, inputs } = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
      { role: "assistant", content: "GRACE-REPORT: ran out of budget after reading data.txt" },
    ]);
    let info: SubagentRunInfo | undefined;
    const answer = await runSubagent({
      model,
      allTools: tools(),
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: ["read_file", "todo_write"] },
      prompt: "read everything",
      loopOptions: { maxTurns: 1 },
      graceTools: ["todo_write"],
      onResult: (i) => { info = i; },
    });
    // The grace-turn text becomes the final report — not the fallback.
    expect(answer).toContain("GRACE-REPORT");
    expect(info?.budgetLimited).toBe(true);
    expect(info?.turns).toBeGreaterThan(0);
    expect(info?.toolCalls).toBe(1);
  });

  it("whitelists the grace turn's tools to graceTools ∩ role tools", async () => {
    const { model, inputs } = recordingModel([
      // Turn 1 (budget): reads a file.
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
      // Grace turn: updates the todo board (allowed), then…
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "todo_write", arguments: { items: ["wrap up"] } }] },
      // …the forced-answer nudge lands and the model reports.
      { role: "assistant", content: "grace done" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: tools(),
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: ["read_file", "write_file", "edit", "shell", "glob", "grep", "todo_write"] },
      prompt: "work",
      loopOptions: { maxTurns: 1 },
      graceTools: ["todo_write"],
    });
    expect(answer).toBe("grace done");
    const budgetCall = inputs[0]!;
    const graceCall = inputs[1]!;
    expect(budgetCall.tools.map((t) => t.name)).toContain("read_file");
    expect(graceCall.tools.map((t) => t.name)).toEqual(["todo_write"]);
  });

  it("treats an empty graceTools array as grace disabled (old behavior)", async () => {
    const { model } = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [readTool()],
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 1 },
      graceTools: [],
    });
    expect(answer).toContain("no final answer");
  });

  it("reports budgetLimited=false when the child completes within budget", async () => {
    const { model } = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
      { role: "assistant", content: "all done" },
    ]);
    let info: SubagentRunInfo | undefined;
    const answer = await runSubagent({
      model,
      allTools: [readTool()],
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 5 },
      graceTools: ["todo_write"],
      onResult: (i) => { info = i; },
    });
    expect(answer).toBe("all done");
    expect(info?.budgetLimited).toBe(false);
  });

  // ω-1 — the receipt must carry the child's cache-hit tokens back to the
  // parent: a multi-agent run's cache accounting sums across its nodes (AWS
  // Strands accumulates cache counters across agents), so dropping the child's
  // hits under-reports the fan-out's real prefix-cache savings.
  it("propagates the child's cacheHitTokens into the run receipt", async () => {
    const script: readonly AssistantMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] },
      { role: "assistant", content: "all done" },
    ];
    // Turn 1 misses (cold prefix); turn 2 rides the warmed prefix (hit).
    const usageByCall: readonly ModelUsage[] = [
      { promptTokens: 1000, cacheHitTokens: 100, cacheMissTokens: 900, completionTokens: 40 },
      { promptTokens: 2000, cacheHitTokens: 1900, cacheMissTokens: 100, completionTokens: 10 },
    ];
    let call = 0;
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        input.onUsage?.(usageByCall[call]!);
        const response = script[call]!;
        call += 1;
        return response;
      },
    };
    let info: SubagentRunInfo | undefined;
    const answer = await runSubagent({
      model,
      allTools: [readTool()],
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 5 },
      onResult: (i) => { info = i; },
    });
    expect(answer).toBe("all done");
    expect(info?.usage.promptTokens).toBe(3000);
    expect(info?.usage.completionTokens).toBe(50);
    expect(info?.usage.cacheHitTokens).toBe(2000);
  });
});
