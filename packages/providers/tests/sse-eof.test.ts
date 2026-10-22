// ω99-44 — SSE EOF 语义硬化（brief §2.1 的切分不变量性质测试）。
// 上游证据：the upstream project64eeb82a4（EOF 当帧终结符）+ ebc374490（proxy EOF 无终态显式报错）。
//
// 三件事钉死：
//  1. 任意切分点等价 —— 完整 body 逐字节枚举全部切分点，两 chunk 喂入的事件
//     序列 == 整体一次读入（EOF flush 让残尾帧不再被静默丢弃）。
//  2. 末帧无换行 —— 最后一帧不带结尾换行仍完整解析（含 finish/usage）。
//  3. 中途掐断 —— body 在终态事件之前干净 EOF → TruncatedStreamError，无 done、
//     无伪造 usage。
//  4. 终态谓词钉 —— anthropic 无 [DONE]（message_stop 即终态）；openai 无 [DONE]
//     但 chunk 带 finish_reason（省 [DONE] 的网关变体）→ 正常完成。
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createResponsesProvider,
} from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;

const CFG_OAI = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const CFG_AN = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const CFG_RS = { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-the upstream project" };

// ---------------------------------------------------------------------------
// Fixtures（≤ 2KB）
// ---------------------------------------------------------------------------

/** anthropic 形：message_delta(stop_reason) + message_stop 收尾。 */
const AN_BODY = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join("");

/** openai 形：finish_reason chunk + usage-only chunk + [DONE] 收尾。 */
const OAI_BODY = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join("");

/** openai 无-[DONE]-带-finish_reason 形（省 [DONE] 的网关变体，brief §2.1 fixture 3）。 */
const OAI_FR_BODY = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
].join("");

/** responses 形（第三个 sseDataLines 消费者）：response.completed 收尾。 */
const RS_BODY = [
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1},"output":[]}}\n\n',
].join("");

// 终态之前的截断体（中途掐断用）。
const AN_CUT = AN_BODY.slice(0, AN_BODY.indexOf('data: {"type":"message_delta"'));
const OAI_CUT = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
const OAI_FR_CUT = OAI_FR_BODY.slice(0, OAI_FR_BODY.indexOf('data: {"choices":[{"delta":{},"finish_reason"'));
const RS_CUT = RS_BODY.slice(0, RS_BODY.indexOf('data: {"type":"response.completed"'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A 200 SSE body delivered as ONE read. */
function bodyFetch(body: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
  })) as typeof fetch;
}

/** A 200 SSE body split into TWO reads at byte offset `at`（空片不入队）。 */
function splitFetch(body: string, at: number): typeof fetch {
  const enc = new TextEncoder();
  const parts = [enc.encode(body.slice(0, at)), enc.encode(body.slice(at))].filter((p) => p.length > 0);
  return (async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    }),
  })) as typeof fetch;
}

interface RunResult {
  events: any[];
  usageRows: any[];
  err: unknown;
}

/** Drain a provider stream: capture events, usage rows, and the terminal error. */
async function runWith(fetch: typeof fetch, make: (f: typeof fetch) => any): Promise<RunResult> {
  const events: any[] = [];
  const usageRows: any[] = [];
  let err: unknown;
  try {
    for await (const ev of make(fetch).stream!({ ...INPUT, onUsage: (u: any) => usageRows.push(u) })) {
      events.push(ev);
    }
  } catch (e) {
    err = e;
  }
  return { events, usageRows, err };
}

const anProvider = (fetch: typeof fetch) => createAnthropicProvider(CFG_AN, { fetch, retry: INSTANT });
const oaiProvider = (fetch: typeof fetch) => createOpenAICompatibleProvider(CFG_OAI, { fetch, retry: INSTANT });
const rsProvider = (fetch: typeof fetch) => createResponsesProvider(CFG_RS, { fetch, retry: INSTANT });

// ---------------------------------------------------------------------------
// §2.1.1 — 任意切分点等价
// ---------------------------------------------------------------------------

describe("ω99-44 §2.1.1 split-point equivalence (EOF flush)", () => {
  const cases: ReadonlyArray<readonly [string, (f: typeof fetch) => any, string]> = [
    ["anthropic", anProvider, AN_BODY],
    ["openai", oaiProvider, OAI_BODY],
    ["openai finish_reason-only", oaiProvider, OAI_FR_BODY],
    ["responses", rsProvider, RS_BODY],
  ];
  for (const [name, make, body] of cases) {
    it(`${name}: every byte-boundary split yields the identical event sequence`, async () => {
      const whole = await runWith(bodyFetch(body), make);
      expect(whole.err).toBeUndefined();
      expect(whole.events.at(-1)?.type).toBe("done");
      for (let at = 0; at <= body.length; at += 1) {
        const split = await runWith(splitFetch(body, at), make);
        expect(split.err).toBeUndefined();
        expect(split.events).toEqual(whole.events);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §2.1.2 — 末帧无换行
// ---------------------------------------------------------------------------

describe("ω99-44 §2.1.2 final frame without its trailing newline", () => {
  it("anthropic: the unterminated message_stop event still completes the stream", async () => {
    const body = AN_BODY.slice(0, -2); // drop the final "\n\n"
    const r = await runWith(bodyFetch(body), anProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.some((e) => e.type === "text_delta")).toBe(true);
    expect(r.events.at(-1)?.type).toBe("done");
    expect(r.events.at(-1)?.message.stopReason).toBe("stop");
    expect(r.usageRows).toHaveLength(1); // message_delta usage honored
  });

  it("openai: `data: [DONE]` without a trailing newline still terminates", async () => {
    const body = OAI_BODY.slice(0, -2);
    const r = await runWith(bodyFetch(body), oaiProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
    expect(r.usageRows).toHaveLength(1); // the usage-only chunk honored
  });

  it("openai finish_reason-only: the finish chunk lands unterminated", async () => {
    const body = OAI_FR_BODY.slice(0, -2);
    const r = await runWith(bodyFetch(body), oaiProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
    expect(r.events.at(-1)?.message.stopReason).toBe("stop");
  });

  it("responses: response.completed unterminated still completes", async () => {
    const body = RS_BODY.slice(0, -2);
    const r = await runWith(bodyFetch(body), rsProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// §2.1.3 — 中途掐断 → TruncatedStreamError（无 done、无伪造 usage）
// ---------------------------------------------------------------------------

describe("ω99-44 §2.1.3 EOF before the terminal event fails loud", () => {
  const cases: ReadonlyArray<readonly [string, (f: typeof fetch) => any, string]> = [
    ["anthropic (cut before message_delta/message_stop)", anProvider, AN_CUT],
    ["openai (cut before [DONE]/finish_reason)", oaiProvider, OAI_CUT],
    ["openai finish_reason-only (cut before the finish chunk)", oaiProvider, OAI_FR_CUT],
    ["responses (cut before response.completed)", rsProvider, RS_CUT],
  ];
  for (const [name, make, body] of cases) {
    it(`${name}: typed TruncatedStreamError, no done, no fabricated usage`, async () => {
      const r = await runWith(bodyFetch(body), make);
      expect(r.err).toMatchObject({ name: "TruncatedStreamError" });
      expect((r.err as any).provider).toBeTypeOf("string");
      expect((r.err as any).sawBytes).toBeGreaterThan(0);
      expect(r.events.some((e) => e.type === "done")).toBe(false);
      expect(r.usageRows).toEqual([]); // 不伪造 usage
    });
  }

  it("残尾判界: a half-JSON residual is dropped, and the truncation still reports", async () => {
    // Content delta delivered, then a clean EOF whose residual is half a JSON
    // line — the tail is discarded (never fabricated into an event), and the
    // missing terminal still fails loud.
    const body = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{"con';
    const r = await runWith(bodyFetch(body), oaiProvider);
    expect(r.err).toMatchObject({ name: "TruncatedStreamError" });
    expect(r.events.some((e) => e.type === "text_delta" && e.text === "ok")).toBe(true);
    expect(r.events.some((e) => e.type === "done")).toBe(false);
    expect(r.usageRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.1.4 — 终态谓词钉
// ---------------------------------------------------------------------------

describe("ω99-44 §2.1.4 terminal predicates (absence of the LITERAL [DONE] is not truncation)", () => {
  it("anthropic wire never carries [DONE] — message_stop alone completes", async () => {
    const r = await runWith(bodyFetch(AN_BODY), anProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
  });

  it("openai without [DONE] but with a finish_reason chunk completes normally", async () => {
    const r = await runWith(bodyFetch(OAI_FR_BODY), oaiProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.message.stopReason).toBe("stop");
  });

  it("openai usage-tail after finish_reason with [DONE] dropped still completes (gateway variant)", async () => {
    const body = OAI_BODY.slice(0, OAI_BODY.indexOf("data: [DONE]"));
    const r = await runWith(bodyFetch(body), oaiProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
    expect(r.usageRows).toHaveLength(1);
  });

  it("responses: response.completed is the terminal", async () => {
    const r = await runWith(bodyFetch(RS_BODY), rsProvider);
    expect(r.err).toBeUndefined();
    expect(r.events.at(-1)?.type).toBe("done");
  });
});
