// 113-A5 —— 投影后置不变量钉（the upstream project0.87.0 裁决引进：冻结契约测试）。
//
// the upstream project的故障形：一个 context 扩展在过滤消息时，把系统提示与工具声明连带
// 丢掉，请求“缺内置工具”仍然发出。wudao 当前未必有此 bug——本文件是把
// 不变量钉死为契约，防未来：任何投影缝（默认投影 / defer 工具集投影 /
// 压缩边界改写 / 冷窗清理）过后的每个 ModelInput 必须满足——
//   I1. systemPrompt 非空且字节稳定（等于 state.systemPrompt，逐字节）；
//   I2. tools 列表齐全：名字序列（数+顺序）与该缝契约一致；
//   I3. 前缀确定性：同一 state 二次投影，messages 序列化字节逐一致；
//   I4. （默认投影额外）append-only：后一请求的 messages 以前一请求为
//       逐字节前缀——压缩/清理缝是声明的合法改写点，不适用 I4。
// 夹具沿用 defer.test.ts / compaction-carryover.test.ts 的既有惯用法
//（scripted recordingModel + runAgentLoop + drain），不发明新夹具。
//
// 场景映射注记：裁决原文的场景 (d) 是“TTL 冷窗清理”。wudao 无时钟 TTL
// 冷窗；位置语义上的等价物是 tier-0 clear（>30k 的旧工具结果被替换为
// CLEARED_MARKER——冷段内容清理）与 emergency drop。本文件钉 tier-0；
// 不变量同构：清理改写 messages 的同时，系统提示与工具声明必须在位。
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/tool.js";
import { LOAD_TOOLS_NAME } from "../src/defer.js";
import { SUMMARY_MARKER, CLEARED_MARKER } from "../src/compaction.js";
import type { LoopEvent, Terminal } from "../src/loop.js";
import type { AgentState } from "../src/state.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import type { Tool } from "../src/tool.js";

const SYS = "你是 wudao。冻结契约：系统提示与工具声明不随投影丢失。𠮷";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** Scripted responses in call order; records every ModelInput it receives. */
function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });

function eagerTool(name: string, result = `${name} ran`): Tool {
  return buildTool({
    name,
    description: `Tool ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return { content: result };
    },
  });
}

function deferredOrchestrator(name: string): Tool {
  return buildTool({
    name,
    description: `Orchestration tool ${name}. Launches work.`,
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The work." } },
      required: ["prompt"],
      additionalProperties: false,
    },
    shouldDefer: () => true,
    async execute() {
      return { content: `${name} ran` };
    },
  });
}

const stateWith = (tools: readonly Tool[], messages: AgentState["messages"]): AgentState => ({
  systemPrompt: SYS,
  messages,
  tools: [...tools],
  status: "idle",
});

const names = (input: ModelInput | undefined): string[] => (input?.tools ?? []).map((t) => t.name);
const bytes = (input: ModelInput): string => JSON.stringify({ systemPrompt: input.systemPrompt, messages: input.messages, tools: input.tools });

/** I1+I2：每个投影产物——系统提示字节在位、工具名字序列齐全且有序。 */
function assertCoreInvariants(inputs: readonly ModelInput[], expectedTools: readonly string[], label: string): void {
  expect(inputs.length, `${label}: 至少一次模型调用`).toBeGreaterThan(0);
  for (const input of inputs) {
    expect(input.systemPrompt.length > 0, `${label}: I1 系统提示非空`).toBe(true);
    expect(input.systemPrompt, `${label}: I1 系统提示字节稳定`).toBe(SYS);
    expect(names(input), `${label}: I2 工具序列（数+顺序）`).toEqual([...expectedTools]);
  }
}

/** I3：同一 state 二次投影逐字节一致（确定性）。 */
async function assertDeterministic(
  make: () => { state: AgentState; model: ModelClient & { inputs: ModelInput[] } },
  options: Parameters<typeof runAgentLoop>[2],
  label: string,
): Promise<ModelInput[]> {
  const first = make();
  await drain(runAgentLoop(first.state, first.model, options));
  const second = make();
  await drain(runAgentLoop(second.state, second.model, options));
  expect(second.model.inputs.length, `${label}: 两次运行调用数一致`).toBe(first.model.inputs.length);
  for (let i = 0; i < first.model.inputs.length; i++) {
    expect(bytes(second.model.inputs[i]!), `${label}: I3 第 ${i} 次投影字节一致`).toBe(bytes(first.model.inputs[i]!));
  }
  return first.model.inputs;
}

// ---------------------------------------------------------------------------
// (a) 默认投影
// ---------------------------------------------------------------------------
describe("113-A5 投影后置不变量：默认投影", () => {
  const tools = () => [eagerTool("alpha"), eagerTool("beta"), eagerTool("gamma")];
  const responses = (): AssistantMessage[] => [call("c1", "beta", {}), { role: "assistant", content: "done" }];
  const options = { maxTurns: 4, gates: { todo: false, verify: false } };

  it("I1+I2：系统提示字节在位、工具序列齐全（每个请求）", async () => {
    const { state, model } = { state: stateWith(tools(), [{ role: "user", content: "go" }]), model: recordingModel(responses()) };
    await drain(runAgentLoop(state, model, options));
    assertCoreInvariants(model.inputs, ["alpha", "beta", "gamma"], "默认投影");
  });

  it("I3+I4：同 state 二次投影逐字节一致；默认投影 append-only（前缀单调）", async () => {
    const inputs = await assertDeterministic(
      () => ({ state: stateWith(tools(), [{ role: "user", content: "go" }]), model: recordingModel(responses()) }),
      options,
      "默认投影",
    );
    expect(inputs.length).toBe(2);
    // 数组序列化尾随 "]"，前缀单调按条目逐字节比较（loop-reflection.test 惯用法）。
    const prior = inputs[0]!.messages;
    expect(JSON.stringify(inputs[1]!.messages.slice(0, prior.length)), "I4 旧消息条目逐字节不变").toBe(JSON.stringify(prior));
  });
});

// ---------------------------------------------------------------------------
// (b) 带 defer（工具集投影缝）
// ---------------------------------------------------------------------------
describe("113-A5 投影后置不变量：defer 工具集投影", () => {
  const tools = () => [eagerTool("a"), deferredOrchestrator("task"), deferredOrchestrator("agent_await"), eagerTool("b")];
  const responses = (): AssistantMessage[] => [
    call("c1", LOAD_TOOLS_NAME, { names: ["agent_await", "task"] }),
    { role: "assistant", content: "done" },
  ];
  const options = { maxTurns: 4, gates: { todo: false, verify: false } };

  it("I1+I2：工具集改写（load 后缀追加）不丢系统提示、不丢既有工具声明", async () => {
    const { state, model } = { state: stateWith(tools(), [{ role: "user", content: "go" }]), model: recordingModel(responses()) };
    await drain(runAgentLoop(state, model, options));
    // 首请求：基集 + load_tools 尾；次请求：已加载定义后缀追加（顺序钉死）。
    assertCoreInvariants(model.inputs.slice(0, 1), ["a", "b", LOAD_TOOLS_NAME], "defer·首请求");
    assertCoreInvariants(model.inputs.slice(1), ["a", "b", LOAD_TOOLS_NAME, "task", "agent_await"], "defer·load 后");
  });

  it("I3：同 state 二次投影逐字节一致（含工具集改写缝两侧）", async () => {
    await assertDeterministic(
      () => ({ state: stateWith(tools(), [{ role: "user", content: "go" }]), model: recordingModel(responses()) }),
      options,
      "defer",
    );
  });
});

// ---------------------------------------------------------------------------
// (c) 带压缩边界（tier-2 LLM 摘要改写 messages 前缀）
// ---------------------------------------------------------------------------
describe("113-A5 投影后置不变量：压缩边界", () => {
  const tools = () => [eagerTool("echo")];
  const bigMessages = (): AgentState["messages"] => [
    { role: "user", content: "task 0 " + "x".repeat(2000) },
    { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
    { role: "user", content: "task 1 " + "x".repeat(2000) },
    { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
    { role: "user", content: "go" },
  ];
  const responses = (): AssistantMessage[] => [
    call("e1", "echo", {}),
    { role: "assistant", content: "SUMMARY" },
    { role: "assistant", content: "done" },
  ];
  const options = { maxTurns: 4, gates: { todo: false, verify: false }, compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false } };

  it("前提：tier-2 压缩确实发生；I1+I2：边界后（含摘要调用自身）系统提示与工具声明在位", async () => {
    const { state, model } = { state: stateWith(tools(), bigMessages()), model: recordingModel(responses()) };
    const { events } = await drain(runAgentLoop(state, model, options));
    if (events.find((e) => e.type === "compacted" && e.tier === 2) === undefined) {
      throw new Error("test premise failed: no tier-2 compaction");
    }
    // 每个记录到的调用（agent 轮 + 摘要器调用）都必须带全系统提示与工具声明。
    assertCoreInvariants(model.inputs, ["echo"], "压缩边界");
    // 边界后的 agent 请求以冻结摘要消息开头（合法前缀改写点）。
    const post = model.inputs[model.inputs.length - 1]!;
    expect((post.messages[0] as { content?: string }).content?.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it("I3：同 state 二次投影逐字节一致（压缩边界两侧）", async () => {
    await assertDeterministic(
      () => ({ state: stateWith(tools(), bigMessages()), model: recordingModel(responses()) }),
      options,
      "压缩边界",
    );
  });
});

// ---------------------------------------------------------------------------
// (d) 冷窗清理（tier-0 clear：>30k 旧工具结果替换为 CLEARED_MARKER）
// ---------------------------------------------------------------------------
describe("113-A5 投影后置不变量：冷窗清理（tier-0 clear）", () => {
  const tools = () => [eagerTool("heavy"), eagerTool("lite")];
  // 巨结果预置于历史（上回合遗留），后面还有交换——keepRecent(1) 保护不到它，
  // 边界梯子第一档（free clear）就能命中，无需摘要器。
  const seed = (): AgentState["messages"] => [
    { role: "user", content: "seed q1 " + "x".repeat(400) },
    { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "heavy", arguments: {} }] },
    { role: "tool", toolCallId: "c0", name: "heavy", content: "h".repeat(31_000) },
    { role: "assistant", content: "seed a1 " + "y".repeat(400) },
    { role: "user", content: "go" },
  ];
  const responses = (): AssistantMessage[] => [call("c1", "lite", {}), { role: "assistant", content: "done" }];
  const options = { maxTurns: 4, gates: { todo: false, verify: false }, compaction: { contextWindowTokens: 2_000, keepRecent: 1, zeroLlmDigest: false } };

  it("前提：tier-0 清理确实发生；I1+I2：清理改写 messages 的同时系统提示与工具声明在位", async () => {
    const { state, model } = { state: stateWith(tools(), seed()), model: recordingModel(responses()) };
    const { events } = await drain(runAgentLoop(state, model, options));
    if (events.find((e) => e.type === "compacted" && e.tier === 0) === undefined) {
      const tiers = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted").map((e) => e.tier);
      throw new Error(`test premise failed: no tier-0 clear (compacted tiers seen: ${JSON.stringify(tiers)})`);
    }
    assertCoreInvariants(model.inputs, ["heavy", "lite"], "冷窗清理");
    // 清理后的请求里，旧巨结果已是确定性 CLEARED_MARKER（内容清理，非丢消息）。
    const post = model.inputs[model.inputs.length - 1]!;
    expect(post.messages.some((m) => m.role === "tool" && m.content.includes(CLEARED_MARKER))).toBe(true);
  });

  it("I3：同 state 二次投影逐字节一致（清理缝之后）", async () => {
    await assertDeterministic(
      () => ({ state: stateWith(tools(), seed()), model: recordingModel(responses()) }),
      options,
      "冷窗清理",
    );
  });
});
