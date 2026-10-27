import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runAgentLoop, createScriptedModel, createReadFileTool,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// M1 acceptance: a deterministic model reads a fixture file and reports its content,
// exercising the full loop (model -> tool -> result -> model -> final answer).
describe("M1 acceptance: read file -> answer", () => {
  it("completes with a final answer derived from the file", async () => {
    const fixturePath = join(here, "fixtures", "sample.txt");
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }],
      },
      { role: "assistant", content: "I read it: the quick brown fox" },
    ]);

    const state = {
      systemPrompt: "You answer questions about files.",
      messages: [{ role: "user", content: "What does the file say?" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };

    // Drain yielded events. The final assistant message is pushed into
    // state.messages before the loop returns, so we assert on state
    // (the typical consumer pattern — for-await discards the return value).
    const gen = runAgentLoop(state, model, { maxTurns: 5 });
    for await (const _event of gen) { void _event; }

    const last = state.messages.at(-1);
    expect(last?.role).toBe("assistant");
    if (last?.role === "assistant") {
      expect(last.content).toContain("the quick brown fox");
    }
  });
});
