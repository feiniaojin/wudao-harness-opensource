import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// 夜移 001（2026-08-28 night porting，dsh interrupted-stream finalization）：
// 用户中止一条已流出 delta 的回答时，已送达的文本/推理前缀必须落为一条
// `interrupted` 助手消息 —— 人类转录与 UI 所见一致，resume/replay 保持有效；
// 下一轮请求把它当作 append-only 后缀（M24：前缀字节永不改写，`interrupted`
// 只进持久化，不上 wire）。未流出任何 delta 的中止维持旧行为：什么都不追加。

async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** A streaming model that yields `deltas`, then parks until the request's
 *  abort signal fires and rejects with AbortError — the "user hit stop
 *  mid-stream" shape. */
function abortingStreamModel(deltas: ModelStreamEvent[]): ModelClient {
  return {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      for (const d of deltas) yield d;
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    },
  };
}

function messages(...ms: AgentMessage[]) {
  return ms;
}

describe("interrupted-stream finalization (夜移 001)", () => {
  it("abort mid-stream commits the delivered text prefix as an interrupted assistant message", async () => {
    const controller = new AbortController();
    const model = abortingStreamModel([
      { type: "text_delta", text: "已经流出的" },
      { type: "text_delta", text: "部分回答" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: messages({ role: "user", content: "go" }),
      tools: [],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10)); // let the loop park inside the model stream
    controller.abort();
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    // The delivered prefix is committed — the transcript keeps what streamed.
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已经流出的部分回答",
      interrupted: true,
    });
    expect(state.messages.length).toBe(2);
    // Frontends that don't track deltas get the final text via the event.
    const ev = events.find((e) => e.type === "assistant_interrupted") as
      | Extract<LoopEvent, { type: "assistant_interrupted" }>
      | undefined;
    expect(ev).toBeDefined();
    expect(ev?.text).toBe("已经流出的部分回答");
    expect(ev?.hasReasoning).toBe(false);
  });

  it("abort before any delta appends nothing (legacy behavior)", async () => {
    const controller = new AbortController();
    const model = abortingStreamModel([]);
    const state = {
      systemPrompt: "s",
      messages: messages({ role: "user", content: "go" }),
      tools: [],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    expect(state.messages.length).toBe(1);
    expect(state.messages.at(-1)).toMatchObject({ role: "user", content: "go" });
    expect(events.some((e) => e.type === "assistant_interrupted")).toBe(false);
  });

  it("reasoning-only abort keeps the thinking prefix (content empty)", async () => {
    const controller = new AbortController();
    const model = abortingStreamModel([{ type: "reasoning_delta", text: "推理前缀" }]);
    const state = {
      systemPrompt: "s",
      messages: messages({ role: "user", content: "go" }),
      tools: [],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: "推理前缀",
      interrupted: true,
    });
    const ev = events.find((e) => e.type === "assistant_interrupted") as
      | Extract<LoopEvent, { type: "assistant_interrupted" }>
      | undefined;
    expect(ev?.hasReasoning).toBe(true);
  });

  it("a completed stream never sets the interrupted flag", async () => {
    const model: ModelClient = {
      generate: () => {
        throw new Error("should not be called");
      },
      async *stream() {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", message: { role: "assistant", content: "完成" } };
      },
    };
    const state = {
      systemPrompt: "s",
      messages: messages({ role: "user", content: "hi" }),
      tools: [],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "完成" });
    expect((state.messages.at(-1) as { interrupted?: boolean }).interrupted).toBeUndefined();
  });
});
