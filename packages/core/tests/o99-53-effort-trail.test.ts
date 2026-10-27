// ω99-53 — 每轮 effort 落 assistant 消息（persistence-only trail）。
// 验收映射（brief §2）：#1 落盘（loop 盖章 + JSONL 原样往返 + resume 可读）、
// #3 interrupted partial 也带、以及 effortSent 缺席 = 今天的逐字节零变化 pin。
// 字节纪律（#2）的完整 pin 在 cli 测试（serializePrompt 属 providers）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return value;
    events.push(value);
  }
}

/** A scripted model that always answers with `reply` (one clean final turn). */
function finalModel(reply: AssistantMessage): ModelClient {
  return {
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      return { ...reply };
    },
  };
}

/** A streaming model that yields `deltas`, then parks until the request's
 *  abort signal fires and rejects with AbortError — the "user hit stop
 *  mid-stream" shape (interrupted-stream.test.ts's fixture, verbatim). */
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

function freshState(): { systemPrompt: string; messages: AgentMessage[]; tools: []; status: "idle" } {
  return { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "idle" };
}

describe("ω99-53 effort trail (loop → assistant message)", () => {
  it("a normal-completion turn stamps effortSent onto the pushed assistant message", async () => {
    const state = freshState();
    const terminal = await drain(runAgentLoop(state, finalModel({ role: "assistant", content: "done" }), {
      maxTurns: 3,
      effortSent: "high",
    }));
    expect(terminal.reason).toBe("completed");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "done", effort: "high" });
  });

  it("effortSent absent → the assistant message has NO effort key (zero-change pin)", async () => {
    const state = freshState();
    await drain(runAgentLoop(state, finalModel({ role: "assistant", content: "done" }), { maxTurns: 3 }));
    const last = state.messages.at(-1);
    expect(last).toEqual({ role: "assistant", content: "done" });
    expect(Object.hasOwn(last as object, "effort")).toBe(false);
  });

  it("an interrupted partial carries the same turn's effort (abort mid-stream)", async () => {
    const controller = new AbortController();
    const model = abortingStreamModel([{ type: "text_delta", text: "部分回答" }]);
    const state = freshState();
    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3, effortSent: "low" }));
    await new Promise((r) => setTimeout(r, 10)); // park inside the model stream
    controller.abort();
    const terminal = await drained;
    expect(terminal.reason).toBe("aborted");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "部分回答", interrupted: true, effort: "low" });
  });

  it("the stamped message persists verbatim to the session JSONL and survives resume reads", async () => {
    const state = freshState();
    await drain(runAgentLoop(state, finalModel({ role: "assistant", content: "answer" }), { maxTurns: 3, effortSent: "high" }));
    const stamped = state.messages.at(-1) as AssistantMessage;
    expect(stamped.effort).toBe("high");

    const dir = mkdtempSync(join(tmpdir(), "o99-53-trail-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("s-effort", stamped);
      // Raw JSONL line carries the field (persistence rides the message verbatim).
      const raw = readFileSync(join(dir, "s-effort.jsonl"), "utf8");
      expect(raw).toContain('"effort":"high"');
      // Resume views: message view + entry view both keep it.
      const loaded = await store.load("s-effort");
      expect(loaded.at(-1)).toMatchObject({ role: "assistant", effort: "high" });
      const entries = await store.loadSessionEntries("s-effort");
      expect(entries.at(-1)).toMatchObject({ role: "assistant", effort: "high" });
      expect(store.lastLoadSkipped).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a tool-call turn stamps effort on the tool-carrying assistant too", async () => {
    const state = freshState();
    let calls = 0;
    const model: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        calls += 1;
        if (calls === 1) {
          return { role: "assistant", content: "calling", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] };
        }
        return { role: "assistant", content: "final" };
      },
    };
    const tools = [{
      name: "noop",
      description: "d",
      parameters: { type: "object" as const, properties: {} },
      execute: async (): Promise<{ content: string }> => ({ content: "ok" }),
      isReadOnly: (): boolean => true,
    }];
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3, effortSent: "max", tools }));
    expect(terminal.reason).toBe("completed");
    const assistants = state.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.every((m) => (m as AssistantMessage).effort === "max")).toBe(true);
  });
});
