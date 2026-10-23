// 133 #5（codex 8bd5a136ff 引进）— content_filter 恢复指导收据。
// 被拦→注入指导+continue；一次性（同 run 不重复）；注入后模型可见；
// 指导文本不含被拦内容原文（注入卫生）；stopReason 非 content_filter 零动作。
import { describe, expect, it } from "vitest";
import { runAgentLoop, type ModelClient, type LoopEvent } from "../src/index.js";
import { CONTENT_FILTER_GUIDANCE } from "../src/loop-synthetics.js";
import type { AgentState, ModelStreamEvent } from "../src/index.js";

const state = (msgs: AgentState["messages"]): AgentState => ({
  systemPrompt: "s",
  messages: msgs,
  tools: [],
  status: "idle",
});

/** A streaming model whose FIRST call ends with content_filter, second answers. */
function filteredModel(): ModelClient & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  let call = 0;
  return {
    inputs,
    async *stream(input) {
      inputs.push(input);
      call += 1;
      if (call === 1) {
        yield { type: "text_delta", text: "被拦的半截" } as ModelStreamEvent;
        yield { type: "done", message: { role: "assistant", content: "被拦的半截", stopReason: "content_filter" } } as ModelStreamEvent;
        return;
      }
      yield { type: "done", message: { role: "assistant", content: "OK" } } as ModelStreamEvent;
    },
  } as never;
}

async function drain(gen: AsyncGenerator<LoopEvent, { reason: string }>) {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

describe("133 #5 — content_filter 恢复指导", () => {
  it("被拦→注入指导→下一轮模型可见指导文本", async () => {
    const model = filteredModel();
    const st = state([{ role: "user", content: "go" }]);
    const { events, terminal } = await drain(runAgentLoop(st, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    // 指导事件恰一枚
    const guided = events.filter((e) => e.type === "content_filter_guided");
    expect(guided.length).toBe(1);
    // 指导注入为 state 的 user 消息
    expect(st.messages.some((m) => m.role === "user" && m.content === CONTENT_FILTER_GUIDANCE)).toBe(true);
    // 第二轮模型请求包含指导文本
    const secondCall = (model.inputs as { messages: { role: string; content: string }[] }[])[1]!;
    expect(secondCall.messages.some((m) => m.role === "user" && m.content === CONTENT_FILTER_GUIDANCE)).toBe(true);
  });

  it("一次性：连续两次被拦也只注入一条指导", async () => {
    const inputs: unknown[] = [];
    let call = 0;
    const model: ModelClient = {
      async *stream(input) {
        inputs.push(input);
        call += 1;
        if (call <= 2) {
          yield { type: "done", message: { role: "assistant", content: "拦", stopReason: "content_filter" } } as ModelStreamEvent;
          return;
        }
        yield { type: "done", message: { role: "assistant", content: "OK" } } as ModelStreamEvent;
      },
    } as never;
    const st = state([{ role: "user", content: "go" }]);
    const { events } = await drain(runAgentLoop(st, model, { maxTurns: 4 }));
    expect(events.filter((e) => e.type === "content_filter_guided").length).toBe(1);
    // 指导消息在 state 里恰一条
    expect(st.messages.filter((m) => m.role === "user" && m.content === CONTENT_FILTER_GUIDANCE).length).toBe(1);
  });

  it("注入卫生：指导文本不引用被拦内容原文", () => {
    const intercepted = "被拦的半截"; // 测试夹具的被拦文本
    expect(CONTENT_FILTER_GUIDANCE).not.toContain(intercepted);
    // 指导文本 ≤ 512 字节（codex 同帽）
    expect(Buffer.byteLength(CONTENT_FILTER_GUIDANCE, "utf8")).toBeLessThanOrEqual(512);
    // 三条纪律关键词在场
    expect(CONTENT_FILTER_GUIDANCE).toContain("不要");
    expect(CONTENT_FILTER_GUIDANCE).toContain("替代");
    expect(CONTENT_FILTER_GUIDANCE).toContain("转到");
  });

  it("stopReason 非 content_filter（length/正常）→ 零注入零事件", async () => {
    const model: ModelClient = {
      async *stream() {
        yield { type: "done", message: { role: "assistant", content: "正常回答" } } as ModelStreamEvent;
      },
    } as never;
    const st = state([{ role: "user", content: "go" }]);
    const { events } = await drain(runAgentLoop(st, model, { maxTurns: 2 }));
    expect(events.filter((e) => e.type === "content_filter_guided").length).toBe(0);
    expect(st.messages.some((m) => m.role === "user" && m.content === CONTENT_FILTER_GUIDANCE)).toBe(false);
  });
});
