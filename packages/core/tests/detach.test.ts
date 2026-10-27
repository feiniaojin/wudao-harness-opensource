// 借鉴弧 δ（penguin-harness 367ab084 思想）— 运行中工具调用转后台的核心面：
// hub 事件盒、loop 的三腿赛跑（执行/abort/detach 并集收集窗——detach 是
// 「不再等待」绝不是「打断」）、BACKGROUNDED 合成配对、轮界收口终态
// （backgrounded）、收集器交接（承诺活到落定）、诚实边界（block 族不武装）。
import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import { createToolDetachHub, formatDetachedResultInjection, DETACH_LANDING_NOTICE_PREFIX, BACKGROUNDED_TOOL_RESULT, type DetachedCall } from "../src/detach.js";
import { buildTool, type Tool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// Drive the generator manually (the Terminal return value is the assertion
// surface — for-await would discard it).
async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const startedEvent = (events: readonly LoopEvent[], callId: string) =>
  events.find((e) => e.type === "tool_call_started" && e.toolCallId === callId);
const finishedEvent = (events: readonly LoopEvent[], callId: string) =>
  events.find((e) => e.type === "tool_call_finished" && e.toolCallId === callId);

/** A never-settling-until-told tool: execute records the per-call signal and
 *  resolves only when the test releases it (the mid-flight posture). */
function slowTool(name: string, opts?: { readonly concurrencySafe?: boolean; readonly block?: boolean }): {
  readonly tool: Tool;
  /** Post-drain release: resolves a call whose execute already parked. */
  release(id: string, content: string): void;
  /** Pre-seeded results, consumed the moment execute runs (deterministic
   *  "already finished" calls — a release at tool_call_started time is a
   *  no-op because execute has not parked its resolver yet). */
  readonly preload: Map<string, string>;
  signals: Map<string, AbortSignal | undefined>;
} {
  const resolvers = new Map<string, (r: { content: string }) => void>();
  const preload = new Map<string, string>();
  const signals = new Map<string, AbortSignal | undefined>();
  const tool = buildTool({
    name,
    description: "slow",
    parameters: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false },
    ...(opts?.concurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
    ...(opts?.block === true ? { interruptBehavior: "block" as const } : {}),
    async execute(args: Record<string, unknown>, _onUpdate?: unknown, signal?: AbortSignal) {
      const id = String(args["payload"]);
      signals.set(id, signal);
      const pre = preload.get(id);
      if (pre !== undefined) return { content: pre };
      return new Promise<{ content: string }>((resolve) => { resolvers.set(id, resolve); });
    },
  });
  return { tool, signals, preload, release: (id, content) => { resolvers.get(id)?.({ content }); resolvers.delete(id); } };
}

const stateWith = (tools: readonly Tool[]) => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" }] as AgentMessage[],
  tools: [...tools],
  status: "idle" as const,
});

describe("createToolDetachHub", () => {
  it("delivers requests to live listeners; an unsubscribed listener hears nothing", () => {
    const hub = createToolDetachHub();
    const seen: string[] = [];
    const off = hub.onRequest((id) => { seen.push(id); });
    hub.request("c1");
    off();
    hub.request("c2");
    expect(seen).toEqual(["c1"]);
  });
});

describe("mid-flight detach (sequential path)", () => {
  it("stops waiting WITHOUT cancelling: synthetic pairs the call, run closes at the turn boundary, the model is not called again", async () => {
    const slow = slowTool("slow");
    // The scripted model throws if a SECOND call happens — the assertion that
    // the detach close skips the next model call.
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow", arguments: { payload: "p1" } }] },
    ]);
    const hub = createToolDetachHub();
    const detached: DetachedCall[] = [];
    const state = stateWith([slow.tool]);
    const gen = runAgentLoop(state, model, {
      toolDetach: hub,
      onDetachedCall: (d) => { detached.push(d); },
    });
    // Consume until the tool phase opens (the call is in flight).
    const seen: LoopEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) throw new Error("run ended before the tool phase");
      seen.push(r.value);
      if (r.value.type === "tool_call_started") break;
    }
    hub.request("c1");
    const { events, terminal } = await drain(gen);
    const all = [...seen, ...events];

    expect(finishedEvent(all, "c1")?.backgrounded).toBe(true);
    expect(finishedEvent(all, "c1")?.result).toBe(BACKGROUNDED_TOOL_RESULT);
    expect(terminal.reason).toBe("completed");
    expect(terminal.backgrounded).toBe(true);
    // Paired history: the synthetic answered the tool_use; the assistant
    // tool-call message is the final message (no second generation).
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { content?: string }).content).toBe(BACKGROUNDED_TOOL_RESULT);
    expect(model.calls).toBe(1);
    // The collector got the still-running promise; releasing it lands the real
    // result (the promise was NEVER cancelled by the detach).
    expect(detached).toHaveLength(1);
    expect(detached[0]!.call.id).toBe("c1");
    let landed: string | undefined;
    void detached[0]!.result.then((r) => { landed = r.message.content; });
    slow.release("p1", "REAL RESULT");
    await viWait(() => landed === "REAL RESULT");
    expect(landed).toBe("REAL RESULT");
  });

  it("threads a per-call signal into execute (armed only with a port); a no-port run passes undefined", async () => {
    const slow = slowTool("slow");
    const hub = createToolDetachHub();
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow", arguments: { payload: "p1" } }] },
    ]);
    const gen = runAgentLoop(stateWith([slow.tool]), model, { toolDetach: hub });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      if (r.value.type === "tool_call_started") { hub.request("c1"); }
    }
    expect(slow.signals.get("p1")).toBeInstanceOf(AbortSignal);

    const slow2 = slowTool("slow2");
    const model2 = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow2", arguments: { payload: "q1" } }] },
      { role: "assistant", content: "done" },
    ]);
    const gen2 = runAgentLoop(stateWith([slow2.tool]), model2, {});
    const consume = async (g: AsyncGenerator<LoopEvent, Terminal>) => {
      for (;;) {
        const r = await g.next();
        if (r.done) return r.value;
        if (r.value.type === "tool_call_started") slow2.preload.set("q1", "ok");
      }
    };
    const t2 = await consume(gen2);
    expect(t2.reason).toBe("completed");
    expect(t2.backgrounded).toBeUndefined();
    expect(slow2.signals.get("q1")).toBeUndefined();
  });

  it("a request landing during the call's GATE wins the moment the race arms (pending park)", async () => {
    const slow = slowTool("slow");
    const hub = createToolDetachHub();
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow", arguments: { payload: "p1" } }] },
    ]);
    const gate = async (toolName: string): Promise<{ behavior: "allow" }> => {
      expect(toolName).toBe("slow");
      hub.request("c1"); // mid-gate: no race is armed yet — must park, then win
      return { behavior: "allow" };
    };
    const detached: DetachedCall[] = [];
    const { events, terminal } = await drain(runAgentLoop(stateWith([slow.tool]), model, {
      toolDetach: hub,
      canUseTool: gate,
      onDetachedCall: (d) => { detached.push(d); },
    }));
    expect(terminal.backgrounded).toBe(true);
    expect(finishedEvent(events, "c1")?.backgrounded).toBe(true);
    expect(detached).toHaveLength(1);
    // The parked request consumed: releasing the (never-awaited) execution
    // still settles the collector's promise — nothing dangles.
    let landed = false;
    void detached[0]!.result.then(() => { landed = true; });
    slow.release("p1", "late");
    await viWait(() => landed);
  });

  it("the rest of a sequential batch still executes after a detach; the run closes at the batch end", async () => {
    const slow = slowTool("slow"); // NOT concurrency-safe → sequential path
    const quick = slowTool("quick");
    const hub = createToolDetachHub();
    const model = createScriptedModel([
      {
        role: "assistant", content: "working",
        toolCalls: [
          { id: "c1", name: "slow", arguments: { payload: "p1" } },
          { id: "c2", name: "quick", arguments: { payload: "p2" } },
        ],
      },
    ]);
    const gen = runAgentLoop(stateWith([slow.tool, quick.tool]), model, { toolDetach: hub });
    let quickReleased = false;
    const { events, terminal } = await drain((async function* () {
      for (;;) {
        const r = await gen.next();
        if (r.done) return r.value;
        if (r.value.type === "tool_call_started" && r.value.toolCallId === "c1") hub.request("c1");
        // Release quick the moment it starts: its REAL result must land.
        if (r.value.type === "tool_call_started" && r.value.toolCallId === "c2") {
          quickReleased = true;
          quick.preload.set("p2", "QUICK REAL");
        }
        yield r.value;
      }
    })());
    expect(quickReleased).toBe(true);
    expect(finishedEvent(events, "c1")?.backgrounded).toBe(true);
    const quickFinished = finishedEvent(events, "c2");
    expect(quickFinished?.backgrounded).toBeUndefined();
    expect(quickFinished?.result).toBe("QUICK REAL");
    expect(terminal.backgrounded).toBe(true);
  });
});

describe("mid-flight detach (fan-out path)", () => {
  it("detaches one call of a concurrency-safe batch; the sibling's real result stands", async () => {
    const a = slowTool("aaa", { concurrencySafe: true });
    const b = slowTool("bbb", { concurrencySafe: true });
    const hub = createToolDetachHub();
    const detached: DetachedCall[] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "working",
        toolCalls: [
          { id: "c1", name: "aaa", arguments: { payload: "p1" } },
          { id: "c2", name: "bbb", arguments: { payload: "p2" } },
        ],
      },
    ]);
    const gen = runAgentLoop(stateWith([a.tool, b.tool]), model, {
      toolDetach: hub,
      onDetachedCall: (d) => { detached.push(d); },
    });
    const { events, terminal } = await drain((async function* () {
      for (;;) {
        const r = await gen.next();
        if (r.done) return r.value;
        if (r.value.type === "tool_call_started" && r.value.toolCallId === "c1") hub.request("c1");
        if (r.value.type === "tool_call_started" && r.value.toolCallId === "c2") b.preload.set("p2", "BBB REAL");
        yield r.value;
      }
    })());
    expect(terminal.backgrounded).toBe(true);
    expect(finishedEvent(events, "c1")?.backgrounded).toBe(true);
    expect(finishedEvent(events, "c2")?.result).toBe("BBB REAL");
    expect(detached.map((d) => d.call.id)).toEqual(["c1"]);
  });
});

describe("honest boundaries", () => {
  it("interruptBehavior:block never arms a detach leg — the request is ignored, the tool settles for real", async () => {
    const blocker = slowTool("blocker", { block: true });
    const hub = createToolDetachHub();
    const detached: DetachedCall[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "blocker", arguments: { payload: "p1" } }] },
      { role: "assistant", content: "done" },
    ]);
    const gen = runAgentLoop(stateWith([blocker.tool]), model, {
      toolDetach: hub,
      onDetachedCall: (d) => { detached.push(d); },
    });
    const { events, terminal } = await drain((async function* () {
      for (;;) {
        const r = await gen.next();
        if (r.done) return r.value;
        if (r.value.type === "tool_call_started") {
          hub.request("c1"); // typed-refused at the surface; ignored here
          blocker.preload.set("p1", "BLOCK SETTLED");
        }
        yield r.value;
      }
    })());
    expect(terminal.backgrounded).toBeUndefined();
    expect(terminal.reason).toBe("completed");
    expect(finishedEvent(events, "c1")?.result).toBe("BLOCK SETTLED");
    expect(detached).toHaveLength(0);
  });

  it("a request for an unknown/finished call is dropped, never resolves anything", async () => {
    const slow = slowTool("slow");
    const hub = createToolDetachHub();
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow", arguments: { payload: "p1" } }] },
      { role: "assistant", content: "done" },
    ]);
    const gen = runAgentLoop(stateWith([slow.tool]), model, { toolDetach: hub });
    const { terminal } = await drain((async function* () {
      for (;;) {
        const r = await gen.next();
        if (r.done) return r.value;
        if (r.value.type === "tool_call_started") {
          hub.request("nonexistent");
          slow.preload.set("p1", "done");
        }
        yield r.value;
      }
    })());
    expect(terminal.backgrounded).toBeUndefined();
  });

  it("abort after a detach never cancels the collected execution (user STOP is the lane's job, via the controller)", async () => {
    const slow = slowTool("slow");
    const hub = createToolDetachHub();
    const ac = new AbortController();
    const detached: DetachedCall[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "slow", arguments: { payload: "p1" } }] },
    ]);
    const gen = runAgentLoop(stateWith([slow.tool]), model, {
      signal: ac.signal,
      toolDetach: hub,
      onDetachedCall: (d) => { detached.push(d); },
    });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      if (r.value.type === "tool_call_started") hub.request("c1");
    }
    // The run closed backgrounded; a LATE abort of the run's own signal must
    // not touch the per-call controller (that is the lane's stop face).
    expect(detached).toHaveLength(1);
    ac.abort();
    expect(detached[0]!.controller.signal.aborted).toBe(false);
    let landed = false;
    void detached[0]!.result.then(() => { landed = true; });
    slow.release("p1", "SURVIVED");
    await viWait(() => landed);
    // The sanctioned stop: the lane aborts the per-call controller.
    detached[0]!.controller.abort();
    expect(detached[0]!.controller.signal.aborted).toBe(true);
  });
});

describe("injection formatting (the landed-result lane payload)", () => {
  it("formats the follow-up with head + full result; the notice prefix is stable", () => {
    expect(formatDetachedResultInjection("shell", "pnpm build", "$ pnpm build\n[exit 0]"))
      .toBe("[后台工具完成] shell(pnpm build)\n$ pnpm build\n[exit 0]");
    expect(formatDetachedResultInjection("shell", "", "r")).toBe("[后台工具完成] shell\nr");
    expect(DETACH_LANDING_NOTICE_PREFIX).toBe("🔄 后台工具完成");
  });
});

/** Tiny deterministic async wait (a bounded poll — no fake timers needed). */
async function viWait(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("viWait: condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}
