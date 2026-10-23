import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type LoopEvent, type Terminal, type AssistantAttemptEntry } from "../src/loop.js";
import type { ModelClient, ModelInput, ModelStreamEvent, ModelUsage } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";
import { createJsonlSessionStore } from "../src/session/store.js";

// ω99-48（dsh 候选 7 v2，attempt log-only settlement）：流式请求在首个
// delta 之后失败（非 abort）时，已渲染的前缀以一条 `assistant_attempt`
// generic entry 落进会话 JSONL——不新增消息、不动消息链、永不进模型
// 可见历史（零缓存代价）。失败语义零变化：结算只留痕，异常照常冒出。
// abort 路径（夜移 001 interrupted finalization）字节不动。

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

/** A scripted streaming model that delivers `deltas`, optionally fires the
 *  provider's usage row (the final-chunk shape — right before death), then
 *  rejects: the mid-stream failure shape ω99-48 settles. */
function failingStreamModel(spec: {
  deltas?: ModelStreamEvent[];
  /** Per-call deltas (1-based call index) — the recovery-retry shape. */
  deltasForCall?: (call: number) => ModelStreamEvent[];
  error: Error;
  usage?: ModelUsage;
}): ModelClient {
  let calls = 0;
  return {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      calls += 1;
      const deltas = spec.deltasForCall !== undefined ? spec.deltasForCall(calls) : (spec.deltas ?? []);
      for (const d of deltas) yield d;
      if (spec.usage !== undefined) input.onUsage?.(spec.usage);
      throw spec.error;
    },
  };
}

/** The abort shape from 夜移 001's own tests — parks inside the stream until
 *  the request's abort signal fires, then rejects AbortError. */
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

/** A completing stream that records the ModelInput projection it received. */
function capturingCompletingModel(): { model: ModelClient; inputs: string[] } {
  const inputs: string[] = [];
  const model: ModelClient = {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      inputs.push(JSON.stringify({ systemPrompt: input.systemPrompt, messages: input.messages, tools: input.tools }));
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  return { model, inputs };
}

function stateOf(messages: AgentMessage[]) {
  return {
    systemPrompt: "s",
    messages,
    tools: [],
    status: "idle" as const,
  };
}

const USAGE_ROW: ModelUsage = { promptTokens: 1200, cacheHitTokens: 900, cacheMissTokens: 300 };

async function tempStore(): Promise<{ dir: string; store: ReturnType<typeof createJsonlSessionStore> }> {
  const dir = await mkdtemp(join(tmpdir(), "o99-48-"));
  return { dir, store: createJsonlSessionStore(dir) };
}

describe("ω99-48 acceptance 1 — mid-stream failure settles one assistant_attempt entry", () => {
  it("delivered prefix + usage + error + at land in the JSONL; the original error still rejects the run", async () => {
    const { dir, store } = await tempStore();
    const written: AssistantAttemptEntry[] = [];
    const model = failingStreamModel({
      deltas: [
        { type: "text_delta", text: "已经渲染的" },
        { type: "text_delta", text: "部分前缀" },
      ],
      error: new Error("gateway 5xx mid-stream"),
      usage: USAGE_ROW,
    });
    const run = drain(
      runAgentLoop(stateOf([{ role: "user", content: "go" }]), model, {
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
          return store.appendEntry("s1", entry);
        },
      }),
    );
    // 失败语义零变化：调用方见到的还是原错误。
    await expect(run).rejects.toThrow("gateway 5xx mid-stream");

    // 恰一条，形状即契约（type 字符串逐字）。
    expect(written.length).toBe(1);
    const entry = written[0]!;
    expect(entry.type).toBe("assistant_attempt");
    expect(entry.data.content).toBe("已经渲染的部分前缀");
    expect(entry.data.reasoning).toBe("");
    expect(entry.data.error).toContain("gateway 5xx mid-stream");
    expect(Number.isNaN(Date.parse(entry.data.at))).toBe(false);
    expect(entry.data.usage).toEqual(USAGE_ROW);

    // 持久化：ω99-47 首写 marker 是 line 1，entry 是 line 2（共存）。
    const raw = await readFile(join(dir, "s1.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "wudao_meta", data: { formatVersion: 1 } });
    expect(JSON.parse(lines[1]!)).toEqual(entry);
    // 旧读者双视图 + ω99-47 计数器：已知 entry，不计数。
    expect(await store.loadSessionEntries("s1")).toEqual([entry]);
    expect(await store.load("s1")).toEqual([]);
    expect(store.lastLoadSkipped).toBe(0);
  });

  it("no usage reported before the failure → data.usage stays undefined", async () => {
    const written: AssistantAttemptEntry[] = [];
    const model = failingStreamModel({
      deltas: [{ type: "text_delta", text: "prefix" }],
      error: new Error("conn reset"),
    });
    const run = drain(
      runAgentLoop(stateOf([{ role: "user", content: "go" }]), model, {
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
        },
      }),
    );
    await expect(run).rejects.toThrow("conn reset");
    expect(written.length).toBe(1);
    expect(written[0]!.data.usage).toBeUndefined();
    expect("usage" in written[0]!.data).toBe(false);
  });

  it("reasoning-only failure settles content='' with the reasoning prefix", async () => {
    const written: AssistantAttemptEntry[] = [];
    const model = failingStreamModel({
      deltas: [{ type: "reasoning_delta", text: "推理前缀" }],
      error: new Error("stream broke"),
    });
    const run = drain(
      runAgentLoop(stateOf([{ role: "user", content: "go" }]), model, {
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
        },
      }),
    );
    await expect(run).rejects.toThrow("stream broke");
    expect(written.length).toBe(1);
    expect(written[0]!.data.content).toBe("");
    expect(written[0]!.data.reasoning).toBe("推理前缀");
  });
});

describe("ω99-48 acceptance 2 — the attempt entry is NEVER model-visible (byte pin)", () => {
  it("resume: the next run's ModelInput projection is byte-identical with vs without the entry", async () => {
    const { store: storeA } = await tempStore();
    const { store: storeB } = await tempStore();
    const user1: AgentMessage = { role: "user", content: "第一问" };
    await storeA.append("with-entry", user1);
    await storeA.appendEntry("with-entry", {
      type: "assistant_attempt",
      data: { content: "失败前缀", reasoning: "", usage: USAGE_ROW, at: "2026-09-04T00:00:00.000Z", error: "gateway 5xx" },
    });
    await storeB.append("no-entry", user1);

    // 旧读者：load() 零泄漏，两个视图逐字节一致。
    const loadedA = await storeA.load("with-entry");
    const loadedB = await storeB.load("no-entry");
    expect(loadedA).toEqual(loadedB);

    // 字节 pin：从两边 resume 的下一轮 ModelInput 序列化相同。
    const capA = capturingCompletingModel();
    const capB = capturingCompletingModel();
    await drain(runAgentLoop(stateOf(loadedA), capA.model, { maxTurns: 2 }));
    await drain(runAgentLoop(stateOf(loadedB), capB.model, { maxTurns: 2 }));
    expect(capA.inputs.length).toBe(1);
    expect(capB.inputs.length).toBe(1);
    expect(capA.inputs[0]).toBe(capB.inputs[0]);
    expect(capA.inputs[0]!.length).toBeGreaterThan(0);
  });
});

describe("ω99-48 acceptance 3 — the abort path is untouched", () => {
  it("abort mid-stream commits the interrupted partial and writes NO attempt entry", async () => {
    const { store } = await tempStore();
    const written: AssistantAttemptEntry[] = [];
    const controller = new AbortController();
    const model = abortingStreamModel([
      { type: "text_delta", text: "已经流出的" },
      { type: "text_delta", text: "部分回答" },
    ]);
    const state = stateOf([{ role: "user", content: "go" }]);
    const drained = drain(
      runAgentLoop(state, model, {
        signal: controller.signal,
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
          return store.appendEntry("aborted-run", entry);
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10)); // park inside the stream
    controller.abort();
    const { events, terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    // 夜移 001 语义原样：interrupted partial 落 state.messages。
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已经流出的部分回答",
      interrupted: true,
    });
    expect(events.some((e) => e.type === "assistant_interrupted")).toBe(true);
    // abort 永不结算 attempt。
    expect(written).toEqual([]);
    expect(await store.loadSessionEntries("aborted-run")).toEqual([]);
  });
});

describe("ω99-48 acceptance 4 — consecutive failures settle exactly ONE entry", () => {
  it("loop-level recovery retries exhaust → one entry, carrying the FINAL attempt's prefix", async () => {
    const { dir, store } = await tempStore();
    const written: AssistantAttemptEntry[] = [];
    // 每次调用都：流出一段前缀后断流；ω99-9 恢复 3 次后预算耗尽最终上抛。
    const model = failingStreamModel({
      deltasForCall: (call) => [{ type: "text_delta", text: `attempt-${call} 前缀` }],
      error: new Error("conn reset"),
    });
    const state = stateOf([{ role: "user", content: "go" }]);
    const run = drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
          return store.appendEntry("retry-run", entry);
        },
      }),
    );
    await expect(run).rejects.toThrow("conn reset");

    // 恢复轨迹：3 条 interrupted partial + 3 条 TURN_RECOVERY_NOTE + 原始 user。
    expect(state.messages.filter((m) => m.role === "assistant" && (m as { interrupted?: boolean }).interrupted === true).length).toBe(3);
    expect(state.messages.length).toBe(7);
    // loop 级恰一条 attempt entry，载最终失败那次的已渲染前缀。
    expect(written.length).toBe(1);
    expect(written[0]!.data.content).toBe("attempt-4 前缀");
    expect(written[0]!.data.error).toContain("conn reset");
    const raw = await readFile(join(dir, "retry-run.jsonl"), "utf8");
    const attemptLines = raw.split("\n").filter((l) => l.trim().length > 0 && l.includes('"assistant_attempt"'));
    expect(attemptLines.length).toBe(1);
  });
});

describe("ω99-48 acceptance 5 — old readers (generic skip semantics)", () => {
  it("load() never leaks the entry; loadSessionEntries sees it in file order", async () => {
    const { store } = await tempStore();
    const user1: AgentMessage = { role: "user", content: "问一" };
    const user2: AgentMessage = { role: "user", content: "问二" };
    await store.append("mixed", user1);
    await store.appendEntry("mixed", {
      type: "assistant_attempt",
      data: { content: "p", reasoning: "r", at: "2026-09-04T00:00:00.000Z", error: "e" },
    });
    await store.append("mixed", user2);

    expect(await store.load("mixed")).toEqual([user1, user2]);
    const entries = await store.loadSessionEntries("mixed");
    expect(entries.length).toBe(3);
    expect(entries[1]).toMatchObject({ type: "assistant_attempt" });
    expect(store.lastLoadSkipped).toBe(0);
  });
});

describe("ω99-48 acceptance 6 — success path pays nothing (negative control)", () => {
  it("a completed streaming run writes zero attempt entries", async () => {
    const { dir, store } = await tempStore();
    const written: AssistantAttemptEntry[] = [];
    const { model } = capturingCompletingModel();
    const { terminal } = await drain(
      runAgentLoop(stateOf([{ role: "user", content: "hi" }]), model, {
        maxTurns: 3,
        appendAttemptEntry: (entry) => {
          written.push(entry);
          return store.appendEntry("ok-run", entry);
        },
      }),
    );
    expect(terminal.reason).toBe("completed");
    expect(written).toEqual([]);
    await expect(readFile(join(dir, "ok-run.jsonl"), "utf8")).rejects.toThrow();
  });
});
