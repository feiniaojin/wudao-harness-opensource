// 夜移 024 surfacing — the empty_final_recovery event must not die in the
// driver's `default: break`: a blank final answer is the exact user-facing
// symptom the guard exists for, so both of its moves get a history notice
// (the 013 surfacing idiom). "nudge" = the dim "re-asking" line before the
// retry streams; "exhausted" = the ⚠️ emptiness marker — without it a blank
// run is indistinguishable from a finished one in every frontend.
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

describe("empty_final_recovery rides history (夜移 024 surfacing)", () => {
  it("a nudge lands the dim re-ask notice before the recovered answer", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "" },
        { role: "assistant", content: "the visible answer" },
      ]),
      tools: [buildTool({
        name: "read_file",
        description: "stub read",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "CONTENT" }),
      })],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    driver.submit("answer the question");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const texts = driver.getHistory().filter((h) => h.kind === "notice").map((h) => h.text);
    expect(texts.some((t) => t.includes("🕳") && t.includes("重答"))).toBe(true);
    // The run recovered — the final assistant is the retry's visible answer.
    const answers = driver.getHistory().filter((h) => h.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "the visible answer" });
    driver.dispose();
  });

  it("exhaustion lands the ⚠️ emptiness marker; the blank answer stays as the final", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "" },
        { role: "assistant", content: "" },
      ]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    driver.submit("answer the question");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const history = driver.getHistory();
    const notices = history.filter((h) => h.kind === "notice").map((h) => h.text);
    expect(notices.some((t) => t.includes("⚠️") && t.includes("可见回答"))).toBe(true);
    const answers = history.filter((h) => h.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "" });
    driver.dispose();
  });
});
