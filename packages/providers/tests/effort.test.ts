import { describe, it, expect } from "vitest";
import {
  parseReasoningEffort,
  parseReasoningFormat,
  reasoningFormatBody,
  resolveReasoningContext,
  supportsReasoningEffort,
  resolveProviderConfig,
  createOpenAICompatibleProvider,
  type ProviderConfig,
  type ReasoningFormat,
} from "../src/index.js";

const minimalInput = {
  systemPrompt: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
};

/** A request context for a bare format (no map, rider off). */
function ctx(format: ReasoningFormat, overrides: { thinkingLevelMap?: Record<string, string | null>; supportsReasoningEffort?: boolean } = {}) {
  return { format, thinkingLevelMap: overrides.thinkingLevelMap, supportsReasoningEffort: overrides.supportsReasoningEffort ?? false };
}

// Capture the exact request body the engine posts for a given config.
async function postedBody(config: ProviderConfig): Promise<Record<string, unknown>> {
  let body = "";
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    };
  }) as typeof fetch;
  const model = createOpenAICompatibleProvider(config, { fetch: fakeFetch });
  await model.generate(minimalInput);
  return JSON.parse(body) as Record<string, unknown>;
}

describe("reasoningFormatBody — the M16 per-profile transforms as enum implementations", () => {
  it("deepseek: {reasoning_effort: <v>}", () => {
    expect(reasoningFormatBody(ctx("deepseek"), "low")).toEqual({ reasoning_effort: "low" });
    expect(reasoningFormatBody(ctx("deepseek"), "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningFormatBody(ctx("deepseek"), "max")).toEqual({ reasoning_effort: "max" });
  });

  it("wudao rides the deepseek format: passthrough {reasoning_effort}", () => {
    expect(reasoningFormatBody(ctx("deepseek"), "medium")).toEqual({ reasoning_effort: "medium" });
  });

  it("zai: thinking enabled only for high/max via the profile thinkingLevelMap (glm bytes preserved)", () => {
    const glmMap = { low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" };
    expect(reasoningFormatBody(ctx("zai", { thinkingLevelMap: glmMap }), "high")).toEqual({ thinking: { type: "enabled" } });
    expect(reasoningFormatBody(ctx("zai", { thinkingLevelMap: glmMap }), "max")).toEqual({ thinking: { type: "enabled" } });
    expect(reasoningFormatBody(ctx("zai", { thinkingLevelMap: glmMap }), "low")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningFormatBody(ctx("zai", { thinkingLevelMap: glmMap }), "medium")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningFormatBody(ctx("zai", { thinkingLevelMap: glmMap }), "none")).toEqual({ thinking: { type: "disabled" } });
  });

  it("zai without a map defaults to enabled for any non-none effort", () => {
    expect(reasoningFormatBody(ctx("zai"), "low")).toEqual({ thinking: { type: "enabled" } });
    expect(reasoningFormatBody(ctx("zai"), "none")).toEqual({ thinking: { type: "disabled" } });
  });

  it("qwen: enable_thinking true unless none", () => {
    expect(reasoningFormatBody(ctx("qwen"), "high")).toEqual({ enable_thinking: true });
    expect(reasoningFormatBody(ctx("qwen"), "low")).toEqual({ enable_thinking: true });
    expect(reasoningFormatBody(ctx("qwen"), "none")).toEqual({ enable_thinking: false });
  });
});

describe("reasoningFormatBody — additive formats (the upstream project-verified shapes)", () => {
  it("none: no wire field at all", () => {
    for (const effort of ["low", "high", "none"] as const) {
      expect(reasoningFormatBody(ctx("none"), effort)).toEqual({});
    }
  });

  it("qwen-chat-template: chat_template_kwargs wrapper", () => {
    expect(reasoningFormatBody(ctx("qwen-chat-template"), "high")).toEqual({
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    });
    expect(reasoningFormatBody(ctx("qwen-chat-template"), "none")).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });

  it("openrouter: {reasoning: {effort}}", () => {
    expect(reasoningFormatBody(ctx("openrouter"), "high")).toEqual({ reasoning: { effort: "high" } });
  });

  it("together: {reasoning: {enabled}}", () => {
    expect(reasoningFormatBody(ctx("together"), "high")).toEqual({ reasoning: { enabled: true } });
    expect(reasoningFormatBody(ctx("together"), "none")).toEqual({ reasoning: { enabled: false } });
  });

  it("baseten: {chat_template_args: {enable_thinking}}", () => {
    expect(reasoningFormatBody(ctx("baseten"), "high")).toEqual({ chat_template_args: { enable_thinking: true } });
    expect(reasoningFormatBody(ctx("baseten"), "none")).toEqual({ chat_template_args: { enable_thinking: false } });
  });

  it("reasoning_effort rider joins the envelope when the endpoint supports it (zai/qwen/together/baseten)", () => {
    expect(reasoningFormatBody(ctx("zai", { supportsReasoningEffort: true }), "high")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(reasoningFormatBody(ctx("qwen", { supportsReasoningEffort: true }), "low")).toEqual({
      enable_thinking: true,
      reasoning_effort: "low",
    });
    expect(reasoningFormatBody(ctx("together", { supportsReasoningEffort: true }), "max")).toEqual({
      reasoning: { enabled: true },
      reasoning_effort: "max",
    });
    expect(reasoningFormatBody(ctx("baseten", { supportsReasoningEffort: true }), "high")).toEqual({
      chat_template_args: { enable_thinking: true },
      reasoning_effort: "high",
    });
  });

  it("thinkingLevelMap remaps the effort value (null = level unsupported → no field)", () => {
    const map = { low: null, medium: "medium", high: "high", max: null, none: "none" };
    expect(reasoningFormatBody(ctx("deepseek", { thinkingLevelMap: map }), "low")).toEqual({});
    expect(reasoningFormatBody(ctx("deepseek", { thinkingLevelMap: map }), "medium")).toEqual({ reasoning_effort: "medium" });
    expect(reasoningFormatBody(ctx("openrouter", { thinkingLevelMap: map }), "max")).toEqual({});
    expect(reasoningFormatBody(ctx("openrouter", { thinkingLevelMap: map }), "high")).toEqual({ reasoning: { effort: "high" } });
  });
});

describe("parseReasoningFormat", () => {
  it("accepts the eight format values", () => {
    for (const v of ["none", "deepseek", "zai", "qwen", "qwen-chat-template", "openrouter", "together", "baseten"] as const) {
      expect(parseReasoningFormat(v)).toBe(v);
    }
  });
  it("rejects junk", () => {
    expect(() => parseReasoningFormat("glm")).toThrow(/invalid reasoning format "glm"/);
    expect(() => parseReasoningFormat("")).toThrow(/invalid reasoning format ""/);
    expect(() => parseReasoningFormat("Deepseek")).toThrow(/invalid reasoning format "Deepseek"/);
  });
});

describe("supportsReasoningEffort — baseUrl sniff (custom endpoints)", () => {
  it("true for endpoints that accept reasoning_effort", () => {
    expect(supportsReasoningEffort("https://api.deepseek.com")).toBe(true);
    expect(supportsReasoningEffort("https://api.openai.com/v1")).toBe(true);
    expect(supportsReasoningEffort("https://openrouter.ai/api/v1")).toBe(true);
    expect(supportsReasoningEffort("http://localhost:8080/v1")).toBe(true);
  });
  it("false for endpoints known to reject it", () => {
    expect(supportsReasoningEffort("https://api.z.ai")).toBe(false);
    expect(supportsReasoningEffort("https://open.bigmodel.cn/api/paas/v4")).toBe(false);
    expect(supportsReasoningEffort("https://api.together.ai/v1")).toBe(false);
    expect(supportsReasoningEffort("https://api.together.xyz/v1")).toBe(false);
    expect(supportsReasoningEffort("https://api.moonshot.cn/v1")).toBe(false);
    expect(supportsReasoningEffort("https://api.x.ai/v1")).toBe(false);
    expect(supportsReasoningEffort("https://integrate.api.nvidia.com/v1")).toBe(false);
    expect(supportsReasoningEffort("https://gateway.ai.cloudflare.com/v1")).toBe(false);
  });
});

describe("resolveReasoningContext — profile defaults + env override", () => {
  it("each profile resolves to its enum format and map", () => {
    const deepseek = resolveReasoningContext(resolveProviderConfig({ WUDAO_API_KEY: "k" })!);
    expect(deepseek.format).toBe("deepseek");
    expect(deepseek.supportsReasoningEffort).toBe(true);

    const glm = resolveReasoningContext(resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" })!);
    expect(glm.format).toBe("zai");
    expect(glm.thinkingLevelMap).toEqual({ low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" });
    // bigmodel.cn never takes the reasoning_effort rider — pinned by the profile.
    expect(glm.supportsReasoningEffort).toBe(false);

    const qwen = resolveReasoningContext(resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "qwen" })!);
    expect(qwen.format).toBe("qwen");
    expect(qwen.supportsReasoningEffort).toBe(false);

    const wudao = resolveReasoningContext(
      resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "wudao", WUDAO_BASE_URL: "https://wudao.example/v1" })!,
    );
    expect(wudao.format).toBe("deepseek");
  });

  it("WUDAO_REASONING_FORMAT overrides the profile default", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm", WUDAO_REASONING_FORMAT: "openrouter" })!;
    expect(resolveReasoningContext(c).format).toBe("openrouter");
  });

  it("WUDAO_REASONING_FORMAT junk throws at resolution time", () => {
    expect(() => resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_REASONING_FORMAT: "bogus" })).toThrow(
      /invalid reasoning format "bogus"/,
    );
  });

  it("custom baseUrl sniffs the rider when the profile does not pin it", () => {
    const wudao = resolveReasoningContext(
      resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "wudao", WUDAO_BASE_URL: "https://api.together.xyz/v1" })!,
    );
    expect(wudao.supportsReasoningEffort).toBe(false);
  });
});

describe("request builder wiring", () => {
  it("deepseek + effort=high posts reasoning_effort in the body", async () => {
    const body = await postedBody({
      apiKey: "k",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      reasoningEffort: "high",
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("glm + effort=high posts thinking:{type:'enabled'} (M16 bytes unchanged)", async () => {
    const body = await postedBody({
      apiKey: "k",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6",
      provider: "glm",
      reasoningEffort: "high",
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("qwen + effort=none posts enable_thinking:false", async () => {
    const body = await postedBody({
      apiKey: "k",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-max",
      provider: "qwen",
      reasoningEffort: "none",
    });
    expect(body.enable_thinking).toBe(false);
  });

  it("reasoningFormat on the config beats the provider profile (openrouter via wudao endpoint)", async () => {
    const body = await postedBody({
      apiKey: "k",
      baseURL: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat",
      provider: "wudao",
      reasoningEffort: "high",
      reasoningFormat: "openrouter",
    });
    expect(body.reasoning).toEqual({ effort: "high" });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("byte-identical default path: no effort configured → no extra body field", async () => {
    const config: ProviderConfig = {
      apiKey: "k",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    };
    const body = await postedBody(config);
    // Exact shape the engine posted before profiles/effort existed.
    expect(Object.keys(body)).toEqual(["model", "messages", "tools", "tool_choice"]);
    expect(body).toEqual({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      tool_choice: "auto",
    });
    expect("reasoning_effort" in body).toBe(false);
    expect("thinking" in body).toBe(false);
    expect("enable_thinking" in body).toBe(false);

    // M24: streaming adds ONLY `stream` + `stream_options` (include_usage) —
    // appended after the pinned key sequence, so the streaming body's bytes
    // are the non-streaming body's bytes plus the two trailing keys. The
    // prompt token content itself is unchanged (prefix-cache safe).
    let streamBody = "";
    const sse = "data: [DONE]\n\n";
    const streamFetch = (async (_url: string, init: RequestInit) => {
      streamBody = String(init.body);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
      };
    }) as typeof fetch;
    const streamModel = createOpenAICompatibleProvider(config, { fetch: streamFetch });
    for await (const _ev of streamModel.stream!(minimalInput)) {
      // drain
    }
    expect(streamBody).toBe(
      `${JSON.stringify(body).slice(0, -1)},"stream":true,"stream_options":{"include_usage":true}}`,
    );
  });
});

describe("response reasoning-field sniffing (reasoning_content / reasoning / thinking)", () => {
  async function generateWith(message: Record<string, unknown>): Promise<string | undefined> {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "ok", ...message } }] }),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "wudao" },
      { fetch: fakeFetch },
    );
    const msg = await model.generate(minimalInput);
    return msg.reasoning;
  }

  it("generate(): reasoning_content still surfaces (deepseek spelling)", async () => {
    expect(await generateWith({ reasoning_content: "chain A" })).toBe("chain A");
  });
  it("generate(): reasoning (openrouter spelling) surfaces without touching the parser", async () => {
    expect(await generateWith({ reasoning: "chain B" })).toBe("chain B");
  });
  it("generate(): thinking (zai spelling) surfaces", async () => {
    expect(await generateWith({ thinking: "chain C" })).toBe("chain C");
  });

  it("stream(): reasoning + thinking deltas ride reasoning_delta events", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning":"r1"}}]}\n\n' +
      'data: {"choices":[{"delta":{"thinking":"t1"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "wudao" },
      { fetch: fakeFetch },
    );
    const reasoning: string[] = [];
    let done: { content: string; reasoning?: string } | undefined;
    for await (const ev of model.stream!(minimalInput)) {
      if (ev.type === "reasoning_delta") reasoning.push(ev.text);
      if (ev.type === "done") done = { content: ev.message.content, reasoning: ev.message.reasoning };
    }
    expect(reasoning.join("")).toBe("r1t1");
    expect(done?.content).toBe("answer");
    expect(done?.reasoning).toBe("r1t1");
  });
});

describe("parseReasoningEffort", () => {
  it("accepts the five valid values", () => {
    for (const v of ["low", "medium", "high", "max", "none"] as const) {
      expect(parseReasoningEffort(v)).toBe(v);
    }
  });
  it("rejects junk", () => {
    expect(() => parseReasoningEffort("ultra")).toThrow(/invalid reasoning effort "ultra"/);
    expect(() => parseReasoningEffort("")).toThrow(/invalid reasoning effort ""/);
    expect(() => parseReasoningEffort("HIGH")).toThrow(/invalid reasoning effort "HIGH"/);
  });
});

// M58 §C (batch A core contract): ModelInput.reasoningEffort — the per-request
// override the tier-2 summary call uses to pass the SESSION effort through.
// It overrides the config's own effort; absent input effort = config effort;
// absent both = no field on the wire (the main loop's requests stay
// byte-identical).
describe("per-input reasoning_effort override (M58 §C tier-2 pass-through)", () => {
  const CFG: ProviderConfig = { apiKey: "k", baseURL: "https://x/v1", model: "m" };

  async function postedWith(input: { reasoningEffort?: string }, config: ProviderConfig = CFG): Promise<Record<string, unknown>> {
    let body = "";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(config, { fetch: fakeFetch });
    await model.generate({ ...minimalInput, ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) });
    return JSON.parse(body) as Record<string, unknown>;
  }

  it("input effort rides the wire when the config has none", async () => {
    const body = await postedWith({ reasoningEffort: "high" });
    expect(body["reasoning_effort"]).toBe("high");
  });

  it("input effort OVERRIDES the config effort (session value wins)", async () => {
    const body = await postedWith({ reasoningEffort: "high" }, { ...CFG, reasoningEffort: "low" });
    expect(body["reasoning_effort"]).toBe("high");
  });

  it("config effort applies when the input carries none (status quo bytes)", async () => {
    const body = await postedWith({}, { ...CFG, reasoningEffort: "low" });
    expect(body["reasoning_effort"]).toBe("low");
  });

  it("no effort anywhere = no field on the wire", async () => {
    const body = await postedWith({});
    expect("reasoning_effort" in body).toBe(false);
  });

  it("junk input effort fails fast (never reaches the wire)", async () => {
    await expect(postedWith({ reasoningEffort: "ultra" })).rejects.toThrow(/invalid reasoning effort "ultra"/);
  });
});
