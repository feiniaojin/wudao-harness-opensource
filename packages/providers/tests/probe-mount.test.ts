// PB-1 探针基础设施弧——providers 工厂缝挂载钉。createOpenAICompatibleProvider
// 的返回处包 probeModelClient（core 的装饰器）：WUDAO_PROBE=on 时 model.call 落
// @wudao/core 的进程级 probeBus（tokens/latency 取 usage 通道真值）；关闭=原
// 对象透传，provider 行为零差（此测试同时是挂载线不被误删的回归钉）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import { PROBE_ENV, probeBus } from "@wudao/core";

const CFG = { apiKey: "k", baseURL: "https://x/v1", model: "m" };

const savedEnv: string | undefined = process.env[PROBE_ENV];
beforeEach(() => {
  delete process.env[PROBE_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[PROBE_ENV];
  else process.env[PROBE_ENV] = savedEnv;
});

function jsonFetch(payload: () => unknown): typeof fetch {
  return (async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => payload(),
  })) as typeof fetch;
}

describe("PB-1 工厂缝探针挂载", () => {
  it("关：generate 行为不变且单例总线零新增", async () => {
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: jsonFetch(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })),
    });
    const bus = probeBus();
    const before = bus.recent().length;
    const msg = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(msg.content).toBe("ok");
    expect(bus.recent().length).toBe(before);
  });

  it("开：generate 记 model.call（model/tokensIn/tokensOut/cacheHitTokens 真值）", async () => {
    process.env[PROBE_ENV] = "on";
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: jsonFetch(() => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 7, prompt_cache_hit_tokens: 800 },
      })),
    });
    const bus = probeBus();
    const before = bus.recent().length;
    const msg = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(msg.content).toBe("ok");
    const gained = bus.recent().slice(before);
    expect(gained.map((e) => `${e.cat}.${e.name}`)).toEqual(["model.model.call"]);
    expect(gained[0]!.data).toMatchObject({
      model: "m",
      tokensIn: 1000,
      tokensOut: 7,
      cacheHitTokens: 800,
      retry: 0,
      ok: true,
    });
    expect(typeof gained[0]!.data.latencyMs).toBe("number");
  });
});
