// 135 §5.3 — TraceRun → OTLP（HTTP）载荷。两种编码，同一中间表示：
//   · `toOtlpJson()`   —— OTLP/HTTP 的 JSON 编码（Langfuse/LangSmith 都收；可 curl、可肉眼 diff）
//   · `toOtlpProto()`  —— OTLP/HTTP 的 protobuf 编码（紧凑、标准；手写 wire writer，零依赖）
//
// 为什么手写 protobuf 而不引 @opentelemetry/*：core 的依赖面是架构资产（CLAUDE.md
// 「Core ≠ Provider」同理）。这里只需要少量字段的编码，引一整套 SDK 会把它拖进
// 所有下游（含桌面 SEA 包体积）。手写 writer 由测试 + 一次 Python 侧
// `ResourceSpans.ParseFromString` 交叉校验钉死。
//
// 不变量：**root span 永远排在 spans 数组的第一个**（LangSmith 的教训：父 span 缺失
// 会导致子 span 被丢弃且不报错，见 135 §3.2）。
//
// 参考：opentelemetry-proto/opentelemetry/proto/{trace,common,resource}/v1/*.proto

import type { TraceRun, TraceSpan } from "./projection.js";
import { ATTR, WD_TRACE_SCHEMA_VERSION } from "./attrs.js";

/** OTLP/JSON 的 ResourceSpans 形状（数值字段按 JSON 规范为字符串）。 */
export interface OtlpJsonValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

export interface OtlpJsonKeyValue {
  key: string;
  value: OtlpJsonValue;
}

export interface OtlpJsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpJsonKeyValue[];
  status: { code: number; message?: string };
}

export interface OtlpJsonResourceSpans {
  resource: { attributes: OtlpJsonKeyValue[] };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: OtlpJsonSpan[];
  }>;
  schemaUrl?: string;
}

export interface OtlpJsonRequest {
  resourceSpans: OtlpJsonResourceSpans[];
}

export interface OtlpExportOptions {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly scopeName?: string;
  readonly scopeVersion?: string;
}

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;

/** observation → OTel SpanKind：generation 是出站调用，tool 是本地操作。 */
function spanKindOf(span: TraceSpan): number {
  return span.observation === "generation" ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL;
}

const STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 } as const;

/** ms → 纳秒字符串。**必须用 BigInt**：epoch 纳秒超过 2^53，JS 浮点乘法
 *  会把 1,760,000,000,005 ms 编成 …004,999,936 ns（约 130ns 漂移）。 */
function toNanos(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

function kv(key: string, value: string | number | boolean): OtlpJsonKeyValue {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/** root 优先，其余保持投影序（确定性——同一 run 两次导出字节相等）。 */
function orderedSpans(run: TraceRun): readonly TraceSpan[] {
  const root = run.spans.find((s) => s.spanId === run.rootSpanId);
  const rest = run.spans.filter((s) => s.spanId !== run.rootSpanId);
  return root === undefined ? rest : [root, ...rest];
}

/** TraceRun → OTLP/JSON 中间表示（纯函数）。 */
export function toOtlpRequest(run: TraceRun, opts: OtlpExportOptions = {}): OtlpJsonRequest {
  const serviceName = opts.serviceName ?? "wudao-harness";
  const serviceVersion = opts.serviceVersion ?? WD_TRACE_SCHEMA_VERSION;
  const spans: OtlpJsonSpan[] = orderedSpans(run).map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId !== undefined ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: spanKindOf(s),
    startTimeUnixNano: toNanos(s.startMs),
    endTimeUnixNano: toNanos(Math.max(s.endMs, s.startMs)),
    // 属性按 key 排序 → 字节确定（测试可 pin）。
    attributes: Object.keys(s.attributes)
      .sort()
      .map((k) => kv(k, s.attributes[k]!)),
    status: {
      code: STATUS_CODE[s.status.code],
      ...(s.status.message !== undefined ? { message: s.status.message } : {}),
    },
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            kv(ATTR.SERVICE_NAME, serviceName),
            kv(ATTR.SERVICE_VERSION, serviceVersion),
            kv(ATTR.SDK_NAME, "wudao.trace"),
            kv(ATTR.SDK_VERSION, WD_TRACE_SCHEMA_VERSION),
            ...(run.sessionId !== undefined ? [kv(ATTR.WD_SESSION_ID, run.sessionId)] : []),
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: opts.scopeName ?? "wudao-harness",
              version: opts.scopeVersion ?? WD_TRACE_SCHEMA_VERSION,
            },
            spans,
          },
        ],
      },
    ],
  };
}

/** OTLP/HTTP JSON body（可直接作为 fetch body 发给 `/v1/traces`）。 */
export function toOtlpJson(run: TraceRun, opts: OtlpExportOptions = {}): string {
  return JSON.stringify(toOtlpRequest(run, opts));
}

// ---------------------------------------------------------------------------
// 手写 protobuf wire 编码
// ---------------------------------------------------------------------------
// wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit

class ProtoWriter {
  private readonly chunks: number[] = [];

  varint(value: number): void {
    let v = value;
    while (v > 0x7f) {
      this.chunks.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.chunks.push(v & 0x7f);
  }

  /** fixed64（little-endian）—— 时间戳字段用它。超过 2^53 时必须传 BigInt。 */
  fixed64(value: number | bigint): void {
    const big = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.round(value)));
    for (let i = 0n; i < 8n; i++) {
      this.chunks.push(Number((big >> (8n * i)) & 0xffn));
    }
  }

  /** IEEE-754 double（fixed64 wire type 的浮点语义）。 */
  double(value: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    for (const b of new Uint8Array(buf)) this.chunks.push(b);
  }

  tag(fieldNumber: number, wireType: number): void {
    this.varint((fieldNumber << 3) | wireType);
  }

  bytes(value: Uint8Array): void {
    this.varint(value.length);
    for (const b of value) this.chunks.push(b);
  }

  string(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  /** 嵌套消息：先写子消息到独立 writer，再作为 length-delimited 追加。 */
  message(build: (w: ProtoWriter) => void): void {
    const nested = new ProtoWriter();
    build(nested);
    this.bytes(nested.toBytes());
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** AnyValue: string=1, bool=2, int=3, double=4（oneof，按类型只写一个）。 */
function writeAnyValue(w: ProtoWriter, value: OtlpJsonValue): void {
  if (value.stringValue !== undefined) {
    w.tag(1, 2);
    w.string(value.stringValue);
    return;
  }
  if (value.boolValue !== undefined) {
    w.tag(2, 0);
    w.varint(value.boolValue ? 1 : 0);
    return;
  }
  if (value.intValue !== undefined) {
    w.tag(3, 0);
    w.varint(Number(value.intValue));
    return;
  }
  if (value.doubleValue !== undefined) {
    w.tag(4, 1);
    // double 不是 fixed64 的整数语义——这里按 IEEE-754 写 8 字节。
    w.double(value.doubleValue);
  }
}

function writeKeyValue(w: ProtoWriter, pair: OtlpJsonKeyValue): void {
  w.message((kvWriter) => {
    kvWriter.tag(1, 2);
    kvWriter.string(pair.key);
    kvWriter.tag(2, 2);
    kvWriter.message((av) => writeAnyValue(av, pair.value));
  });
}

function writeSpan(w: ProtoWriter, span: OtlpJsonSpan): void {
  w.tag(1, 2);
  w.bytes(hexToBytes(span.traceId));
  w.tag(2, 2);
  w.bytes(hexToBytes(span.spanId));
  if (span.parentSpanId !== undefined && span.parentSpanId !== "") {
    w.tag(4, 2);
    w.bytes(hexToBytes(span.parentSpanId));
  }
  w.tag(5, 2);
  w.string(span.name);
  w.tag(6, 0);
  w.varint(span.kind);
  w.tag(7, 1);
  w.fixed64(BigInt(span.startTimeUnixNano));
  w.tag(8, 1);
  w.fixed64(BigInt(span.endTimeUnixNano));
  for (const attr of span.attributes) {
    w.tag(9, 2);
    writeKeyValue(w, attr);
  }
  w.tag(15, 2);
  w.message((st) => {
    if (span.status.message !== undefined) {
      st.tag(2, 2);
      st.string(span.status.message);
    }
    st.tag(3, 0);
    st.varint(span.status.code);
  });
}

/** OTLP/HTTP protobuf body（`ExportTraceServiceRequest` 的二进制编码）。 */
export function toOtlpProto(run: TraceRun, opts: OtlpExportOptions = {}): Uint8Array {
  const req = toOtlpRequest(run, opts);
  const w = new ProtoWriter();
  for (const rs of req.resourceSpans) {
    w.tag(1, 2);
    w.message((resourceSpans) => {
      // Resource { repeated KeyValue attributes = 1 }
      resourceSpans.tag(1, 2);
      resourceSpans.message((resource) => {
        for (const attr of rs.resource.attributes) {
          resource.tag(1, 2);
          writeKeyValue(resource, attr);
        }
      });
      for (const ss of rs.scopeSpans) {
        resourceSpans.tag(2, 2);
        resourceSpans.message((scopeSpans) => {
          scopeSpans.tag(1, 2);
          scopeSpans.message((scope) => {
            scope.tag(1, 2);
            scope.string(ss.scope.name);
            scope.tag(2, 2);
            scope.string(ss.scope.version);
          });
          for (const span of ss.spans) {
            scopeSpans.tag(2, 2);
            scopeSpans.message((s) => writeSpan(s, span));
          }
        });
      }
    });
  }
  return w.toBytes();
}
