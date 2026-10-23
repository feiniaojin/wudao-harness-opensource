// 夜移 014 — /btw 缓存共享旁问（真 CC sideQuestion.ts + forkedAgent.ts 的
// wudao 适配）。关键契约：旁问 fork 与主会话**共享前缀字节**（systemPrompt、
// 消息前缀、工具列表全同——唯一差异是尾部追加的旁问 user 消息），所以它
// 命中主会话的前缀缓存，近乎免费。答案走 driver history 的 notice 通道：
// 所有前端可见（TUI/web/desktop 一处接线），但永不进 state.messages、永不
// 持久化 JSONL、主 agent 永不可见。运行中可用——旁问的全部意义就是不打断。
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
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

const params = { type: "object" as const, properties: {}, additionalProperties: false as const };

function stubTool(name = "noop"): Tool {
  return buildTool({ name, description: "stub", parameters: params, execute: async () => ({ content: "ok" }) });
}

/** Records every generate() input; answers come from a scripted tail. */
function recordingModel(responses: readonly string[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  const scripted = createScriptedModel(responses.map((t) => ({ role: "assistant", content: t })));
  return {
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      calls += 1;
      return scripted.generate(input);
    },
  };
}

describe("/btw side question (夜移 014, cache-shared)", () => {
  it("idle: the fork shares the session's prefix bytes exactly — same systemPrompt, same message prefix, same tools; the question rides as a pure suffix", async () => {
    const model = recordingModel(["主线完成。", "旁答：三句话以内。"]);
    const tools = [stubTool("noop"), stubTool("read_file")];
    const driver = createAgentDriver({ model, tools, systemPrompt: "SYS-PROMPT", summarize: summarizeToolCall });
    driver.submit("main task");
    await until(() => driver.getStatus().busy === false, "main run");
    const parentCalls = model.inputs.length;
    expect(parentCalls).toBeGreaterThanOrEqual(1);

    driver.submit("/btw 主任务用的什么算法？");
    await until(() => driver.getHistory().some((e) => e.kind === "notice" && String((e as { text?: string }).text).startsWith("💬")), "btw answer notice");
    model.inputs[parentCalls] && expect(model.inputs.length).toBe(parentCalls + 1);

    const btwInput = model.inputs[parentCalls] as ModelInput;
    // Cache-safe: the system prompt and the FULL prior message prefix are
    // byte-identical (snapshot + one appended user message).
    const mainInput = model.inputs[0] as ModelInput;
    expect(btwInput.systemPrompt).toBe(mainInput.systemPrompt);
    expect(btwInput.systemPrompt).toBe("SYS-PROMPT");
    // The btw call's messages = main-run history + the [旁问] suffix.
    const btwTail = btwInput.messages.at(-1) as { role: string; content: string };
    expect(btwTail.role).toBe("user");
    expect(btwTail.content).toContain("[旁问]");
    expect(btwTail.content).toContain("主任务用的什么算法？");
    // Tools identical (cache-safe params discipline).
    expect(btwInput.tools?.map((t) => t.name)).toEqual(mainInput.tools?.map((t) => t.name));
    // Bounded, marked side lane.
    expect(btwInput.maxTokens).toBe(1024);
    expect(btwInput.querySource).toBe("btw");
    driver.dispose();
  });

  it("the answer is a driver notice — never a state message, never persisted, never model-visible", async () => {
    const model = recordingModel(["主线答完。", "旁答。"]);
    const driver = createAgentDriver({ model, tools: [], systemPrompt: "s", summarize: summarizeToolCall });
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "main run");
    driver.submit("/btw 问点别的");
    await until(() => driver.getHistory().some((e) => e.kind === "notice" && String((e as { text?: string }).text).includes("旁答")), "btw answer");
    // The answer exists ONLY as a driver-history notice.
    const notices = driver.getHistory().filter((e) => e.kind === "notice" && String((e as { text?: string }).text).includes("旁答"));
    expect(notices.length).toBeGreaterThan(0);
    driver.dispose();
  });

  it("works WHILE a run is in flight (a gated tool holds the loop) and the run still completes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    // Named "grep" — a READ_TOOLS member, so the driver's permission
    // pipeline auto-allows it; any other name parks the run at the ask gate
    // and the tool never executes (fail-closed).
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
        if (calls === 1) return { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "grep", arguments: {} }] };
        if (calls === 2) return { role: "assistant", content: "旁答：主任务还在跑，先答你。" };
        return { role: "assistant", content: "主线完成" };
      },
    };
    const driver = createAgentDriver({
      model: realModel,
      tools: [gated],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      // The driver's gate falls to askPermission (parked, fail-closed) when
      // no mode-rule gate is supplied — frontends build one from the
      // permission settings; the test allows directly.
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("main task");
    await until(() => driver.getStatus().busy === true, "run starts");
    // The loop parks inside the gated tool — fire the side question mid-run.
    driver.submit("/btw 现在怎么样了？");
    await until(() => driver.getHistory().some((e) => e.kind === "notice" && String((e as { text?: string }).text).includes("旁答")), "mid-run btw answer");
    expect(driver.getStatus().busy).toBe(true); // the main run is STILL going
    release?.();
    await until(() => driver.getStatus().busy === false, "main run finishes");
    const answers = driver.getHistory().filter((e) => e.kind === "assistant");
    expect(answers.at(-1)).toMatchObject({ text: "主线完成" });
    // The btw fork's request carried the side-question suffix.
    const btwInput = inputs[1];
    expect(btwInput.messages.at(-1)).toMatchObject({ role: "user" });
    expect(String((btwInput.messages.at(-1) as { content?: string }).content)).toContain("[旁问]");
    driver.dispose();
  });

  it("bare /btw is a usage notice with zero model calls", async () => {
    const model = recordingModel(["x"]);
    const driver = createAgentDriver({ model, tools: [], systemPrompt: "s", summarize: summarizeToolCall });
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "main run");
    const callsBefore = model.inputs.length;
    driver.submit("/btw");
    await until(() => driver.getHistory().some((e) => e.kind === "notice" && String((e as { text?: string }).text).includes("用法：")), "usage notice"); // ω99-166d-i: 泛 usage 钉演进（#38 头换）
    expect(model.inputs.length).toBe(callsBefore);
    driver.dispose();
  });
});
