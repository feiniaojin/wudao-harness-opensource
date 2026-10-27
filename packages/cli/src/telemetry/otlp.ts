// P2-15 (96 队列 #15) — 零依赖手写 OTLP HTTP/JSON payload 组装（纯函数）。
// 不引 @opentelemetry/* 任何包：这里只做最小 resourceSpans 结构与 OTLP
// JSON 的 any-value 拼装（stringValue/intValue/doubleValue/boolValue）。
// traceId 32-hex / spanId 16-hex、时间戳为纳秒字符串（BigInt 折算后转
// string —— number 会丢精度）、status code 0=UNSET 1=OK 2=ERROR、kind
// 1=INTERNAL。纯函数 + id 工厂/时钟注入 → deterministic 可测。
import { randomBytes } from "node:crypto";

/** OTLP JSON any-value: exactly one of the typed value members. */
export type OtelAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: number }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean };

/** One typed resource/span attribute. */
export interface OtelAttribute {
  readonly key: string;
  readonly value: OtelAnyValue;
}

export function strAttr(key: string, value: string): OtelAttribute {
  return { key, value: { stringValue: value } };
}

export function intAttr(key: string, value: number): OtelAttribute {
  return { key, value: { intValue: Math.round(value) } };
}

export function doubleAttr(key: string, value: number): OtelAttribute {
  return { key, value: { doubleValue: value } };
}

export function boolAttr(key: string, value: boolean): OtelAttribute {
  return { key, value: { boolValue: value } };
}

/** The exportable span record (the OTLP JSON spelling minus kind, added here). */
export interface OtelSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: 1; // SPAN_KIND_INTERNAL
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly attributes: readonly OtelAttribute[];
  /** 0 = UNSET, 1 = OK, 2 = ERROR. */
  readonly status: { readonly code: 0 | 1 | 2 };
}

/** Milliseconds since epoch → nanoseconds-as-string (BigInt: >2^53). */
export function nanosFromMs(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1000000n).toString();
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A 32-hex trace id from an injected 16-byte source (default: node crypto). */
export function mintTraceId(bytes: () => Uint8Array = () => randomBytes(16)): string {
  return toHex(bytes());
}

/** A 16-hex span id from an injected 16-byte source (first 8 bytes). */
export function mintSpanId(bytes: () => Uint8Array = () => randomBytes(16)): string {
  return toHex(bytes().slice(0, 8));
}

/** The minimal OTLP/JSON traces body: one resource + one scope, N spans. */
export function buildTracesPayload(
  resourceAttributes: readonly OtelAttribute[],
  spans: readonly OtelSpan[],
): { readonly resourceSpans: readonly unknown[] } {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: "wudao-harness.telemetry", version: "1" },
            spans,
          },
        ],
      },
    ],
  };
}
