// ω-1a — tool_call id 去重（name-as-id 端点并行同名调用）。
//
// 部分 OpenAI 兼容端点（GLM/Qwen 某些兼容模式）把 tool call 的 id 原样回显
// 为函数名（name-as-id）。一轮里并行调用同名工具两次 → 两个 tool call 同
// id → 下游按 id 关联/序列化时互相覆盖甚至丢调用；部分严格端点还会因出站
// 历史里出现重复 tool_call id 直接 400。
//
// 契约（入站去重 / 出站还原，均在本包完成，core 不感知）：
//   - dedupeToolCallIds：仅当 id === 函数名（name-as-id 形状）且同一条
//     assistant 消息内重复时，第二个起改为 `${name}#2`、`${name}#3`…；
//     非 name-as-id 的 id（如 `call_abc123`）永不去重。
//   - restoreToolCallIds / restoreToolCallId：出站前剥离——id 精确匹配
//     `${name}#${整数}` 时还原为 name，否则原样返回（对真 id 恒为 no-op）。
import { describe, it, expect } from "vitest";
import { dedupeToolCallIds, restoreToolCallIds, restoreToolCallId } from "../src/tool-call-ids.js";
import { createOpenAICompatibleProvider } from "../src/index.js";
import type { ToolCall } from "@wudao-org/core";

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: {} });

describe("dedupeToolCallIds — 仅 name-as-id 形状去重", () => {
  it("同名并行两次 → name / name#2", () => {
    const out = dedupeToolCallIds([call("get_weather", "get_weather"), call("get_weather", "get_weather")]);
    expect(out.map((t) => t.id)).toEqual(["get_weather", "get_weather#2"]);
    expect(out.map((t) => t.name)).toEqual(["get_weather", "get_weather"]);
  });

  it("同名并行三次 → #2 #3 依次递增", () => {
    const out = dedupeToolCallIds([
      call("read_file", "read_file"),
      call("read_file", "read_file"),
      call("read_file", "read_file"),
    ]);
    expect(out.map((t) => t.id)).toEqual(["read_file", "read_file#2", "read_file#3"]);
  });

  it("id ≠ name（call_x）重复出现也不去重", () => {
    const out = dedupeToolCallIds([call("call_x", "read_file"), call("call_x", "read_file")]);
    expect(out.map((t) => t.id)).toEqual(["call_x", "call_x"]);
  });

  it("混排时非 name-as-id 项不占计数", () => {
    const out = dedupeToolCallIds([
      call("get_weather", "get_weather"),
      call("call_real", "get_weather"),
      call("get_weather", "get_weather"),
    ]);
    expect(out.map((t) => t.id)).toEqual(["get_weather", "call_real", "get_weather#2"]);
  });

  it("无重复 / 不同名各一次 → 原样返回（顺序不变，原对象不被改写）", () => {
    const a = call("get_weather", "get_weather");
    const b = call("call_1", "read_file");
    const out = dedupeToolCallIds([a, b]);
    expect(out).toEqual([a, b]);
    expect(out[0]).toBe(a);
    expect(a.id).toBe("get_weather");
  });
});

describe("restoreToolCallIds — 出站剥离 `${name}#${整数}`", () => {
  it("精确匹配 `${name}#${整数}` 的 id 还原为 name", () => {
    const out = restoreToolCallIds([call("get_weather#2", "get_weather"), call("read_file#10", "read_file")]);
    expect(out.map((t) => t.id)).toEqual(["get_weather", "read_file"]);
  });

  it("真 id（call_abc）不受影响", () => {
    const out = restoreToolCallIds([call("call_abc123", "read_file")]);
    expect(out[0].id).toBe("call_abc123");
  });

  it("含 # 但非 `${name}#${整数}` 形状的不误伤", () => {
    // id 与 name 的 # 后缀不一致、后缀非纯数字、裸 "#2"（name 为空）都不剥离。
    const out = restoreToolCallIds([
      call("call_abc#2", "get_weather"),
      call("get_weather#2x", "get_weather"),
      call("#2", ""),
    ]);
    expect(out.map((t) => t.id)).toEqual(["call_abc#2", "get_weather#2x", "#2"]);
  });

  it("往返（dedupe→restore）还原 provider 原生形状", () => {
    const native = [call("get_weather", "get_weather"), call("get_weather", "get_weather"), call("get_weather", "get_weather")];
    const back = restoreToolCallIds(dedupeToolCallIds(native));
    expect(back.map((t) => t.id)).toEqual(["get_weather", "get_weather", "get_weather"]);
  });
});

describe("restoreToolCallId — 单 id 形态（tool_result 出站路径）", () => {
  it("id === `${name}#${整数}` 时还原为 name", () => {
    expect(restoreToolCallId("get_weather#2", "get_weather")).toBe("get_weather");
  });
  it("非匹配形状原样返回", () => {
    expect(restoreToolCallId("call_abc", "get_weather")).toBe("call_abc");
    expect(restoreToolCallId("get_weather", "get_weather")).toBe("get_weather");
  });
});

// ---------------------------------------------------------------------------
// 集成：走真实的 provider 解析 / 序列化路径（不 mock 内部函数）。
// ---------------------------------------------------------------------------

/** 抓请求体并回一个最小 completion 的 fetch（body 每次调用覆写）。 */
function captureBody(reply: () => unknown): { fetch: typeof fetch; body: Record<string, unknown> } {
  const cap: { fetch?: typeof fetch; body: Record<string, unknown> } = { body: {} };
  cap.fetch = (async (_url, init) => {
    cap.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => reply() } as unknown as Response;
  }) as typeof fetch;
  return cap as { fetch: typeof fetch; body: Record<string, unknown> };
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const WEATHER_TOOLS = [
  {
    name: "get_weather",
    description: "d",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];

describe("非流式集成 — name-as-id 端点", () => {
  it("并行同名两次解析为互异 id", async () => {
    const cap = captureBody(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "get_weather", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
              { id: "get_weather", type: "function", function: { name: "get_weather", arguments: '{"city":"上海"}' } },
            ],
          },
        },
      ],
    }));
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: cap.fetch },
    );
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "两城天气" }], tools: WEATHER_TOOLS });
    expect(msg.toolCalls?.map((t) => t.id)).toEqual(["get_weather", "get_weather#2"]);
    expect(msg.toolCalls?.[0]?.arguments).toEqual({ city: "北京" });
    expect(msg.toolCalls?.[1]?.arguments).toEqual({ city: "上海" });
  });

  it("出站序列化后请求体里两个 id 均还原为 get_weather（assistant 与 tool 消息一致）", async () => {
    const cap = captureBody(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: cap.fetch },
    );
    await model.generate({
      systemPrompt: "s",
      tools: WEATHER_TOOLS,
      messages: [
        { role: "user", content: "两城天气" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "get_weather", name: "get_weather", arguments: { city: "北京" } },
            { id: "get_weather#2", name: "get_weather", arguments: { city: "上海" } },
          ],
        },
        { role: "tool", toolCallId: "get_weather", name: "get_weather", content: "晴" },
        { role: "tool", toolCallId: "get_weather#2", name: "get_weather", content: "雨" },
        { role: "user", content: "继续" },
      ],
    });
    const messages = cap.body.messages as Array<Record<string, any>>;
    const assistant = messages.find((m) => m.role === "assistant");
    const ids = (assistant.tool_calls as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(["get_weather", "get_weather"]);
    const toolIds = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolIds).toEqual(["get_weather", "get_weather"]);
  });

  it("真 id（call_*）历史出站字节不变", async () => {
    const cap = captureBody(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: cap.fetch },
    );
    await model.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_abc", name: "read_file", arguments: { path: "a" } }] },
        { role: "tool", toolCallId: "call_abc", name: "read_file", content: "file a" },
      ],
    });
    const messages = cap.body.messages as Array<Record<string, any>>;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant.tool_calls).toEqual([
      { id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
    ]);
    expect(messages.find((m) => m.role === "tool").tool_call_id).toBe("call_abc");
  });
});

describe("流式集成 — delta 聚合后同样去重", () => {
  it("index 0/1、id 仅在首片段出现：聚合后 name / name#2", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"get_weather","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"get_weather","function":{"name":"get_weather","arguments":"{\\"city\\":\\"上海\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: WEATHER_TOOLS })) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done.toolCalls.map((t: ToolCall) => t.id)).toEqual(["get_weather", "get_weather#2"]);
    expect(done.toolCalls[0].arguments).toEqual({ city: "北京" });
    expect(done.toolCalls[1].arguments).toEqual({ city: "上海" });
  });

  it("真 id 流式聚合不去重（回归保护）", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done.toolCalls.map((t: ToolCall) => t.id)).toEqual(["call_a", "call_b"]);
  });
});
