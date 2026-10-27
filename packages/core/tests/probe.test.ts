// PB-1 探针基础设施测试：格式钉 / 总线 CRUD / 环形缓冲帽 / 订阅退订 /
// 五类探针 emit 形状 / 零侵入（探针关=被包装者原样，含 loop 端到端）。
// 五类中 ui.* 本弧只钉格式位（web 层后续弧挂载），其余四类各有真实 emit 面。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PROBE_CATEGORIES, PROBE_ENV, PROBE_RING_DEFAULT, SYSTEM_PROBE_INTERVAL_MS,
  createProbeBus, probeAgentLoop, probeBus, probeEnabled, probeModelClient,
  probeTool, probeTools, startSystemProbes,
  type ProbeEvent,
} from "../src/probe.js";
import { runAgentLoop } from "../src/loop.js";
import { createScriptedModel } from "../src/model-client.js";
import type { LoopEvent } from "../src/loop.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { Tool } from "../src/tool.js";
import type { AgentState } from "../src/state.js";
import type { AssistantMessage, Terminal } from "../src/types.js";

// ---------------------------------------------------------------------------
// 环境开关治理：每个用例从干净态出发，结束恢复进程原值。
// ---------------------------------------------------------------------------
const savedEnv: string | undefined = process.env[PROBE_ENV];
beforeEach(() => {
  delete process.env[PROBE_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[PROBE_ENV];
  else process.env[PROBE_ENV] = savedEnv;
});

/** 最小合法事件构造器（数值负载，五类通用）。 */
function ev(cat: ProbeEvent["cat"], name: string, data: Record<string, unknown> = {}): ProbeEvent {
  return { ts: Date.now(), cat, name, data };
}

/** 手动排空 generator（保留 Terminal 返回值——for-await 会丢弃它）。 */
async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  while (true) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
}

// ---------------------------------------------------------------------------
// §1 格式钉
// ---------------------------------------------------------------------------
describe("PB-1 探针格式（标准化）", () => {
  it("五类别字面量表钉：model/tool/ui/system/agent", () => {
    expect(PROBE_CATEGORIES).toEqual(["model", "tool", "ui", "system", "agent"]);
  });

  it("ProbeEvent 字段集钉：ts/cat/name/sessionId/lane/data/dur（可选字段缺席时不占位）", () => {
    const minimal = ev("model", "model.call", { latencyMs: 1 });
    expect(Object.keys(minimal).sort()).toEqual(["cat", "data", "name", "ts"]);
    const full: ProbeEvent = { ts: 1, cat: "agent", name: "agent.turn", sessionId: "s1", lane: "main", data: { turn: 1 }, dur: 5 };
    expect(Object.keys(full).sort()).toEqual(["cat", "data", "dur", "lane", "name", "sessionId", "ts"]);
    expect(full.data).toEqual({ turn: 1 });
  });

  it("总开关：WUDAO_PROBE 恰为 \"on\" 才启用（1/true/ON 均关）", () => {
    expect(probeEnabled()).toBe(false);
    process.env[PROBE_ENV] = "1";
    expect(probeEnabled()).toBe(false);
    process.env[PROBE_ENV] = "true";
    expect(probeEnabled()).toBe(false);
    process.env[PROBE_ENV] = "ON";
    expect(probeEnabled()).toBe(false);
    process.env[PROBE_ENV] = "on";
    expect(probeEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2 总线 CRUD / 环形缓冲 / 订阅
// ---------------------------------------------------------------------------
describe("PB-1 探针总线", () => {
  it("新总线：recent 空、stats 空表", () => {
    const bus = createProbeBus();
    expect(bus.recent()).toEqual([]);
    expect(bus.stats()).toEqual({});
  });

  it("emit→recent：时间升序；cat 过滤；limit 取该类最后 N 条", () => {
    const bus = createProbeBus();
    const e1 = ev("model", "model.call", { i: 1 });
    const e2 = ev("tool", "tool.start", { i: 2 });
    const e3 = ev("model", "model.call", { i: 3 });
    const e4 = ev("agent", "agent.turn", { i: 4 });
    bus.emit(e1);
    bus.emit(e2);
    bus.emit(e3);
    bus.emit(e4);
    expect(bus.recent()).toEqual([e1, e2, e3, e4]);
    expect(bus.recent("model")).toEqual([e1, e3]);
    expect(bus.recent("model", 1)).toEqual([e3]);
    expect(bus.recent("model", 99)).toEqual([e1, e3]);
    expect(bus.recent("ui")).toEqual([]);
  });

  it("环形缓冲帽：ringSize 3 发 5 条只留最后 3（序不乱）", () => {
    const bus = createProbeBus({ ringSize: 3 });
    const sent = [1, 2, 3, 4, 5].map((i) => ev("system", `s${i}`, { i }));
    for (const e of sent) bus.emit(e);
    expect(bus.recent()).toEqual(sent.slice(2));
    // 环回绕后的类目过滤照常
    expect(bus.recent("system", 1)).toEqual([sent[4]!]);
  });

  it("环形缓冲缺省帽 1000：发 1002 条只留 1000（首条被挤出）", () => {
    expect(PROBE_RING_DEFAULT).toBe(1000);
    const bus = createProbeBus();
    for (let i = 0; i < 1002; i++) bus.emit(ev("model", "m", { i }));
    const all = bus.recent();
    expect(all).toHaveLength(1000);
    expect(all[0]!.data.i).toBe(2);
    expect(all[999]!.data.i).toBe(1001);
  });

  it("订阅：单类只见本类；\"*\" 全见；同类按注册序、单类先于通配", () => {
    const bus = createProbeBus();
    const seen: string[] = [];
    bus.subscribe("model", () => seen.push("m1"));
    bus.subscribe("*", () => seen.push("star"));
    bus.subscribe("model", () => seen.push("m2"));
    bus.emit(ev("model", "model.call"));
    bus.emit(ev("tool", "tool.start"));
    expect(seen).toEqual(["m1", "m2", "star", "star"]);
  });

  it("退订：停止投递且幂等", () => {
    const bus = createProbeBus();
    let n = 0;
    const off = bus.subscribe("model", () => {
      n += 1;
    });
    bus.emit(ev("model", "model.call"));
    off();
    off();
    bus.emit(ev("model", "model.call"));
    expect(n).toBe(1);
  });

  it("监听器抛错被隔离：emit 不外抛、环形照记、其它订阅者照收", () => {
    const bus = createProbeBus();
    let ok = 0;
    bus.subscribe("model", () => {
      throw new Error("listener bug");
    });
    bus.subscribe("model", () => {
      ok += 1;
    });
    expect(() => bus.emit(ev("model", "model.call"))).not.toThrow();
    expect(ok).toBe(1);
    expect(bus.recent("model")).toHaveLength(1);
    // stats 面不受监听器故障影响
    expect(bus.stats().model?.count).toBe(1);
  });

  it("stats：按类目聚合计数+最近时间戳；快照可变不影响总线内部", () => {
    const bus = createProbeBus();
    bus.emit(ev("model", "m1"));
    bus.emit({ ts: 12345, cat: "model", name: "m2", data: {} });
    bus.emit(ev("tool", "t1"));
    const s = bus.stats();
    expect(s.model).toEqual({ count: 2, lastTs: 12345 });
    expect(s.tool).toEqual({ count: 1, lastTs: bus.recent("tool")[0]!.ts });
    expect(Object.keys(s).sort()).toEqual(["model", "tool"]);
    s.model!.count = 99;
    expect(bus.stats().model?.count).toBe(2);
  });

  it("进程级单例：probeBus() 两次同一对象", () => {
    expect(probeBus()).toBe(probeBus());
  });
});

// ---------------------------------------------------------------------------
// §3 model.call（ModelClient 装饰）
// ---------------------------------------------------------------------------
function scriptedAssistant(): AssistantMessage {
  return { role: "assistant", content: "answer" };
}

describe("PB-1 model.call 探针", () => {
  it("generate 成功：形状钉（model/tokensIn/tokensOut/cacheHitTokens/latencyMs/retry/ok）+ usage/修复原样透传", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const msg = scriptedAssistant();
    const seenUsage: number[] = [];
    const seenRepair: string[] = [];
    const inner: ModelClient = {
      modelId: "test-model",
      async generate(input: ModelInput) {
        input.onUsage?.({ promptTokens: 11, cacheHitTokens: 5, cacheMissTokens: 6, completionTokens: 7 });
        input.onTerminalRepair?.("reasoning-only");
        return msg;
      },
    };
    const wrapped = probeModelClient(inner, { bus });
    const out = await wrapped.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seenUsage.push(u.promptTokens), onTerminalRepair: (k) => seenRepair.push(k) });
    // 被包装者行为不变：同一返回对象；调用方回调收到同一语义
    expect(out).toBe(msg);
    expect(seenUsage).toEqual([11]);
    expect(seenRepair).toEqual(["reasoning-only"]);
    // 探针形状
    const events = bus.recent("model");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.name).toBe("model.call");
    expect(e.cat).toBe("model");
    expect(e.dur).toBe(e.data.latencyMs);
    expect(typeof e.data.latencyMs).toBe("number");
    expect(e.data).toMatchObject({ model: "test-model", tokensIn: 11, tokensOut: 7, cacheHitTokens: 5, retry: 1, ok: true });
    expect(e.data.error).toBeUndefined();
  });

  it("generate 无 usage 上报：tokens 按 0 记（不造 null）", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const wrapped = probeModelClient({ async generate() { return scriptedAssistant(); } }, { bus });
    await wrapped.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(bus.recent("model")[0]!.data).toMatchObject({ tokensIn: 0, tokensOut: 0, cacheHitTokens: 0, retry: 0, ok: true });
  });

  it("generate 失败：ok:false 带 error，异常原样上抛", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const boom = new Error("503 up");
    const wrapped = probeModelClient({
      async generate() {
        throw boom;
      },
    }, { bus });
    await expect(wrapped.generate({ systemPrompt: "s", messages: [], tools: [] })).rejects.toThrow("503 up");
    expect(bus.recent("model")[0]!.data).toMatchObject({ ok: false, error: "503 up" });
  });

  it("stream：事件逐位透传；收尾记 ok:true", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const done = scriptedAssistant();
    const inner: ModelClient = {
      async *stream() {
        yield { type: "reasoning_delta", text: "think" };
        yield { type: "text_delta", text: "hi" };
        yield { type: "done", message: done };
      },
    };
    const wrapped = probeModelClient(inner, { bus });
    const got: unknown[] = [];
    for await (const e of wrapped.stream!({ systemPrompt: "s", messages: [], tools: [] })) got.push(e);
    expect(got).toEqual([
      { type: "reasoning_delta", text: "think" },
      { type: "text_delta", text: "hi" },
      { type: "done", message: done },
    ]);
    expect(bus.recent("model")[0]!.data).toMatchObject({ ok: true });
  });

  it("stream 中途弃收（break）：按未完成记账 ok:false/abandoned", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const inner: ModelClient = {
      async *stream() {
        yield { type: "text_delta", text: "a" };
        yield { type: "text_delta", text: "b" };
      },
    };
    const wrapped = probeModelClient(inner, { bus });
    for await (const _e of wrapped.stream!({ systemPrompt: "s", messages: [], tools: [] })) break;
    expect(bus.recent("model")[0]!.data).toMatchObject({ ok: false, error: "stream abandoned by consumer" });
  });

  it("stream 抛错：ok:false 带 error 且异常透传", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const wrapped = probeModelClient({
      async *stream() {
        yield { type: "text_delta", text: "x" };
        throw new Error("sse broke");
      },
    }, { bus });
    const consume = async (): Promise<void> => {
      for await (const _e of wrapped.stream!({ systemPrompt: "s", messages: [], tools: [] })) void _e;
    };
    await expect(consume()).rejects.toThrow("sse broke");
    expect(bus.recent("model")[0]!.data).toMatchObject({ ok: false, error: "sse broke" });
  });

  it("无 stream 的 client 包装后仍无 stream 面；modelId 透传", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const wrapped = probeModelClient({ modelId: "m", async generate() { return scriptedAssistant(); } }, { bus });
    expect("stream" in wrapped).toBe(false);
    expect(wrapped.modelId).toBe("m");
  });
});

// ---------------------------------------------------------------------------
// §4 tool.start / tool.finish（Tool 装饰）
// ---------------------------------------------------------------------------
const echoTool: Tool = {
  name: "echo",
  description: "echo back",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "path to echo" } },
    additionalProperties: false,
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(args: Record<string, unknown>) {
    return { content: `ok:${JSON.stringify(args)}` };
  },
};

describe("PB-1 工具探针", () => {
  it("成功路径：start{name,args} + finish{name,dur,ok,resultBytes}；结果原对象返回", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const wrapped = probeTool(echoTool, { bus });
    const args = { path: "a.ts" };
    const r = await wrapped.execute(args);
    const events = bus.recent("tool");
    expect(events.map((e) => e.name)).toEqual(["tool.start", "tool.finish"]);
    expect(events[0]!.data).toEqual({ name: "echo", args });
    expect(events[1]!.data).toMatchObject({ name: "echo", ok: true, resultBytes: r.content.length });
    expect(events[1]!.data.dur).toBe(events[1]!.dur);
    expect(typeof events[1]!.dur).toBe("number");
  });

  it("isError 结果：finish ok:false（仍是正常返回）", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const failing: Tool = {
      ...echoTool,
      name: "failing",
      async execute() {
        return { content: "nope", isError: true };
      },
    };
    await probeTool(failing, { bus }).execute({});
    const finish = bus.recent("tool")[1]!;
    expect(finish.data).toMatchObject({ name: "failing", ok: false, resultBytes: 4 });
  });

  it("执行抛错：finish ok:false 带 error 且异常原样上抛", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const throwing: Tool = {
      ...echoTool,
      name: "throwing",
      async execute() {
        throw new Error("boom");
      },
    };
    await expect(probeTool(throwing, { bus }).execute({})).rejects.toThrow("boom");
    expect(bus.recent("tool")[1]!.data).toMatchObject({ name: "throwing", ok: false, resultBytes: 0, error: "boom" });
  });

  it("probeTools：整表装饰保序保名；风险标注透传", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const second: Tool = { ...echoTool, name: "second" };
    const wrapped = probeTools([echoTool, second], { bus });
    expect(wrapped.map((t) => t.name)).toEqual(["echo", "second"]);
    const w0 = wrapped[0]!;
    expect(w0.isReadOnly?.({})).toBe(true);
    expect(w0.isConcurrencySafe?.({})).toBe(true);
    expect(w0.parameters).toBe(echoTool.parameters);
    await w0.execute({});
    expect(bus.recent("tool")).toHaveLength(2);
  });

  it("sessionId/lane 标注落到事件（车道格式位预占）", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    await probeTool(echoTool, { bus, sessionId: "s1", lane: "main" }).execute({});
    for (const e of bus.recent("tool")) {
      expect(e.sessionId).toBe("s1");
      expect(e.lane).toBe("main");
    }
  });
});

// ---------------------------------------------------------------------------
// §5 agent.turn / agent.retry / agent.steer（loop 事件转发）
// ---------------------------------------------------------------------------
/** 合成 loop 事件流（一轮带 delta 的 turn + 重试 + 转向）。 */
function syntheticLoop(): AsyncGenerator<LoopEvent, Terminal> {
  return (async function* (): AsyncGenerator<LoopEvent, Terminal> {
    yield { type: "turn_started", turn: 1 };
    yield { type: "reasoning_delta", turn: 1, text: "abc" };
    yield { type: "assistant_delta", turn: 1, text: "hello" };
    yield { type: "model_call_finished", turn: 1, hasToolCalls: true, toolCallCount: 2 };
    yield { type: "turn_finished", turn: 1, toolCallCount: 2 };
    yield { type: "turn_retried", turn: 2, attempt: 1, reason: "sse idle", reasonClass: "idle", leg: "main" };
    yield { type: "steered", turn: 2, text: "去查另一个文件" };
    return { reason: "completed" };
  })();
}

describe("PB-1 agent 探针（transition 转发）", () => {
  it("事件与 Terminal 返回值逐位透传（同一引用）；三类 agent.* 形状钉", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const inner = syntheticLoop();
    const wrapped = probeAgentLoop(inner, { bus });
    const { events, terminal } = await drain(wrapped);
    expect(terminal).toEqual({ reason: "completed" });
    expect(events.map((e) => e.type)).toEqual([
      "turn_started", "reasoning_delta", "assistant_delta", "model_call_finished", "turn_finished", "turn_retried", "steered",
    ]);
    const probes = bus.recent("agent");
    expect(probes.map((e) => e.name)).toEqual(["agent.turn", "agent.retry", "agent.steer"]);
    const turn = probes[0]!;
    expect(turn.data).toMatchObject({ turn: 1, toolCalls: 2, reasoningChars: 3, answerChars: 5 });
    expect(typeof turn.data.dur).toBe("number");
    expect(turn.dur).toBe(turn.data.dur);
    expect(probes[1]!.data).toEqual({ reason: "sse idle", attempt: 1 });
    expect(probes[2]!.data).toEqual({ text: "去查另一个文件" });
  });

  it("多轮流：每轮 turn_finished 各记一条 agent.turn（累计不串轮）", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const inner = (async function* (): AsyncGenerator<LoopEvent, Terminal> {
      yield { type: "turn_started", turn: 1 };
      yield { type: "reasoning_delta", turn: 1, text: "xyz" };
      yield { type: "turn_finished", turn: 1, toolCallCount: 0 };
      yield { type: "turn_started", turn: 2 };
      yield { type: "assistant_delta", turn: 2, text: "yes" };
      yield { type: "turn_finished", turn: 2, toolCallCount: 1 };
      return { reason: "completed" };
    })();
    await drain(probeAgentLoop(inner, { bus }));
    const turns = bus.recent("agent", 2);
    expect(turns.map((e) => e.data.turn)).toEqual([1, 2]);
    expect(turns[0]!.data.reasoningChars).toBe(3);
    expect(turns[0]!.data.answerChars).toBe(0);
    expect(turns[1]!.data.reasoningChars).toBe(0);
    expect(turns[1]!.data.answerChars).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §6 system.mem / system.uptime（定时采样，缺省关）
// ---------------------------------------------------------------------------
describe("PB-1 系统健康探针", () => {
  it("缺省关：探针未开时空句柄（sample 无事件）", () => {
    const bus = createProbeBus();
    const handle = startSystemProbes({ bus, intervalMs: 10 });
    handle.sample();
    handle.stop();
    expect(bus.recent()).toEqual([]);
  });

  it("采样形状钉：system.mem{rss,heapUsed,heapTotal,external} + system.uptime{seconds,activeSessions}", () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const handle = startSystemProbes({
      bus,
      intervalMs: 60_000,
      memoryUsage: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
      uptime: () => 42.5,
      activeSessions: () => 3,
    });
    handle.sample();
    expect(bus.recent("system").map((e) => [e.name, e.data])).toEqual([
      ["system.mem", { rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }],
      ["system.uptime", { seconds: 42.5, activeSessions: 3 }],
    ]);
    handle.stop();
  });

  it("stop 幂等且停后 sample 无事件；间隔缺省 60s 常量钉", () => {
    process.env[PROBE_ENV] = "on";
    const bus = createProbeBus();
    const handle = startSystemProbes({ bus, memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0 }), uptime: () => 1 });
    expect(SYSTEM_PROBE_INTERVAL_MS).toBe(60_000);
    handle.stop();
    handle.stop();
    handle.sample();
    expect(bus.recent()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §7 零侵入（探针关=被包装者字节不变）
// ---------------------------------------------------------------------------
describe("PB-1 零侵入纪律", () => {
  it("关闭时包装函数返回原对象（同一引用）", async () => {
    const client: ModelClient = { modelId: "m", async generate() { return scriptedAssistant(); } };
    const gen = syntheticLoop();
    expect(probeModelClient(client)).toBe(client);
    expect(probeTool(echoTool)).toBe(echoTool);
    const tools = [echoTool];
    expect(probeTools(tools)).toBe(tools);
    expect(probeAgentLoop(gen)).toBe(gen);
    await gen.return({ reason: "completed" });
  });

  it("loop 端到端：关→单例总线零新增；开→tool.*/agent.* 落单例总线且行为位面（事件序+terminal）不变", async () => {
    const makeRun = () => {
      const toolTurn: AssistantMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { path: "x" } }] };
      const finalTurn: AssistantMessage = { role: "assistant", content: "done" };
      const state: AgentState = {
        systemPrompt: "s",
        messages: [{ role: "user", content: "run" }],
        tools: [echoTool],
        status: "idle",
      };
      return { state, model: createScriptedModel([toolTurn, finalTurn]) };
    };

    // 关：跑完一轮，单例总线零新增
    const bus = probeBus();
    const before = bus.recent().length;
    const offRun = makeRun();
    const offOut = await drain(runAgentLoop(offRun.state, offRun.model, { maxTurns: 5 }));
    expect(bus.recent().length).toBe(before);

    // 开：同型 run，事件序与 terminal 完全一致（探针不改变 loop 行为位面）
    process.env[PROBE_ENV] = "on";
    const onRun = makeRun();
    const onOut = await drain(runAgentLoop(onRun.state, onRun.model, { maxTurns: 5 }));
    expect(onOut.terminal.reason).toBe(offOut.terminal.reason);
    expect(onOut.events.map((e) => e.type)).toEqual(offOut.events.map((e) => e.type));
    // 探针落单例总线：工具面与 agent 面（模型面挂 providers 工厂缝，不在 loop）
    const gained = bus.recent().length - before;
    expect(gained).toBeGreaterThan(0);
    const names = new Set(bus.recent(undefined, 12).map((e) => e.name));
    expect(names.has("tool.start")).toBe(true);
    expect(names.has("tool.finish")).toBe(true);
    expect(names.has("agent.turn")).toBe(true);
    expect(bus.stats().agent?.count).toBeGreaterThan(0);
    expect(bus.stats().tool?.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 基准×探针弧：梯子重试探针（model.retry）——probeModelClient 的 cap.retries
// 只见终局修复，梯子内重试此前整面不可见（4s 定谳盲点缝的接线收口）。
// ---------------------------------------------------------------------------
describe("model.retry 探针（梯子缝）", () => {
  it("关=纯 no-op 零事件；开=每次重试决策恰一条（attempt/delayMs/reason）", async () => {
    const { probeModelRetry } = await import("../src/probe.js");
    const bus = createProbeBus();
    const attemptFn = (fails: number): (() => Promise<string>) => {
      let n = 0;
      return async () => {
        n += 1;
        if (n <= fails) throw new Error(`net fail ${n}`);
        return "healed";
      };
    };
    // 关（缺省 env）：零事件
    const prev = process.env.WUDAO_PROBE;
    delete process.env.WUDAO_PROBE;
    probeModelRetry({ attempt: 1, delayMs: 0, reason: "test" }, bus);
    expect(bus.recent().length).toBe(0);
    // 开：恰一条、载荷精确
    process.env.WUDAO_PROBE = "on";
    probeModelRetry({ attempt: 2, delayMs: 120, reason: "5xx" }, bus);
    const rows = bus.recent();
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("model.retry");
    expect(rows[0]?.cat).toBe("model");
    expect(rows[0]?.data).toEqual({ attempt: 2, delayMs: 120, reason: "5xx" });
    process.env.WUDAO_PROBE = prev;
  });
});
