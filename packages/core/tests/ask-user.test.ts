// M34 §1 — the ask_user tool: an injected askUser seam, fail-closed
// non-interactive refusal, timeout, and option validation. The tool itself is
// interaction-free; frontends inject the asking.
import { describe, it, expect } from "vitest";
import { createAskUserTool } from "../src/tools/ask-user.js";
import type { AskUserFn, AskUserOption } from "../src/tools/ask-user.js";
import { runSubagent } from "../src/subagent.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient } from "../src/model-client.js";

const toolCallTurn = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});

describe("createAskUserTool", () => {
  it("returns the user's answer verbatim and relays question + options to the seam", async () => {
    const seen: { question: string; options?: readonly AskUserOption[] }[] = [];
    const askUser: AskUserFn = async (question, options) => {
      seen.push({ question, ...(options !== undefined ? { options } : {}) });
      return "ship it behind a flag";
    };
    const tool = createAskUserTool({ askUser });
    const result = await tool.execute({
      question: "Flag or no flag?",
      options: [{ label: "flag" }, { label: "no flag", description: "direct release" }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ship it behind a flag");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Flag or no flag?");
    expect(seen[0]?.options?.[1]).toEqual({ label: "no flag", description: "direct release" });
  });

  it("passes no options argument to the seam when the model sent none", async () => {
    let sawOptions: readonly AskUserOption[] | undefined = "sentinel" as unknown as readonly AskUserOption[];
    const tool = createAskUserTool({
      askUser: async (_q, options) => {
        sawOptions = options;
        return "typed answer";
      },
    });
    await tool.execute({ question: "Name?" });
    expect(sawOptions).toBeUndefined();
  });

  it("fails closed with a no-interactive-user error when no askUser is injected", async () => {
    const tool = createAskUserTool({});
    const result = await tool.execute({ question: "Which one?" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no interactive user");
    expect(result.content).toContain("decide yourself");
  });

  it("times out (default-seamable) and tells the model to decide itself", async () => {
    const tool = createAskUserTool({
      askUser: () => new Promise<string>(() => {}),
      timeoutMs: 25,
    });
    const result = await tool.execute({ question: "Anyone there?" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(result.content).toContain("decide yourself");
  });

  it("surfaces a throwing seam (user dismissed) as an error result", async () => {
    const tool = createAskUserTool({
      askUser: async () => {
        throw new Error("user dismissed the question");
      },
    });
    const result = await tool.execute({ question: "Which one?" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("user dismissed the question");
  });

  it("rejects more than 4 options, malformed options, and multiSelect", async () => {
    const tool = createAskUserTool({ askUser: async () => "x" });
    const tooMany = await tool.execute({
      question: "q",
      options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }],
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain("at most 4 options");

    const malformed = await tool.execute({ question: "q", options: [{ description: "no label" } as unknown as { label: string }] });
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toContain("label");

    const multi = await tool.execute({ question: "q", options: [{ label: "a" }], multiSelect: true });
    expect(multi.isError).toBe(true);
    expect(multi.content).toContain("multiSelect");

    const ok = await tool.execute({ question: "q", options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }], multiSelect: false });
    expect(ok.isError).toBeUndefined();
  });

  it("is read-only (it only asks) and not concurrency-safe", () => {
    const tool = createAskUserTool({ askUser: async () => "x" });
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
  });
});

describe("ask_user inside a forked subagent", () => {
  it("keeps the tool in the fork's array (byte-stable) but refuses execution fail-closed", async () => {
    const askTool = createAskUserTool({ askUser: async () => "never happens" });
    const inputs: { tools: { name: string }[]; messages: { role: string; content: string; isError?: boolean }[] }[] = [];
    const model = createScriptedModel([
      toolCallTurn("a1", "ask_user", { question: "Should I continue?" }),
      { role: "assistant", content: "I decided myself." },
    ]);
    // Wrap the scripted model to snapshot each child request.
    const wrapped = {
      generate: async (input: Parameters<ModelClient["generate"]>[0]) => {
        inputs.push({
          tools: input.tools.map((t) => ({ name: t.name })),
          messages: [...input.messages] as { role: string; content: string; isError?: boolean }[],
        });
        return model.generate(input);
      },
    };
    const answer = await runSubagent({
      model: wrapped,
      allTools: [askTool],
      subagentType: { name: "fork", description: "", systemPrompt: "fork", toolNames: [] },
      prompt: "forked work",
      loopOptions: { maxTurns: 20 },
      forkFrom: {
        systemPrompt: "parent prompt",
        tools: [askTool],
        messages: [{ role: "user", content: "parent turn" }],
      },
    });
    expect(answer).toContain("I decided myself.");
    // The tool array still lists ask_user (the fork shares the parent's bytes)…
    expect(inputs[0]?.tools.map((t) => t.name)).toContain("ask_user");
    // …but its execution was refused and the refusal reached the model.
    const refusal = inputs[1]?.messages.find(
      (m) => m.role === "tool" && m.content.includes("ask_user"),
    );
    expect(refusal?.content).toContain("unavailable inside a forked subagent");
  });
});
