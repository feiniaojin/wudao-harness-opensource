import { describe, it, expect } from "vitest";
import { runAgentLoop, createStreamPreemptChannel, type LoopEvent, type Terminal } from "../src/index.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// 124b 项 1（codex instant_interrupt）——流抢占。
//
// steering 只能在模型调用边界落地的问题：DeepSeek/GLM 的长 reasoning 流期
// 间（可达数分钟）用户的新指令只能排队干等。streamPreempt 通道让 busy-
// submit 即时中断在飞模型流：被弃 partial 不进转录/JSONL/模型所见（M24：
// 下一次请求的前缀 = 原 append-only 历史 + steering user 消息），量与时
// 刻走 stream_preempted 事件的旁路审计，循环立即续跑注入新指令。
//
// 与 夜移 001（interrupted-stream.test.ts）的分界：那是【运行中止】——已
// 送达前缀提交为 interrupted 助手消息（转录保真）；这是【调用抢占】——前
// 缀彻底丢弃（模型永远不知道自己被打断过，除非 Phase B 的 MetaNote 告诉
// 它）。两套语义并存，归类面 = 运行 signal 是否触发。

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

function messages(...ms: AgentMessage[]) {
  return ms;
}

/** The preemptable fake: call 1 streams `deltas` then parks until the request's
 *  (composite) abort signal fires and rejects with AbortError — the provider
 *  seam's shape on a preempted stream; later calls complete normally. Every
 *  call's input (messages included) is recorded. */
function preemptableModel(deltas: ModelStreamEvent[], laterAnswer: string): {
  model: ModelClient;
  calls: ModelInput[];
} {
  const calls: ModelInput[] = [];
  const model: ModelClient = {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      calls.push(input);
      if (calls.length === 1) {
        for (const d of deltas) yield d;
        await new Promise<never>((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          );
        });
      }
      yield { type: "done", message: { role: "assistant", content: laterAnswer } };
    },
  };
  return { model, calls };
}

const baseState = (first: string) => ({
  systemPrompt: "s",
  messages: messages({ role: "user", content: first }),
  tools: [],
  status: "idle" as const,
});

describe("stream preemption (124b 项 1, codex instant_interrupt)", () => {
  it("busy-submit preempts the in-flight stream: steer lands, dropped partial never enters the model context", async () => {
    const channel = createStreamPreemptChannel();
    const queue: string[] = [];
    const { model, calls } = preemptableModel(
      [
        { type: "reasoning_delta", text: "思考前缀" },
        { type: "text_delta", text: "部分回答" },
      ],
      "新答",
    );
    const state = baseState("go");

    const drained = drain(runAgentLoop(state, model, {
      maxTurns: 5,
      streamPreempt: channel,
      steering: { take: () => queue.shift() },
    }));
    await new Promise((r) => setTimeout(r, 10)); // let the loop park inside the model stream
    queue.push("新的指令"); // the driver parks the text…
    channel.request(); // …then fires the preempt trigger
    const { events, terminal } = await drained;

    // The run CONTINUED (never aborted): the steer became the next user turn
    // and the second call answered it.
    expect(terminal.reason).toBe("completed");
    if (terminal.reason === "completed") expect(terminal.finalMessage.content).toBe("新答");
    expect(calls.length).toBe(2);

    // M24 (the load-bearing assertion): the second call's input is the prior
    // append-only history + the steering user message — the dropped partial
    // appears NOWHERE (no interrupted message, no reasoning, no text).
    // The THIRD user is the Phase B MetaNote riding the notes projection's
    // degraded channel (no tool_result tail → a projected trailing user
    // message, loop.ts projectNotes) — projection-only, never persisted
    // (the state assertion below is the persistence boundary).
    const second = calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect((second[0] as { content: string }).content).toBe("go");
    expect((second[1] as { content: string }).content).toBe("新的指令");
    const flat = JSON.stringify(second);
    expect(flat).not.toContain("部分回答");
    expect(flat).not.toContain("思考前缀");

    // The transcript kept nothing of the abandoned prefix either.
    expect(state.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    const stateFlat = JSON.stringify(state.messages);
    expect(stateFlat).not.toContain("部分回答");
    expect(stateFlat).not.toContain("思考前缀");

    // The steered text was consumed through the normal drain channel.
    const steered = events.filter((e) => e.type === "steered");
    expect(steered.length).toBe(1);

    // The side-channel audit event: byte counts + timestamp, no content.
    const preempted = events.find((e) => e.type === "stream_preempted") as
      | Extract<LoopEvent, { type: "stream_preempted" }>
      | undefined;
    expect(preempted).toBeDefined();
    expect(preempted?.droppedTextChars).toBe("部分回答".length);
    expect(preempted?.droppedReasoningChars).toBe("思考前缀".length);
    expect(typeof preempted?.preemptedAt).toBe("string");
    // The audit event carries COUNTS, never the bytes. (The live delta events
    // ABOVE the preempt in this list do carry them — they streamed to the UI
    // before the interrupt; that's the streaming surface, not the audit.
    // "Never enters the model context / transcript" is pinned by the calls[]
    // and state.messages assertions above.)
    expect(JSON.stringify(preempted)).not.toContain("部分回答");
    expect(JSON.stringify(preempted)).not.toContain("思考前缀");

    // Phase B: the next call carries the interrupted MetaNote (projection-
    // only): the model learns WHY the context may feel incomplete.
    expect(flat).toContain("interrupted by the user");
  });

  it("no preempt request → the stream completes normally (the channel alone changes nothing)", async () => {
    const channel = createStreamPreemptChannel();
    const model: ModelClient = {
      generate: () => {
        throw new Error("should not be called");
      },
      async *stream() {
        yield { type: "text_delta", text: "完整" };
        yield { type: "done", message: { role: "assistant", content: "完整" } };
      },
    };
    const state = baseState("hi");
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      streamPreempt: channel,
      steering: { take: () => undefined },
    }));

    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "stream_preempted")).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "完整" });
  });

  it("no channel at all → zero behavior change (regression pin)", async () => {
    // Born-red fix: the old body used preemptableModel, whose first call PARKS
    // awaiting an abort — with no channel (and no run signal) nothing ever
    // aborts, so the loop parked forever and the test timed out. The pin's
    // real job: with the channel ABSENT the request shape is byte-identical
    // to pre-124b (no injected signal on the model input) and the run
    // completes normally.
    const calls: ModelInput[] = [];
    const model: ModelClient = {
      generate: () => {
        throw new Error("should not be called");
      },
      async *stream(input: ModelInput) {
        calls.push(input);
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", message: { role: "assistant", content: "完成" } };
      },
    };
    const state = baseState("hi");
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(calls.length).toBe(1);
    expect(calls[0]!.signal).toBeUndefined(); // no channel → no signal injection, pre-124b shape
    expect(events.some((e) => e.type === "stream_preempted")).toBe(false);
  });

  it("preempt before any delta: honest zero counts, steer still lands", async () => {
    const channel = createStreamPreemptChannel();
    const queue: string[] = [];
    const { model, calls } = preemptableModel([], "新答");
    const state = baseState("go");

    const drained = drain(runAgentLoop(state, model, {
      maxTurns: 5,
      streamPreempt: channel,
      steering: { take: () => queue.shift() },
    }));
    await new Promise((r) => setTimeout(r, 10));
    queue.push("改做这件事");
    channel.request();
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("completed");
    const preempted = events.find((e) => e.type === "stream_preempted") as
      | Extract<LoopEvent, { type: "stream_preempted" }>
      | undefined;
    expect(preempted).toBeDefined();
    expect(preempted?.droppedTextChars).toBe(0);
    expect(preempted?.droppedReasoningChars).toBe(0);
    expect(calls.length).toBe(2);
    expect((calls[1]!.messages.filter((m) => m.role === "user") as { content: string }[]).some((m) => m.content === "改做这件事")).toBe(true);
    expect(state.messages.length).toBe(3); // user, user(steer), assistant — nothing else
  });

  it("Esc (the RUN signal) keeps the aborted semantics even with the channel wired", async () => {
    const channel = createStreamPreemptChannel();
    const runSignal = new AbortController();
    const { model } = preemptableModel([{ type: "text_delta", text: "被中止的" }], "不应到达");
    const state = baseState("go");

    const drained = drain(runAgentLoop(state, model, {
      maxTurns: 3,
      signal: runSignal.signal,
      streamPreempt: channel,
      steering: { take: () => undefined },
    }));
    await new Promise((r) => setTimeout(r, 10));
    runSignal.abort(); // the RUN aborts — not a preempt
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    // 夜移 001 semantics: the delivered prefix IS committed (transcript fidelity).
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "被中止的",
      interrupted: true,
    });
    expect(events.some((e) => e.type === "assistant_interrupted")).toBe(true);
    expect(events.some((e) => e.type === "stream_preempted")).toBe(false);
  });

  it("a preempt request between attempts is a harmless no-op (stale controller is replaced)", async () => {
    const channel = createStreamPreemptChannel();
    // request() with nothing in flight fires a controller nobody listens to;
    // the loop's next next() must hand out a FRESH signal or the next call
    // would abort instantly.
    channel.request();
    // The documented contract (stream-preempt.ts): false = nothing in flight —
    // the request is a harmless no-op (the steering text drains at the next
    // turn boundary). The stale-fired controller the first call left behind is
    // REPLACED wholesale by the next next(), so it can never poison the run.
    expect(channel.request()).toBe(false);
    const model: ModelClient = {
      generate: () => {
        throw new Error("should not be called");
      },
      async *stream() {
        yield { type: "done", message: { role: "assistant", content: "正常" } };
      },
    };
    const state = baseState("hi");
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 2,
      streamPreempt: channel,
      steering: { take: () => undefined },
    }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "stream_preempted")).toBe(false);
  });
});
