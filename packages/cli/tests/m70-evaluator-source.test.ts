// M70 §3 (the upstream format) — the /goal evaluator's model call is BACKGROUND (no human is
// blocking on the verdict): its ModelInput carries querySource "evaluator" so
// the provider retry ladder's foreground-only allowlist bails immediately on
// overload instead of amplifying a capacity cascade.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalController, goalEvaluatorAvailable } from "../src/goal.js";
import type { AgentState, AssistantMessage, ModelInput } from "@wudao/core";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m70-goal-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

describe("evaluator querySource tag (M70 §3)", () => {
  it("the evaluator's generate input carries querySource 'evaluator'", async () => {
    expect((await goalEvaluatorAvailable({}, ws)).ok).toBe(true);
    const inputs: ModelInput[] = [];
    const controller = createGoalController({
      workspaceRoot: ws,
      sessionId: () => "s-m70",
      getMessages: () => [{ role: "user", content: "go" }],
      evaluator: {
        client: {
          generate: async (input: ModelInput): Promise<AssistantMessage> => {
            inputs.push(input);
            return { role: "assistant", content: "VERDICT: met" };
          },
        },
        label: "test-eval",
        fallback: false,
      },
      appendEntry: async () => {},
      notify: () => {},
      env: {},
    });
    await controller.set("tests green");
    expect(await controller.onStop({ systemPrompt: "s", messages: [], tools: [], status: "idle" } as AgentState)).toBe("allow");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.querySource).toBe("evaluator");
  });
});
