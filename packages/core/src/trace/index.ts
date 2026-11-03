// 135 — 可观测（trace）投影层的公共面。
//
// 三层，各自可独立测试：
//   attrs.ts     属性名/内容策略/脱敏（单一事实源）
//   projection.ts LoopEvent → TraceRun（纯函数，无 IO）
//   otlp.ts      TraceRun → OTLP JSON / protobuf（纯函数，零依赖）
//   exporter.ts  OTLP/HTTP 发送（缺省关、fail-silent、有界）
//   observe.ts   loop generator 的旁路包装（逐事件透传、结算一次）

export {
  ATTR, WD_TRACE_SCHEMA_VERSION, DEFAULT_CONTENT_MODE, CONTENT_PREVIEW_MAX_CHARS,
  redactText, isSensitiveKey,
} from "./attrs.js";
export type { ContentMode } from "./attrs.js";

export { projectTrace, traceIdFor } from "./projection.js";
export type { TraceRun, TraceSpan, SpanObservation, TimedLoopEvent, ProjectTraceOptions } from "./projection.js";

export { toOtlpRequest, toOtlpJson, toOtlpProto } from "./otlp.js";
export type {
  OtlpJsonRequest, OtlpJsonResourceSpans, OtlpJsonSpan, OtlpJsonKeyValue, OtlpJsonValue, OtlpExportOptions,
} from "./otlp.js";

export {
  createOtlpExporter, createOtlpExporterFromEnv,
  OTEL_ENDPOINT_ENV, OTEL_HEADERS_ENV, OTEL_AUTH_ENV, OTEL_ENCODING_ENV,
} from "./exporter.js";
export type { OtlpExporter, OtlpExporterOptions, OtlpEncoding } from "./exporter.js";

export { observeRun } from "./observe.js";
export type { ObserveRunOptions } from "./observe.js";
