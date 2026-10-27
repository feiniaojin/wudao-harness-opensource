// PB-1 — 探针基础设施弧首件：core 层探针总线 + 标准化遥测格式。
// 所有子系统（模型/工具/UI/系统/agent）共用一个 ProbeEvent 形状与一条进程级
// ProbeBus；内置探针以装饰器/包装器挂载在既有缝上，零改被包装者源码。
//
// 宪法（零侵入纪律，本弧钉死）：
//   1. 缺省全关——WUDAO_PROBE=on 才启用；关闭时每个包装函数返回原对象
//      （同一引用，连包装层都不存在，「不开探针=被包装者字节不变」由构造保证）。
//   2. fail-silent——emit 与订阅回调的一切失败被吞：监听器是观察者
//      （Events≠Hooks 纪律），探针永远不改变宿主行为、不放大宿主故障。
//   3. 环形缓冲缺省 1000 条（recent()/stats() 是 CLI 查询面；订阅是实时面）。
//   4. 内置五类事件的负载字段以本文件的 emit 点为单一事实源——后续弧
//      （web 层 ui.*、boot 层 system 采样接线）只加挂载点，不再发明格式。
//
// 挂载点地图（本弧落地的三处 + 一处待接线）：
//   model.call     probeModelClient —— providers 工厂返回缝（openai-compatible）
//   tool.start/finish  probeTools   —— core loop 的 execTools（executeToolCall 前）
//   agent.turn/retry/steer  probeAgentLoop —— runAgentLoop 导出薄壳（transition 缝）
//   system.mem/uptime  startSystemProbes —— 定时采样（60s，缺省关，boot 弧接线）
//   ui.*            不在本弧（web 层后续弧做）。

import type { ModelClient, ModelInput, ModelUsage, TerminalRepairKind } from "./model-client.js";
import type { Tool } from "./tool.js";
import type { ToolResult } from "./types.js";
import type { Terminal } from "./types.js";
// 仅类型引用（编译期擦除）：loop.ts 运行时反向 import 本模块，无环。
import type { LoopEvent } from "./loop.js";

// ---------------------------------------------------------------------------
// §1 标准化探针事件格式（所有子系统统一）
// ---------------------------------------------------------------------------

/** 五类探针之一。ui 类本弧只定义格式（web 层后续弧挂载）。 */
export type ProbeCategory = "model" | "tool" | "ui" | "system" | "agent";

/** 类别字面量表（测试与校验面的单一事实源）。 */
export const PROBE_CATEGORIES: readonly ProbeCategory[] = ["model", "tool", "ui", "system", "agent"];

/** 标准化遥测事件。`data` 自由形状但建议数值/字符串（可聚合、可序列化）；
 *  `dur` 只在 span 类事件（一次调用/一轮 turn）上出现，单位 ms。 */
export interface ProbeEvent {
  /** epoch ms。 */
  readonly ts: number;
  readonly cat: ProbeCategory;
  /** 事件名，点分命名空间（"model.call" / "tool.finish" / "ui.click"）。 */
  readonly name: string;
  /** 哪个会话/车道发出（可选——core 挂载点未知时缺省，后续弧接线补齐）。 */
  readonly sessionId?: string;
  /** 车道 id（多 driver 并发弧的 lane）。 */
  readonly lane?: string;
  readonly data: Record<string, unknown>;
  /** 持续时间 ms（span 类事件）。 */
  readonly dur?: number;
}

// ---------------------------------------------------------------------------
// §2 探针总线（环形缓冲 + 订阅面 + 统计面）
// ---------------------------------------------------------------------------

/** stats() 的单个类目行：累计计数 + 最近一次时间戳。 */
export interface ProbeBusStatsEntry {
  readonly count: number;
  readonly lastTs: number;
}

export interface ProbeBus {
  /** 发布一条事件。订阅回调的失败被隔离（绝不影响其它订阅者与宿主）；
   *  本方法自身也不会抛（零侵入纪律第 2 条）。 */
  emit(event: ProbeEvent): void;
  /** 订阅单类或 "*"（全部）。返回退订闭包（幂等）。 */
  subscribe(cat: ProbeCategory | "*", cb: (event: ProbeEvent) => void): () => void;
  /** 环形缓冲查询面：最近事件（时间升序）；cat 过滤后取最后 limit 条。 */
  recent(cat?: ProbeCategory, limit?: number): readonly ProbeEvent[];
  /** 统计面：按 cat 聚合 {count, lastTs}（只含见过的类目）。 */
  stats(): Record<string, ProbeBusStatsEntry>;
}

/** 环形缓冲缺省容量。 */
export const PROBE_RING_DEFAULT = 1000;

/** 新建一条独立总线（测试/嵌入方用；进程级单例走 probeBus()）。 */
export function createProbeBus(opts?: { ringSize?: number }): ProbeBus {
  const ringSize = Math.max(1, Math.floor(opts?.ringSize ?? PROBE_RING_DEFAULT));
  // 预分配真环：head=下一写位，size=在环条数（≤ringSize）。
  const ring: (ProbeEvent | undefined)[] = new Array<ProbeEvent | undefined>(ringSize).fill(undefined);
  let head = 0;
  let size = 0;
  // 订阅面：cat（或 "*"）→ 注册序集合。Map/Set 保插入序=回调确定序。
  const subs = new Map<ProbeCategory | "*", Set<(event: ProbeEvent) => void>>();
  // 统计面：cat → {count, lastTs}。
  const counts = new Map<ProbeCategory, { count: number; lastTs: number }>();

  const notify = (event: ProbeEvent): void => {
    // 单类订阅者先于通配订阅者（各自按注册序）——确定序，文档化即契约。
    for (const cb of subs.get(event.cat) ?? []) {
      try {
        cb(event);
      } catch {
        /* 监听器失败隔离——绝不影响宿主与其它订阅者 */
      }
    }
    for (const cb of subs.get("*") ?? []) {
      try {
        cb(event);
      } catch {
        /* 同上 */
      }
    }
  };

  return {
    emit(event: ProbeEvent): void {
      // 环+统计先落（观察者依赖它们已完成），全程不抛。
      try {
        ring[head] = event;
        head = (head + 1) % ringSize;
        size = Math.min(size + 1, ringSize);
        const prev = counts.get(event.cat);
        counts.set(event.cat, { count: (prev?.count ?? 0) + 1, lastTs: event.ts });
      } catch {
        /* 缓冲/统计失败也绝不外抛 */
      }
      notify(event);
    },
    subscribe(cat, cb) {
      let set = subs.get(cat);
      if (set === undefined) {
        set = new Set();
        subs.set(cat, set);
      }
      set.add(cb);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set!.delete(cb);
        if (set!.size === 0) subs.delete(cat);
      };
    },
    recent(cat, limit) {
      // 时间升序遍历：未满环从 0；满环从 head（最老在写位）。
      const ordered: ProbeEvent[] = [];
      const start = size < ringSize ? 0 : head;
      for (let i = 0; i < size; i++) {
        const ev = ring[(start + i) % ringSize];
        if (ev !== undefined) ordered.push(ev);
      }
      const filtered = cat === undefined ? ordered : ordered.filter((e) => e.cat === cat);
      if (limit === undefined) return filtered;
      return filtered.slice(Math.max(0, filtered.length - Math.max(0, limit)));
    },
    stats() {
      const out: Record<string, ProbeBusStatsEntry> = {};
      for (const [cat, row] of counts) out[cat] = { ...row };
      return out;
    },
  };
}

let processBus: ProbeBus | undefined;

/** 进程级记忆化单例（内置挂载点的默认总线）。 */
export function probeBus(): ProbeBus {
  processBus ??= createProbeBus();
  return processBus;
}

// ---------------------------------------------------------------------------
// §3 总开关（缺省全关）
// ---------------------------------------------------------------------------

/** 启用环境变量名（唯一真值点；wiring 层与测试都引用本常量）。 */
export const PROBE_ENV = "WUDAO_PROBE";

/** 探针是否启用：WUDAO_PROBE 恰为 "on"。逐调用读环境（boot 期一次置位，
 *  测试可切换）；非 Node 环境恒关。 */
/** 梯子重试探针（cat model，基准×探针弧接线）：每次梯子重试决策一条
 *  （attempt/delayMs/reason）。probeModelClient 的 cap.retries 只见终局
 *  修复——梯子内的重试此前整面不可见（4s 定谳时 47 次 abort 全记
 *  retry=0 的盲点缝）。关=纯 no-op（零侵入纪律）。 */
export function probeModelRetry(info: { attempt: number; delayMs: number; reason: string }, bus: ProbeBus = probeBus()): void {
  if (!probeEnabled()) return;
  safeEmit(bus, {
    ts: Date.now(),
    cat: "model",
    name: "model.retry",
    data: { attempt: info.attempt, delayMs: info.delayMs, reason: info.reason },
  });
}

export function probeEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.[PROBE_ENV] === "on";
}

/** 包装器族的公共可选项：注入独立总线（测试）+ 会话/车道标注。 */
export interface ProbeMountOpts {
  /** 诊断缝：失败面的栈头（内部组装，非公开 API）。 */
  __stack?: string;
  bus?: ProbeBus;
  sessionId?: string;
  lane?: string;
}

/** fail-silent 发布：包装点唯一出口（零侵入纪律第 2 条的最后一道闸）。 */
function safeEmit(bus: ProbeBus, event: ProbeEvent): void {
  try {
    bus.emit(event);
  } catch {
    /* 探针失败绝不影响宿主 */
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// §4 内置探针——模型调用（model.call）
//   包装 ModelClient（装饰器；零改 provider 本体），挂在 providers 工厂返回缝。
//   tokens 语义：tokensIn=promptTokens，tokensOut=completionTokens（端点未
//   报 usage 的老构造器按 0 记），cacheHitTokens=缓存命中；retry=终局修复的
//   冻结重放次数（M48 §2 语义内的重试；梯子 onRetry 缝由后续弧接入）。
// ---------------------------------------------------------------------------

interface CallCapture {
  usage?: ModelUsage;
  retries: number;
}

/** 链式 tap：先记探针侧，再原样转调调用方的 onUsage/onTerminalRepair
 *  （调用方回抛=调用方的 bug，语义原样透传——M24 契约不变）。 */
function tapModelInput(input: ModelInput, cap: CallCapture): ModelInput {
  return {
    ...input,
    onUsage: (usage: ModelUsage): void => {
      cap.usage = usage;
      input.onUsage?.(usage);
    },
    onTerminalRepair: (kind: TerminalRepairKind): void => {
      cap.retries += 1;
      input.onTerminalRepair?.(kind);
    },
  };
}

function emitModelCall(
  bus: ProbeBus,
  modelId: string | undefined,
  cap: CallCapture,
  latencyMs: number,
  ok: boolean,
  failure: string | undefined,
  opts: ProbeMountOpts | undefined,
): void {
  const u = cap.usage;
  safeEmit(bus, {
    ts: Date.now(),
    cat: "model",
    name: "model.call",
    ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts?.lane !== undefined ? { lane: opts.lane } : {}),
    data: {
      model: modelId ?? "unknown",
      tokensIn: u?.promptTokens ?? 0,
      tokensOut: u?.completionTokens ?? 0,
      cacheHitTokens: u?.cacheHitTokens ?? 0,
      latencyMs,
      retry: cap.retries,
      ok,
      ...(failure !== undefined ? { error: failure } : {}),
      ...(opts?.__stack !== undefined ? { stack: opts.__stack } : {}),
    },
    dur: latencyMs,
  });
}

/** 装饰 ModelClient：generate/stream 各记一条 model.call。关闭时返回原对象
 *  （同一引用）。stream 的三个终态——正常收尾/抛错/消费者提前弃收——都记账
 *  （弃收按 ok:false、error:"stream abandoned by consumer"）。 */
export function probeModelClient(client: ModelClient, opts?: ProbeMountOpts): ModelClient {
  if (!probeEnabled()) return client;
  const bus = opts?.bus ?? probeBus();
  const wrapped: ModelClient = {
    ...(client.modelId !== undefined ? { modelId: client.modelId } : {}),
    async generate(input: ModelInput) {
      const cap: CallCapture = { retries: 0 };
      const t0 = Date.now();
      try {
        const message = await client.generate(tapModelInput(input, cap));
        emitModelCall(bus, client.modelId, cap, Date.now() - t0, true, undefined, opts);
        return message;
      } catch (err) {
        emitModelCall(bus, client.modelId, cap, Date.now() - t0, false, errText(err), { ...opts, __stack: err instanceof Error && err.stack !== undefined ? err.stack.split("\n").slice(0, 14).join(" ⇐ ") + " || cause=" + String((err as { cause?: unknown }).cause ?? "") : undefined });
        throw err;
      }
    },
    ...(client.stream !== undefined
      ? {
          async *stream(input: ModelInput) {
            const inner = client.stream;
            if (inner === undefined) return;
            const cap: CallCapture = { retries: 0 };
            const t0 = Date.now();
            let settled = false;
            try {
              for await (const ev of inner(tapModelInput(input, cap))) yield ev;
              settled = true;
              emitModelCall(bus, client.modelId, cap, Date.now() - t0, true, undefined, opts);
            } catch (err) {
              settled = true;
              emitModelCall(bus, client.modelId, cap, Date.now() - t0, false, errText(err), { ...opts, __stack: err instanceof Error && err.stack !== undefined ? err.stack.split("\n").slice(0, 14).join(" ⇐ ") + " || cause=" + String((err as { cause?: unknown }).cause ?? "") : undefined });
              throw err;
            } finally {
              if (!settled) {
                // for-await 提前 break 会调 return()——弃收也是一次未完成的调用。
                emitModelCall(bus, client.modelId, cap, Date.now() - t0, false, "stream abandoned by consumer", opts);
              }
            }
          },
        }
      : {}),
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// §5 内置探针——工具调用（tool.start / tool.finish）
//   包装 Tool 接口（零改工具本体），挂在 core loop 的 execTools（executeToolCall
//   的查找表——每次执行必经）。resultBytes=结果 content 的字符串长度。
// ---------------------------------------------------------------------------

function resultBytesOf(result: ToolResult): number {
  return typeof result.content === "string" ? result.content.length : 0;
}

/** 装饰单个 Tool：execute 前后各记一条。关闭时返回原对象。执行抛错照原样
 *  上抛（executeToolCall 本就把抛错归一为 error tool result——行为不变）。 */
export function probeTool(tool: Tool, opts?: ProbeMountOpts): Tool {
  if (!probeEnabled()) return tool;
  const bus = opts?.bus ?? probeBus();
  const stamp = opts?.sessionId !== undefined || opts?.lane !== undefined
    ? { ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}), ...(opts?.lane !== undefined ? { lane: opts.lane } : {}) }
    : {};
  return {
    ...tool,
    async execute(args: Record<string, unknown>, onUpdate, signal) {
      safeEmit(bus, {
        ts: Date.now(),
        cat: "tool",
        name: "tool.start",
        ...stamp,
        data: { name: tool.name, args },
      });
      const t0 = Date.now();
      try {
        const result = await tool.execute(args, onUpdate, signal);
        const dur = Date.now() - t0;
        safeEmit(bus, {
          ts: Date.now(),
          cat: "tool",
          name: "tool.finish",
          ...stamp,
          data: { name: tool.name, dur, ok: result.isError !== true, resultBytes: resultBytesOf(result) },
          dur,
        });
        return result;
      } catch (err) {
        const dur = Date.now() - t0;
        safeEmit(bus, {
          ts: Date.now(),
          cat: "tool",
          name: "tool.finish",
          ...stamp,
          data: { name: tool.name, dur, ok: false, resultBytes: 0, error: errText(err) },
          dur,
        });
        throw err;
      }
    },
  };
}

/** 装饰一张工具表（保持序与名字面；loop 的 execTools 挂载点）。关闭时返回
 *  原数组（同一引用）。 */
export function probeTools(tools: readonly Tool[], opts?: ProbeMountOpts): readonly Tool[] {
  if (!probeEnabled()) return tools;
  return tools.map((tool) => probeTool(tool, opts));
}

// ---------------------------------------------------------------------------
// §6 内置探针——agent 行为（agent.turn / agent.retry / agent.steer）
//   loop 已有事件流直接转发：包装 runAgentLoop 产出的 generator（transition
//   缝），逐事件翻译，事件与 Terminal 返回值原样透传。
//   · agent.turn   ← turn_finished（dur=turn_started→turn_finished 墙钟，
//                    含工具时间；reasoning/answer 字符数由 delta 累计）
//   · agent.retry  ← turn_retried（断流重连梯）
//   · agent.steer  ← steered（转向注入）
// ---------------------------------------------------------------------------

/** 有状态翻译器：delta 字符累计 + 轮起计时。 */
export function createAgentProbeForwarder(opts?: ProbeMountOpts): (event: LoopEvent) => void {
  const bus = opts?.bus ?? probeBus();
  const stamp = opts?.sessionId !== undefined || opts?.lane !== undefined
    ? { ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}), ...(opts?.lane !== undefined ? { lane: opts.lane } : {}) }
    : {};
  let turnStart: number | undefined;
  let reasoningChars = 0;
  let answerChars = 0;
  return (event: LoopEvent): void => {
    switch (event.type) {
      case "turn_started":
        turnStart = Date.now();
        reasoningChars = 0;
        answerChars = 0;
        return;
      case "reasoning_delta":
        reasoningChars += event.text.length;
        return;
      case "assistant_delta":
        answerChars += event.text.length;
        return;
      case "turn_finished": {
        const dur = turnStart !== undefined ? Date.now() - turnStart : 0;
        safeEmit(bus, {
          ts: Date.now(),
          cat: "agent",
          name: "agent.turn",
          ...stamp,
          data: { turn: event.turn, toolCalls: event.toolCallCount, reasoningChars, answerChars, dur },
          dur,
        });
        return;
      }
      case "turn_retried":
        safeEmit(bus, {
          ts: Date.now(),
          cat: "agent",
          name: "agent.retry",
          ...stamp,
          data: { reason: event.reason, attempt: event.attempt },
        });
        return;
      case "steered":
        safeEmit(bus, {
          ts: Date.now(),
          cat: "agent",
          name: "agent.steer",
          ...stamp,
          data: { text: event.text },
        });
        return;
      default:
        return;
    }
  };
}

/** 装饰 loop generator：翻译 transition 为 agent.* 探针。关闭时返回原
 *  generator（同一引用）。Terminal 返回值逐位透传；消费者提前 break/return
 *  时 finally 把 return() 传进内层（for-await 语义等价——内层清理照跑）。
 *  唯一收窄：消费者向 generator 注入 throw() 不转发（本仓无此用例，见弧记）。 */
export function probeAgentLoop(
  gen: AsyncGenerator<LoopEvent, Terminal>,
  opts?: ProbeMountOpts,
): AsyncGenerator<LoopEvent, Terminal> {
  if (!probeEnabled()) return gen;
  const onEvent = createAgentProbeForwarder(opts);
  return (async function* forwarding(): AsyncGenerator<LoopEvent, Terminal> {
    try {
      while (true) {
        const r = await gen.next();
        if (r.done) return r.value;
        onEvent(r.value);
        yield r.value;
      }
    } finally {
      // 正常收尾后 return() 对已完 generator 是无操作；弃收路径由此传播。
      await gen.return(undefined as unknown as Terminal);
    }
  })();
}

// ---------------------------------------------------------------------------
// §7 内置探针——系统健康（system.mem / system.uptime）
//   定时采样（60s 缺省），缺省关：由 boot 接线层显式 startSystemProbes()
//   （且仅在探针开启时）；测试经 handle.sample() 手动触发。
// ---------------------------------------------------------------------------

/** 采样间隔缺省（60s）。 */
export const SYSTEM_PROBE_INTERVAL_MS = 60_000;

export interface SystemProbeOpts {
  bus?: ProbeBus;
  /** 采样间隔 ms（缺省 60_000）。 */
  intervalMs?: number;
  /** 活跃会话数来源（缺省恒 0——会话账本在 driver 层，后续弧接线注入）。 */
  activeSessions?: () => number;
  /** 内存快照来源（缺省 process.memoryUsage；测试注入定值）。 */
  memoryUsage?: () => { rss: number; heapUsed: number; heapTotal: number; external: number };
  /** 运行秒数来源（缺省 process.uptime）。 */
  uptime?: () => number;
}

export interface SystemProbeHandle {
  /** 停止采样（幂等）。 */
  stop(): void;
  /** 立即采一次样（定时器的 tick 本体；测试面）。 */
  sample(): void;
}

/** 启动系统健康采样。探针未开启时返回空句柄（双重门：接线层 + 这里）。 */
export function startSystemProbes(opts?: SystemProbeOpts): SystemProbeHandle {
  if (!probeEnabled()) return { stop: () => {}, sample: () => {} };
  const bus = opts?.bus ?? probeBus();
  const activeSessions = opts?.activeSessions ?? (() => 0);
  const memoryUsage = opts?.memoryUsage
    ?? (() => {
        if (typeof process !== "undefined" && typeof process.memoryUsage === "function") {
          return process.memoryUsage();
        }
        return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
      });
  const uptime = opts?.uptime
    ?? (() => (typeof process !== "undefined" && typeof process.uptime === "function" ? process.uptime() : 0));
  const intervalMs = Math.max(1, Math.floor(opts?.intervalMs ?? SYSTEM_PROBE_INTERVAL_MS));

  let stopped = false;
  const sample = (): void => {
    if (stopped) return;
    const mem = memoryUsage();
    safeEmit(bus, {
      ts: Date.now(),
      cat: "system",
      name: "system.mem",
      data: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    });
    safeEmit(bus, {
      ts: Date.now(),
      cat: "system",
      name: "system.uptime",
      data: { seconds: uptime(), activeSessions: activeSessions() },
    });
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    sample,
  };
}
