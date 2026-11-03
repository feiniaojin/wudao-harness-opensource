// 135 §5.3 — OTLP/HTTP 导出器（缺省关、fail-silent、有界队列、绝不阻塞 loop）。
//
// 宪法（与 probe.ts 同一条：Events ≠ Hooks，观察永不改变执行）：
//   1. 缺省全关：没有 endpoint（env 或显式 opts）时 `createOtlpExporter` 返回
//      null，调用点拿到的不是一个"空转对象"而是 null —— 构造层面保证零开销。
//   2. fail-silent：任何网络/序列化/权限错误都被吞；导出失败绝不上抛给 loop。
//   3. 有界：队列满即丢弃并计数（丢的是 trace，不是运行）；永不无限重试。
//   4. 单向：只读 TraceRun，绝不回写任何状态。
//
// 端点约定：OTLP/HTTP 的基础端点以 `/v1/traces` 结尾时按原样使用；否则追加
// （与 OTel 规范一致：`OTEL_EXPORTER_OTLP_ENDPOINT` 是 base，signal path 由
// exporter 自己拼——LangSmith 文档专门警告过重复拼接 404）。

import type { TraceRun } from "./projection.js";
import { toOtlpJson, toOtlpProto } from "./otlp.js";

export const OTEL_ENDPOINT_ENV = "WUDAO_OTEL_ENDPOINT";
export const OTEL_HEADERS_ENV = "WUDAO_OTEL_HEADERS";
export const OTEL_AUTH_ENV = "WUDAO_OTEL_AUTH";
export const OTEL_ENCODING_ENV = "WUDAO_OTEL_ENCODING";

export type OtlpEncoding = "json" | "protobuf";

export interface OtlpExporterOptions {
  readonly endpoint: string;
  /** 附加头（Langfuse: Authorization=Basic …；LangSmith: x-api-key=…）。 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly encoding?: OtlpEncoding;
  /** 达到多少 span 触发一次发送（默认 64）。 */
  readonly flushAt?: number;
  /** 定时间隔（ms，默认 10s）。 */
  readonly flushIntervalMs?: number;
  /** 队列上限（span 条数；默认 2048，满即丢最旧的）。 */
  readonly maxQueue?: number;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  /** 注入用（测试）。默认 globalThis.fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 重试上限（默认 2；4xx 永不重试）。 */
  readonly maxRetries?: number;
}

export interface OtlpExporter {
  /** 追加一个 run（把它的 spans 全部入队；root 必然先于子 span 入队）。 */
  enqueue(run: TraceRun): void;
  /** 立即发送队列中所有 span（幂等并发安全）。 */
  flush(): Promise<void>;
  /** flush + 停表（进程退出前调用）。 */
  shutdown(): Promise<void>;
  /** 累计计数（不含敏感内容；给 /probe 类读面用）。 */
  stats(): { queued: number; sent: number; dropped: number; failed: number };
}

interface QueuedRun {
  readonly run: TraceRun;
  /** 该 run 的 span 条数（队列容量按 span 计；一个 run 只发一次请求）。 */
  readonly spanCount: number;
}

function resolveTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

function parseHeaderList(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key !== "" && value !== "") out[key] = value;
  }
  return out;
}

/** 从环境构造（缺省返回 null = 完全不启用，连对象都不存在）。 */
export function createOtlpExporterFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OtlpExporter | null {
  const endpoint = env[OTEL_ENDPOINT_ENV];
  if (endpoint === undefined || endpoint.trim() === "") return null;
  const headers = parseHeaderList(env[OTEL_HEADERS_ENV]);
  const auth = env[OTEL_AUTH_ENV];
  if (auth !== undefined && auth.trim() !== "" && headers["Authorization"] === undefined) {
    headers["Authorization"] = auth.startsWith("Basic ") ? auth : `Basic ${auth}`;
  }
  const encoding = env[OTEL_ENCODING_ENV] === "protobuf" ? "protobuf" : "json";
  return createOtlpExporter({ endpoint, headers, encoding });
}

export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  const url = resolveTracesEndpoint(opts.endpoint);
  const encoding: OtlpEncoding = opts.encoding ?? "json";
  const flushAt = Math.max(1, opts.flushAt ?? 64);
  const flushIntervalMs = Math.max(200, opts.flushIntervalMs ?? 10_000);
  // 队列上限独立于 flushAt：上限小于一次 flush 的量是合法配置（丢旧留新）。
  const maxQueue = Math.max(1, opts.maxQueue ?? 2048);
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    "content-type": encoding === "protobuf" ? "application/x-protobuf" : "application/json",
  };
  const exportOpts = {
    ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
    ...(opts.serviceVersion !== undefined ? { serviceVersion: opts.serviceVersion } : {}),
  };

  const queue: QueuedRun[] = [];
  let queuedSpans = 0;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const counters = { sent: 0, dropped: 0, failed: 0 };

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const sendBatch = async (batch: readonly QueuedRun[]): Promise<void> => {
    if (doFetch === undefined || batch.length === 0) return;
    // 一个 run 的 span 只导出一次（OTLP 允许一个请求携带多个 run，但分开更可归因）。
    for (const { run } of batch) {
      const body: string | Uint8Array = encoding === "protobuf" ? toOtlpProto(run, exportOpts) : toOtlpJson(run, exportOpts);
      let attempt = 0;
      while (attempt <= maxRetries) {
        try {
          const res = await doFetch(url, { method: "POST", headers, body });
          if (res.ok) {
            counters.sent += run.spans.length;
            break;
          }
          // 4xx = 永久拒绝（协议/鉴权/超限）→ 不重试，计数后丢弃。
          if (res.status < 500) {
            counters.failed += 1;
            break;
          }
          counters.failed += 1;
        } catch {
          counters.failed += 1;
        }
        attempt += 1;
        if (attempt <= maxRetries) {
          const backoff = 250 * 2 ** (attempt - 1);
          await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
  };

  const flush = async (): Promise<void> => {
    if (inFlight !== undefined) {
      await inFlight.catch(() => {});
    }
    const batch = queue.splice(0, queue.length);
    queuedSpans -= batch.reduce((n, item) => n + item.spanCount, 0);
    if (batch.length === 0) return;
    inFlight = sendBatch(batch)
      .catch(() => {})
      .finally(() => {
        inFlight = undefined;
      });
    await inFlight.catch(() => {});
  };

  const ensureTimer = (): void => {
    if (timer !== undefined || flushIntervalMs <= 0) return;
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    // Node 上不让导出定时器吊住进程退出（shutdown 仍会显式 flush）。
    const handle = timer as unknown as { unref?: () => void };
    handle.unref?.();
  };

  return {
    enqueue(run: TraceRun): void {
      if (closed) return;
      try {
        const spanCount = run.spans.length;
        if (spanCount === 0) return;
        // root 必然随 run 一起发出（投影层保证 root 在数组首位，OTLP 编码层
        // 再排一次序）——父先于子的不变量在这里不需要逐条入队来保证。
        queue.push({ run, spanCount });
        queuedSpans += spanCount;
        while (queuedSpans > maxQueue && queue.length > 1) {
          const evicted = queue.shift();
          if (evicted === undefined) break;
          queuedSpans -= evicted.spanCount;
          counters.dropped += evicted.spanCount;
        }
        if (queuedSpans >= flushAt) void flush();
        else ensureTimer();
      } catch {
        counters.dropped += 1;
      }
    },
    flush,
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      stopTimer();
      await flush();
    },
    stats() {
      return { queued: queuedSpans, ...counters };
    },
  };
}
