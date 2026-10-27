// M19 wiring: hooks configured at the CLI layer must flow into runAgentLoop
// through useAgent (TUI path) — an onRunStop hook forces one continuation
// (state.messages gains the "[stop blocked] <reason>" user message), and
// absent hooks change nothing. The REPL and one-shot paths thread the same
// LoopOptions.hooks seam.
import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { createScriptedModel, buildTool } from "@wudao/core";
import type { AgentMessage, AgentHooks, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { useAgent } from "../src/tui/use-agent.js";
import type { UseAgentOptions, UseAgentResult } from "../src/tui/use-agent.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const apiBox: { current: UseAgentResult | null } = { current: null };

function Probe({ opts }: { opts: UseAgentOptions }): React.JSX.Element {
  const api = useAgent(opts);
  apiBox.current = api;
  return <Text>{api.busy ? "busy" : "idle"}</Text>;
}

function baseOpts(hooks?: AgentHooks): Omit<UseAgentOptions, "model"> {
  return {
    tools: [] as Tool[],
    systemPrompt: "",
    summarize: summarizeToolCall,
    onPermissionAsk: async () => ({ kind: "deny" as const }),
    ...(hooks ? { hooks } : {}),
  };
}

describe("hooks wiring through useAgent", () => {
  it("an onRunStop hook that blocks forces one continuation; the reason lands in state.messages", async () => {
    let stopCalls = 0;
    const hooks: AgentHooks = {
      onRunStop: async () => {
        stopCalls += 1;
        return stopCalls === 1 ? { block: true, reason: "tests not run" } : "allow";
      },
    };
    const model = createScriptedModel([
      { role: "assistant", content: "first answer" },
      { role: "assistant", content: "second answer" },
    ]);
    const completed: AgentMessage[][] = [];
    const opts: UseAgentOptions = {
      ...baseOpts(hooks),
      model,
      onRunComplete: (messages) => completed.push([...messages]),
    };

    const inst = render(React.createElement(Probe, { opts }));
    try {
      apiBox.current?.submit("do the thing");
      await until(() => !apiBox.current?.busy && completed.length > 0, "run to complete");
      expect(model.calls).toBe(2);
      expect(stopCalls).toBe(2);
      const messages = completed[0] ?? [];
      // The injected continuation message carries the hook's reason.
      expect(messages.some((m) => m.role === "user" && m.content === "[stop blocked] tests not run")).toBe(true);
      // And the final answer is the second scripted response.
      const last = messages[messages.length - 1];
      expect(last?.role).toBe("assistant");
      if (last?.role === "assistant") expect(last.content).toBe("second answer");
    } finally {
      inst.unmount();
    }
  }, 10000);

  it("a prompt-submit hook rewrites the prompt before the first model call", async () => {
    const hooks: AgentHooks = {
      onPromptSubmit: async (prompt) => `UPPER:${prompt}`,
    };
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const completed: AgentMessage[][] = [];
    const opts: UseAgentOptions = {
      ...baseOpts(hooks),
      model,
      onRunComplete: (messages) => completed.push([...messages]),
    };

    const inst = render(React.createElement(Probe, { opts }));
    try {
      apiBox.current?.submit("hello");
      await until(() => !apiBox.current?.busy && completed.length > 0, "run to complete");
      expect(model.calls).toBe(1);
      const messages = completed[0] ?? [];
      expect(messages[0]?.role).toBe("user");
      if (messages[0]?.role === "user") expect(messages[0].content).toBe("UPPER:hello");
    } finally {
      inst.unmount();
    }
  }, 10000);

  it("hooks absent → zero behavior change (single model call, no injected messages)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "sole answer" }]);
    const completed: AgentMessage[][] = [];
    const opts: UseAgentOptions = {
      ...baseOpts(),
      model,
      onRunComplete: (messages) => completed.push([...messages]),
    };

    const inst = render(React.createElement(Probe, { opts }));
    try {
      apiBox.current?.submit("hello");
      await until(() => !apiBox.current?.busy && completed.length > 0, "run to complete");
      expect(model.calls).toBe(1);
      const messages = completed[0] ?? [];
      expect(messages.length).toBe(2); // user prompt + one assistant answer
      expect(messages.some((m) => m.role === "user" && m.content.startsWith("[stop blocked]"))).toBe(false);
    } finally {
      inst.unmount();
    }
  }, 10000);

  // M33 §2: the tool-use hooks ride the same hooks seam — a blocking
  // onPreToolUse skips execution (the reason lands in the tool result), and
  // onPostToolUse observes executed calls only.
  it("onPreToolUse block skips the tool; onPostToolUse sees only executed calls", async () => {
    const posts: string[] = [];
    const hooks: AgentHooks = {
      onPreToolUse: async (_name, input) =>
        input["blockMe"] === true ? { block: true, reason: "hook veto" } : undefined,
      onPostToolUse: (name) => { posts.push(name); },
    };
    const stub = buildTool({
      name: "probe",
      description: "probe",
      parameters: { type: "object", properties: { blockMe: { type: "boolean" } }, required: [], additionalProperties: false },
      execute: async () => ({ content: "RAN" }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "b1", name: "probe", arguments: { blockMe: true } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "o1", name: "probe", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const completed: AgentMessage[][] = [];
    const opts: UseAgentOptions = {
      ...baseOpts(hooks),
      model,
      tools: [stub],
      // allow the non-blocked probe through (default mode would ask → deny)
      canUseTool: async () => ({ behavior: "allow" as const }),
      onRunComplete: (messages) => completed.push([...messages]),
    };

    const inst = render(React.createElement(Probe, { opts }));
    try {
      apiBox.current?.submit("run the probes");
      await until(() => !apiBox.current?.busy && completed.length > 0, "run to complete");
      const messages = completed[0] ?? [];
      const toolResults = messages.filter((m) => m.role === "tool");
      expect(toolResults.length).toBe(2);
      expect(toolResults[0]?.content).toContain("blocked by hook: hook veto");
      expect(toolResults[1]?.content).toBe("RAN");
      // Only the executed call reached the observer.
      expect(posts).toEqual(["probe"]);
    } finally {
      inst.unmount();
    }
  }, 10000);
});
