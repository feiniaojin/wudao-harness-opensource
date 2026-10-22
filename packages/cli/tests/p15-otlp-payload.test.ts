// P2-15 (96 队列 #15) — OTLP payload 组装（纯函数）。零依赖手写 OTLP
// HTTP/JSON：最小 resourceSpans 结构、session→turn→tool 父子 spanId 链、
// 属性值形（stringValue/intValue/doubleValue）。deterministic：id 工厂注入。
import { describe, it, expect } from "vitest";
import {
  strAttr,
  intAttr,
  doubleAttr,
  buildTracesPayload,
  mintTraceId,
  mintSpanId,
} from "../src/telemetry/otlp.js";

describe("attribute constructors (OTLP JSON value shape)", () => {
  it("string / int / double map to the OTLP any-value spelling", () => {
    expect(strAttr("model", "deepseek-v4")).toEqual({ key: "model", value: { stringValue: "deepseek-v4" } });
    expect(intAttr("input_tokens", 1200)).toEqual({ key: "input_tokens", value: { intValue: 1200 } });
    expect(doubleAttr("cost_usd", 0.000776)).toEqual({ key: "cost_usd", value: { doubleValue: 0.000776 } });
  });
});

describe("mintTraceId / mintSpanId", () => {
  it("mints 32-hex trace ids and 16-hex span ids from the injected byte source", () => {
    // A counter byte source: every call advances, so ids are deterministic
    // AND distinct (each byte consumed exactly once).
    let n = 0;
    const bytes = () => new Uint8Array(Array.from({ length: 16 }, () => (n += 1) & 0xff));
    const t1 = mintTraceId(bytes);
    const t2 = mintTraceId(bytes);
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(t2).toMatch(/^[0-9a-f]{32}$/);
    expect(t1).not.toBe(t2);
    const s = mintSpanId(bytes);
    expect(s).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildTracesPayload (minimal resourceSpans)", () => {
  it("wraps spans under resource + one scopeSpans, resource attrs included", () => {
    const session = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "session",
      kind: 1,
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      attributes: [],
      status: { code: 1 },
    };
    const turn = {
      traceId: "a".repeat(32),
      spanId: "c".repeat(16),
      parentSpanId: "b".repeat(16),
      name: "turn",
      kind: 1,
      startTimeUnixNano: "1100000000",
      endTimeUnixNano: "1900000000",
      attributes: [intAttr("turn", 1)],
      status: { code: 1 },
    };
    const payload = buildTracesPayload(
      [strAttr("service.name", "wudao-harness"), strAttr("session.id", "s-1")],
      [session, turn],
    );
    // Top-level shape: exactly one resourceSpans entry.
    expect(Object.keys(payload)).toEqual(["resourceSpans"]);
    const rs = (payload as { resourceSpans: unknown[] }).resourceSpans[0] as {
      resource: { attributes: { key: string; value: { stringValue: string } }[] };
      scopeSpans: { scope: { name: string }; spans: unknown[] }[];
    };
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "wudao-harness" } },
      { key: "session.id", value: { stringValue: "s-1" } },
    ]);
    expect(rs.scopeSpans.length).toBe(1);
    expect(rs.scopeSpans[0]!.scope.name).toBe("wudao-harness.telemetry");
    expect(rs.scopeSpans[0]!.spans).toHaveLength(2);
    // Hierarchy: the turn's parent is the session span id; one shared trace.
    const spans = rs.scopeSpans[0]!.spans as { name: string; spanId: string; parentSpanId?: string; traceId: string }[];
    expect(spans.find((s) => s.name === "turn")!.parentSpanId).toBe(spans.find((s) => s.name === "session")!.spanId);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    // Serializable to JSON without BigInt errors (timestamps are strings).
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it("an empty span list still builds (flush edge) — spans array empty, not malformed", () => {
    const payload = buildTracesPayload([strAttr("service.name", "wudao-harness")], []);
    const rs = (payload as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }).resourceSpans[0]!;
    expect(rs.scopeSpans[0]!.spans).toEqual([]);
  });
});
