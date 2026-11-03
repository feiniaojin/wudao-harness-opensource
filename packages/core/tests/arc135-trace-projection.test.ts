// 135 — 可观测投影层的不变量钉测。全部离线：无网络、无真实时钟、无文件系统。
import { describe, expect, it } from "vitest";
import {
  ATTR, projectTrace, toOtlpJson, toOtlpProto, toOtlpRequest, traceIdFor, redactText,
  type TimedLoopEvent, type LoopEvent, type Terminal,
} from "../src/trace/index.js";

const T0 = 1_760_000_000_000;

function ev(at: number, event: LoopEvent): TimedLoopEvent {
  return { at, event };
}

/** 一段典型 run：2 轮，第一轮一次工具调用，第二轮压缩后收尾。 */
function sampleEvents(): TimedLoopEvent[] {
  return [
    ev(T0 + 0, { type: "turn_started", turn: 1 }),
    ev(T0 + 5, { type: "model_call_started", turn: 1 }),
    ev(T0 + 40, { type: "reasoning_delta", turn: 1, text: "思考十六个字" }),
    ev(T0 + 60, { type: "assistant_delta", turn: 1, text: "我先读文件" }),
    ev(T0 + 90, { type: "model_call_finished", turn: 1, hasToolCalls: true, toolCallCount: 1 }),
    ev(T0 + 91, {
      type: "usage", turn: 1,
      usage: { promptTokens: 1000, completionTokens: 120, cacheHitTokens: 800, cacheMissTokens: 200, cacheWriteTokens: 200 },
    }),
    ev(T0 + 100, { type: "tool_call_started", turn: 1, toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }),
    ev(T0 + 180, { type: "tool_call_finished", turn: 1, toolCallId: "c1", isError: false, result: "contents", durationMs: 80 }),
    ev(T0 + 190, { type: "turn_finished", turn: 1, toolCallCount: 1 }),
    ev(T0 + 200, { type: "turn_started", turn: 2 }),
    ev(T0 + 205, {
      type: "compacted", turn: 2, beforeTokens: 9000, afterTokens: 3000, tier: 2,
      trigger: "threshold", reason: "threshold",
      economics: { reason: "worthwhile", breakevenRequests: 3, expectedRemainingRequests: 5, cacheWriteReadRatio: 10, ratioSource: "default", carriedDebtTokens: 3000 },
    }),
    ev(T0 + 210, { type: "model_call_started", turn: 2 }),
    ev(T0 + 300, { type: "model_call_finished", turn: 2, hasToolCalls: false, toolCallCount: 0 }),
    ev(T0 + 301, {
      type: "usage", turn: 2,
      usage: { promptTokens: 500, completionTokens: 60, cacheHitTokens: 0, cacheMissTokens: 500 },
    }),
    ev(T0 + 310, { type: "turn_finished", turn: 2, toolCallCount: 0 }),
  ];
}

describe("135 / projection — 结构与身份", () => {
  it("traceId 由 (sessionId, runStartedAtMs) 确定性派生（重放得同一 id）", () => {
    const a = traceIdFor("sess-1", T0);
    const b = traceIdFor("sess-1", T0);
    const c = traceIdFor("sess-1", T0 + 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("root 是 agent.run，所有 turn span 挂在 root 下，model/tool 挂在 turn 下", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "sess-1", runStartedAtMs: T0 });
    const root = run.spans.find((s) => s.spanId === run.rootSpanId)!;
    expect(root.name).toBe("agent.run");
    expect(root.observation).toBe("agent");
    expect(root.parentSpanId).toBeUndefined();

    const turns = run.spans.filter((s) => s.name === "turn");
    expect(turns).toHaveLength(2);
    for (const t of turns) expect(t.parentSpanId).toBe(root.spanId);

    const modelCalls = run.spans.filter((s) => s.name === "model.call");
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0]!.parentSpanId).toBe(turns[0]!.spanId);
    expect(modelCalls[1]!.parentSpanId).toBe(turns[1]!.spanId);

    const tool = run.spans.find((s) => s.name === "tool.read_file")!;
    expect(tool.parentSpanId).toBe(turns[0]!.spanId);
    expect(tool.observation).toBe("tool");
  });

  it("spanId 唯一且 root 排在 spans 首位", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "s", runStartedAtMs: T0 });
    const ids = run.spans.map((s) => s.spanId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(run.spans[0]!.spanId).toBe(run.rootSpanId);
  });

  it("会话身份三写（Langfuse / OTel / LangSmith）+ schema 版本锚", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "sess-1", runStartedAtMs: T0 });
    for (const span of run.spans) {
      expect(span.attributes[ATTR.SESSION_ID]).toBe("sess-1");
      expect(span.attributes[ATTR.SESSION_ID_ALT]).toBe("sess-1");
      expect(span.attributes[ATTR.LANGSMITH_SESSION_ID]).toBe("sess-1");
      expect(span.attributes[ATTR.WD_SCHEMA_VERSION]).toBe("1");
    }
  });
});

describe("135 / projection — 用量与缓存取证", () => {
  it("usage 折进最近的 model.call（不单独成 span）", () => {
    const run = projectTrace(sampleEvents(), { runStartedAtMs: T0 });
    expect(run.spans.filter((s) => s.name === "usage")).toHaveLength(0);
    const first = run.spans.filter((s) => s.name === "model.call")[0]!;
    expect(first.attributes[ATTR.INPUT_TOKENS]).toBe(1000);
    expect(first.attributes[ATTR.OUTPUT_TOKENS]).toBe(120);
    expect(first.attributes[ATTR.TOTAL_TOKENS]).toBe(1120);
    expect(first.attributes[ATTR.CACHE_HIT_TOKENS]).toBe(800);
    expect(first.attributes[ATTR.CACHE_HIT_RATIO]).toBe(0.8);
  });

  it("omit-never-null：没有 completionTokens 时不写 0，也不写 total", () => {
    const events: TimedLoopEvent[] = [
      ev(T0, { type: "turn_started", turn: 1 }),
      ev(T0 + 1, { type: "model_call_started", turn: 1 }),
      ev(T0 + 2, { type: "model_call_finished", turn: 1, hasToolCalls: false, toolCallCount: 0 }),
      ev(T0 + 3, { type: "usage", turn: 1, usage: { promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10 } }),
    ];
    const run = projectTrace(events, { runStartedAtMs: T0 });
    const model = run.spans.find((s) => s.name === "model.call")!;
    expect(model.attributes[ATTR.INPUT_TOKENS]).toBe(10);
    expect(ATTR.OUTPUT_TOKENS in model.attributes).toBe(false);
    expect(ATTR.TOTAL_TOKENS in model.attributes).toBe(false);
  });

  it("compacted 建 span，并把冷轮归因交给**下一个** model.call", () => {
    const run = projectTrace(sampleEvents(), { runStartedAtMs: T0 });
    const compact = run.spans.find((s) => s.name === "compact")!;
    expect(compact.attributes[ATTR.COMPACT_TIER]).toBe(2);
    expect(compact.attributes[ATTR.COMPACT_TRIGGER]).toBe("threshold");
    expect(compact.attributes[ATTR.COMPACT_BEFORE_TOKENS]).toBe(9000);
    expect(compact.attributes[ATTR.COMPACT_CARRIED_DEBT_TOKENS]).toBe(3000);
    expect(compact.attributes[ATTR.COMPACT_BREAKEVEN_REQUESTS]).toBe(3);

    const calls = run.spans.filter((s) => s.name === "model.call");
    expect(calls[0]!.attributes[ATTR.CACHE_COLD_EXPECTED]).toBeUndefined();
    expect(calls[1]!.attributes[ATTR.CACHE_COLD_EXPECTED]).toBe(true);
    expect(calls[1]!.attributes[ATTR.CACHE_BREAK_ATTRIBUTION]).toBe("threshold");
  });

  it("delta 不建 span，只折成计数与 TTFT", () => {
    const run = projectTrace(sampleEvents(), { runStartedAtMs: T0 });
    expect(run.spans.filter((s) => s.name.includes("delta"))).toHaveLength(0);
    const turn1 = run.spans.find((s) => s.name === "turn" && s.attributes[ATTR.TURN_INDEX] === 1)!;
    expect(turn1.attributes[ATTR.REASONING_CHARS]).toBe("思考十六个字".length);
    expect(turn1.attributes[ATTR.ANSWER_CHARS]).toBe("我先读文件".length);
    expect(turn1.attributes[ATTR.TOOL_CALL_COUNT]).toBe(1);
    expect(turn1.attributes["wudao.turn.ttft_ms"]).toBe(40);
  });

  it("工具错误 → span 状态 ERROR；durationMs 优先用事件自带值", () => {
    const events: TimedLoopEvent[] = [
      ev(T0, { type: "turn_started", turn: 1 }),
      ev(T0 + 10, { type: "tool_call_started", turn: 1, toolCallId: "x", toolName: "bash", input: { cmd: "false" } }),
      ev(T0 + 500, { type: "tool_call_finished", turn: 1, toolCallId: "x", isError: true, result: "exit 1", durationMs: 42 }),
    ];
    const run = projectTrace(events, { runStartedAtMs: T0 });
    const tool = run.spans.find((s) => s.name === "tool.bash")!;
    expect(tool.status.code).toBe("ERROR");
    expect(tool.attributes[ATTR.DURATION_MS]).toBe(42);
  });

  it("未识别事件被忽略（additive-only 契约）", () => {
    const events = [
      ...sampleEvents(),
      ev(T0 + 999, { type: "some_future_event", turn: 9 } as unknown as LoopEvent),
    ];
    expect(() => projectTrace(events, { runStartedAtMs: T0 })).not.toThrow();
  });
});

describe("135 / projection — 内容三档与脱敏", () => {
  it("off 档：工具参数/结果无内容，只有字节数", () => {
    const run = projectTrace(sampleEvents(), { runStartedAtMs: T0, contentMode: "off" });
    const tool = run.spans.find((s) => s.name === "tool.read_file")!;
    expect(tool.attributes[ATTR.CONTENT_MODE]).toBe("off");
    expect(JSON.stringify(tool.attributes)).not.toContain("a.ts");
    expect(JSON.stringify(tool.attributes)).not.toContain("contents");
  });

  it("hash 档（默认）：写入指纹 + 预览，可复现", () => {
    const a = projectTrace(sampleEvents(), { runStartedAtMs: T0 });
    const b = projectTrace(sampleEvents(), { runStartedAtMs: T0 });
    const ta = a.spans.find((s) => s.name === "tool.read_file")!;
    const tb = b.spans.find((s) => s.name === "tool.read_file")!;
    expect(ta.attributes["wudao.tool.arguments.sha256"]).toBe(tb.attributes["wudao.tool.arguments.sha256"]);
    expect(ta.attributes["wudao.tool.arguments.preview"]).toBe('{"path":"a.ts"}');
    expect(ta.attributes["wudao.tool.arguments.bytes"]).toBe(15);
  });

  it("full 档：全文进 span", () => {
    const run = projectTrace(sampleEvents(), { runStartedAtMs: T0, contentMode: "full" });
    const tool = run.spans.find((s) => s.name === "tool.read_file")!;
    expect(tool.attributes["wudao.tool.result.text"]).toBe("contents");
  });

  it("脱敏：家目录→~、敏感键→[REDACTED]、私钥整段", () => {
    expect(redactText("read /Users/alice/x.ts", "/Users/alice")).toBe("read ~/x.ts");
    expect(redactText("api_key=sk-abc123")).toContain("[REDACTED]");
    expect(redactText("token: \"xyz\"")).toContain("[REDACTED]");
    expect(redactText("-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----"))
      .toBe("[REDACTED_PRIVATE_KEY]");
  });

  it("长文本预览按 512 字符截断且不切断代理对", () => {
    const long = "a".repeat(511) + "😀" + "b".repeat(10);
    const events: TimedLoopEvent[] = [
      ev(T0, { type: "turn_started", turn: 1 }),
      ev(T0 + 1, { type: "tool_call_started", turn: 1, toolCallId: "y", toolName: "read_file", input: { p: long } }),
    ];
    const run = projectTrace(events, { runStartedAtMs: T0 });
    const preview = String(run.spans.find((s) => s.name === "tool.read_file")!.attributes["wudao.tool.arguments.preview"]);
    expect(preview.length).toBeLessThanOrEqual(512);
    const last = preview.charCodeAt(preview.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("135 / projection — 终态", () => {
  it("terminal 写进 root，completed=OK，其余=ERROR", () => {
    const ok = projectTrace(sampleEvents(), {
      runStartedAtMs: T0,
      terminal: { reason: "completed" } as Terminal,
    });
    const rootOk = ok.spans.find((s) => s.spanId === ok.rootSpanId)!;
    expect(rootOk.status.code).toBe("OK");
    expect(rootOk.attributes[ATTR.TERMINAL_REASON]).toBe("completed");

    const bad = projectTrace(sampleEvents(), {
      runStartedAtMs: T0,
      terminal: { reason: "max_turns" } as Terminal,
    });
    const rootBad = bad.spans.find((s) => s.spanId === bad.rootSpanId)!;
    expect(rootBad.status.code).toBe("ERROR");
    expect(rootBad.status.message).toBe("max_turns");
  });
});

describe("135 / OTLP 编码", () => {
  it("root 永远在 spans 数组第一位（父先于子）", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "s", runStartedAtMs: T0 });
    const req = toOtlpRequest(run);
    const spans = req.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans[0]!.name).toBe("agent.run");
    expect(spans[0]!.spanId).toBe(run.rootSpanId);
  });

  it("JSON 编码字节确定（属性排序 + 同输入同输出）", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "s", runStartedAtMs: T0 });
    expect(toOtlpJson(run)).toBe(toOtlpJson(run));
  });

  it("JSON 里的 int/double/bool 分流正确", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "s", runStartedAtMs: T0 });
    const spans = toOtlpRequest(run).resourceSpans[0]!.scopeSpans[0]!.spans;
    const first = spans.find((s) => s.name === "model.call" && s.attributes.some((a) => a.key === ATTR.INPUT_TOKENS))!;
    const hit = first.attributes.find((a) => a.key === ATTR.CACHE_HIT_TOKENS)!;
    expect(hit.value.intValue).toBe("800");
    const ratio = first.attributes.find((a) => a.key === ATTR.CACHE_HIT_RATIO)!;
    expect(ratio.value.doubleValue).toBeCloseTo(0.8, 6);
  });

  it("protobuf 编码确定且非空；traceId 以原始字节写入", () => {
    const run = projectTrace(sampleEvents(), { sessionId: "s", runStartedAtMs: T0 });
    const bytes = toOtlpProto(run);
    expect(bytes.length).toBeGreaterThan(50);
    expect(Buffer.from(bytes).equals(Buffer.from(toOtlpProto(run)))).toBe(true);
    expect(Buffer.from(bytes).includes(Buffer.from(run.traceId, "hex"))).toBe(true);
  });
});
