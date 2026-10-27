// P2-15 (96 队列 #15) — TelemetryRuntime：turn/tool 两级 span 骑事件观察缝。
//
// 设计纪律（brief §硬约束，逐条落地）：
// • Redaction 先行——observe() 只读取事件的白名单字段（type/turn/
//   toolCallId/toolName/isError/durationMs）。消息文本（assistant_delta/
//   reasoning_delta/steered 的 text）、工具参数（tool_call_started 的
//   input）、工具结果（tool_call_finished 的 result）从不解构、从不进
//   span。span 与属性只含：span 名、时长、ok|error、工具名、model/
//   provider/session.id、token 数、priced cost。
// • usage 从 CostRegistry 现成分账取（rows 游标差量），unpriced 行
//   （costUsd===null）绝不折算成 cost_usd —— unpriced ≠ free，不造假。
// • best-effort：observe/flush/close 一切异常自吞（log 一条），绝不
//   rethrow 进主流程（红线中的红线——观测失败永不影响 loop/工具/回复）。
// • 缺省 off：settings 无 telemetry 节点 → resolveTelemetryConfig 返回
//   undefined → 不建 runtime，零 fetch、零分配。
// • 批量纪律：turn 边界（turn_finished）批量 flush，close（sessionEnd）
//   强制 flush；队列上限保护（超限丢最老并计数，绝不无界增长）。
// • 导出失败重试一次后放弃并 log——批次丢弃不回队（防死亡螺旋）。
import type { LoopEvent } from "@wudao/core";
import type { CostRow } from "../commands/cost.js";
import { buildTracesPayload, intAttr, doubleAttr, strAttr, mintSpanId, mintTraceId, nanosFromMs } from "./otlp.js";
import type { OtelAttribute, OtelSpan } from "./otlp.js";

/** The settings node shape this runtime consumes (telemetry.otlpEndpoint). */
export interface TelemetryConfig {
  readonly otlpEndpoint: string;
}

/**
 * Fail-closed resolution: anything but a non-empty string endpoint means OFF
 * (no network egress, no runtime). The caller wires `settings.telemetry`
 * (global-tier only — the settings-layer trust gate drops it from the
 * cloneable tiers; a cloned repo must not beacon the operator's telemetry).
 */
export function resolveTelemetryConfig(node: unknown): TelemetryConfig | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const raw = (node as Record<string, unknown>)["otlpEndpoint"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return { otlpEndpoint: raw.trim() };
}

/** A live (mutable-end) span in flight; exported via toOtelSpan at flush. */
interface LiveSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  endTimeUnixNano?: string;
  readonly attributes: OtelAttribute[];
  statusCode: 0 | 1 | 2;
}

function toOtelSpan(s: LiveSpan): OtelSpan {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId !== undefined ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: 1,
    startTimeUnixNano: s.startTimeUnixNano,
    ...(s.endTimeUnixNano !== undefined ? { endTimeUnixNano: s.endTimeUnixNano } : {}),
    attributes: s.attributes,
    status: { code: s.statusCode },
  };
}

export interface TelemetryRuntimeDeps {
  /** The collector base URL (POST {otlpEndpoint}/v1/traces). */
  readonly otlpEndpoint: string;
  readonly sessionId: string;
  /** Live model/provider identity (resource attributes; read at flush). */
  readonly liveIdentity: () => { readonly model: string; readonly provider?: string };
  /** The session's CostRegistry rows (read-only差量 — never mutated here). */
  readonly costRows: () => readonly CostRow[];
  /** Injectable transport (tests assert payload without a real collector). */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock (ms since epoch) — deterministic tests. */
  readonly now?: () => number;
  /** Injectable id factory — deterministic tests. */
  readonly ids?: { traceId(): string; spanId(): string };
  /** Failure log (default: silent; the engine wires its notice lane). */
  readonly log?: (line: string) => void;
  /** Per-attempt POST timeout. Default 8000ms. */
  readonly timeoutMs?: number;
  /** In-memory queue cap (overflow drops OLDEST and counts). Default 512. */
  readonly queueCap?: number;
  /** sessionEnd flush await cap — teardown never waits longer. Default 1500ms. */
  readonly closeAwaitCapMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_QUEUE_CAP = 512;
const DEFAULT_CLOSE_AWAIT_MS = 1500;

export class TelemetryRuntime {
  private readonly endpoint: string;
  private readonly sessionId: string;
  private readonly liveIdentity: () => { readonly model: string; readonly provider?: string };
  private readonly costRows: () => readonly CostRow[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ids: { traceId(): string; spanId(): string };
  private readonly logLine: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly queueCap: number;
  private readonly closeAwaitCapMs: number;

  private readonly traceId: string;
  private readonly sessionSpan: LiveSpan;
  private openTurn: { readonly turn: number; readonly span: LiveSpan } | undefined;
  private readonly openTools = new Map<string, LiveSpan>();
  private readonly queue: LiveSpan[] = [];
  private dropped = 0;
  private costCursor = 0;
  private sessionEnded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: TelemetryRuntimeDeps) {
    this.endpoint = deps.otlpEndpoint.replace(/\/+$/, "");
    this.sessionId = deps.sessionId;
    this.liveIdentity = deps.liveIdentity;
    this.costRows = deps.costRows;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.ids = deps.ids ?? { traceId: () => mintTraceId(), spanId: () => mintSpanId() };
    this.logLine = deps.log ?? (() => {});
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.queueCap = deps.queueCap ?? DEFAULT_QUEUE_CAP;
    this.closeAwaitCapMs = deps.closeAwaitCapMs ?? DEFAULT_CLOSE_AWAIT_MS;
    this.traceId = this.ids.traceId();
    this.sessionSpan = {
      traceId: this.traceId,
      spanId: this.ids.spanId(),
      name: "session",
      startTimeUnixNano: nanosFromMs(this.now()),
      attributes: [],
      statusCode: 0,
    };
  }

  /** Pending (closed, not yet exported) spans — queue-cap visibility. */
  get pendingSpanCount(): number {
    return this.queue.length;
  }

  /** Spans dropped by the queue cap since construction. */
  get droppedSpans(): number {
    return this.dropped;
  }

  // -------------------------------------------------------------------------
  // the events seam (observer only — every failure self-isolates)
  // -------------------------------------------------------------------------

  /**
   * Observe one LoopEvent. REDACTION: only the allowlisted fields below are
   * ever read; text-bearing payloads (assistant/reasoning deltas, steered,
   * tool input/result) are ignored entirely and can never reach a span.
   */
  observe(event: LoopEvent): void {
    try {
      switch (event.type) {
        case "turn_started":
          this.onTurnStarted(event.turn);
          return;
        case "tool_call_started":
          this.onToolStarted(event.turn, event.toolCallId, event.toolName);
          return;
        case "tool_call_finished":
          this.onToolFinished(event.toolCallId, event.isError, event.durationMs);
          return;
        case "turn_finished":
          this.onTurnFinished(event.turn);
          return;
        default:
          return; // text/usage/compaction events — deliberately unread
      }
    } catch (err) {
      this.note("observe failed (isolated)", err);
    }
  }

  private onTurnStarted(turn: number): void {
    // Orphan guard: a previous turn never finished (abort mid-turn) — close
    // it as-is so the map never leaks an open span.
    if (this.openTurn !== undefined && this.openTurn.turn !== turn) {
      this.closeSpan(this.openTurn.span);
      this.enqueue(this.openTurn.span);
      this.openTurn = undefined;
    }
    if (this.openTurn !== undefined) return;
    const span: LiveSpan = {
      traceId: this.traceId,
      spanId: this.ids.spanId(),
      parentSpanId: this.sessionSpan.spanId,
      name: "turn",
      startTimeUnixNano: nanosFromMs(this.now()),
      attributes: [intAttr("turn", turn)],
      statusCode: 0,
    };
    this.openTurn = { turn, span };
  }

  private onToolStarted(_turn: number, toolCallId: string, toolName: string): void {
    if (this.openTools.has(toolCallId)) return;
    const span: LiveSpan = {
      traceId: this.traceId,
      spanId: this.ids.spanId(),
      parentSpanId: (this.openTurn ?? { span: this.sessionSpan }).span.spanId,
      name: `tool.${toolName}`,
      startTimeUnixNano: nanosFromMs(this.now()),
      attributes: [strAttr("tool.name", toolName)],
      statusCode: 0,
    };
    this.openTools.set(toolCallId, span);
  }

  private onToolFinished(toolCallId: string, isError: boolean, durationMs?: number): void {
    const span = this.openTools.get(toolCallId);
    if (span === undefined) return; // unmatched (never started here) — ignore
    this.openTools.delete(toolCallId);
    if (durationMs !== undefined) span.attributes.push(intAttr("tool.duration_ms", durationMs));
    span.statusCode = isError ? 2 : 1;
    this.closeSpan(span);
    this.enqueue(span);
  }

  private onTurnFinished(turn: number): void {
    if (this.openTurn === undefined) return;
    const { span } = this.openTurn;
    this.openTurn = undefined;
    this.attachUsage(span, turn);
    span.statusCode = 1;
    this.closeSpan(span);
    this.enqueue(span);
    // Batch discipline: the turn boundary flushes (fire-and-forget, isolated).
    void this.flush();
  }

  /**
   * Usage attributes from the CostRegistry's existing ledger (cursor差量):
   * the rows recorded since the last turn boundary are THIS turn's calls.
   * unpriced ≠ free — cost_usd only when every delta row was priced.
   */
  private attachUsage(span: LiveSpan, _turn: number): void {
    const rows = this.costRows().slice(this.costCursor);
    this.costCursor += rows.length;
    if (rows.length === 0) return;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let costUsd = 0;
    let allPriced = true;
    for (const row of rows) {
      inputTokens += row.usage.promptTokens;
      outputTokens += row.usage.completionTokens ?? 0;
      reasoningTokens += row.usage.reasoningTokens ?? 0;
      if (row.costUsd === null) allPriced = false;
      else costUsd += row.costUsd;
    }
    const last = rows[rows.length - 1]!;
    span.attributes.push(
      strAttr("model", last.model),
      ...(last.provider !== undefined ? [strAttr("provider", last.provider)] : []),
      intAttr("input_tokens", inputTokens),
      intAttr("output_tokens", outputTokens),
      intAttr("reasoning_tokens", reasoningTokens),
      ...(allPriced ? [doubleAttr("cost_usd", costUsd)] : []),
    );
  }

  private closeSpan(span: LiveSpan): void {
    if (span.endTimeUnixNano === undefined) span.endTimeUnixNano = nanosFromMs(this.now());
  }

  private enqueue(span: LiveSpan): void {
    this.queue.push(span);
    // Queue-cap protection: drop the OLDEST closed spans (counts exposed).
    while (this.queue.length > this.queueCap) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  private resourceAttributes(): OtelAttribute[] {
    const identity = this.liveIdentity();
    return [
      strAttr("service.name", "wudao-harness"),
      strAttr("session.id", this.sessionId),
      strAttr("model", identity.model),
      ...(identity.provider !== undefined ? [strAttr("provider", identity.provider)] : []),
    ];
  }

  // -------------------------------------------------------------------------
  // export (best-effort: never throws, never requeues a failed batch)
  // -------------------------------------------------------------------------

  /** Drain the queue into one OTLP POST. Serialized on a chain; never rejects. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.drain());
    this.chain = run.catch((err) => {
      this.note("flush failed (isolated)", err);
    });
    return this.chain;
  }

  /**
   * sessionEnd: close the session root span (plus any stragglers), force a
   * flush, and NEVER let teardown wait past closeAwaitCapMs (the shared
   * SessionEnd budget discipline — hooks never hold the exit hostage).
   */
  async close(): Promise<void> {
    try {
      if (!this.sessionEnded) {
        this.sessionEnded = true;
        for (const span of this.openTools.values()) {
          this.closeSpan(span);
          this.enqueue(span);
        }
        this.openTools.clear();
        if (this.openTurn !== undefined) {
          this.attachUsage(this.openTurn.span, this.openTurn.turn);
          this.closeSpan(this.openTurn.span);
          this.enqueue(this.openTurn.span);
          this.openTurn = undefined;
        }
        this.closeSpan(this.sessionSpan);
        this.enqueue(this.sessionSpan);
      }
      const cap = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.closeAwaitCapMs);
        t.unref?.();
      });
      await Promise.race([this.flush(), cap]);
    } catch (err) {
      this.note("close failed (isolated)", err);
    }
  }

  private async drain(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload = buildTracesPayload(this.resourceAttributes(), batch.map(toOtelSpan));
    try {
      await this.post(payload);
    } catch (err) {
      // Give up after the in-post retry: drop the batch (no requeue — a dead
      // collector must not spiral memory or hammer the network).
      this.note(`OTLP export gave up — ${batch.length} span(s) dropped`, err);
    }
  }

  /** One POST {endpoint}/v1/traces with exactly one retry per failure class. */
  private async post(payload: unknown): Promise<void> {
    const url = `${this.endpoint}/v1/traces`;
    const body = JSON.stringify(payload);
    const attempt = async (): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        return await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let res: Response;
    try {
      res = await attempt();
    } catch {
      res = await attempt(); // network error → exactly one retry
    }
    if (res.ok) return;
    if (res.status >= 500 || res.status === 429) {
      const retried = await attempt().catch(() => null);
      if (retried !== null && retried.ok) return;
    }
    throw new Error(`OTLP collector answered ${res.status}`);
  }

  private note(what: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
    this.logLine(`telemetry: ${what}${detail !== "" ? ` (${detail})` : ""}`);
  }
}

/** Construct from already-resolved deps (the engine calls this directly). */
export function createTelemetryRuntime(deps: TelemetryRuntimeDeps): TelemetryRuntime {
  return new TelemetryRuntime(deps);
}

/**
 * The production call shape: settings node → runtime | undefined. Undefined
 * telemetry config ⇒ NO runtime ⇒ zero network calls, zero hot allocations
 * (fail-closed privacy default: unconfigured sends nothing).
 */
export function createTelemetryRuntimeFromSettings(
  node: unknown,
  deps: Omit<TelemetryRuntimeDeps, "otlpEndpoint">,
): TelemetryRuntime | undefined {
  const config = resolveTelemetryConfig(node);
  if (config === undefined) return undefined;
  return new TelemetryRuntime({ ...deps, otlpEndpoint: config.otlpEndpoint });
}
