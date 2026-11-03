// P2-15 (96 队列 #15) — TelemetryRuntime：turn/tool 两级 span 骑事件观察缝，
// usage 从 CostRegistry 现成分账取（unpriced 不造假 cost），redaction 先行
// （消息内容/工具载荷永不进 span），turn 边界批量 flush，best-effort 自吞，
// 缺省 off 零外发。deterministic：fetch/时钟/id 工厂全部注入。
import { describe, it, expect } from "vitest";
import type { LoopEvent, ModelUsage } from "@wudao-org/core";
import { CostRegistry } from "../src/commands/cost.js";
import {
  resolveTelemetryConfig,
  createTelemetryRuntime,
} from "../src/telemetry/telemetry.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  promptTokens: 1000,
  cacheHitTokens: 700,
  cacheMissTokens: 300,
  completionTokens: 9,
  cacheWriteTokens: 300,
  ...over,
});

/** One captured OTLP POST. */
interface Post {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** A fake fetch that records every call and answers with the queued results
 *  (default: 200 ok). `gate` lets a test HOLD a flush in flight. */
function fakeFetch(opts: { gate?: Promise<void>; results?: (Response | Error)[] } = {}) {
  const posts: Post[] = [];
  const calls = { count: 0 };
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.count += 1;
    const raw = typeof init?.body === "string" ? init.body : "";
    posts.push({ url: String(url), init: init ?? {}, body: raw === "" ? undefined : JSON.parse(raw) });
    if (opts.gate !== undefined) await opts.gate;
    const r = opts.results?.shift();
    if (r instanceof Error) throw r;
    if (r !== undefined) return r;
    return new Response("{}", { status: 200 });
  };
  return { posts, calls, impl };
}

/** Deterministic id factory: sequential hex, distinct per mint. */
function idFactory() {
  let n = 0;
  const hex = (len: number): string => {
    const out: string[] = [];
    for (let i = 0; i < len; i += 1) {
      n = (n + 1) % 256;
      out.push(n.toString(16).padStart(2, "0"));
    }
    return out.join("").slice(0, len);
  };
  return { traceId: () => hex(32), spanId: () => hex(16) };
}

/** A controllable ms clock (tests step it explicitly). */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, step: (ms: number) => { t += ms; } };
}

/** A flattened view of an exported span (post-JSON). */
interface SpanView {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  attributes?: { key: string; value: Record<string, unknown> }[];
  status: { code: number };
}

interface Rig {
  fetch: ReturnType<typeof fakeFetch>;
  clk: ReturnType<typeof clock>;
  registry: CostRegistry;
  logs: string[];
  rt: ReturnType<typeof createTelemetryRuntime>;
  spans: () => SpanView[];
}

function rig(over: {
  env?: NodeJS.ProcessEnv;
  gate?: Promise<void>;
  results?: (Response | Error)[];
  queueCap?: number;
} = {}): Rig {
  const fetch = fakeFetch({ gate: over.gate, results: over.results });
  const clk = clock();
  const registry = new CostRegistry({ ...(over.env ?? {}) });
  const logs: string[] = [];
  const rt = createTelemetryRuntime({
    otlpEndpoint: "https://otel.example.test",
    sessionId: "s-telemetry",
    liveIdentity: () => ({ model: "deepseek-v4-flash", provider: "deepseek" }),
    costRows: () => registry.rows,
    fetchImpl: fetch.impl as unknown as typeof fetch,
    now: clk.now,
    ids: idFactory(),
    log: (line) => logs.push(line),
    ...(over.queueCap !== undefined ? { queueCap: over.queueCap } : {}),
  });
  const spans = (): SpanView[] => {
    const all: SpanView[] = [];
    for (const p of fetch.posts) {
      const rs = (p.body as { resourceSpans?: { scopeSpans?: { spans?: unknown[] }[] }[] }).resourceSpans ?? [];
      for (const r of rs) for (const sc of r.scopeSpans ?? []) for (const s of sc.spans ?? []) all.push(s as SpanView);
    }
    return all;
  };
  return { fetch, clk, registry, logs, rt, spans };
}

const ev = {
  turnStarted: (turn: number): LoopEvent => ({ type: "turn_started", turn }),
  turnFinished: (turn: number): LoopEvent => ({ type: "turn_finished", turn, toolCallCount: 1 }),
  toolStarted: (turn: number, id: string, name: string, input: Record<string, unknown> = {}): LoopEvent =>
    ({ type: "tool_call_started", turn, toolCallId: id, toolName: name, input }),
  toolFinished: (turn: number, id: string, isError = false, result = "", durationMs?: number): LoopEvent =>
    ({ type: "tool_call_finished", turn, toolCallId: id, isError, result, ...(durationMs !== undefined ? { durationMs } : {}) }),
};

const PRICED_ENV = { WUDAO_PRICE_DEEPSEEK_V4_FLASH: "0.27,1.10,0.07,0.27" };

/** One full turn with one tool call + a model row (pricedness follows the rig's env). */
function driveTurn(r: Rig, turn: number, over: { recordRow?: boolean } = {}): void {
  r.rt.observe(ev.turnStarted(turn));
  r.clk.step(50);
  r.rt.observe(ev.toolStarted(turn, `call-${turn}`, "read_file", { path: "/tmp/secret-path.txt" }));
  r.clk.step(120);
  r.rt.observe(ev.toolFinished(turn, `call-${turn}`, false, "SECRET RESULT BODY", 120));
  if (over.recordRow !== false) {
    r.registry.record({ model: "deepseek-v4-flash", provider: "deepseek", usage: usage({ reasoningTokens: 42 }) });
  }
  r.clk.step(30);
  r.rt.observe(ev.turnFinished(turn));
}

// ---------------------------------------------------------------------------
// settings resolution (fail-closed off)
// ---------------------------------------------------------------------------

describe("resolveTelemetryConfig", () => {
  it("absent / null / non-object / missing endpoint / empty string → off", () => {
    expect(resolveTelemetryConfig(undefined)).toBeUndefined();
    expect(resolveTelemetryConfig(null)).toBeUndefined();
    expect(resolveTelemetryConfig("https://x")).toBeUndefined();
    expect(resolveTelemetryConfig(42)).toBeUndefined();
    expect(resolveTelemetryConfig({})).toBeUndefined();
    expect(resolveTelemetryConfig({ otlpEndpoint: "" })).toBeUndefined();
    expect(resolveTelemetryConfig({ otlpEndpoint: 7 })).toBeUndefined();
  });

  it("a non-empty string endpoint resolves to the enabled config", () => {
    expect(resolveTelemetryConfig({ otlpEndpoint: "https://otel.example.test" })).toEqual({
      otlpEndpoint: "https://otel.example.test",
    });
  });
});

// ---------------------------------------------------------------------------
// span hierarchy + usage attributes
// ---------------------------------------------------------------------------

describe("span set: session → turn → tool (+ usage attributes)", () => {
  it("one turn with a tool call exports a turn span (usage attrs) + tool span (name/duration/ok)", async () => {
    const r = rig({ env: PRICED_ENV });
    driveTurn(r, 1);
    await r.rt.flush();
    const spans = r.spans();
    const tool = spans.find((s) => s.name === "tool.read_file");
    const turn = spans.find((s) => s.name === "turn");
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();
    // hierarchy: tool's parent is the turn span
    expect(tool!.parentSpanId).toBe(turn!.spanId);
    // tool span: ok status, duration attribute from the finished event
    expect(tool!.status.code).toBe(1);
    const toolAttrs = Object.fromEntries((tool!.attributes ?? []).map((a) => [a.key, a.value]));
    expect(toolAttrs).toMatchObject({ "tool.name": { stringValue: "read_file" }, "tool.duration_ms": { intValue: 120 } });
    // turn span: usage attributes from the CostRegistry row
    const turnAttrs = Object.fromEntries((turn!.attributes ?? []).map((a) => [a.key, a.value]));
    expect(turnAttrs).toMatchObject({
      turn: { intValue: 1 },
      model: { stringValue: "deepseek-v4-flash" },
      provider: { stringValue: "deepseek" },
      input_tokens: { intValue: 1000 },
      output_tokens: { intValue: 9 },
      reasoning_tokens: { intValue: 42 },
      cost_usd: { doubleValue: expect.any(Number) },
    });
    // the flushed payload's resource carries service.name + session.id
    const res = (r.fetch.posts[0]!.body as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[] })
      .resourceSpans[0]!.resource.attributes;
    expect(res).toEqual(expect.arrayContaining([
      { key: "service.name", value: { stringValue: "wudao-harness" } },
      { key: "session.id", value: { stringValue: "s-telemetry" } },
    ]));
    // POST went to {endpoint}/v1/traces with the OTLP JSON content type
    expect(r.fetch.posts[0]!.url).toBe("https://otel.example.test/v1/traces");
    expect((r.fetch.posts[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    r.rt.close();
  });

  it("unpriced rows NEVER carry a cost_usd key (unpriced ≠ free)", async () => {
    const r = rig({}); // no WUDAO_PRICE_* → every row unpriced
    driveTurn(r, 1); // the row lands BEFORE turn_finished (the cursor diff sees it)
    await r.rt.flush();
    const turn = r.spans().find((s) => s.name === "turn")!;
    const keys = (turn.attributes ?? []).map((a) => a.key);
    expect(keys).toContain("input_tokens");
    expect(keys).toContain("model");
    expect(keys).not.toContain("cost_usd");
    r.rt.close();
  });

  it("a tool error marks the tool span ERROR and the turn stays attributable", async () => {
    const r = rig({ env: PRICED_ENV });
    r.rt.observe(ev.turnStarted(1));
    r.rt.observe(ev.toolStarted(1, "c-err", "shell", { command: "SECRET COMMAND" }));
    r.rt.observe(ev.toolFinished(1, "c-err", true, "SECRET ERROR OUTPUT"));
    r.rt.observe(ev.turnFinished(1));
    await r.rt.flush();
    const tool = r.spans().find((s) => s.name === "tool.shell")!;
    expect(tool.status.code).toBe(2);
    r.rt.close();
  });

  it("close() ends the session root span and force-flushes it", async () => {
    const r = rig({ env: PRICED_ENV });
    driveTurn(r, 1);
    await r.rt.flush();
    await r.rt.close();
    const session = r.spans().find((s) => s.name === "session");
    expect(session).toBeDefined();
    expect(session!.parentSpanId).toBeUndefined();
    // session span is the root of the trace the turn spans used
    expect(session!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// redaction (红线)
// ---------------------------------------------------------------------------

describe("redaction — message content / tool payloads never enter a span", () => {
  it("payloads contain no message text, tool arguments, or tool results", async () => {
    const r = rig({ env: PRICED_ENV });
    const secrets = [
      "SECRET-PROMPT-TEXT",
      "SECRET-COMMAND",
      "SECRET RESULT BODY",
      "secret-path.txt",
      "SECRET-REASONING",
      "SECRET-STEERED",
    ];
    r.rt.observe({ type: "turn_started", turn: 1 } as LoopEvent);
    // text-bearing events the runtime must ignore entirely
    r.rt.observe({ type: "reasoning_delta", turn: 1, text: "SECRET-REASONING" });
    r.rt.observe({ type: "assistant_delta", turn: 1, text: "SECRET-PROMPT-TEXT" });
    r.rt.observe({ type: "steered", turn: 1, text: "SECRET-STEERED" });
    r.rt.observe(ev.toolStarted(1, "c1", "shell", { command: "SECRET COMMAND", path: "/tmp/secret-path.txt" }));
    r.rt.observe(ev.toolFinished(1, "c1", false, "SECRET RESULT BODY", 5));
    r.registry.record({ model: "deepseek-v4-flash", provider: "deepseek", usage: usage() });
    r.rt.observe(ev.turnFinished(1));
    await r.rt.flush();
    await r.rt.close();
    const raw = JSON.stringify(r.fetch.posts.map((p) => p.body));
    for (const s of secrets) expect(raw).not.toContain(s);
    // …while the ALLOWED fields still made it out (宁缺勿泄, not 宁缺勿发)
    expect(raw).toContain("shell");
    expect(raw).toContain("deepseek-v4-flash");
  });
});

// ---------------------------------------------------------------------------
// batching / flush discipline
// ---------------------------------------------------------------------------

describe("batch + flush", () => {
  it("turn boundary flushes (one POST per turn), close force-flushes the remainder", async () => {
    const r = rig({ env: PRICED_ENV });
    driveTurn(r, 1);
    await r.rt.flush();
    driveTurn(r, 2);
    await r.rt.flush();
    expect(r.fetch.calls.count).toBeGreaterThanOrEqual(2);
    await r.rt.close();
    // every exported span landed in some POST; none left behind
    const names = r.spans().map((s) => s.name);
    expect(names).toContain("session");
    expect(names.filter((n) => n === "turn").length).toBe(2);
    expect(r.rt.pendingSpanCount).toBe(0);
  });

  it("queue cap protects memory: oldest spans drop, count exposed", async () => {
    const gate = new Promise<void>(() => {}); // never resolves → queue grows
    const r = rig({ env: PRICED_ENV, gate, queueCap: 8 });
    for (let turn = 1; turn <= 10; turn += 1) driveTurn(r, turn);
    expect(r.rt.pendingSpanCount).toBeLessThanOrEqual(8);
    expect(r.rt.droppedSpans).toBeGreaterThan(0);
    r.rt.close(); // fire-and-capped; no await needed for the assertion above
  });
});

// ---------------------------------------------------------------------------
// best-effort (红线：观测失败绝不影响执行)
// ---------------------------------------------------------------------------

describe("best-effort export", () => {
  it("unreachable endpoint: exactly one retry, then give up + log; nothing throws", async () => {
    const r = rig({ env: PRICED_ENV, results: [new Error("ECONNREFUSED"), new Error("ECONNREFUSED")] });
    driveTurn(r, 1);
    await r.rt.flush();
    expect(r.fetch.calls.count).toBe(2); // initial + the single retry
    expect(r.logs.length).toBeGreaterThan(0);
    expect(r.logs[0]).toContain("telemetry");
    // the dropped batch is gone (no unbounded re-queue)
    expect(r.rt.pendingSpanCount).toBe(0);
    // observe() stays safe after failures
    expect(() => driveTurn(r, 2)).not.toThrow();
    await r.rt.flush();
    await expect(r.rt.close()).resolves.toBeUndefined();
  });

  it("4xx (non-429) answers are NOT retried; 5xx are", async () => {
    const four = rig({ env: PRICED_ENV, results: [new Response("bad", { status: 400 })] });
    driveTurn(four, 1);
    await four.rt.flush();
    expect(four.fetch.calls.count).toBe(1);
    const five = rig({ env: PRICED_ENV, results: [new Response("boom", { status: 503 }), new Response("{}", { status: 200 })] });
    driveTurn(five, 1);
    await five.rt.flush();
    expect(five.fetch.calls.count).toBe(2);
  });

  it("a throwing observe event NEVER propagates", () => {
    const r = rig({ env: PRICED_ENV });
    // costRows throwing must not escape observe()
    const broken = createTelemetryRuntime({
      otlpEndpoint: "https://x",
      sessionId: "s",
      liveIdentity: () => { throw new Error("boom"); },
      costRows: () => { throw new Error("boom"); },
      fetchImpl: fakeFetch().impl as unknown as typeof fetch,
      now: () => 1,
      ids: idFactory(),
      log: () => {},
    });
    expect(() => broken.observe(ev.turnStarted(1))).not.toThrow();
    expect(() => broken.observe(ev.toolStarted(1, "c", "read_file"))).not.toThrow();
    expect(() => broken.observe(ev.turnFinished(1))).not.toThrow();
    expect(r.rt.pendingSpanCount).toBe(0);
    broken.close();
  });
});

// ---------------------------------------------------------------------------
// default off (缺省零外发字节)
// ---------------------------------------------------------------------------

describe("default off", () => {
  it("no telemetry config → no runtime → zero fetch calls, zero bytes out", async () => {
    const f = fakeFetch();
    // The production call shape: settings node → runtime | undefined.
    const cfg = resolveTelemetryConfig(undefined);
    expect(cfg).toBeUndefined();
    if (cfg !== undefined) {
      createTelemetryRuntime({ ...cfg, sessionId: "s", liveIdentity: () => ({ model: "m" }), costRows: () => [], fetchImpl: f.impl as unknown as typeof fetch });
    }
    // …and the disabled path on a real node shape
    const off = resolveTelemetryConfig({ otlpEndpoint: "" });
    expect(off).toBeUndefined();
    expect(f.calls.count).toBe(0);
  });
});
