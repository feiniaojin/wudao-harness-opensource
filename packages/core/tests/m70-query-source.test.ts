// M70 §3 (the upstream format) — querySource tags on core-originated model calls. The
// compaction summarizer is a BACKGROUND call (nobody is blocking on the
// summary): it tags ModelInput.querySource = "summarizer" so the provider
// retry ladder's foreground-only allowlist can bail immediately on overload
// instead of amplifying a capacity cascade.
import { describe, it, expect } from "vitest";
import { summarizeSpan } from "../src/index.js";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput } from "../src/index.js";

function capturingModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return { role: "assistant", content: "SUMMARY" };
    },
  };
}

describe("querySource tags (M70 §3)", () => {
  it("summarizeSpan sends querySource 'summarizer' (background)", async () => {
    const model = capturingModel();
    const span: AgentMessage[] = [{ role: "user", content: "do the thing" }, { role: "assistant", content: "did it" }];
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: span }, model);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]?.querySource).toBe("summarizer");
  });
});
