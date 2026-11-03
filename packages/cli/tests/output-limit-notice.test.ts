// 夜移 013 surfacing — the output_limit_recovery event must not die in the
// driver's `default: break`: a text answer cut by the output cap is the
// exact user-facing symptom the ladder exists for, so both of its moves get
// a history notice (the compact_deferred idiom). "nudge" = the dim
// "continuing from the cut" line before the continuation streams;
// "exhausted" = the ⚠️ incompleteness marker — without it a cut answer is
// indistinguishable from a finished one in every frontend.
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
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

describe("output_limit_recovery rides history (夜移 013 surfacing)", () => {
  it("a nudge lands the dim continuation notice before the recovered answer", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "partial ans", stopReason: "length" },
        { role: "assistant", content: "partial answer, completed" },
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
    driver.submit("write a long report");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const texts = driver.getHistory().filter((h) => h.kind === "notice").map((h) => h.text);
    expect(texts.some((t) => t.includes("✂️") && t.includes("继续"))).toBe(true);
    // The run recovered — the final assistant is the completed continuation.
    const answers = driver.getHistory().filter((h) => h.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "partial answer, completed" });
    driver.dispose();
  });

  it("exhaustion lands the ⚠️ incompleteness marker; the truncated answer stays", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "cut one", stopReason: "length" },
        { role: "assistant", content: "cut two", stopReason: "length" },
      ]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      // Turn budget caps the ladder after one nudge (call 2 truncates with
      // turn+1 === maxTurns → the typed exhaustion terminal, exactly 2 calls).
      maxTurns: 2,
    });
    driver.submit("write a long report");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const history = driver.getHistory();
    const notices = history.filter((h) => h.kind === "notice").map((h) => h.text);
    expect(notices.some((t) => t.includes("⚠️") && t.includes("截断"))).toBe(true);
    const answers = history.filter((h) => h.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "cut two" });
    driver.dispose();
  });
});
