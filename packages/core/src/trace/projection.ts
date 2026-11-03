// 135 §5.5 — LoopEvent → span 树（纯投影）。
//
// 本模块是**纯函数**：输入「带时刻的 LoopEvent 序列」，输出 TraceRun（span 树）。
// 无 IO、无时钟读取（时刻由调用方给）、无全局状态 —— 因此全部行为可确定性钉测。
//
// 纪律：
//   · 单向投影：span 只能从事件**读出**，永不回流进 ModelInput（M24）。
//   · 缺证据不伪造：没有 usage 的 turn 省略 token 属性，不写 0。
//   · delta 不建 span：reasoning/assistant 的逐帧文本折成 model.call span 的计数属性。
//   · compacted 必建 span：它解释「这一轮为什么冷」——coldTurnExpected /
//     cacheBreakAttribution 落在**下一个** model.call 上，两者靠时间序对齐。
//   · 未识别的事件类型一律忽略（additive-only 契约；新事件不破旧消费者）。

import { createHash } from "node:crypto";
import type { LoopEvent } from "../loop.js";
import type { Terminal } from "../types.js";
import {
  ATTR, WD_TRACE_SCHEMA_VERSION,
  type ContentMode, DEFAULT_CONTENT_MODE, CONTENT_PREVIEW_MAX_CHARS, redactText,
} from "./attrs.js";

/** 一个 Observation 类型（Langfuse 的 observation type 词汇 + OTel span kind 的并集视角）。 */
export type SpanObservation = "agent" | "generation" | "tool" | "span" | "event" | "chain";

export interface TraceSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly observation: SpanObservation;
  /** epoch ms。 */
  readonly startMs: number;
  readonly endMs: number;
  readonly status: { readonly code: "UNSET" | "OK" | "ERROR"; readonly message?: string };
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface TraceRun {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly sessionId?: string;
  readonly runStartedAtMs: number;
  readonly runEndedAtMs: number;
  readonly spans: readonly TraceSpan[];
}

/** 带时刻的事件（时刻由消费者在收到时打点——导出侧零侵入的选择，见 135 §5.6）。 */
export interface TimedLoopEvent {
  readonly at: number;
  readonly event: LoopEvent;
}

export interface ProjectTraceOptions {
  /** 会话身份。缺省时 traceId 退化为「进程内序号 + runStartedAtMs」的哈希。 */
  readonly sessionId?: string;
  /** 内容策略三档；缺省 hash。 */
  readonly contentMode?: ContentMode;
  /** 脱敏用的家目录（传了就替换成 `~`）。 */
  readonly homeDir?: string;
  /** run 起始时刻（epoch ms）。必须与 traceId 种子一致，保证重放得同一 id。 */
  readonly runStartedAtMs: number;
  /** 终态（可选——缺席时 root span 状态为 UNSET）。 */
  readonly terminal?: Terminal;
}

/** OTel trace id 是 16 字节（32 hex）；span id 是 8 字节（16 hex）。 */
function sha16(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
function sha8(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/** 确定性 trace id：同一 (sessionId, runStartedAtMs) 必然得到同一 id ——
 *  本地 JSONL / eval receipt / 远端 trace 三者可复现 join（harbor ATIF 同款）。 */
export function traceIdFor(sessionId: string | undefined, runStartedAtMs: number): string {
  return sha16(`${sessionId ?? "-"}@${runStartedAtMs}`);
}

interface MutableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  observation: SpanObservation;
  startMs: number;
  endMs: number;
  status: TraceSpan["status"];
  attributes: Record<string, string | number | boolean>;
}

/** 内容 → 属性组（三档策略的唯一实现点）。 */
function contentAttrs(
  prefix: string,
  raw: string,
  mode: ContentMode,
  homeDir: string | undefined,
): Record<string, string | number> {
  if (mode === "off") return {};
  const bytes = Buffer.byteLength(raw, "utf8");
  const redacted = redactText(raw, homeDir);
  const out: Record<string, string | number> = {
    [`${prefix}.bytes`]: bytes,
  };
  if (mode === "full") {
    out[`${prefix}.text`] = redacted;
    return out;
  }
  // hash 档：指纹 + 有界预览（UTF-8 边界安全截断）。
  out[`${prefix}.sha256`] = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  if (redacted.length > CONTENT_PREVIEW_MAX_CHARS) {
    let cut = CONTENT_PREVIEW_MAX_CHARS;
    // 不切断代理对：回退到完整码点边界。
    const code = redacted.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out[`${prefix}.preview`] = redacted.slice(0, cut);
  } else {
    out[`${prefix}.preview`] = redacted;
  }
  return out;
}

/** 属性键映射：内容类属性走三档策略，其余走固定键。 */
const CONTENT_ATTR_KEYS = {
  "gen_ai.tool.call.arguments": "wudao.tool.arguments",
  "gen_ai.tool.call.result": "wudao.tool.result",
  "langfuse.observation.input": "wudao.model.input",
  "langfuse.observation.output": "wudao.model.output",
} as const;

/** 主投影：事件序列 → TraceRun。纯函数。 */
export function projectTrace(
  events: readonly TimedLoopEvent[],
  opts: ProjectTraceOptions,
): TraceRun {
  const mode = opts.contentMode ?? DEFAULT_CONTENT_MODE;
  const traceId = traceIdFor(opts.sessionId, opts.runStartedAtMs);
  let seq = 0;
  const spans: MutableSpan[] = [];

  const newSpan = (
    name: string,
    observation: SpanObservation,
    startMs: number,
    parentSpanId: string | undefined,
  ): MutableSpan => {
    seq += 1;
    const span: MutableSpan = {
      traceId,
      spanId: sha8(`${traceId}|${seq}`),
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      name,
      observation,
      startMs,
      endMs: startMs,
      status: { code: "UNSET" },
      attributes: {},
    };
    spans.push(span);
    return span;
  };

  const stampIdentity = (s: MutableSpan): void => {
    s.attributes[ATTR.WD_SCHEMA_VERSION] = WD_TRACE_SCHEMA_VERSION;
    if (opts.sessionId !== undefined) {
      // 三写：Langfuse 筛选、OTel 通用、LangSmith 各自要一份（135 §3.1）。
      s.attributes[ATTR.SESSION_ID] = opts.sessionId;
      s.attributes[ATTR.SESSION_ID_ALT] = opts.sessionId;
      s.attributes[ATTR.LANGSMITH_SESSION_ID] = opts.sessionId;
      s.attributes[ATTR.WD_SESSION_ID] = opts.sessionId;
    }
    s.attributes[ATTR.WD_RUN_ID] = traceId;
  };

  // —— root：agent.run ——
  const lastAt = events.length > 0 ? events[events.length - 1]!.at : opts.runStartedAtMs;
  const root = newSpan("agent.run", "agent", opts.runStartedAtMs, undefined);
  root.attributes[ATTR.OBSERVATION_TYPE] = "agent";
  root.attributes[ATTR.LANGSMITH_SPAN_KIND] = "chain";
  root.attributes[ATTR.TRACE_NAME] = "wudao.agent.run";
  stampIdentity(root);

  const turnSpans = new Map<number, MutableSpan>();
  /** 最近一次 model.call（usage 与 delta 折进去）。 */
  let lastModelSpan: MutableSpan | undefined;
  /** 最近一次 compacted 的补丁（下一个 model.call 读它写 cold 归因）。 */
  let pendingColdAttr: { attribution: string } | undefined;
  /** 未闭合的 tool span（按 toolCallId）。 */
  const openTools = new Map<string, MutableSpan>();
  /** 每个 turn 的 delta 计数（reasoning/answer 字符数 + TTFT 起点）。 */
  const turnDelta = new Map<number, { reasoningChars: number; answerChars: number; firstTokenAt?: number }>();

  const turnSpan = (turn: number, at: number): MutableSpan => {
    const existing = turnSpans.get(turn);
    if (existing !== undefined) return existing;
    const s = newSpan("turn", "span", at, root.spanId);
    s.attributes[ATTR.TURN_INDEX] = turn;
    s.attributes[ATTR.OBSERVATION_TYPE] = "span";
    stampIdentity(s);
    turnSpans.set(turn, s);
    return s;
  };

  for (const { at, event } of events) {
    switch (event.type) {
      case "turn_started": {
        turnSpan(event.turn, at);
        turnDelta.set(event.turn, { reasoningChars: 0, answerChars: 0 });
        break;
      }

      case "model_call_started": {
        const parent = turnSpan(event.turn, at);
        const s = newSpan("model.call", "generation", at, parent.spanId);
        s.attributes[ATTR.OBSERVATION_TYPE] = "generation";
        s.attributes[ATTR.LANGSMITH_SPAN_KIND] = "llm";
        s.attributes[ATTR.GEN_AI_OPERATION] = "chat";
        s.attributes[ATTR.TURN] = event.turn;
        if (pendingColdAttr !== undefined) {
          s.attributes[ATTR.CACHE_COLD_EXPECTED] = true;
          s.attributes[ATTR.CACHE_BREAK_ATTRIBUTION] = pendingColdAttr.attribution;
          pendingColdAttr = undefined;
        }
        stampIdentity(s);
        lastModelSpan = s;
        break;
      }

      case "reasoning_delta": {
        const d = turnDelta.get(event.turn);
        if (d !== undefined) {
          d.reasoningChars += event.text.length;
          d.firstTokenAt ??= at;
        }
        break;
      }

      case "assistant_delta": {
        const d = turnDelta.get(event.turn);
        if (d !== undefined) {
          d.answerChars += event.text.length;
          d.firstTokenAt ??= at;
        }
        break;
      }

      case "model_call_finished": {
        const s = lastModelSpan;
        if (s !== undefined) {
          s.endMs = at;
          s.attributes[ATTR.HAS_TOOL_CALLS] = event.hasToolCalls;
          s.attributes[ATTR.TOOL_CALL_COUNT] = event.toolCallCount;
          s.attributes[ATTR.DURATION_MS] = Math.max(0, at - s.startMs);
          s.status = { code: "OK" };
        }
        break;
      }

      case "usage": {
        const s = lastModelSpan;
        if (s === undefined) break;
        const u = event.usage;
        // omit-never-null：只在已知时写（M56 纪律）。
        if (u.promptTokens !== undefined) s.attributes[ATTR.INPUT_TOKENS] = u.promptTokens;
        if (u.completionTokens !== undefined) s.attributes[ATTR.OUTPUT_TOKENS] = u.completionTokens;
        if (u.promptTokens !== undefined && u.completionTokens !== undefined) {
          s.attributes[ATTR.TOTAL_TOKENS] = u.promptTokens + u.completionTokens;
        }
        s.attributes[ATTR.CACHE_HIT_TOKENS] = u.cacheHitTokens;
        s.attributes[ATTR.CACHE_MISS_TOKENS] = u.cacheMissTokens;
        if (u.cacheWriteTokens !== undefined) s.attributes[ATTR.CACHE_WRITE_TOKENS] = u.cacheWriteTokens;
        if (u.promptTokens > 0) {
          s.attributes[ATTR.CACHE_HIT_RATIO] = Number((u.cacheHitTokens / u.promptTokens).toFixed(4));
        }
        if (u.reasoningTokens !== undefined) s.attributes[ATTR.REASONING_TOKENS] = u.reasoningTokens;
        if (u.reasoningReplayTokens !== undefined) {
          s.attributes[ATTR.REASONING_REPLAY_TOKENS] = u.reasoningReplayTokens;
        }
        if (u.coldTurnExpected === true) s.attributes[ATTR.CACHE_COLD_EXPECTED] = true;
        if (u.cacheBreakAttribution !== undefined) {
          s.attributes[ATTR.CACHE_BREAK_ATTRIBUTION] = u.cacheBreakAttribution;
        }
        if (u.durationMs !== undefined) s.attributes[ATTR.DURATION_MS] = u.durationMs;
        break;
      }

      case "tool_call_started": {
        const parent = turnSpan(event.turn, at);
        const s = newSpan(`tool.${event.toolName}`, "tool", at, parent.spanId);
        s.attributes[ATTR.OBSERVATION_TYPE] = "tool";
        s.attributes[ATTR.LANGSMITH_SPAN_KIND] = "tool";
        s.attributes[ATTR.TOOL_NAME] = event.toolName;
        s.attributes[ATTR.TOOL_CALL_ID] = event.toolCallId;
        s.attributes[ATTR.TURN] = event.turn;
        const args = contentAttrs(
          CONTENT_ATTR_KEYS["gen_ai.tool.call.arguments"],
          safeJson(event.input),
          mode,
          opts.homeDir,
        );
        for (const [k, v] of Object.entries(args)) s.attributes[k] = v;
        s.attributes[ATTR.CONTENT_MODE] = mode;
        stampIdentity(s);
        openTools.set(event.toolCallId, s);
        break;
      }

      case "tool_call_finished": {
        const s = openTools.get(event.toolCallId);
        if (s === undefined) break;
        s.endMs = at;
        if (event.durationMs !== undefined) s.attributes[ATTR.DURATION_MS] = event.durationMs;
        else s.attributes[ATTR.DURATION_MS] = Math.max(0, at - s.startMs);
        const res = contentAttrs(
          CONTENT_ATTR_KEYS["gen_ai.tool.call.result"],
          event.result,
          mode,
          opts.homeDir,
        );
        for (const [k, v] of Object.entries(res)) s.attributes[k] = v;
        if (event.provenance !== undefined) s.attributes["wudao.tool.provenance"] = event.provenance;
        if (event.backgrounded === true) s.attributes["wudao.tool.backgrounded"] = true;
        s.status = event.isError ? { code: "ERROR" } : { code: "OK" };
        openTools.delete(event.toolCallId);
        break;
      }

      case "compacted": {
        const parent = turnSpan(event.turn, at);
        const s = newSpan("compact", "span", at, parent.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "span";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes[ATTR.COMPACT_TIER] = event.tier;
        s.attributes[ATTR.COMPACT_TRIGGER] = event.trigger;
        s.attributes[ATTR.COMPACT_REASON] = event.reason;
        s.attributes[ATTR.COMPACT_BEFORE_TOKENS] = event.beforeTokens;
        s.attributes[ATTR.COMPACT_AFTER_TOKENS] = event.afterTokens;
        if (event.windowIndex !== undefined) s.attributes[ATTR.COMPACT_WINDOW_INDEX] = event.windowIndex;
        if (event.economics !== undefined) {
          s.attributes[ATTR.COMPACT_CARRIED_DEBT_TOKENS] = event.economics.carriedDebtTokens;
          if (event.economics.breakevenRequests !== null) {
            s.attributes[ATTR.COMPACT_BREAKEVEN_REQUESTS] = event.economics.breakevenRequests;
          }
        }
        s.status = { code: "OK" };
        stampIdentity(s);
        // 下一个 model.call 是冷轮——按 M58 §A 归属一次。
        pendingColdAttr = { attribution: event.trigger };
        break;
      }

      case "compact_deferred": {
        const parent = turnSpan(event.turn, at);
        const s = newSpan("compact.deferred", "span", at, parent.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "span";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes["wudao.compact.defer_reason"] = safeText(event.reason, mode, opts.homeDir);
        if (event.economics !== undefined) {
          s.attributes[ATTR.COMPACT_CARRIED_DEBT_TOKENS] = event.economics.carriedDebtTokens;
        }
        stampIdentity(s);
        break;
      }

      case "loop_detected": {
        const s = newSpan("guard.loop", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.GUARD_KIND] = event.kind;
        s.attributes[ATTR.GUARD_ATTEMPT] = event.attempt;
        s.attributes[ATTR.GUARD_EVIDENCE] = safeText(event.evidence, mode, opts.homeDir);
        s.status = { code: "ERROR" };
        stampIdentity(s);
        break;
      }

      case "reflection_fork": {
        const s = newSpan("guard.reflection", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.GUARD_KIND] = event.kind;
        s.attributes["wudao.guard.outcome"] = event.outcome;
        if (event.rationale !== undefined) {
          s.attributes["wudao.guard.rationale"] = safeText(event.rationale, mode, opts.homeDir);
        }
        s.status = { code: event.outcome === "stuck" ? "ERROR" : "OK" };
        stampIdentity(s);
        break;
      }

      case "terminal_repair": {
        const s = newSpan("model.terminal_repair", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes["wudao.repair.kind"] = event.kind;
        s.attributes[ATTR.TURN] = event.turn;
        stampIdentity(s);
        break;
      }

      case "turn_retried": {
        const s = newSpan("turn.retried", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes["wudao.retry.attempt"] = event.attempt;
        s.attributes[ATTR.RETRY_CLASS] = event.reasonClass;
        s.attributes[ATTR.RETRY_LEG] = event.leg;
        s.attributes["wudao.retry.reason"] = safeText(event.reason, mode, opts.homeDir);
        s.status = { code: "ERROR" };
        stampIdentity(s);
        break;
      }

      case "context_recovery":
      case "output_limit_recovery": {
        const s = newSpan(
          event.type === "context_recovery" ? "recovery.context" : "recovery.output_limit",
          "event",
          at,
          root.spanId,
        );
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes[ATTR.RECOVERY_KIND] = event.kind;
        if (event.maxTokens !== undefined) s.attributes[ATTR.RECOVERY_MAX_TOKENS] = event.maxTokens;
        stampIdentity(s);
        break;
      }

      case "content_filter_guided":
      case "empty_final_recovery": {
        const s = newSpan(
          event.type === "content_filter_guided" ? "recovery.content_filter" : "recovery.empty_final",
          "event",
          at,
          root.spanId,
        );
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        if (event.type === "empty_final_recovery") s.attributes[ATTR.RECOVERY_KIND] = event.kind;
        stampIdentity(s);
        break;
      }

      case "gate_injected":
      case "meta_note":
      case "prompt_blocked": {
        const s = newSpan(
          event.type === "gate_injected" ? "gate.injected"
            : event.type === "meta_note" ? "gate.meta_note" : "gate.prompt_blocked",
          "event",
          at,
          root.spanId,
        );
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        const text = event.type === "prompt_blocked" ? event.reason : event.text;
        s.attributes["wudao.gate.text"] = safeText(text, mode, opts.homeDir);
        if (event.type === "prompt_blocked") s.status = { code: "ERROR" };
        if (event.type === "meta_note") s.attributes["wudao.gate.channel"] = event.channel;
        stampIdentity(s);
        break;
      }

      case "steered": {
        const s = newSpan("steer", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes["wudao.steer.text"] = safeText(event.text, mode, opts.homeDir);
        if (event.blockedReason !== undefined) {
          s.attributes["wudao.steer.blocked_reason"] = event.blockedReason;
          s.status = { code: "ERROR" };
        }
        stampIdentity(s);
        break;
      }

      case "session_budget_exhausted": {
        const s = newSpan("budget.exhausted", "event", at, root.spanId);
        s.endMs = at;
        s.attributes[ATTR.OBSERVATION_TYPE] = "event";
        s.attributes[ATTR.TURN] = event.turn;
        s.attributes["wudao.budget.used_units"] = event.usedUnits;
        s.status = { code: "ERROR" };
        stampIdentity(s);
        break;
      }

      case "turn_finished": {
        const s = turnSpans.get(event.turn);
        if (s !== undefined) {
          s.endMs = at;
          s.attributes[ATTR.TOOL_CALL_COUNT] = event.toolCallCount;
          const d = turnDelta.get(event.turn);
          if (d !== undefined) {
            s.attributes[ATTR.REASONING_CHARS] = d.reasoningChars;
            s.attributes[ATTR.ANSWER_CHARS] = d.answerChars;
            if (d.firstTokenAt !== undefined) {
              s.attributes["wudao.turn.ttft_ms"] = Math.max(0, d.firstTokenAt - s.startMs);
            }
          }
          s.status = { code: "OK" };
        }
        break;
      }

      // —— 不建 span 的事件：defer_loaded / continuation_injected /
      //    context_rule_loaded / assistant_interrupted / stream_preempted 等
      //    只有增量语义，噪声大于价值（135 §9「不做全自动埋点」）。
      default:
        break;
    }
  }

  // —— 收尾：零宽 span 按自身的"事件时刻"封口（瞬时事件 = start==end 是诚实的）
  //    —— 绝不把未闭合的 span 一律拉长到 run 末尾（那会伪造时长）。
  const endMs = Math.max(lastAt, opts.runStartedAtMs);
  for (const s of spans) {
    if (s.endMs < s.startMs) s.endMs = s.startMs;
  }
  root.endMs = endMs;
  if (opts.terminal !== undefined) {
    root.attributes[ATTR.TERMINAL_REASON] = opts.terminal.reason;
    root.status = opts.terminal.reason === "completed"
      ? { code: "OK" }
      : { code: "ERROR", message: opts.terminal.reason };
  }

  return {
    traceId,
    rootSpanId: root.spanId,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    runStartedAtMs: opts.runStartedAtMs,
    runEndedAtMs: endMs,
    spans: spans as readonly TraceSpan[],
  };
}

/** JSON 序列化（永不抛；循环引用退化成类型标注）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

/** 文本按内容策略收敛（event 类小文本也遵守三档）。 */
function safeText(text: string, mode: ContentMode, homeDir: string | undefined): string {
  if (mode === "off") return "[redacted]";
  const redacted = redactText(text, homeDir);
  if (mode === "full") return redacted;
  return redacted.length > CONTENT_PREVIEW_MAX_CHARS
    ? `${redacted.slice(0, CONTENT_PREVIEW_MAX_CHARS)}…`
    : redacted;
}
