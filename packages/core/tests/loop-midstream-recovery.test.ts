import { describe, it, expect } from "vitest";
import {
  runAgentLoop,
  MAX_TURN_RECOVERY_ATTEMPTS,
  TURN_RECOVERY_NOTE,
  type LoopEvent,
  type Terminal,
} from "../src/loop.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";

// ω99-9（penguin #571 引擎级恢复 + wudao 转录语义）：模型已流出 delta 后的
// 传输失败不再是 run 终止 + 已生成内容全丢。loop 层恢复臂把已送达前缀落为
// `interrupted` 助手消息（复用 abort 路径的 finalizeInterruptedStream 语义），
// 追加字节稳定续写指令 TURN_RECOVERY_NOTE，然后带着 append-only 后缀重发模型
// 调用（走完整既有 clip/compact/context-overflow 阶梯）。providers 的 pre-delta
// 重试梯子（produced 守卫）零触碰；恢复预算 per-turn 独立（上限
// MAX_TURN_RECOVERY_ATTEMPTS）。排除表：abort / ContextLengthError（含
// ContextOverflowHardError，同名 duck-type）/ BackgroundOverloadError。

async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
  out?: LoopEvent[],
): Promise<Terminal> {
  while (true) {
    const { done, value } = await gen.next();
    if (done) return value;
    out?.push(value);
  }
}

/** One scripted streaming call: yield `events`, then either die with `die`
 *  (the mid-stream transport failure) or complete with `done`. */
interface ScriptedCall {
  readonly events: ModelStreamEvent[];
  readonly die?: Error;
  readonly done?: AssistantMessage;
}

/** What the loop actually sent: a deep snapshot of each ModelInput's prompt
 *  side (messages are the LIVE state array, so capturing the reference would
 *  see later appends — the M24 assertions need the bytes as they went out). */
interface CapturedInput {
  readonly systemPrompt: string;
  readonly maxTokens: number | undefined;
  readonly messages: AgentMessage[];
}

/** A streaming model whose calls play `script` in order, recording a deep
 *  snapshot of every ModelInput it received. */
function scriptedModel(
  script: readonly ScriptedCall[],
): ModelClient & { captures: CapturedInput[] } {
  const captures: CapturedInput[] = [];
  let call = 0;
  return {
    captures,
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      captures.push({
        systemPrompt: input.systemPrompt,
        maxTokens: input.maxTokens,
        messages: JSON.parse(JSON.stringify(input.messages)) as AgentMessage[],
      });
      const s = script[call];
      call += 1;
      if (s === undefined) throw new Error(`script exhausted at call ${call}`);
      for (const ev of s.events) yield ev;
      if (s.die !== undefined) throw s.die;
      yield { type: "done", message: s.done ?? { role: "assistant", content: "" } };
    },
  };
}

function freshState() {
  return {
    systemPrompt: "s",
    messages: [{ role: "user", content: "go" }] as AgentMessage[],
    tools: [],
    status: "idle" as const,
  };
}

const socketHangUp = (tag: string) => new Error(`socket hang up ${tag}`);

describe("mid-stream recovery arm (ω99-9)", () => {
  it("① existence: a post-delta transport failure no longer kills the run — the partial is committed and the call is resent", async () => {
    const model = scriptedModel([
      {
        events: [
          { type: "text_delta", text: "第一段" },
          { type: "text_delta", text: "已流出" },
        ],
        die: socketHangUp("1"),
      },
      { events: [], done: { role: "assistant", content: "续写完成" } },
    ]);
    const state = freshState();
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(state.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    // The delivered prefix is committed (UI 与转录一致), marked persistence-only.
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "第一段已流出",
      interrupted: true,
    });
    // The frozen continuation note is a real user message in history.
    expect(state.messages[2]).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(state.messages[3]).toMatchObject({ role: "assistant", content: "续写完成" });
  });

  it("② recovery success: event order assistant_interrupted → turn_retried{attempt:1} → …; the resend sees partial + note", async () => {
    const model = scriptedModel([
      { events: [{ type: "text_delta", text: "写到这里" }], die: new Error("ECONNRESET") },
      {
        events: [{ type: "text_delta", text: "继续" }],
        done: { role: "assistant", content: "继续写完" },
      },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3 }), events);

    expect(terminal.reason).toBe("completed");
    const order = events
      .filter((e) =>
        e.type === "assistant_interrupted" || e.type === "turn_retried" || e.type === "model_call_finished")
      .map((e) => e.type);
    expect(order).toEqual(["assistant_interrupted", "turn_retried", "model_call_finished"]);
    const retried = events.find((e) => e.type === "turn_retried") as
      | Extract<LoopEvent, { type: "turn_retried" }>
      | undefined;
    expect(retried?.attempt).toBe(1);
    expect(retried?.reason).toContain("ECONNRESET");
    // Exactly one resend, carrying original + interrupted partial + note.
    expect(model.captures.length).toBe(2);
    const [first, second] = model.captures;
    expect(second.messages.length).toBe(first.messages.length + 2);
    expect(second.messages.at(-2)).toMatchObject({ role: "assistant", content: "写到这里" });
    expect(second.messages.at(-1)).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "继续写完" });
  });

  it("③ budget cap: an always-dropping endpoint gets exactly MAX_TURN_RECOVERY_ATTEMPTS, then the failure propagates", async () => {
    expect(MAX_TURN_RECOVERY_ATTEMPTS).toBe(3);
    const model = scriptedModel([1, 2, 3, 4].map((n) => ({
      events: [{ type: "text_delta", text: `段${n}` }],
      die: socketHangUp(String(n)),
    })));
    const state = freshState();
    const events: LoopEvent[] = [];
    await expect(drain(runAgentLoop(state, model, { maxTurns: 3 }), events))
      .rejects.toThrow("socket hang up 4");

    const attempts = events
      .filter((e): e is Extract<LoopEvent, { type: "turn_retried" }> => e.type === "turn_retried")
      .map((e) => e.attempt);
    expect(attempts).toEqual([1, 2, 3]);
    expect(events.filter((e) => e.type === "assistant_interrupted").length).toBe(3);
    // Every segment committed independently: user + 3×(partial, note).
    expect(state.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user",
    ]);
    expect(model.captures.length).toBe(4);
  });
  it("④ excluded-context: a post-delta ContextLengthError keeps its existing hard-overflow path — no recovery, no note", async () => {
    const err = Object.assign(new Error("prompt too long"), { name: "ContextLengthError" });
    const model = scriptedModel([
      { events: [{ type: "text_delta", text: "部分" }], die: err },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    await expect(drain(runAgentLoop(state, model, { maxTurns: 3 }), events))
      .rejects.toThrow(/context exceeds the model window/);
    expect(state.messages.length).toBe(1); // no partial, no note — ladder owns it
    expect(events.some((e) => e.type === "turn_retried")).toBe(false);
    expect(events.some((e) => e.type === "assistant_interrupted")).toBe(false);
  });

  it("⑤ excluded-background: a BackgroundOverloadError (M70) propagates immediately — the arm never revives it", async () => {
    const err = Object.assign(new Error("background query source overloaded"), {
      name: "BackgroundOverloadError",
    });
    const model = scriptedModel([
      { events: [{ type: "text_delta", text: "部分" }], die: err },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    await expect(drain(runAgentLoop(state, model, { maxTurns: 3 }), events))
      .rejects.toThrow("background query source overloaded");
    expect(state.messages.length).toBe(1);
    expect(events.some((e) => e.type === "turn_retried")).toBe(false);
  });

  it("⑥ excluded-abort: a user abort keeps the existing finalize-only path — partial committed, terminal aborted, no recovery", async () => {
    const controller = new AbortController();
    const model: ModelClient = {
      generate: () => {
        throw new Error("should not be called");
      },
      async *stream(input: ModelInput) {
        yield { type: "text_delta", text: "已流出的" };
        await new Promise<never>((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          );
        });
      },
    };
    const state = freshState();
    const events: LoopEvent[] = [];
    const drained = drain(runAgentLoop(state, model, {
      signal: controller.signal,
      maxTurns: 3,
    }), events);
    await new Promise((r) => setTimeout(r, 10)); // park inside the stream
    controller.abort();
    const terminal = await drained;
    expect(terminal.reason).toBe("aborted");
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已流出的",
      interrupted: true,
    });
    expect(events.some((e) => e.type === "turn_retried")).toBe(false);
  });

  it("⑦ tracker reset: two drops then success commit five independent parts — no segment text bleeds into the next", async () => {
    const model = scriptedModel([
      { events: [{ type: "text_delta", text: "段一" }], die: new Error("drop 1") },
      {
        events: [
          { type: "reasoning_delta", text: "思考" },
          { type: "text_delta", text: "段二" },
        ],
        die: new Error("drop 2"),
      },
      { events: [], done: { role: "assistant", content: "最终答案" } },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3 }), events);

    expect(terminal.reason).toBe("completed");
    expect(state.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(state.messages[1]).toMatchObject({ content: "段一", interrupted: true });
    expect((state.messages[1] as AssistantMessage).reasoning).toBeUndefined();
    expect(state.messages[3]).toMatchObject({ content: "段二", interrupted: true });
    expect((state.messages[3] as AssistantMessage).reasoning).toBe("思考");
    expect(state.messages[5]).toMatchObject({ content: "最终答案" });
    expect((state.messages[5] as { interrupted?: boolean }).interrupted).toBeUndefined();
    const interruptedEvents = events.filter(
      (e): e is Extract<LoopEvent, { type: "assistant_interrupted" }> =>
        e.type === "assistant_interrupted",
    );
    expect(interruptedEvents.map((e) => e.hasReasoning)).toEqual([false, true]);
    const attempts = events
      .filter((e): e is Extract<LoopEvent, { type: "turn_retried" }> => e.type === "turn_retried")
      .map((e) => e.attempt);
    expect(attempts).toEqual([1, 2]);
  });

  it("⑧ M24: recovery is append-only — the resent request keeps the original prompt bytes as a stable prefix", async () => {
    const model = scriptedModel([
      { events: [{ type: "text_delta", text: "aa" }], die: new Error("UND_ERR_SOCKET") },
      { events: [], done: { role: "assistant", content: "done" } },
    ]);
    const state = freshState();
    await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    const canon = (ms: readonly AgentMessage[]) => JSON.stringify(ms);
    const [first, second] = model.captures;
    expect(canon(second.messages.slice(0, first.messages.length))).toBe(canon(first.messages));
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.length).toBe(first.messages.length + 2);
    // The persisted original turn itself is untouched.
    expect(canon(second.messages.slice(0, 1))).toBe(canon([{ role: "user", content: "go" }]));
  });

  it("⑨ no-delta: a pre-delta failure is untouched — the provider ladder owns pre-delta retries, the loop appends nothing", async () => {
    const model = scriptedModel([
      { events: [], die: new Error("connect ECONNREFUSED") },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    await expect(drain(runAgentLoop(state, model, { maxTurns: 3 }), events))
      .rejects.toThrow("connect ECONNREFUSED");
    expect(state.messages.length).toBe(1);
    expect(events.filter((e) => e.type === "turn_retried" || e.type === "assistant_interrupted").length)
      .toBe(0);
  });

  it("⑩ escalation cap survives recovery (夜移013 × ω99-9): the resend of an escalated continuation still carries the raised maxTokens", async () => {
    const model = scriptedModel([
      // Call 1: a length-truncated answer → the 013 nudge arms the escalation.
      { events: [], done: { role: "assistant", content: "长文前半", stopReason: "length" } },
      // Call 2: the ESCALATED continuation dies mid-stream → the recovery arm.
      { events: [{ type: "text_delta", text: "续写中段" }], die: socketHangUp("esc") },
      // Call 3: the recovery resend completes.
      { events: [], done: { role: "assistant", content: "全文完成" } },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      outputLimitRecovery: { escalateTo: 8192 },
    }), events);

    expect(terminal.reason).toBe("completed");
    expect(model.captures.length).toBe(3);
    // Precondition: call 2 WAS the escalated continuation — the original was
    // cap-free, the continuation carries the raised cap (pinned in 013's own
    // suite; restated here so the recovery assertion can't pass vacuously).
    expect(model.captures[0]?.maxTokens).toBeUndefined();
    expect(model.captures[1]?.maxTokens).toBe(8192);
    // THE GUARD (loop.ts recoveryInput): the recovery resend keeps the raised
    // cap — it is still completing that same escalated output. buildModelInput
    // rebuilds cap-free (escalateNextCall was consumed), so this only holds
    // because the arm copies callInput.maxTokens onto the resend.
    expect(model.captures[2]?.maxTokens).toBe(8192);
    // History: original + truncated + nudge + interrupted partial + note + done.
    expect(state.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(state.messages[3]).toMatchObject({
      role: "assistant",
      content: "续写中段",
      interrupted: true,
    });
    expect(state.messages[4]).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    const nudge = events.find((e) => e.type === "output_limit_recovery" && e.kind === "nudge");
    expect(nudge).toMatchObject({ maxTokens: 8192 });
  });
});
