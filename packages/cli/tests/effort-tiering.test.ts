// 推理档三级配置 S2 — the READ chain (spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md §1):
// the registry's THREE-STATE effort binding (absent = follow global; string =
// bound level; null = explicit don't-send), the pure chain fold
// (pin > binding > global > model default), the boot fold, the
// provider-switch RE-DERIVATION (effort no longer sticks across endpoints —
// the spec's intentional behavior change) plus the driver's modelLive reset,
// and the settings-matrix column the web detail card seeds from.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createReadFileTool } from "@wudao/core";
import type { ModelClient, ProviderConfig } from "@wudao/core";
import { foldEffortChain } from "../src/commands/model.js";
import { resolveProviderSwitch } from "../src/commands/provider.js";
import { readProviderEffortBinding } from "../src/driver/provider-registry-ops.js";
import { buildProviderMatrix } from "../src/driver/settings-ops.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { saveGlobalSettings } from "../src/settings-layer.js";
import { buildUiBootPlan } from "../src/run.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  home = mkdtempSync(join(tmpdir(), "wudao-effort-s2-"));
  process.env.WUDAO_GLOBAL_HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });
const registryPath = (): string => join(home, "providers.json");

/** Write a fresh registry and drop the memo — each test starts from its own
 *  file (and NO settings.json: a prior test's saved global defaultEffort must
 *  not leak into the next test's chain fold). */
function seedRegistry(providers: Record<string, unknown>): void {
  writeFileSync(registryPath(), JSON.stringify({ version: 1, providers }, null, 2), "utf8");
  rmSync(join(home, "settings.json"), { force: true });
  resetProviderRegistryCacheForTests();
}

/** A live deepseek config (the shape every frontend's live config has). */
function deepseekConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    apiKey: "sk-live",
    apiKeys: ["sk-live"],
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    reasoningEffort: "high",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The pure chain fold
// ---------------------------------------------------------------------------

describe("foldEffortChain — pin > binding > global > model default", () => {
  it("the pin (flag/env) outranks both tiers", () => {
    expect(foldEffortChain("low", "high", "max")).toBe("low");
  });
  it("a bound level beats the global default", () => {
    expect(foldEffortChain(undefined, "high", "max")).toBe("high");
  });
  it("binding null BLOCKS the global — explicit don't-send, not follow", () => {
    expect(foldEffortChain(undefined, null, "max")).toBeUndefined();
  });
  it("binding absent falls to the global", () => {
    expect(foldEffortChain(undefined, undefined, "max")).toBe("max");
  });
  it("everything absent = the model default (send nothing)", () => {
    expect(foldEffortChain(undefined, undefined, undefined)).toBeUndefined();
    expect(foldEffortChain("", "high", "max")).toBe("high"); // blank pin is no pin
  });
});

// ---------------------------------------------------------------------------
// The binding read
// ---------------------------------------------------------------------------

describe("readProviderEffortBinding — the three-state registry column", () => {
  it("bound level / key-absent / explicit null / unknown id / junk row (validated view)", () => {
    seedRegistry({
      ds: { baseUrl: "https://a.test", defaultModel: "m", effort: "high" },
      bare: { baseUrl: "https://b.test", defaultModel: "m" },
      off: { baseUrl: "https://c.test", defaultModel: "m", effort: null },
      junk: { baseUrl: "https://d.test", defaultModel: "m", effort: "ultra" },
    });
    expect(readProviderEffortBinding("ds", env())).toBe("high");
    expect(readProviderEffortBinding("bare", env())).toBeUndefined();
    expect(readProviderEffortBinding("off", env())).toBeNull();
    expect(readProviderEffortBinding("nobody", env())).toBeUndefined();
    // A junk effort REFUSED the row at load (fail-visible) — it can never
    // masquerade as a state here.
    expect(readProviderEffortBinding("junk", env())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The boot fold — binding ?? global under the unpinned guard
// ---------------------------------------------------------------------------

describe("buildUiBootPlan — the effort binding tier", () => {
  it("a binding on the boot provider beats the stored global default", () => {
    seedRegistry({ deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", effort: "low" } });
    const p = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }), storedModelDefaults: { effort: "max" } });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.reasoningEffort).toBe("low");
  });

  it("binding absent → the global applies (the r6 quickwin unchanged)", () => {
    seedRegistry({});
    const p = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }), storedModelDefaults: { effort: "max" } });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.reasoningEffort).toBe("max");
  });

  it("binding null → nothing sent even with a global default", () => {
    seedRegistry({ deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", effort: null } });
    const p = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }), storedModelDefaults: { effort: "max" } });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.reasoningEffort).toBeUndefined();
  });

  it("the flag and env pins still beat the binding", () => {
    seedRegistry({ deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", effort: "high" } });
    const byFlag = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }), reasoningEffort: "low" });
    if (byFlag.kind !== "real") throw new Error("expected real");
    expect(byFlag.config.reasoningEffort).toBe("low");
    const byEnv = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k", WUDAO_REASONING_EFFORT: "medium" }) });
    if (byEnv.kind !== "real") throw new Error("expected real");
    expect(byEnv.config.reasoningEffort).toBe("medium");
  });

  it("a binding applies even with NO stored defaults (every boot, not just the ui pick path)", () => {
    seedRegistry({ deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", effort: "high" } });
    const p = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }) });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.reasoningEffort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// The provider switch — re-derive from the TARGET's chain, carry dies
// ---------------------------------------------------------------------------

describe("resolveProviderSwitch — effort re-derivation (the sticky carry dies)", () => {
  it("no binding, no global → the carried effort is DROPPED (model default)", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({ target: "glm", env: env(), current: deepseekConfig() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningEffort).toBeUndefined();
  });

  it("the target's binding wins; the global fills when it is absent; null blocks it", async () => {
    seedRegistry({ glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", effort: "low" } });
    const bound = resolveProviderSwitch({ target: "glm", env: env(), current: deepseekConfig() });
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.config.reasoningEffort).toBe("low");

    seedRegistry({});
    await saveGlobalSettings({ model: { defaultEffort: "max" } }, env());
    const byGlobal = resolveProviderSwitch({ target: "glm", env: env(), current: deepseekConfig() });
    if (!byGlobal.ok) throw new Error(byGlobal.error);
    expect(byGlobal.config.reasoningEffort).toBe("max");

    seedRegistry({ glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", effort: null } });
    const blocked = resolveProviderSwitch({ target: "glm", env: env(), current: deepseekConfig() });
    if (!blocked.ok) throw new Error(blocked.error);
    expect(blocked.config.reasoningEffort).toBeUndefined();
  });

  it("the env pin survives the switch (process-level, above every tier)", () => {
    seedRegistry({ glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", effort: "low" } });
    const r = resolveProviderSwitch({ target: "glm", env: env({ WUDAO_REASONING_EFFORT: "medium" }), current: deepseekConfig() });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.reasoningEffort).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// resolveProviderSwitch — wire re-derivation (0.3.31 kimi-400 弧)
// The switch used to carry current.wire unchanged ("wire is orthogonal").
// Since 0.3.30's plan-gateway split the builtin profiles PIN their wire
// (kimi-code = anthropic), and the boot chain folds selection > env >
// profile — the switch was missing the profile leg BOTH ways: deepseek
// (wire unset) → kimi-code sent openai-shaped bytes to the anthropic
// endpoint, and kimi-code (anthropic fold) → deepseek carried the fold
// into an openai endpoint. Provenance rule: a current.wire that EQUALS
// the old profile's pin is a fold (drops); one that differs is a genuine
// user selection (carries).
// ---------------------------------------------------------------------------

describe("resolveProviderSwitch — wire re-derivation (0.3.31)", () => {
  it("deepseek (wire unset) → kimi-code: the TARGET profile's anthropic pin lands", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({ target: "kimi-code", env: env(), current: deepseekConfig() });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.wire).toBe("anthropic");
  });

  it("kimi-code (anthropic fold) → deepseek: the OLD profile's fold drops — no anthropic bytes to the openai endpoint", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({
      target: "deepseek",
      env: env(),
      current: deepseekConfig({ provider: "kimi-code", wire: "anthropic", baseURL: "https://api.kimi.com/coding", model: "k3-256k" }),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.wire).toBeUndefined();
  });

  it("a genuine user wire (≠ the old profile's pin) carries across the switch", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({ target: "glm", env: env(), current: deepseekConfig({ wire: "responses" }) });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.wire).toBe("responses");
  });

  it("env WUDAO_WIRE fills when no selection is known, and the selection outranks it", () => {
    seedRegistry({});
    const byEnv = resolveProviderSwitch({ target: "deepseek", env: env({ WUDAO_WIRE: "responses" }), current: deepseekConfig() });
    if (!byEnv.ok) throw new Error(byEnv.error);
    expect(byEnv.config.wire).toBe("responses");

    const userWins = resolveProviderSwitch({
      target: "glm",
      env: env({ WUDAO_WIRE: "responses" }),
      current: deepseekConfig({ wire: "anthropic" }),
    });
    if (!userWins.ok) throw new Error(userWins.error);
    expect(userWins.config.wire).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// resolveProviderSwitch — endpoint & key re-derivation (0.3.31b kimi-404)
// 用户报告:0.3.31 上切 k3-256k 后 run 404。根因(端到端核实):桌面端
// 工作区 .env 钉了 WUDAO_BASE_URL=api.deepseek.com,而 switch 的 baseURL
// 腿 env 优先于目标 profile → 端点没搬家;再叠 0.3.31 修对的 anthropic
// wire → api.deepseek.com/v1/messages + k3-256k → 404。同理钥匙腿 live
// pool 优先,把 boot 供应商的钥匙发给新端点(端点修对也会 401)。
// 修:profile 自带 defaultBaseUrl = 目标端点真相,switch 时压过进程级
// env 钉(boot 保持 env 优先——restart 是显式尊重 env 的行为,不对称是
// 刻意的);跨供应商切换时目标的凭证文件钥匙优先于 live pool。
// ---------------------------------------------------------------------------

describe("resolveProviderSwitch — endpoint & key re-derivation (0.3.31b kimi-404)", () => {
  it("the 404 repro: a .env-pinned deepseek boot switches to kimi-code — the TARGET profile's endpoint + the TARGET's file key land", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({
      target: "kimi-code",
      env: env({ WUDAO_BASE_URL: "https://api.deepseek.com", WUDAO_API_KEY: "sk-live", WUDAO_MODEL: "deepseek-v4-flash" }),
      current: deepseekConfig(),
      credentials: { "kimi-code": "sk-kimi" },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.baseURL).toBe("https://api.kimi.com/coding");
    expect(r.config.apiKey).toBe("sk-kimi");
    expect(r.config.wire).toBe("anthropic");
    expect(r.config.model).toBe("k3-256k");
  });

  it("env base still serves a target with NO profile default (wudao must be configured)", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({
      target: "wudao",
      env: env({ WUDAO_BASE_URL: "https://proxy.example/v1" }),
      current: deepseekConfig(),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.baseURL).toBe("https://proxy.example/v1");
  });

  it("an overlay's requiresBaseUrl still refuses the builtin default, and env still satisfies it", () => {
    seedRegistry({ deepseek: { requiresBaseUrl: true } });
    const refused = resolveProviderSwitch({
      target: "deepseek",
      env: env(),
      current: deepseekConfig(),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("needs-endpoint");

    const byEnv = resolveProviderSwitch({
      target: "deepseek",
      env: env({ WUDAO_BASE_URL: "https://proxy.example/v1" }),
      current: deepseekConfig(),
    });
    if (!byEnv.ok) throw new Error(byEnv.error);
    expect(byEnv.config.baseURL).toBe("https://proxy.example/v1");
  });

  it("same-provider keeps the pool when the file key is IN it; a pool-lacking file key WINS (0.3.32c refresh — the kimi-401 trap)", () => {
    seedRegistry({});
    // File key already one of the pool: rotation order preserved (0.3.31b
    // order — the authenticated keys are the target's own).
    const inPool = resolveProviderSwitch({
      target: "kimi-code",
      env: env(),
      current: deepseekConfig({ provider: "kimi-code", baseURL: "https://api.kimi.com/coding", model: "k3-256k", wire: "anthropic", apiKeys: ["sk-live", "sk-stale-file"] }),
      credentials: { "kimi-code": "sk-stale-file" },
    });
    if (!inPool.ok) throw new Error(inPool.error);
    expect(inPool.config.apiKey).toBe("sk-live");
    // File key NOT in the pool (0.3.32c inversion, deliberate): an explicit
    // credentials snapshot carrying a key the pool lacks is NEWER by
    // construction (the settings page just saved it) — it outranks a pool
    // the T0 cross-provider fallback may have filled with the OLD
    // provider's key. Pool-first kept a mislabeled borrow alive forever
    // (401 on every retry after the save — the reported bug).
    const refreshed = resolveProviderSwitch({
      target: "kimi-code",
      env: env(),
      current: deepseekConfig({ provider: "kimi-code", baseURL: "https://api.kimi.com/coding", model: "k3-256k", wire: "anthropic" }),
      credentials: { "kimi-code": "sk-stale-file" },
    });
    if (!refreshed.ok) throw new Error(refreshed.error);
    expect(refreshed.config.apiKey).toBe("sk-stale-file");
    expect(refreshed.borrowedKeyPool).toBeUndefined(); // same-provider is never a borrow
    // No snapshot: the pool stands (the file legs are opt-in).
    const noSnapshot = resolveProviderSwitch({
      target: "kimi-code",
      env: env(),
      current: deepseekConfig({ provider: "kimi-code", baseURL: "https://api.kimi.com/coding", model: "k3-256k", wire: "anthropic" }),
    });
    if (!noSnapshot.ok) throw new Error(noSnapshot.error);
    expect(noSnapshot.config.apiKey).toBe("sk-live");
  });

  it("cross-provider with no target file key keeps the live pool (the one-gateway proxy pattern)", () => {
    seedRegistry({});
    const r = resolveProviderSwitch({
      target: "glm",
      env: env(),
      current: deepseekConfig(),
      credentials: {},
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.apiKey).toBe("sk-live");
  });
});

// ---------------------------------------------------------------------------
// The driver reset — modelLive.effort mirrors the new chain after a switch
// ---------------------------------------------------------------------------

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const noticesOf = (driver: AgentDriver): string =>
  driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");

function makeDriver(model: ModelClient, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
    ...opts,
  });
}

describe("driver /provider — the effort reset lands with the switch", () => {
  it("a /effort session override is RESET to the target's binding-chain value; the notice says so", async () => {
    seedRegistry({ glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", effort: "low" } });
    const log: string[] = [];
    const driver = makeDriver(createScriptedModel([]), {
      workspaceRoot: home,
      sessionId: "wudao-effort-reset-1",
      sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
      onProviderSwitch: {
        resolve: (target) => resolveProviderSwitch({ target, env: env(), current: deepseekConfig() }),
        build: (config) => {
          log.push(`${config.provider}/${config.reasoningEffort ?? "-"}`);
          return createScriptedModel([]);
        },
      },
    });
    driver.submit("/effort max");
    await wait();
    driver.submit("/provider glm");
    await until(() => log.length === 1, "the switch builds");
    // The rebuilt client's config already carries the re-derived chain…
    expect(log[0]).toBe("glm/low");
    // …and the notice names the intentional reset (spec §1: 切换后 /effort 覆盖失效重置).
    expect(noticesOf(driver)).toContain("effort max → low");
    // The session overlay now mirrors the new chain — bare /effort marks low current.
    driver.submit("/effort");
    await wait();
    expect(noticesOf(driver)).toContain("low  ← current");
  });

  it("an empty target chain resets the override to send-nothing (off), not the stale session value", async () => {
    seedRegistry({});
    const log: string[] = [];
    const driver = makeDriver(createScriptedModel([]), {
      workspaceRoot: home,
      sessionId: "wudao-effort-reset-2",
      sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
      onProviderSwitch: {
        resolve: (target) => resolveProviderSwitch({ target, env: env(), current: deepseekConfig() }),
        build: (config) => {
          log.push(config.reasoningEffort ?? "-");
          return createScriptedModel([]);
        },
      },
    });
    driver.submit("/effort max");
    await wait();
    driver.submit("/provider glm");
    await until(() => log.length === 1, "the switch builds");
    expect(log[0]).toBe("-");
    expect(noticesOf(driver)).toContain("effort max → off");
    // No current marker anywhere (the "off" state has no level to mark).
    driver.submit("/effort");
    await wait();
    expect(noticesOf(driver)).not.toContain("← current");
  });
});

// ---------------------------------------------------------------------------
// The settings matrix — the three-state column the detail card seeds from
// ---------------------------------------------------------------------------

describe("buildProviderMatrix — the effort column", () => {
  it("emits the binding ONLY when the registry row carries the key (null is a VALUE)", () => {
    seedRegistry({
      "eff-bound": { baseUrl: "https://a.test", defaultModel: "m", effort: "high" },
      "eff-bare": { baseUrl: "https://b.test", defaultModel: "m" },
      "eff-off": { baseUrl: "https://c.test", defaultModel: "m", effort: null },
    });
    const cards = buildProviderMatrix(env(), {});
    const by = (id: string) => cards.find((c) => c.provider === id);
    expect(by("eff-bound")?.effort).toBe("high");
    expect("effort" in (by("eff-bare") ?? {})).toBe(false);
    expect(by("eff-off")?.effort).toBeNull();
  });
});
