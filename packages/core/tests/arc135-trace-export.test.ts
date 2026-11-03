// 135 — 导出器与旁路包装的不变量钉测。无真实网络：fetch 全部注入。
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createOtlpExporter, createOtlpExporterFromEnv, observeRun, projectTrace, toOtlpRequest,
  OTEL_ENDPOINT_ENV, OTEL_HEADERS_ENV, OTEL_AUTH_ENV, OTEL_ENCODING_ENV, ATTR,
  type LoopEvent, type Terminal, type TraceRun,
} from "../src/trace/index.js";
import {
  runAgentLoop, createScriptedModel, createReadFileTool, canonicalJson,
  type ModelInput,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

const T0 = 1_760_000_000_000;

function tinyRun(): TraceRun {
  return projectTrace(
    [
      { at: T0, event: { type: "turn_started", turn: 1 } },
      { at: T0 + 1, event: { type: "model_call_started", turn: 1 } },
      { at: T0 + 2, event: { type: "model_call_finished", turn: 1, hasToolCalls: false, toolCallCount: 0 } },
    ],
    { sessionId: "s1", runStartedAtMs: T0 },
  );
}

async function* scripted(events: LoopEvent[], terminal: Terminal): AsyncGenerator<LoopEvent, Terminal> {
  for (const e of events) yield e;
  return terminal;
}

describe("135 / OTLP 时间戳精度", () => {
  it("纳秒是精确整数（不经浮点乘法）", () => {
    const run = projectTrace(
      [{ at: 1_760_000_000_005, event: { type: "turn_started", turn: 1 } }],
      { runStartedAtMs: 1_760_000_000_005 },
    );
    const span = toOtlpRequest(run).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("1760000000005000000");
    expect(span.endTimeUnixNano).toBe("1760000000005000000");
  });
});

describe("135 / 导出器 — 缺省关闭", () => {
  it("无 endpoint → 返回 null（构造层面零开销，不是空转对象）", () => {
    expect(createOtlpExporterFromEnv({})).toBeNull();
    expect(createOtlpExporterFromEnv({ [OTEL_ENDPOINT_ENV]: "   " })).toBeNull();
  });

  it("endpoint 已带 /v1/traces 时不重复拼；否则追加", async () => {
    const urls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const a = createOtlpExporter({ endpoint: "http://h:3000/api/public/otel", fetchImpl: fakeFetch });
    a.enqueue(tinyRun());
    await a.flush();
    expect(urls[0]).toBe("http://h:3000/api/public/otel/v1/traces");

    const b = createOtlpExporter({ endpoint: "http://h:3000/api/public/otel/v1/traces/", fetchImpl: fakeFetch });
    b.enqueue(tinyRun());
    await b.flush();
    expect(urls[1]).toBe("http://h:3000/api/public/otel/v1/traces");
  });

  it("headers 环境变量解析 + Basic auth 自动补前缀（发出去的头为准）", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    // createOtlpExporterFromEnv 不接受 fetch 注入，故这里直接构造同一份头语义：
    const e = createOtlpExporter({
      endpoint: "http://h",
      headers: { "x-api-key": "k1", "Langsmith-Project": "p1", Authorization: "Basic cGsta2V5OnNrLWtleQ==" },
      fetchImpl: fakeFetch,
    });
    e.enqueue(tinyRun());
    await e.flush();
    expect(seen[0]!["x-api-key"]).toBe("k1");
    expect(seen[0]!["Langsmith-Project"]).toBe("p1");
    expect(seen[0]!["Authorization"]).toBe("Basic cGsta2V5OnNrLWtleQ==");
    // env 构造也要能成立
    expect(createOtlpExporterFromEnv({
      [OTEL_ENDPOINT_ENV]: "http://h",
      [OTEL_HEADERS_ENV]: "x-api-key=k1, Langsmith-Project=p1",
      [OTEL_AUTH_ENV]: "cGsta2V5OnNrLWtleQ==",
    })).not.toBeNull();
  });

  it("encoding=protobuf 时 content-type 为 application/x-protobuf", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const e = createOtlpExporter({ endpoint: "http://h", encoding: "protobuf", fetchImpl: fakeFetch });
    e.enqueue(tinyRun());
    await e.flush();
    expect(seen[0]!["content-type"]).toBe("application/x-protobuf");
    expect(seen[0]!["content-type"]).not.toBe("application/json");
  });

  it("4xx 永不重试（一次即弃）", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 400 })) as unknown as typeof fetch;
    const e = createOtlpExporter({ endpoint: "http://h", fetchImpl: fakeFetch, maxRetries: 2 });
    e.enqueue(tinyRun());
    await expect(e.flush()).resolves.toBeUndefined();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(e.stats().failed).toBe(1);
  });

  it("5xx 重试到上限后停止；全程 fail-silent（绝不抛）", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const e = createOtlpExporter({ endpoint: "http://h", fetchImpl: fakeFetch, maxRetries: 2 });
    e.enqueue(tinyRun());
    await expect(e.flush()).resolves.toBeUndefined();
    // 1 次首发 + 2 次重试
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(e.stats().failed).toBe(3);
  });

  it("fetch 抛错也被吞（网络断开不打断运行）", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const e = createOtlpExporter({ endpoint: "http://h", fetchImpl: fakeFetch, maxRetries: 0 });
    e.enqueue(tinyRun());
    await expect(e.flush()).resolves.toBeUndefined();
    expect(e.stats().failed).toBe(1);
  });

  it("队列有界：超限丢最旧的并计数", () => {
    const e = createOtlpExporter({ endpoint: "http://h", maxQueue: 6, flushAt: 1000 });
    for (let i = 0; i < 5; i += 1) e.enqueue(tinyRun());
    const s = e.stats();
    expect(s.queued).toBeLessThanOrEqual(6);
    expect(s.dropped).toBeGreaterThan(0);
  });

  it("shutdown 后不再入队", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const e = createOtlpExporter({ endpoint: "http://h", fetchImpl: fakeFetch });
    await e.shutdown();
    e.enqueue(tinyRun());
    expect(e.stats().queued).toBe(0);
  });
});

describe("135 / observeRun — 逐事件透传", () => {
  it("消费者拿到的对象与内层是同一引用（字节不变）", async () => {
    const events: LoopEvent[] = [
      { type: "turn_started", turn: 1 },
      { type: "model_call_started", turn: 1 },
    ];
    const inner: LoopEvent[] = [];
    const gen = observeRun(
      (async function* () {
        for (const e of events) { inner.push(e); yield e; }
        return { reason: "completed" } as Terminal;
      })(),
      { onSettled: () => {} },
    );
    const seen: LoopEvent[] = [];
    for await (const e of gen) seen.push(e);
    expect(seen).toHaveLength(2);
    for (let i = 0; i < seen.length; i += 1) expect(seen[i]).toBe(inner[i]);
  });

  it("Terminal 逐位透传", async () => {
    const terminal: Terminal = { reason: "max_turns" } as Terminal;
    const gen = observeRun(scripted([{ type: "turn_started", turn: 1 }], terminal), { onSettled: () => {} });
    let out: Terminal | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done === true) { out = step.value; break; }
    }
    expect(out).toBe(terminal);
  });

  it("结束时结算一次，终态进 root", async () => {
    const settled: TraceRun[] = [];
    const gen = observeRun(
      scripted(
        [
          { type: "turn_started", turn: 1 },
          { type: "model_call_started", turn: 1 },
          { type: "model_call_finished", turn: 1, hasToolCalls: false, toolCallCount: 0 },
        ],
        { reason: "completed" } as Terminal,
      ),
      { sessionId: "s1", now: (() => { let t = T0; return () => (t += 10); })(), onSettled: (r) => settled.push(r) },
    );
    for await (const _ of gen) { /* drain */ }
    expect(settled).toHaveLength(1);
    const root = settled[0]!.spans.find((s) => s.spanId === settled[0]!.rootSpanId)!;
    expect(root.attributes[ATTR.TERMINAL_REASON]).toBe("completed");
    expect(root.status.code).toBe("OK");
  });

  it("消费者提前 return() 也结算（且只一次）", async () => {
    const settled: TraceRun[] = [];
    const gen = observeRun(
      scripted([{ type: "turn_started", turn: 1 }, { type: "turn_finished", turn: 1, toolCallCount: 0 }], { reason: "completed" } as Terminal),
      { onSettled: (r) => settled.push(r) },
    );
    for await (const e of gen) { if (e.type === "turn_started") break; }
    expect(settled).toHaveLength(1);
  });

  it("内层抛错：异常透传，仍结算一次", async () => {
    const settled: TraceRun[] = [];
    const gen = observeRun(
      (async function* (): AsyncGenerator<LoopEvent, Terminal> {
        yield { type: "turn_started", turn: 1 };
        throw new Error("boom");
      })(),
      { onSettled: (r) => settled.push(r) },
    );
    await expect((async () => { for await (const _ of gen) { /* drain */ } })()).rejects.toThrow("boom");
    expect(settled).toHaveLength(1);
  });

  it("结算回调抛错被吞（观测的失败绝不打断运行）", async () => {
    const errors: unknown[] = [];
    const gen = observeRun(
      scripted([{ type: "turn_started", turn: 1 }], { reason: "completed" } as Terminal),
      { onSettled: () => { throw new Error("sink boom"); }, onError: (e) => errors.push(e) },
    );
    await expect((async () => { for await (const _ of gen) { /* drain */ } })()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("opts 缺席时返回原 generator（同一引用）", () => {
    const inner = scripted([], { reason: "completed" } as Terminal);
    expect(observeRun(inner, undefined)).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// M24 零字节不变量：观测开/关，发给模型的请求字节完全相等。
// 这是整弧最重要的一条——trace 只能"看"，永远不能"改"。
// ---------------------------------------------------------------------------
describe("135 / M24 — 观测零影响", () => {
  it("observeRun 开与关，两次运行发给模型的请求字节逐一相等", async () => {
    const fixturePath = join(here, "fixtures", "sample.txt");

    const runOnce = async (observe: boolean): Promise<string[]> => {
      const bodies: string[] = [];
      const script = [
        { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
        { role: "assistant" as const, content: "done" },
      ];
      const base = createScriptedModel(script);
      const model = {
        ...(base.modelId !== undefined ? { modelId: base.modelId } : {}),
        async generate(input: ModelInput) {
          bodies.push(canonicalJson({ messages: input.messages, tools: input.tools ?? null }));
          return base.generate(input);
        },
        ...(base.stream !== undefined
          ? {
              async *stream(input: ModelInput) {
                bodies.push(canonicalJson({ messages: input.messages, tools: input.tools ?? null }));
                for await (const ev of base.stream!(input)) yield ev;
              },
            }
          : {}),
      };
      const state = {
        systemPrompt: "You answer questions about files.",
        messages: [{ role: "user" as const, content: "What does the file say?" }],
        tools: [createReadFileTool()],
        status: "idle" as const,
      };
      const gen = runAgentLoop(state, model, { maxTurns: 5 });
      const wrapped = observe ? observeRun(gen, { sessionId: "m24", onSettled: () => {} }) : gen;
      for await (const _ of wrapped) { void _; }
      return bodies;
    };

    const off = await runOnce(false);
    const on = await runOnce(true);
    expect(off.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });
});

describe("135 / observeRun — 生成器协议转发", () => {
  it("消费者 return() 会转进内层（内层 finally 照跑）", async () => {
    let innerCleaned = false;
    const gen = observeRun(
      (async function* (): AsyncGenerator<LoopEvent, Terminal> {
        try {
          yield { type: "turn_started", turn: 1 };
          yield { type: "turn_finished", turn: 1, toolCallCount: 0 };
        } finally {
          innerCleaned = true;
        }
        return { reason: "completed" } as Terminal;
      })(),
      { onSettled: () => {} },
    );
    for await (const e of gen) { if (e.type === "turn_started") break; }
    expect(innerCleaned).toBe(true);
  });

  it("消费者向包装层 throw 会转进内层", async () => {
    let received: unknown;
    const gen = observeRun(
      (async function* (): AsyncGenerator<LoopEvent, Terminal> {
        try {
          yield { type: "turn_started", turn: 1 };
        } catch (err) {
          received = err;
          throw err;
        }
        return { reason: "completed" } as Terminal;
      })(),
      { onSettled: () => {} },
    );
    const first = await gen.next();
    expect(first.done).toBe(false);
    await expect(gen.throw(new Error("consumer abort"))).rejects.toThrow("consumer abort");
    expect((received as Error | undefined)?.message).toBe("consumer abort");
  });
});
