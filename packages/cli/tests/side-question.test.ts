// ω99-316 — /btw 侧问引擎 + driver.sideQuestion（server op 的 driver 半边）。
// the upstream project 三宝石的 wudao 落地契约：
//   同表封禁   旁路声明与主线程完全相同的工具表（序列化字节同一）但 execute
//              全部返回结构化冻结错误——空表会丢前缀缓存（M24）；
//   每轮重克隆 follow-up 轮重新克隆最新主投影，早前侧问轮次追加其后；
//   <side_question> 标签+指令 + 保留主会话 thinking 档位（reasoning_effort）。
// M24 双证在此钉：①store 零调用（旁路绝不写 session JSONL）；②tools 序列化
// 与主 run 字节同一（JSON.stringify 全串断言）。
// 旁路 run = detached loop：克隆投影构造独立 State 跑 core loop()，maxTurns=3，
// 绝不触碰 session AgentState/JSONL/store；超轮帽给诚实尾注。
import { describe, it, expect, vi } from "vitest";
import { buildTool, toModelToolDefinition } from "@wudao/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, SessionStore, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import {
  runSideQuestion,
  snapshotForSideLane,
  stampSideModelClient,
  SIDE_TOOLS_FROZEN_RESULT,
  SIDE_QUESTION_TURNS_EXHAUSTED_NOTE,
} from "../src/side-question.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = { type: "object" as const, properties: {}, additionalProperties: false as const };

function stubTool(name = "noop"): Tool {
  return buildTool({ name, description: "stub", parameters: params, execute: async () => ({ content: "ok" }) });
}

/** Records every generate() input; answers come from a scripted tail (full
 *  assistant shapes — plain text or toolCalls — so cap/freeze lanes are
 *  scriptable). */
function scriptedLaneModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  return {
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const reply = responses[Math.min(calls, responses.length - 1)] as AssistantMessage;
      calls += 1;
      return { ...reply };
    },
  };
}

const text = (content: string): AssistantMessage => ({ role: "assistant", content });
const toolCall = (content: string, ...calls: { id: string; name: string }[]): AssistantMessage => ({
  role: "assistant",
  content,
  toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: {} })),
});

describe("side-question engine (ω99-316, prime 三宝石)", () => {
  it("M24: the side request's tools serialize BYTE-IDENTICAL to the main run's full table (same-table freeze, NOT an empty table)", async () => {
    const model = scriptedLaneModel([text("旁答：好。")]);
    const tools = [stubTool("noop"), stubTool("read_file")];
    const messages: AgentMessage[] = [
      { role: "user", content: "主任务" },
      { role: "assistant", content: "主线答" },
    ];
    await runSideQuestion({ question: "这报错什么意思？", systemPrompt: "SYS", messages, tools, model });
    expect(model.inputs.length).toBe(1);
    const input = model.inputs[0] as ModelInput;
    // The load-bearing M24 assertion: full-table serialization, byte-identical.
    expect(JSON.stringify(input.tools)).toBe(JSON.stringify(tools.map(toModelToolDefinition)));
    expect(input.tools?.length).toBe(2);
    // Prefix shared: same system prompt, same message prefix, tagged suffix.
    expect(input.systemPrompt).toBe("SYS");
    expect(input.messages.length).toBe(3);
    expect(input.messages[0]).toMatchObject({ role: "user", content: "主任务" });
    expect(input.messages[1]).toMatchObject({ role: "assistant", content: "主线答" });
    const tail = input.messages[2] as { role: string; content: string };
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("<side_question>");
    expect(tail.content).toContain("[旁问]");
    expect(tail.content).toContain("这报错什么意思？");
    expect(tail.content).toContain("不要从这里启动主会话工作");
    // Bounded, marked side lane (querySource rides the retry ladder's
    // background allowlist; maxTokens caps a runaway generation).
    expect(input.querySource).toBe("btw");
    expect(input.maxTokens).toBe(1024);
  });

  it("declared tools never execute: a tool call gets the structured frozen error and the model self-corrects next turn", async () => {
    const realExecute = vi.fn(async () => ({ content: "REAL EXECUTION MUST NOT HAPPEN" }));
    const frozenBait = buildTool({ name: "noop", description: "stub", parameters: params, execute: realExecute });
    const model = scriptedLaneModel([toolCall("", { id: "t1", name: "noop" }), text("旁答：改用上下文答。")]);
    const result = await runSideQuestion({
      question: "问",
      systemPrompt: "s",
      messages: [{ role: "user", content: "主线" }],
      tools: [frozenBait],
      model,
    });
    expect(realExecute).not.toHaveBeenCalled();
    // Turn 2's request carries the frozen tool RESULT (structured error), so
    // the model can self-correct off it.
    const second = model.inputs[1] as ModelInput;
    const toolMsg = second.messages.find((m) => m.role === "tool") as { content: string; isError?: boolean };
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe(SIDE_TOOLS_FROZEN_RESULT);
    expect(result.answer).toContain("旁答");
    expect(result.rounds).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("3-turn cap: an always-tool-calling model exhausts the cap with the honest footnote (rounds === 3)", async () => {
    const model = scriptedLaneModel([toolCall("", { id: "t", name: "noop" })]);
    const result = await runSideQuestion({
      question: "问",
      systemPrompt: "s",
      messages: [{ role: "user", content: "主线" }],
      tools: [stubTool("noop")],
      model,
    });
    expect(result.rounds).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.answer).toContain(SIDE_QUESTION_TURNS_EXHAUSTED_NOTE);
  });

  it("snapshot sanitize: mid-run half-messages (dangling/partial tool batches) never reach the side projection", () => {
    const a1 = toolCall("partial", { id: "t1", name: "n" }, { id: "t2", name: "n" });
    const a2 = toolCall("", { id: "t9", name: "n" });
    const a3 = toolCall("", { id: "t5", name: "n" });
    // Partial batch: owner announced 2 calls, only 1 result landed.
    expect(
      snapshotForSideLane([
        { role: "user", content: "u" },
        a1,
        { role: "tool", toolCallId: "t1", name: "n", content: "r1" },
      ]),
    ).toEqual([{ role: "user", content: "u" }]);
    // Dangling: owner announced, zero results (loop parked mid-tool).
    expect(snapshotForSideLane([{ role: "user", content: "u" }, a2])).toEqual([{ role: "user", content: "u" }]);
    // Complete batch + later text: kept whole.
    expect(
      snapshotForSideLane([
        { role: "user", content: "u" },
        a3,
        { role: "tool", toolCallId: "t5", name: "n", content: "r" },
        { role: "assistant", content: "done" },
      ]).length,
    ).toBe(4);
    // Empty input is empty.
    expect(snapshotForSideLane([])).toEqual([]);
  });

  it("detached: the caller's state array is never mutated", async () => {
    const model = scriptedLaneModel([text("旁答")]);
    const messages: AgentMessage[] = [{ role: "user", content: "主线" }];
    const before = JSON.stringify(messages);
    await runSideQuestion({ question: "问", systemPrompt: "s", messages, tools: [], model });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("prior side turns ride AFTER the fresh main projection (per-round re-clone), before the new envelope", async () => {
    const model = scriptedLaneModel([text("旁答二")]);
    const prior: AgentMessage[] = [
      { role: "user", content: "[旁问] 问一" },
      { role: "assistant", content: "旁答一" },
    ];
    await runSideQuestion({
      question: "问二",
      systemPrompt: "s",
      messages: [{ role: "user", content: "最新主线" }],
      priorTurns: prior,
      tools: [],
      model,
    });
    const input = model.inputs[0] as ModelInput;
    expect(input.messages.map((m) => (m.role === "user" || m.role === "assistant" ? m.content : ""))).toEqual([
      "最新主线",
      "[旁问] 问一",
      "旁答一",
      expect.stringContaining("问二") as unknown as string,
    ]);
  });

  it("effort passthrough: the stamp threads reasoningEffort when present, omits the key when absent", async () => {
    const seen: ModelInput[] = [];
    const base: ModelClient = { async generate(i: ModelInput) { seen.push(i); return text("ok"); } };
    const withEffort = stampSideModelClient(base, "high");
    await withEffort.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(seen[0]?.reasoningEffort).toBe("high");
    expect(seen[0]?.querySource).toBe("btw");
    expect(seen[0]?.maxTokens).toBe(1024);
    const withoutEffort = stampSideModelClient(base, undefined);
    await withoutEffort.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect((seen[1] as ModelInput).reasoningEffort).toBeUndefined();
  });
});

describe("driver.sideQuestion (ω99-316 op lane)", () => {
  it("M24: the side lane makes ZERO sessionStore calls (never writes session JSONL)", async () => {
    const fns = new Map<string, ReturnType<typeof vi.fn>>();
    const store = new Proxy({} as SessionStore, {
      get: (_t, k: string) => {
        if (typeof k !== "string" || k === "then") return undefined;
        if (!fns.has(k)) {
          // Array-shaped reads resolve []; everything else resolves void —
          // the MAIN run persists through this store, the side lane must
          // not add a single call to it.
          const ret = k === "load" || k === "loadSessionEntries" || k === "list" ? Promise.resolve([]) : Promise.resolve(undefined);
          fns.set(k, vi.fn().mockReturnValue(ret));
        }
        return fns.get(k);
      },
    }) as SessionStore;
    const totalCalls = () => [...fns.values()].reduce((n, f) => n + f.mock.calls.length, 0);
    const model = scriptedLaneModel([text("主线答"), text("旁答：答了")]);
    const driver = createAgentDriver({
      model, tools: [], systemPrompt: "s", summarize: summarizeToolCall, sessionStore: store, sessionId: "s1",
    });
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "main run");
    const callsBefore = totalCalls();
    expect(callsBefore).toBeGreaterThan(0); // the MAIN run persists — the side lane must not add to it
    const out = await driver.sideQuestion("s1", "顺手问一句");
    expect(out.answer).toContain("旁答");
    expect(typeof out.rounds).toBe("number");
    expect(totalCalls()).toBe(callsBefore);
    driver.dispose();
  });

  it("busy: answers mid-run without taking the run lock; the main run still completes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = buildTool({
      name: "grep", description: "gated read", parameters: params,
      execute: async () => { await gate; return { content: "GATED" }; },
    });
    const inputs: ModelInput[] = [];
    let calls = 0;
    const realModel: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        calls += 1;
        if (calls === 1) return toolCall("", { id: "t1", name: "grep" });
        if (calls === 2) return text("旁答：主任务还在跑，先答你。");
        return text("主线完成");
      },
    };
    const driver = createAgentDriver({
      model: realModel, tools: [gated], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s1",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("main task");
    await until(() => driver.getStatus().busy === true, "run starts");
    const sideP = driver.sideQuestion("s1", "现在怎么样了？");
    const out = await sideP;
    expect(out.answer).toContain("旁答");
    expect(driver.getStatus().busy).toBe(true); // main run STILL going
    release?.();
    await until(() => driver.getStatus().busy === false, "main run finishes");
    const answers = driver.getHistory().filter((e) => e.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "主线完成" });
    driver.dispose();
  });

  it("per-round re-clone: follow-up carries the LATEST main projection plus prior side turns", async () => {
    const inputs: ModelInput[] = [];
    let calls = 0;
    const replies = [text("主线答一"), text("旁答一"), text("主线答二"), text("旁答二")];
    const realModel: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        return { ...(replies[calls++] as AssistantMessage) };
      },
    };
    const driver = createAgentDriver({ model: realModel, tools: [], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s1" });
    driver.submit("第一问");
    await until(() => driver.getStatus().busy === false, "main 1");
    await driver.sideQuestion("s1", "问一");
    driver.submit("第二问");
    await until(() => driver.getStatus().busy === false, "main 2");
    await driver.sideQuestion("s1", "问二");
    const side2 = inputs[3] as ModelInput;
    const contents = side2.messages.map((m) => (m.role === "tool" ? m.content : (m as { content: string }).content));
    const idxLatest = contents.findIndex((c) => c.includes("主线答二"));
    const idxPriorSide = contents.findIndex((c) => c.includes("旁答一"));
    const idxEnvelope = contents.findIndex((c) => c.includes("问二"));
    expect(idxLatest).toBeGreaterThanOrEqual(0);
    expect(idxPriorSide).toBeGreaterThan(idxLatest);
    expect(idxEnvelope).toBeGreaterThan(idxPriorSide);
    driver.dispose();
  });

  it("guards: empty text rejects; wrong session rejects", async () => {
    const model = scriptedLaneModel([text("x")]);
    const driver = createAgentDriver({ model, tools: [], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s1" });
    await expect(driver.sideQuestion("s1", "   ")).rejects.toThrow();
    await expect(driver.sideQuestion("other-session", "问")).rejects.toThrow();
    driver.dispose();
  });

  it("effort: the session's live thinking level threads through to the side request", async () => {
    const model = scriptedLaneModel([text("主线答"), text("旁答")]);
    const driver = createAgentDriver({
      model, tools: [], systemPrompt: "s", summarize: summarizeToolCall,
      sessionId: "s1", sessionMeta: { effort: "high" },
    });
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "main run");
    await driver.sideQuestion("s1", "问");
    const sideInput = model.inputs.at(-1) as ModelInput;
    expect(sideInput.reasoningEffort).toBe("high");
    driver.dispose();
  });
});
