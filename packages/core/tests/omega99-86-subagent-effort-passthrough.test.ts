// ω99-86 — the child loop's effortSent passthrough (53 停泊债清偿). Core's
// runSubagent rebuilds the caller's loopOptions through a PER-FIELD
// whitelist (maxTurns/compaction/signal/steering/sessionBudget/onToolUpdate)
// — an upstream effortSent was silently dropped, so a child spawned while
// the parent ran at a live /effort level kept NO effort trail: its assistant
// messages recorded nothing while the parent's recorded the level every turn
// (ω99-53). The whitelist entry forwards effortSent verbatim to the child's
// runAgentLoop, whose EXISTING stamp (:1815 interrupted partial / :2229
// final) is the observable here — persistence-only (AssistantMessage.effort),
// never a wire field. Absent effortSent keeps the child's messages
// byte-identical (no key — the zero-change pin).
import { describe, it, expect } from "vitest";
import { runSubagent, BUILTIN_SUBAGENT_TYPES } from "../src/subagent.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AgentState, AssistantMessage } from "../src/types.js";

/** One clean final turn, no tool calls — the child stops naturally and the
 *  stop face receives the child's final state (the trail's observation). */
function finalModel(reply: AssistantMessage): ModelClient {
  return {
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      return { ...reply };
    },
  };
}

describe("ω99-86 subagent effortSent passthrough (loopOptions whitelist)", () => {
  it("forwards loopOptions.effortSent to the child loop — the child's final assistant message carries the effort trail", async () => {
    let childState: AgentState | undefined;
    const answer = await runSubagent({
      model: finalModel({ role: "assistant", content: "CHILD DONE" }),
      allTools: [],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "go",
      loopOptions: { maxTurns: 5, effortSent: "high" },
      subagentHooks: {
        onStop: (_type, state) => {
          childState = state;
          return "allow";
        },
      },
    });
    expect(answer).toBe("CHILD DONE");
    expect(childState).toBeDefined();
    const final = childState!.messages.at(-1) as AssistantMessage;
    expect(final.role).toBe("assistant");
    expect(final.content).toBe("CHILD DONE");
    // The whitelist is the only seam between the caller's effortSent and the
    // loop's stamp: dropped here ⇒ no effort key ⇒ undefined.
    expect(final.effort).toBe("high");
  });

  it("effortSent absent → the child's final assistant message has NO effort key (zero-change pin)", async () => {
    let childState: AgentState | undefined;
    await runSubagent({
      model: finalModel({ role: "assistant", content: "PLAIN" }),
      allTools: [],
      subagentType: BUILTIN_SUBAGENT_TYPES["general-purpose"]!,
      prompt: "go",
      loopOptions: { maxTurns: 5 },
      subagentHooks: {
        onStop: (_type, state) => {
          childState = state;
          return "allow";
        },
      },
    });
    const final = childState!.messages.at(-1) as AssistantMessage;
    expect(final.effort).toBeUndefined();
    expect("effort" in final).toBe(false);
  });
});
