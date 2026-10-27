// ω99-315 — turn_retried 事件的分类字段 + 缓存感知接续的前缀同一性。
// 恢复臂（ω99-9/11 的 callModelWithTurnRecovery）照单全收 StreamIdleError：
// 看门狗只「检测挂死 + 取消」（providers 层），恢复走既有 for(;;) 环——绝不
// 造第二套重试。本弧给 turn_retried 补 reasonClass（idle/429/5xx/network/
// other），让下游（driver 的 run-stats 断流重连计数）能只数 idle；并自证
// M24 前缀不变量的直接变现：idle 恢复的重发请求，其 messages 序列化是首
// 请求的字节前缀（append-only：interrupted 前缀 + TURN_RECOVERY_NOTE 后缀，
// 永不改写历史）——重连命中 provider 前缀缓存，成本≈增量 token。
import { describe, it, expect } from "vitest";
import {
  runAgentLoop,
  TURN_RECOVERY_NOTE,
  classifyTurnRetryError,
  type LoopEvent,
  type Terminal,
} from "../src/index.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>, out?: LoopEvent[]): Promise<Terminal> {
  while (true) {
    const { done, value } = await gen.next();
    if (done) return value;
    out?.push(value);
  }
}

/** A streaming model whose calls play `script` in order, recording a deep
 *  snapshot of every ModelInput (the M24 assertions need the bytes as they
 *  went out — messages are the LIVE state array). */
function scriptedModel(
  script: readonly { events: ModelStreamEvent[]; die?: Error; done?: AssistantMessage }[],
): ModelClient & { captures: { systemPrompt: string; messages: AgentMessage[] }[] } {
  const captures: { systemPrompt: string; messages: AgentMessage[] }[] = [];
  let call = 0;
  return {
    captures,
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      captures.push({
        systemPrompt: input.systemPrompt,
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

/** A providers-shaped typed idle error (duck-typed on `name` — core never
 *  imports the providers package). */
function streamIdleError(idleMs = 300_000): Error {
  return Object.assign(new Error(`stream idle for ${idleMs}ms without a chunk — watchdog abort`), {
    name: "StreamIdleError",
  });
}

describe("classifyTurnRetryError (ω99-315)", () => {
  it("idle: the duck-typed StreamIdleError name", () => {
    expect(classifyTurnRetryError(streamIdleError())).toBe("idle");
  });

  it("429 / 5xx: the providers' ProviderHttpError message shape", () => {
    expect(classifyTurnRetryError(new Error("provider request failed: 429 too many requests"))).toBe("429");
    expect(classifyTurnRetryError(new Error("provider stream failed: 429 rate limited"))).toBe("429");
    expect(classifyTurnRetryError(new Error("provider request failed: 502 bad gateway"))).toBe("5xx");
    expect(classifyTurnRetryError(new Error("provider stream failed: 529 overloaded"))).toBe("5xx");
  });

  it("other statuses classify as other; transport-shaped everything else is network", () => {
    expect(classifyTurnRetryError(new Error("provider request failed: 404 nope"))).toBe("other");
    expect(classifyTurnRetryError(new Error("socket hang up"))).toBe("network");
    expect(classifyTurnRetryError(new Error("fetch failed"))).toBe("network");
    expect(classifyTurnRetryError(new Error("terminated"))).toBe("network");
  });

  it("abort and context-length never classify (they never reach turn_retried)", () => {
    // The classifier is only consulted on the recovery path; these document
    // the boundary — an AbortError-name is not a retry class at all.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyTurnRetryError(abort)).toBe("network");
  });
});

describe("turn_retried.reasonClass + M24 prefix identity (ω99-315)", () => {
  it("an idle abort mid-stream recovers with reasonClass \"idle\"; the resent messages are a byte-prefix superset (append-only)", async () => {
    const model = scriptedModel([
      {
        events: [
          { type: "text_delta", text: "夜里流到一半" },
        ],
        die: streamIdleError(),
      },
      { events: [], done: { role: "assistant", content: "续写完成" } },
    ]);
    const events: LoopEvent[] = [];
    const state = freshState();
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3 }), events);

    expect(terminal.reason).toBe("completed");
    const retried = events.find((e): e is Extract<LoopEvent, { type: "turn_retried" }> => e.type === "turn_retried");
    expect(retried).toMatchObject({ attempt: 1, leg: "main", reasonClass: "idle" });
    // The raw message stays (existing consumers); the class is ADDITIVE.
    expect(retried?.reason).toContain("stream idle");
    // ★ 超越点①（core 侧）：idle 恢复的重发走 append-only —— 首请求的
    // messages 序列化是重发请求的字节前缀（interrupted 前缀 + NOTE 是后缀），
    // 重连命中 provider 前缀缓存，重连成本≈增量 token。
    expect(model.captures).toHaveLength(2);
    const first = JSON.stringify(model.captures[0]!.messages);
    const second = JSON.stringify(model.captures[1]!.messages);
    expect(second.startsWith(first.slice(0, -1))).toBe(true);
    expect(second.length).toBeGreaterThan(first.length);
    // The appended suffix is exactly the interrupted partial + the frozen note.
    expect(state.messages[1]).toMatchObject({ role: "assistant", content: "夜里流到一半", interrupted: true });
    expect(state.messages[2]).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
  });

  it("a network-shaped mid-stream failure recovers with reasonClass \"network\"; a 429-shaped one with \"429\"", async () => {
    for (const [die, want] of [
      [new Error("socket hang up"), "network"],
      [new Error("provider request failed: 429 rate limited"), "429"],
    ] as const) {
      const model = scriptedModel([
        { events: [{ type: "text_delta", text: "x" }], die },
        { events: [], done: { role: "assistant", content: "ok" } },
      ]);
      const events: LoopEvent[] = [];
      const terminal = await drain(runAgentLoop(freshState(), model, { maxTurns: 3 }), events);
      expect(terminal.reason).toBe("completed");
      expect(events.find((e) => e.type === "turn_retried")).toMatchObject({ reasonClass: want });
    }
  });
});
