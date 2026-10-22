import { describe, it, expect } from "vitest";
import {
  PROVIDER_PROFILES,
  resolveProviderConfig,
  resolveProviderConfigResult,
  effectiveProfiles,
} from "../src/index.js";

describe("PROVIDER_PROFILES", () => {
  it("registers the four profiles with their defaults + reasoning-format matrix entries", () => {
    expect(PROVIDER_PROFILES.deepseek).toEqual({
      label: "deepseek",
      defaultBaseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      reasoningFormat: "deepseek",
      acceptsReasoningOnlyFinish: true,
      // ω-2b (I1-c): the shared prompt+completion window pin.
      windowMode: "shared",
      // ω99-39: the only probe-verified client-replay drop (billing + cache
      // both inert — see capClientReasoningReplay).
      dropsClientReasoningReplay: true,
      // P0-4 (96 队列): the only documented wallet-balance endpoint.
      balanceUrl: "https://api.deepseek.com/user/balance",
      // 反馈① 收口 (2026-08-29 夜): doc-verified per-model context pins.
      models: [
        { name: "deepseek-v4-flash", contextLength: 1_000_000 },
        { name: "deepseek-v4-pro", contextLength: 1_000_000 },
        { name: "deepseek-v4-flash-vision-exp", contextLength: 1_000_000 },
      ],
    });
    expect(PROVIDER_PROFILES.glm).toEqual({
      label: "glm",
      defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-4.6",
      reasoningFormat: "zai",
      thinkingLevelMap: { low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" },
      supportsReasoningEffort: false,
      acceptsReasoningOnlyFinish: true,
      // 夜移 022: zhipu legitimately omits reasoning on tool turns.
      omitsReasoningOnToolTurns: true,
      models: [{ name: "glm-4.6", contextLength: 204_800 }],
    });
    expect(PROVIDER_PROFILES.qwen).toEqual({
      label: "qwen",
      defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen3-max",
      reasoningFormat: "qwen",
      supportsReasoningEffort: false,
      acceptsReasoningOnlyFinish: false,
      models: [{ name: "qwen3-max", contextLength: 262_144 }],
    });
    expect(PROVIDER_PROFILES.wudao).toEqual({
      label: "wudao",
      defaultBaseUrl: undefined,
      defaultModel: "wudao-preview",
      requiresBaseUrl: true,
      reasoningFormat: "deepseek",
      acceptsReasoningOnlyFinish: true,
    });
  });

  it("registers the anthropic profile (0.3.12): messages wire, native thinking, independent window", () => {
    expect(PROVIDER_PROFILES.anthropic).toEqual({
      label: "anthropic",
      defaultBaseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-5",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      windowMode: "independent",
      wire: "anthropic",
    });
  });

  it("registers the pay-API split (0.3.30): kimi + minimax mirror their plan gateways' model catalogs", () => {
    expect(PROVIDER_PROFILES.kimi).toEqual({
      label: "kimi",
      defaultBaseUrl: "https://api.moonshot.cn/anthropic",
      defaultModel: "kimi-k3",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      windowMode: "independent",
      wire: "anthropic",
      bearerAuth: true,
      // kimi-k2.6 没有官方窗口数——不钉（错钉比漏钉危险：晚 autocompact → 413）。
      models: [
        { name: "kimi-k3", contextLength: 1_048_576 },
        { name: "kimi-k2.7-code", contextLength: 262_144 },
        { name: "kimi-k2.7-code-highspeed", contextLength: 262_144 },
        { name: "kimi-k2.6" },
      ],
    });
    expect(PROVIDER_PROFILES.minimax).toEqual({
      label: "minimax",
      defaultBaseUrl: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M3",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      // 窗口数未在按量文档核实——不钉。
      models: [{ name: "MiniMax-M3" }],
    });
  });

  it("registers the three coding-plan profiles (glm-code / kimi-code / minimax-code): anthropic wire", () => {
    expect(PROVIDER_PROFILES["glm-code"]).toEqual({
      label: "glm-code",
      defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
      defaultModel: "glm-5.3",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      windowMode: "independent",
      wire: "anthropic",
      bearerAuth: true,
      // 取证弧 0921: probe-verified completion tiers (4096-default reasoning
      // exhaustion was polyglot 三败题 root cause).
      defaultMaxTokens: 16_384,
      outputEscalateTo: 32_768,
      models: [
        { name: "glm-5.3", contextLength: 1_000_000 },
        { name: "glm-5.3-flash", contextLength: 1_000_000 },
      ],
    });
    // 0.3.30 重指向：kimi-code 现在是订阅网关（api.kimi.com/coding +
    // k3-256k），按量平台 API 拆到上方的 `kimi`。鉴权按官方配置走
    // x-api-key（无 bearerAuth 键）。
    expect(PROVIDER_PROFILES["kimi-code"]).toEqual({
      label: "kimi-code",
      defaultBaseUrl: "https://api.kimi.com/coding",
      defaultModel: "k3-256k",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      windowMode: "independent",
      wire: "anthropic",
      models: [{ name: "k3-256k", contextLength: 262_144 }],
    });
    expect(PROVIDER_PROFILES["minimax-code"]).toEqual({
      label: "minimax-code",
      defaultBaseUrl: "https://api.minimaxi.com/anthropic",
      defaultModel: "MiniMax-M3",
      reasoningFormat: "none",
      acceptsReasoningOnlyFinish: false,
      windowMode: "independent",
      wire: "anthropic",
      bearerAuth: true,
      models: [{ name: "MiniMax-M3", contextLength: 1_000_000 }],
    });
  });
});

describe("resolveProviderConfig — anthropic builtin (0.3.12)", () => {
  it("selecting anthropic resolves the messages wire with NO WUDAO_WIRE (the profile carries it)", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "sk-ant", WUDAO_PROVIDER: "anthropic" });
    expect(c?.baseURL).toBe("https://api.anthropic.com");
    expect(c?.model).toBe("claude-sonnet-5");
    expect(c?.wire).toBe("anthropic");
  });

  it("an explicit WUDAO_WIRE still beats the profile's native wire", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "anthropic", WUDAO_WIRE: "openai-chat" });
    expect(c?.wire).toBe("openai-chat");
  });

  it("the other builtins stay wire-absent (byte-identical historical configs)", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" });
    expect(c?.wire).toBeUndefined();
  });
});

describe("resolveProviderConfig — coding-plan builtins (bearerAuth)", () => {
  it("selecting a dual-send coding-plan profile resolves the anthropic wire + bearerAuth:true", () => {
    for (const provider of ["glm-code", "minimax-code"] as const) {
      const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: provider });
      expect(c?.wire).toBe("anthropic");
      expect(c?.bearerAuth).toBe(true);
    }
    const glmCode = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm-code" });
    expect(glmCode?.baseURL).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(glmCode?.model).toBe("glm-5.3");
  });

  it("kimi-code (0.3.30 订阅网关) resolves the anthropic wire with x-api-key only (bearerAuth absent)", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "kimi-code" });
    expect(c?.wire).toBe("anthropic");
    expect(c?.baseURL).toBe("https://api.kimi.com/coding");
    expect(c?.model).toBe("k3-256k");
    expect("bearerAuth" in (c ?? {})).toBe(false);
  });

  it("kimi (按量平台 API) keeps the dual-send bearerAuth:true on the moonshot endpoint", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "kimi" });
    expect(c?.baseURL).toBe("https://api.moonshot.cn/anthropic");
    expect(c?.model).toBe("kimi-k3");
    expect(c?.bearerAuth).toBe(true);
  });

  it("the real anthropic builtin stays bearerAuth-absent (request bytes unchanged)", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "sk-ant", WUDAO_PROVIDER: "anthropic" });
    expect("bearerAuth" in (c ?? {})).toBe(false);
  });
});

describe("resolveProviderConfig — provider selection", () => {
  it("defaults to the deepseek profile when nothing is configured", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k" });
    expect(c).toEqual({
      apiKey: "k",
      // M56 §1: the resolved config always carries the key pool (a single
      // key is a one-element pool; apiKey stays the primary).
      apiKeys: ["k"],
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      reasoningEffort: undefined,
      supportsReasoningEffort: true,
      acceptsReasoningOnlyFinish: true,
      // 夜移 022: resolver-threaded profile fact (deepseek does not omit).
      omitsReasoningOnToolTurns: false,
      // ω-2b (I1-c): threaded from the deepseek profile pin.
      windowMode: "shared",
      // P0-4 (96 队列): the wallet-balance endpoint rides the resolved config
      // (bearerAuth fold pattern).
      balanceUrl: "https://api.deepseek.com/user/balance",
    });
  });

  it("selects via WUDAO_PROVIDER env", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" });
    expect(c?.provider).toBe("glm");
    expect(c?.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(c?.model).toBe("glm-4.6");
  });

  it("--provider flag beats WUDAO_PROVIDER env", () => {
    const c = resolveProviderConfig(
      { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" },
      { provider: "qwen" },
    );
    expect(c?.provider).toBe("qwen");
    expect(c?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(c?.model).toBe("qwen3-max");
  });

  it("WUDAO_BASE_URL / WUDAO_MODEL still override the profile defaults", () => {
    const c = resolveProviderConfig({
      WUDAO_API_KEY: "k",
      WUDAO_PROVIDER: "glm",
      WUDAO_BASE_URL: "https://proxy.example/v1",
      WUDAO_MODEL: "custom-model",
    });
    expect(c?.baseURL).toBe("https://proxy.example/v1");
    expect(c?.model).toBe("custom-model");
  });

  // R3-T002 深测弧：环境钉模型与所选 provider 目录不相容 → 选型时刻
  // fail-fast（点修法），不再放行到厂商端点吃无归因 404。网关豁免、空目
  // 录自定义、profile 缺省三形零触（各自有钉）。
  it("throws at selection when an env-pinned model is not in the selected provider's catalog (no gateway override)", () => {
    expect(() =>
      resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm", WUDAO_MODEL: "deepseek-v4-flash" }),
    ).toThrow(/model "deepseek-v4-flash" \(from WUDAO_MODEL\) is not offered by provider "glm"/);
    // OPENAI_MODEL 同款归因。
    expect(() =>
      resolveProviderConfig({ OPENAI_API_KEY: "ok", WUDAO_PROVIDER: "glm", OPENAI_MODEL: "deepseek-v4-flash" }),
    ).toThrow(/from OPENAI_MODEL/);
  });

  it("gateway base URL exempts the catalog guard (any model name routable)", () => {
    const c = resolveProviderConfig({
      WUDAO_API_KEY: "k",
      WUDAO_PROVIDER: "glm",
      WUDAO_BASE_URL: "https://proxy.example/v1",
      WUDAO_MODEL: "deepseek-v4-flash", // 目录外，但网关路由合法
    });
    expect(c?.model).toBe("deepseek-v4-flash");
  });

  // R3-T002（续）：枚举面豁免——矩阵扫描类调用方（goal 的
  // cheapestMatrixModel、workflow 的 routePreflight）置
  // allowEnvModelMismatch:true 关哨兵：env 模型与本成员目录不合由调用方
  // 自有的更细守门处理（跳过成员 / model 检查 + fallback 链路由）。
  it("allowEnvModelMismatch exempts the catalog guard (enumeration surfaces)", () => {
    const r = resolveProviderConfigResult(
      { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm", WUDAO_MODEL: "deepseek-v4-flash" },
      { allowEnvModelMismatch: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.model).toBe("deepseek-v4-flash");
  });

  it("profile default model never trips the guard; empty-catalog customs are exempt", () => {
    // profile 缺省（无 env 钉）永远合法。
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" });
    expect(c?.model).toBe("glm-4.6");
    // 目录空的自定义 provider（私有网关常见形）不设防。
    const profiles = new Map([
      ["gw", { label: "gw", defaultBaseUrl: "https://gw.example/v1", defaultModel: "anything", models: [], custom: true }],
    ]);
    const r = resolveProviderConfigResult(
      { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "gw", WUDAO_MODEL: "totally-custom" },
      undefined,
      undefined,
      profiles,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.model).toBe("totally-custom");
  });

  it("throws on an unknown provider name", () => {
    expect(() => resolveProviderConfig({ WUDAO_API_KEY: "k" }, { provider: "claude" })).toThrow(
      /unknown provider "claude".*deepseek, glm, qwen, wudao/,
    );
    expect(() => resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "nope" })).toThrow(
      /unknown provider "nope"/,
    );
  });

  it("keeps OPENAI_* key/base/model fallbacks working", () => {
    const c = resolveProviderConfig({ OPENAI_API_KEY: "ok", OPENAI_BASE_URL: "https://oai/v1", OPENAI_MODEL: "gpt-x" });
    expect(c?.apiKey).toBe("ok");
    expect(c?.baseURL).toBe("https://oai/v1");
    expect(c?.model).toBe("gpt-x");
  });

  it("returns null without an API key (friendly path)", () => {
    expect(resolveProviderConfig({})).toBeNull();
    expect(resolveProviderConfig({}, { provider: "glm" })).toBeNull();
  });
});

describe("resolveProviderConfigResult — wudao requires a baseUrl", () => {
  it("fails with a reason when the wudao profile has no explicit baseUrl", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "wudao" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wudao provider needs WUDAO_BASE_URL");
  });

  it("also fails with a reason via WUDAO_PROVIDER=wudao without baseUrl", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "wudao" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wudao provider needs WUDAO_BASE_URL");
  });

  it("resolves wudao when WUDAO_BASE_URL is set", () => {
    const r = resolveProviderConfigResult(
      { WUDAO_API_KEY: "k", WUDAO_BASE_URL: "https://wudao.example/v1" },
      { provider: "wudao" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("wudao");
      expect(r.config.baseURL).toBe("https://wudao.example/v1");
      expect(r.config.model).toBe("wudao-preview");
    }
  });

  it("no-key failure carries a reason too", () => {
    const r = resolveProviderConfigResult({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no API key found");
  });
});

// M63 §B — the credentials-file fallback seam: env pool WINS; the file fills
// in only when no env key exists, keyed by the SELECTED provider.
describe("resolveProviderConfigResult credentials fallback (M63 §B)", () => {
  it("env wins: a set env key beats the credentials entry", () => {
    const r = resolveProviderConfigResult(
      { WUDAO_API_KEY: "env-key" },
      {},
      { deepseek: "file-key", glm: "glm-file" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.apiKey).toBe("env-key");
      expect(r.config.apiKeys).toEqual(["env-key"]);
    }
  });

  it("empty env pool falls back to the selected provider's file key", () => {
    const r = resolveProviderConfigResult({}, { provider: "glm" }, { deepseek: "file-key", glm: "glm-file" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.apiKey).toBe("glm-file");
      expect(r.config.provider).toBe("glm");
    }
  });

  it("the file's entry for a DIFFERENT provider does not leak in", () => {
    const r = resolveProviderConfigResult({}, { provider: "qwen" }, { deepseek: "file-key" });
    expect(r.ok).toBe(false);
  });

  it("a blank/whitespace file entry counts as no key", () => {
    const r = resolveProviderConfigResult({}, { provider: "deepseek" }, { deepseek: "   " });
    expect(r.ok).toBe(false);
  });

  it("absent map keeps the historical no-key failure", () => {
    expect(resolveProviderConfigResult({}).ok).toBe(false);
  });

  it("WUDAO_API_KEYS pool still beats the file (multi-key env wins)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEYS: "a,b" }, {}, { deepseek: "file" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.apiKeys).toEqual(["a", "b"]);
  });
});

// P0-4 (96 队列) — balanceUrl: the wallet-balance face's config leg. Only
// deepseek has a documented GET /user/balance endpoint; the rest stay
// undefined (graceful omission is the design, not a debt — Reasonix
// discipline). The fold mirrors bearerAuth: profile → config, and a user
// overlay/custom's explicit balanceUrl rides through.
describe("balanceUrl (P0-4 wallet face)", () => {
  it("only the deepseek builtin pins a balanceUrl; every other builtin stays undefined", () => {
    expect(PROVIDER_PROFILES.deepseek.balanceUrl).toBe("https://api.deepseek.com/user/balance");
    for (const [name, profile] of Object.entries(PROVIDER_PROFILES)) {
      if (name === "deepseek") continue;
      expect(profile.balanceUrl, name).toBeUndefined();
    }
  });

  it("resolution folds the profile's balanceUrl onto the config (deepseek), absent elsewhere", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.balanceUrl).toBe("https://api.deepseek.com/user/balance");
    const g = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "glm" });
    expect(g.ok).toBe(true);
    if (g.ok) expect("balanceUrl" in g.config).toBe(false);
  });

  it("a user overlay's explicit balanceUrl overrides the builtin (registry fold)", () => {
    const providers = effectiveProfiles(new Map([["deepseek", { balanceUrl: "https://gw.example/balance" }]]));
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, providers);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.balanceUrl).toBe("https://gw.example/balance");
  });

  it("a custom provider's explicit balanceUrl rides the effective profile", () => {
    const providers = effectiveProfiles(
      new Map([["acme", { baseUrl: "https://acme.example/v1", defaultModel: "acme-x", balanceUrl: "https://acme.example/balance" }]]),
    );
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "acme" }, undefined, providers);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.balanceUrl).toBe("https://acme.example/balance");
  });
});
