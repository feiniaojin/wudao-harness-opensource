// M63 §A — the provider switch: pure derivation (target config from the
// profile matrix, status dots, the provider_change entry), the cold-first-
// turn receipt stamp, and the driver's boundary semantics (idle → applied
// now; busy → queued for run settle; mid-stream → refused; missing key →
// clear error naming the fix). Byte-stability note: switching changes the
// request bytes legitimately (a new provider transform) — no prefix assert
// crosses a switch; the SAME-provider no-switch path stays pinned elsewhere
// (m55b: one client identity; det-06 canonical bytes).
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, createScriptedModel, createReadFileTool } from "@wudao/core";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage, SessionEntry, Tool } from "@wudao/core";
import { createCacheTrackingModel } from "../src/cache.js";
import { asMutableConfig } from "../src/commands/model.js";
import type { MutableProviderConfig } from "../src/commands/model.js";
import {
  validateProviderName,
  resolveProviderSwitch,
  applyProviderConfig,
  keyRefreshPending,
  configRefreshPending,
  recordProviderChange,
  providerRows,
  formatProviderList,
  envOnlyProviderResolver,
  PROVIDER_SWITCH_CACHE_NOTE,
  PROVIDER_SWITCH_COLD_ATTRIBUTION,
} from "../src/commands/provider.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { lastModelState, recordModelState } from "../src/run.js";
import { WIZARD_PLACEHOLDER_KEY } from "../src/credentials.js";
import { readNewestSessionSummary } from "../src/statusline.js";
import type { ProviderConfig } from "@wudao/providers";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// 封闭性(2026-08-29 夜闸全量红根因):本文件 resolveProviderSwitch 的
// env:{} 走 readGlobalSettingsSync({}) → globalSettingsPath 只看传入 env
// 对象的 key(空对象不回看 process.env)→ 真机 ~/.wudao。真家若存了
// model.defaultEffort(用户经 UI「设为默认推理档」写入,本机今天有了
// medium),S2 链第三级(settings global)就会送档,「无 binding/global ⇒
// reasoningEffort undefined」的断言在任何设过全局档的机器上必红——产品
// 链没错(env > binding > global 按设计),错在测试读真家。全文件的
// env:{} 统一换成 HERMETIC_ENV(空 tmp 家):第三级恒缺席,断言与机器
// 状态解耦;驱动器流也不再吸真家的 persona/权限等全局档。
const hermeticHome = mkdtempSync(join(tmpdir(), "m63-hermetic-"));
const HERMETIC_ENV: NodeJS.ProcessEnv = { WUDAO_GLOBAL_HOME: hermeticHome };
afterAll(async () => {
  await rm(hermeticHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// 回滚重做 T2d：会话 JSONL 由异步写入器落盘，provider_change/model_change
// 条目可能晚于 driver 可见状态（notices/builds/history 的 until 都不蕴含
// 「已写入」）——暖机盒全量第 4 轮 491/1101 两处 ENOENT 复现（solo 全绿，
// 前三轮全量也绿）。轮询至全部标记串出现再返回全文；条目真丢时轮询超时，
// 测试照红，断言不弱化。
async function readJsonlWhen(ws: string, sid: string, markers: readonly string[], timeoutMs = 5000): Promise<string> {
  const file = join(ws, ".wudao", "sessions", `${sid}.jsonl`);
  const start = Date.now();
  for (;;) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (markers.every((m) => content.includes(m))) return content;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for session JSONL ${sid} to contain ${JSON.stringify(markers)}`);
    }
    await wait(25);
  }
}

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "m63-prov-"));
}

const noticesOf = (driver: AgentDriver): string =>
  driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");

// A live deepseek config (the shape every frontend's live config has).
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
// Pure derivation
// ---------------------------------------------------------------------------

describe("resolveProviderSwitch — the target config", () => {
  it("derives the glm profile: endpoint + matrix from the TARGET profile, keys and prefs carried", () => {
    const r = resolveProviderSwitch({ target: "glm", env: HERMETIC_ENV, current: deepseekConfig() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.provider).toBe("glm");
    expect(r.config.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(r.config.model).toBe("glm-4.6");
    expect(r.config.apiKey).toBe("sk-live");
    // 推理档三级配置 S2 (spec 2026-08-28 §1): the switch re-derives effort
    // from the TARGET's chain (env pin > binding > global) — the sticky carry
    // of the old endpoint's value is gone. No glm binding/global here ⇒
    // nothing sent (the model default).
    expect(r.config.reasoningEffort).toBeUndefined();
    // The reasoning matrix is re-derived from the profile, not carried.
    expect(r.config.reasoningFormat).toBe("zai");
    expect(r.config.thinkingLevelMap).toEqual({ low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" });
    expect(r.config.supportsReasoningEffort).toBe(false);
    expect(r.config.acceptsReasoningOnlyFinish).toBe(true);
    // 夜移 022: the tool-turn omission fact follows the target profile too —
    // glm omits legitimately; a stale explicit true must not survive a
    // switch to deepseek (the in-place sync below relies on this field
    // being RE-DERIVED, exactly like acceptsReasoningOnlyFinish).
    expect(r.config.omitsReasoningOnToolTurns).toBe(true);
    // The M62 fallback chain is same-provider scoped — dropped, not carried.
    const withChain = resolveProviderSwitch({
      target: "glm",
      env: HERMETIC_ENV,
      current: deepseekConfig({ fallbackModels: ["deepseek-v4-pro"] }),
    });
    if (withChain.ok) expect(withChain.config.fallbackModels).toBeUndefined();
  });

  it("the env model override rides only its provider (the /model matrix rule)", () => {
    const env = { WUDAO_MODEL: "custom-x" } as NodeJS.ProcessEnv;
    const ds = resolveProviderSwitch({ target: "deepseek", env, current: deepseekConfig() });
    const glm = resolveProviderSwitch({ target: "glm", env, current: deepseekConfig() });
    if (ds.ok) expect(ds.config.model).toBe("custom-x");
    if (glm.ok) expect(glm.config.model).toBe("glm-4.6");
  });

  it("missing key: refused, naming the fix", () => {
    const r = resolveProviderSwitch({ target: "glm", env: HERMETIC_ENV, current: deepseekConfig({ apiKey: "", apiKeys: [] }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing-key");
      expect(r.error).toContain("no API key configured");
      expect(r.error).toContain("WUDAO_API_KEY");
    }
  });

  it("M63 §C credentials leg: a file key for the TARGET provider resolves when live+env are empty (wizard completion)", () => {
    // The exact shape the wizard leaves behind: a blank placeholder live
    // config, no env key, and a just-saved glm key in the credentials file.
    const r = resolveProviderSwitch({
      target: "glm",
      env: HERMETIC_ENV,
      current: deepseekConfig({ apiKey: "", apiKeys: [] }),
      credentials: { glm: "sk-wizard-saved" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("glm");
      expect(r.config.apiKey).toBe("sk-wizard-saved");
      expect(r.config.apiKeys).toEqual(["sk-wizard-saved"]);
    }
    // The sentinel variant of the same boot: the placeholder key reads as
    // ABSENT — the switch resolves the real file key, never carries it.
    const sentinel = resolveProviderSwitch({
      target: "glm",
      env: HERMETIC_ENV,
      current: deepseekConfig({ apiKey: WIZARD_PLACEHOLDER_KEY, apiKeys: undefined }),
      credentials: { glm: "sk-wizard-saved" },
    });
    expect(sentinel.ok).toBe(true);
    if (sentinel.ok) expect(sentinel.config.apiKey).toBe("sk-wizard-saved");
    // And with nothing real anywhere, the sentinel alone still refuses.
    const bare = resolveProviderSwitch({ target: "glm", env: HERMETIC_ENV, current: deepseekConfig({ apiKey: WIZARD_PLACEHOLDER_KEY, apiKeys: undefined }) });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toBe("missing-key");
  });

  it("M63 §C precedence (0.3.31b + 0.3.32c): same-provider keeps the pool unless the file key is NEW; cross-provider the TARGET's file key outranks the old pool", () => {
    // Same-provider, the file key already IN the pool (0.3.31b order): the
    // live pool IS the target's own authenticated key — rotation order
    // preserved, the file copy adds nothing.
    const live = resolveProviderSwitch({
      target: "deepseek",
      env: { WUDAO_API_KEY: "env-key" } as NodeJS.ProcessEnv,
      current: deepseekConfig({ apiKeys: ["sk-live", "file-key"] }),
      credentials: { deepseek: "file-key" },
    });
    if (live.ok) expect(live.config.apiKey).toBe("sk-live");
    // Same-provider, the file key NOT in the pool (0.3.32c refresh leg —
    // the kimi-401 trap): an explicit credentials snapshot carrying a key
    // the pool lacks is NEWER by construction (the settings page just
    // saved it); it outranks a pool the T0 cross-provider fallback may
    // have filled with the OLD provider's key. The 0.3.31b "stale file
    // key must not displace" case inverted HERE deliberately — with the
    // seams passing a snapshot on every resolve, pool-first would keep a
    // mislabeled borrow alive forever (401 on every retry).
    const refreshed = resolveProviderSwitch({
      target: "deepseek",
      env: { WUDAO_API_KEY: "env-key" } as NodeJS.ProcessEnv,
      current: deepseekConfig(),
      credentials: { deepseek: "file-key" },
    });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.config.apiKey).toBe("file-key");
      expect(refreshed.borrowedKeyPool).toBeUndefined(); // same-provider is never a borrow
    }
    // Same-provider with NO snapshot: the pool stands (the file legs are
    // opt-in — callers that never read the file see the old order).
    const noSnapshot = resolveProviderSwitch({ target: "deepseek", env: HERMETIC_ENV, current: deepseekConfig() });
    if (noSnapshot.ok) expect(noSnapshot.config.apiKey).toBe("sk-live");
    const envWins = resolveProviderSwitch({ target: "deepseek", env: { WUDAO_API_KEY: "env-key" } as NodeJS.ProcessEnv, current: deepseekConfig({ apiKey: "", apiKeys: [] }), credentials: { deepseek: "file-key" } });
    if (envWins.ok) expect(envWins.config.apiKey).toBe("env-key");
    // Cross-provider (the 0.3.31b kimi-404 fix): the boot provider's pool
    // key would be sent to a DIFFERENT endpoint — the target's own file key
    // outranks it when one exists, and the old live pool otherwise (the
    // one-gateway proxy pattern).
    const crossFile = resolveProviderSwitch({ target: "glm", env: { WUDAO_API_KEY: "env-key" } as NodeJS.ProcessEnv, current: deepseekConfig(), credentials: { glm: "file-key" } });
    if (crossFile.ok) expect(crossFile.config.apiKey).toBe("file-key");
    const crossPool = resolveProviderSwitch({ target: "glm", env: { WUDAO_API_KEY: "env-key" } as NodeJS.ProcessEnv, current: deepseekConfig(), credentials: { qwen: "q-key" } });
    expect(crossPool.ok).toBe(true);
    if (crossPool.ok) {
      expect(crossPool.config.apiKey).toBe("sk-live");
      // 0.3.32c: the borrow is FLAGGED — the landing notice names the 401
      // risk and the fix (see borrowedKeyPoolNote).
      expect(crossPool.borrowedKeyPool).toBe(true);
    }
    // A file key for a DIFFERENT provider does not leak onto the target.
    const other = resolveProviderSwitch({ target: "glm", env: HERMETIC_ENV, current: deepseekConfig({ apiKey: "", apiKeys: [] }), credentials: { qwen: "q-key" } });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("missing-key");
  });

  it("wudao without an endpoint: refused naming WUDAO_BASE_URL; the env override satisfies it", () => {
    const bare = resolveProviderSwitch({ target: "wudao", env: HERMETIC_ENV, current: deepseekConfig() });
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.reason).toBe("needs-endpoint");
      expect(bare.error).toContain("WUDAO_BASE_URL");
    }
    const withEnv = resolveProviderSwitch({
      target: "wudao",
      env: { WUDAO_BASE_URL: "https://wudao.internal/v1" } as NodeJS.ProcessEnv,
      current: deepseekConfig(),
    });
    expect(withEnv.ok).toBe(true);
    if (withEnv.ok) expect(withEnv.config.baseURL).toBe("https://wudao.internal/v1");
  });
});

// ω99-39 — the replay contract across a switch. Env is the only source of
// replay intent; the TARGET profile's probe-verified drop fact (deepseek:
// client-sent reasoning_content is uncounted and cache-inert) caps whatever
// would land on a drops-marked config. Fresh module registry per test so
// the once-per-process notice guard starts armed.
describe("resolveProviderSwitch — ω99-39 replay cap on the target config", () => {
  type ProviderModule = typeof import("../src/commands/provider.js");
  async function freshSwitch(): Promise<ProviderModule["resolveProviderSwitch"]> {
    vi.resetModules();
    return (await import("../src/commands/provider.js")).resolveProviderSwitch;
  }
  const glmLiveCarryingReplay = (): Parameters<ProviderModule["resolveProviderSwitch"]>[0]["current"] => ({
    apiKey: "sk-live",
    apiKeys: ["sk-live"],
    reasoningEffort: undefined,
    reasoningReplay: "toolCallTurns",
    provider: "glm",
    wire: undefined,
  });

  it("a carried toolCallTurns landing on deepseek is capped to never, with the one-line tell", async () => {
    const resolve = await freshSwitch();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = resolve({ target: "deepseek", env: HERMETIC_ENV, current: glmLiveCarryingReplay() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningReplay).toBe("never"); // the probe fact caps intent
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("WUDAO_REASONING_REPLAY"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deepseek");
    vi.restoreAllMocks();
  });

  it("env re-derivation: a capped deepseek boot's never does NOT erase replay intent on an unmarked target", async () => {
    const resolve = await freshSwitch();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The deepseek boot already capped its own config to "never"; the user's
    // env intent stays toolCallTurns. Switching to glm must restore it —
    // pre-ω99-39 the carry produced exactly these bytes on glm.
    const r = resolve({
      target: "glm",
      env: { ...HERMETIC_ENV, WUDAO_REASONING_REPLAY: "toolCallTurns" } as NodeJS.ProcessEnv,
      current: deepseekConfig({ reasoningReplay: "never" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningReplay).toBe("toolCallTurns");
    vi.restoreAllMocks();
  });

  it("no env, no carry: the field stays off the switched config", async () => {
    const resolve = await freshSwitch();
    const r = resolve({ target: "glm", env: HERMETIC_ENV, current: deepseekConfig() });
    expect(r.ok).toBe(true);
    if (r.ok) expect("reasoningReplay" in r.config).toBe(false);
  });
});

describe("applyProviderConfig — in-place sync for the live config holders", () => {
  it("syncs every field INCLUDING optional-field removal (a stale matrix would shape wrong bytes)", () => {
    const live: MutableProviderConfig = asMutableConfig(deepseekConfig({ fallbackModels: ["deepseek-v4-pro"] }));
    const glm = resolveProviderSwitch({ target: "glm", env: HERMETIC_ENV, current: live });
    if (!glm.ok) throw new Error("glm resolution failed");
    applyProviderConfig(live, glm.config);
    expect(live.provider).toBe("glm");
    expect(live.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(live.thinkingLevelMap).toBeDefined();
    expect(live.fallbackModels).toBeUndefined();
    // Back to deepseek: the glm-only matrix fields are REMOVED, not left stale.
    const back = resolveProviderSwitch({ target: "deepseek", env: HERMETIC_ENV, current: live });
    if (!back.ok) throw new Error("deepseek resolution failed");
    applyProviderConfig(live, back.config);
    expect(live.thinkingLevelMap).toBeUndefined();
    expect(live.supportsReasoningEffort).toBe(true); // profile sniff default
    // 夜移 022: the omission flag is re-derived per switch — a stale glm-era
    // `true` surviving onto deepseek would wrongly suppress the
    // missing-reasoning repair there (explicit beats profile in the helper).
    expect(live.omitsReasoningOnToolTurns).toBe(false);
  });
});

describe("validateProviderName + the bare listing", () => {
  it("accepts the matrix names (case-folded); unknown lists them", () => {
    expect(validateProviderName(" GLM ")).toEqual({ ok: true, name: "glm" });
    const bad = validateProviderName("grok");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("unknown provider \"grok\"");
      expect(bad.error).toContain("deepseek, glm, qwen, wudao");
    }
  });

  it("providerRows: configured dots with a key; missing-key and needs-endpoint dots otherwise", () => {
    const withKey = providerRows({}, (name) => resolveProviderSwitch({ target: name, env: HERMETIC_ENV, current: deepseekConfig() }));
    expect(withKey.map((r) => `${r.name}:${r.dot}`)).toEqual([
      "deepseek:configured",
      "glm:configured",
      "qwen:configured",
      "wudao:needs-endpoint",
      "anthropic:configured", // 0.3.12: the messages-wire builtin rides the same dot row
      "kimi:configured", // 0.3.30: 按量平台 API — 与 *-code 订阅网关成对
      "minimax:configured",
      "glm-code:configured", // 0.3.26: the coding-plan gateways ride the same row
      "kimi-code:configured",
      "minimax-code:configured",
    ]);
    const keyless = providerRows({}, envOnlyProviderResolver({}));
    expect(keyless.every((r) => r.dot !== "configured")).toBe(true);
    expect(keyless[0]?.detail).toContain("WUDAO_API_KEY");
  });

  it("formatProviderList: dots, the current marker, and the colder-than-model hint", () => {
    const rows = providerRows({}, (name) => resolveProviderSwitch({ target: name, env: HERMETIC_ENV, current: deepseekConfig() }));
    const text = formatProviderList(rows, "deepseek");
    expect(text).toContain("● deepseek · deepseek-v4-flash  ← current");
    expect(text).toContain("● glm · glm-4.6");
    expect(text).toContain("○ wudao · wudao-preview  (the wudao profile has no default endpoint — set WUDAO_BASE_URL");
    expect(text).toContain("colder than a model switch");
  });
});

describe("recordProviderChange — the session entry", () => {
  it("appends a provider_change entry that survives a store round-trip", async () => {
    const ws = await tmpWs();
    try {
      await recordProviderChange({ workspaceRoot: ws, sessionId: "swprov1", to: "glm", model: "glm-4.6", from: "deepseek", now: new Date("2026-08-19T00:00:00Z") });
      const entries = await createJsonlSessionStore(join(ws, ".wudao", "sessions")).loadSessionEntries("swprov1");
      const change = entries.find((e) => "type" in e && e.type === "provider_change");
      expect(change).toEqual({
        type: "provider_change",
        provider: "glm",
        model: "glm-4.6",
        from: "deepseek",
        at: "2026-08-19T00:00:00.000Z",
      });
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the cache note says the WHOLE history is reprocessed — colder than a model switch", () => {
    expect(PROVIDER_SWITCH_CACHE_NOTE).toContain("全部历史"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉：note 常量值钉）
    expect(PROVIDER_SWITCH_CACHE_NOTE).toContain("比切模型更冷"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉：note 常量值钉）
  });
});

// ---------------------------------------------------------------------------
// The cold-first-turn receipt
// ---------------------------------------------------------------------------

// A model that reports usage once per call (scripted models never do).
function usageModel(answer: string): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(input: ModelInput): Promise<AgentMessage> {
      calls += 1;
      input.onUsage?.({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100 });
      return { role: "assistant", content: answer };
    },
  };
}

describe("coldFirstTurnAttribution — the turn_usage receipt stamp", () => {
  it("stamps the FIRST usage only; later turns are clean", async () => {
    const seen: ModelUsage[] = [];
    const wrapped = createCacheTrackingModel(usageModel("a"), {
      onUsage: (u) => seen.push(u),
      coldFirstTurnAttribution: PROVIDER_SWITCH_COLD_ATTRIBUTION,
    });
    const input: ModelInput = { systemPrompt: "s", messages: [], tools: [] };
    await wrapped.generate(input);
    await wrapped.generate(input);
    expect(seen[0]?.coldTurnExpected).toBe(true);
    expect(seen[0]?.cacheBreakAttribution).toBe(PROVIDER_SWITCH_COLD_ATTRIBUTION);
    expect(seen[1]?.coldTurnExpected).toBeUndefined();
    expect(seen[1]?.cacheBreakAttribution).toBeUndefined();
  });

  it("the attribution says the full history was reprocessed", () => {
    expect(PROVIDER_SWITCH_COLD_ATTRIBUTION).toContain("provider switched");
    expect(PROVIDER_SWITCH_COLD_ATTRIBUTION).toContain("full history reprocessed");
  });
});

// ---------------------------------------------------------------------------
// Driver — the boundary semantics
// ---------------------------------------------------------------------------

function makeDriver(model: ModelClient, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
    ...opts,
  });
}

// The frontend seam the tests stand in for: resolve from the module's pure
// derivation (a controlled env — never the machine's), build from a passed-in
// ModelClient so the assertions see exactly what the next run uses.
function seamFor(current: ProviderConfig, buildClient: (config: ProviderConfig) => ModelClient, log: { resolve: string[]; builds: string[] }) {
  return {
    resolve: (target: import("@wudao/providers").ProviderName) => {
      log.resolve.push(target);
      return resolveProviderSwitch({ target, env: HERMETIC_ENV, current });
    },
    build: (config: ProviderConfig) => {
      log.builds.push(`${config.provider}/${config.model}`);
      return buildClient(config);
    },
  };
}

describe("driver /provider — switch at a turn boundary", () => {
  it("idle: client rebuilt + swapped, profile used, entry written, receipt annotated, status live", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      const received: ModelUsage[] = [];
      let replacement: ModelClient | null = null;
      const driver = makeDriver(createScriptedModel([{ role: "assistant", content: "before" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-1",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: seamFor(
          deepseekConfig(),
          (config) => {
            expect(config.provider).toBe("glm"); // the profile the switch lands on
            replacement = createCacheTrackingModel(usageModel("glm-answer"), {
              onUsage: (u) => received.push(u),
              coldFirstTurnAttribution: PROVIDER_SWITCH_COLD_ATTRIBUTION,
            });
            return replacement;
          },
          log,
        ),
      });
      driver.submit("/provider glm");
      await until(() => log.builds.length === 1, "build called");
      expect(log.resolve).toEqual(["glm"]);
      // The receipt: applied + the colder-than-model cache note.
      expect(noticesOf(driver)).toContain("供应商 → glm (glm-4.6) —— 已记录（provider_change 条目）并应用"); // ω99-166f-ii: 钉随源演进
      expect(noticesOf(driver)).toContain(PROVIDER_SWITCH_CACHE_NOTE);
      // The session log: a provider_change entry naming both sides.
      const jsonl = await readJsonlWhen(ws, "wudao-prov-1", ['"type":"provider_change"', '"provider":"glm"']);
      expect(jsonl).toContain("\"type\":\"provider_change\"");
      expect(jsonl).toContain("\"provider\":\"glm\"");
      expect(jsonl).toContain("\"from\":\"deepseek\"");
      // The picker/status identity moved (the web StatusBar + TUI model segment).
      expect(driver.getStatus().model?.provider).toBe("glm");
      expect(driver.getStatus().model?.label).toBe("glm-4.6");
      // The statusline snapshot follows the live overlay (M57 provider field).
      const line = driver.snapshotForStatusline();
      expect(line.model).toContain("glm-4.6");
      expect(line.provider).toBe("glm");
      // The NEXT run reads the replacement client — and its FIRST usage
      // receipt carries the cold-turn pair.
      driver.submit("hello");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "glm-answer"), "new client answered");
      expect(received[0]?.coldTurnExpected).toBe(true);
      expect(received[0]?.cacheBreakAttribution).toBe(PROVIDER_SWITCH_COLD_ATTRIBUTION);
      expect(received[1]).toBeUndefined(); // one call, one receipt
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("busy: queued for the run's settle — build deferred, entry recorded, next run carries it", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      let releaseTool: (() => void) | undefined;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () => new Promise((resolve) => {
          releaseTool = () => resolve({ content: "released" });
        }),
      };
      const first = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] },
        { role: "assistant", content: "settled" },
      ]);
      const replacement = usageModel("post-switch");
      const driver = makeDriver(first, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-2",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        tools: [gateTool],
        onPermissionAsk: async () => ({ kind: "allow" }),
        onProviderSwitch: seamFor(deepseekConfig(), () => replacement, log),
      });
      driver.submit("use the gate");
      await until(() => releaseTool !== undefined, "tool in flight (busy, not streaming)");
      // While the run is in flight (tool phase — between model calls) the
      // switch QUEUES: resolved now, built (and recorded) at the settle.
      driver.submit("/provider qwen");
      await until(() => log.resolve.length === 1, "resolve ran up front");
      expect(noticesOf(driver)).toContain("供应商 → qwen (qwen3-max) —— 已排队；有运行在飞，切换在其收束时构建、落地并记录条目（下一轮界）"); // ω99-166f-ii: 钉随源演进
      expect(log.builds.length).toBe(0); // deferred — the run is still on deepseek
      // LOW 2: the entry writes only after a successful build — nothing in
      // the JSONL yet, even though the switch is queued.
      const jsonlEarly = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-2.jsonl"), "utf8").catch(() => "");
      expect(jsonlEarly).not.toContain("provider_change");
      releaseTool?.();
      await until(() => log.builds.length === 1, "build at run settle");
      expect(log.builds[0]).toBe("qwen/qwen3-max");
      expect(noticesOf(driver)).toContain("供应商切换已在运行收束时落地——下一轮的请求走 qwen/qwen3-max"); // ω99-166f-ii: 钉随源演进
      // The entry lands with the build (async write — poll it in).
      let jsonlLate = "";
      for (let i = 0; i < 200 && !jsonlLate.includes("provider_change"); i += 1) {
        jsonlLate = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-2.jsonl"), "utf8").catch(() => "");
        if (!jsonlLate.includes("provider_change")) await wait();
      }
      expect(jsonlLate).toContain("\"type\":\"provider_change\"");
      expect(jsonlLate).toContain("\"from\":\"deepseek\"");
      expect(driver.getStatus().model?.provider).toBe("qwen");
      // The next run uses the replacement.
      driver.submit("again");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "post-switch"), "replacement answered");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("mid-stream: refused outright — nothing queued, nothing recorded", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      let releaseModel: (() => void) | undefined;
      let entered = false;
      const streaming: ModelClient = {
        async generate(): Promise<AgentMessage> {
          entered = true;
          await new Promise<void>((resolve) => {
            releaseModel = resolve;
          });
          return { role: "assistant", content: "late" };
        },
      };
      const driver = makeDriver(streaming, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-3",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: seamFor(deepseekConfig(), () => usageModel("never"), log),
      });
      driver.submit("hold");
      await until(() => entered, "model call in flight");
      await wait(); // let the driver consume model_call_started
      driver.submit("/provider glm");
      await wait();
      expect(noticesOf(driver)).toContain("运行中无法 /provider");
      expect(log.resolve.length).toBe(0);
      expect(log.builds.length).toBe(0);
      const jsonl = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-3.jsonl"), "utf8").catch(() => "");
      expect(jsonl).not.toContain("provider_change");
      releaseModel?.();
      await until(() => driver.getStatus().busy === false, "run settled");
      // The refusal left no park: the model identity never moved.
      expect(driver.getStatus().model?.provider).toBe("deepseek");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("missing key: refused with the fix named; unknown profile lists the matrix; same-provider is a no-op", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      const keyless = deepseekConfig({ apiKey: "", apiKeys: [] });
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-4",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: seamFor(keyless, () => usageModel("never"), log),
      });
      driver.submit("/provider glm");
      await until(() => log.resolve.length === 1, "resolve ran");
      expect(noticesOf(driver)).toContain("拒绝切换到 provider glm：no API key configured"); // ω99-166c-iii: #10 钉演进（孪生归一）
      expect(noticesOf(driver)).toContain("WUDAO_API_KEY");
      expect(log.builds.length).toBe(0);
      driver.submit("/provider grok");
      await wait();
      expect(noticesOf(driver)).toContain("unknown provider \"grok\"");
      expect(noticesOf(driver)).toContain("deepseek, glm, qwen, wudao");
      driver.submit("/provider deepseek");
      await wait();
      expect(noticesOf(driver)).toContain("（已在 deepseek 上"); // ω99-166f-ii: 钉随源演进
      const jsonl = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-4.jsonl"), "utf8").catch(() => "");
      expect(jsonl).not.toContain("provider_change");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("bare /provider lists the matrix (structure + legend; the unavailable note without a seam)", async () => {
    const ws = await tmpWs();
    try {
      const noSeam = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-5",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
      });
      noSeam.submit("/provider");
      await wait();
      const text = noticesOf(noSeam);
      expect(text).toContain("供应商（profile 矩阵；/provider <名称> 在下一轮边界切换）：");
      expect(text).toContain("deepseek · deepseek-v4-flash  ← current");
      expect(text).toContain("glm · glm-4.6");
      expect(text).toContain("qwen · qwen3-max");
      expect(text).toContain("wudao · wudao-preview");
      expect(text).toContain("● ready to switch · ○ not configured");
      expect(text).toContain("switching unavailable in this frontend");
      // And with a seam, switching answers unavailable without one is moot —
      // the seam path itself is covered above; here the no-seam switch says so.
      noSeam.submit("/provider glm");
      await wait();
      expect(noticesOf(noSeam)).toContain("（此前端不支持切换供应商"); // ω99-166f-ii: 钉随源演进
      noSeam.dispose();

      const withSeam = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-6",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: seamFor(deepseekConfig(), () => usageModel("x"), { resolve: [], builds: [] }),
      });
      withSeam.submit("/provider");
      await wait();
      const seamText = noticesOf(withSeam);
      expect(seamText).toContain("● glm · glm-4.6");
      expect(seamText).not.toContain("switching unavailable");
      withSeam.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("dual switch: /provider lands first, then /model switches WITHIN the new provider", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      const switches: string[] = [];
      const matrix = [
        { provider: "deepseek" as const, model: "deepseek-v4-flash", source: "profile" as const },
        { provider: "glm" as const, model: "glm-4.6", source: "profile" as const },
        { provider: "glm" as const, model: "glm-4.7-air", source: "env" as const },
      ];
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-7",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        availableModels: matrix,
        onModelSwitch: (sel) => switches.push(JSON.stringify(sel)),
        onProviderSwitch: seamFor(deepseekConfig(), () => usageModel("glm"), log),
      });
      driver.submit("/provider glm");
      await until(() => log.builds.length === 1, "provider landed");
      expect(driver.getStatus().model?.label).toBe("glm-4.6");
      // The /model lane now switches WITHIN glm (the current provider moved).
      driver.submit("/model glm-4.7-air");
      await until(() => switches.length === 1, "model switch fired");
      expect(switches[0]).toContain("glm-4.7-air");
      expect(driver.getStatus().model?.label).toBe("glm-4.7-air");
      expect(driver.getStatus().model?.provider).toBe("glm");
      // Both entries are in the JSONL. Their RELATIVE order is not an
      // invariant: both records are fire-and-forget appends through
      // independent write paths (submit is a sync API), and the
      // model_change entry itself carries the provider field — replay is
      // self-consistent in either order. Assert presence, not row order.
      const jsonl = await readJsonlWhen(ws, "wudao-prov-7", ['"type":"provider_change"', '"type":"model_change"']);
      expect(jsonl.indexOf("\"type\":\"provider_change\"")).toBeGreaterThanOrEqual(0);
      expect(jsonl.indexOf("\"type\":\"model_change\"")).toBeGreaterThanOrEqual(0);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no switch → no rebuild: the same client serves every run (the unchanged byte-stability posture)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    const driver = makeDriver(model, { sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" } });
    driver.submit("first");
    await until(() => driver.getStatus().busy === false, "run 1");
    driver.submit("second");
    await until(() => driver.getStatus().busy === false, "run 2");
    expect(model.calls).toBe(2); // ONE client identity across runs — a provider switch is what rebuilds
    expect(driver.getStatus().model?.provider).toBe("deepseek");
    driver.dispose();
  });

  // -------------------------------------------------------------------------
  // Review round — LOW 1: the untested park boundaries.
  // -------------------------------------------------------------------------

  it("review L1a: a second switch while one is parked → last-wins; only the LANDING switch records an entry", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      let releaseTool: (() => void) | undefined;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () => new Promise((resolve) => {
          releaseTool = () => resolve({ content: "released" });
        }),
      };
      const first = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] },
        { role: "assistant", content: "settled" },
      ]);
      const replacement = usageModel("post-switch");
      const driver = makeDriver(first, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-8",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        tools: [gateTool],
        onPermissionAsk: async () => ({ kind: "allow" }),
        onProviderSwitch: seamFor(deepseekConfig(), () => replacement, log),
      });
      driver.submit("run");
      await until(() => releaseTool !== undefined, "tool in flight");
      driver.submit("/provider glm");
      await until(() => log.resolve.length === 1, "first queued");
      driver.submit("/provider qwen");
      await until(() => log.resolve.length === 2, "second queued");
      // The supersede is VISIBLE — the dropped switch never builds, never records.
      expect(noticesOf(driver)).toContain("（取代排队的到 glm 的切换——它永不构建，也不记录任何条目）"); // ω99-166f-ii: 钉随源演进
      releaseTool?.();
      await until(() => log.builds.length === 1, "build at settle");
      expect(log.builds[0]).toBe("qwen/qwen3-max"); // last-wins
      expect(driver.getStatus().model?.provider).toBe("qwen");
      let jsonl = "";
      for (let i = 0; i < 200 && !jsonl.includes("provider_change"); i += 1) {
        jsonl = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-8.jsonl"), "utf8").catch(() => "");
        if (!jsonl.includes("provider_change")) await wait();
      }
      expect(jsonl).toContain("\"provider\":\"qwen\"");
      // Exactly ONE provider_change — the landing switch's (LOW 2 makes the
      // superseded park write nothing: it never happened).
      expect(jsonl.split("\"type\":\"provider_change\"").length - 1).toBe(1);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("review L1b: an ABORTED run still lands its parked switch at settle (pendingModelApply symmetry)", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      let releaseTool: (() => void) | undefined;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () => new Promise((resolve) => {
          releaseTool = () => resolve({ content: "released" });
        }),
      };
      const first = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] },
        { role: "assistant", content: "settled" },
      ]);
      const replacement = usageModel("post-switch");
      const driver = makeDriver(first, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-9",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        tools: [gateTool],
        onPermissionAsk: async () => ({ kind: "allow" }),
        onProviderSwitch: seamFor(deepseekConfig(), () => replacement, log),
      });
      driver.submit("run");
      await until(() => releaseTool !== undefined, "tool in flight");
      driver.submit("/provider glm");
      await until(() => log.resolve.length === 1, "switch parked");
      expect(log.builds.length).toBe(0);
      driver.interrupt(); // the run aborts with the switch still parked
      await until(() => driver.getStatus().busy === false, "aborted run settled");
      // The queued switch SURVIVES the abort and lands at the aborted run's
      // settle — deliberate symmetry with a parked /model switch.
      await until(() => log.builds.length === 1, "switch landed despite the abort");
      expect(noticesOf(driver)).toContain("供应商切换已在运行收束时落地——下一轮的请求走 glm/glm-4.6"); // ω99-166f-ii: 钉随源演进
      expect(driver.getStatus().model?.provider).toBe("glm");
      // And the next (post-abort) run reads the replacement client.
      driver.submit("next");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "post-switch"), "replacement answered after the abort");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("review L1c: a prompt queued while a switch is parked lands on the NEW client", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      let releaseTool: (() => void) | undefined;
      let releaseSecond: (() => void) | undefined;
      let secondEntered = false;
      let call = 0;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () => new Promise((resolve) => {
          releaseTool = () => resolve({ content: "released" });
        }),
      };
      const twoPhase: ModelClient = {
        async generate(): Promise<AgentMessage> {
          call += 1;
          if (call === 1) return { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] };
          secondEntered = true;
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
          return { role: "assistant", content: "settled" };
        },
      };
      const replacement = usageModel("post-switch");
      const driver = makeDriver(twoPhase, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-10",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        tools: [gateTool],
        onPermissionAsk: async () => ({ kind: "allow" }),
        onProviderSwitch: seamFor(deepseekConfig(), () => replacement, log),
      });
      driver.submit("run");
      await until(() => releaseTool !== undefined, "tool in flight");
      driver.submit("/provider glm"); // parked
      await until(() => log.resolve.length === 1, "switch parked");
      releaseTool?.();
      await until(() => secondEntered, "second model call in flight (past the final steering drain)");
      // A prompt submitted AFTER the run's final drain parks in the steering
      // queue and auto-starts at run end — AFTER the switch lands.
      driver.submit("late prompt");
      releaseSecond?.();
      await until(() => log.builds.length === 1, "switch landed at settle");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "post-switch"), "queued prompt answered by the NEW client");
      expect(driver.getStatus().model?.provider).toBe("glm");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // -------------------------------------------------------------------------
  // Review round — LOW 2: a build that throws records NO entry.
  // -------------------------------------------------------------------------

  it("review L2: a throwing build records no entry — idle and at a parked settle — and the session keeps the old provider", async () => {
    const ws = await tmpWs();
    try {
      const log = { resolve: [] as string[], builds: [] as string[] };
      const throwing = seamFor(deepseekConfig(), () => {
        throw new Error("construction boom");
      }, log);
      // Idle: the switch is attempted immediately.
      const idle = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-prov-11",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: throwing,
      });
      idle.submit("/provider glm");
      await until(() => log.builds.length === 1, "idle build attempted");
      expect(noticesOf(idle)).toContain("⚠️ provider 切换到 glm 失败：construction boom——会话仍留在 deepseek（未记录切换）"); // ω99-166c-i: #4 整句钉随改。
      expect(idle.getStatus().model?.provider).toBe("deepseek");
      const idleJsonl = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-11.jsonl"), "utf8").catch(() => "");
      expect(idleJsonl).not.toContain("provider_change");
      idle.dispose();

      // Parked: the build throws at the run's settle.
      const log2 = { resolve: [] as string[], builds: [] as string[] };
      let releaseTool: (() => void) | undefined;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () => new Promise((resolve) => {
          releaseTool = () => resolve({ content: "released" });
        }),
      };
      const first = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] },
        { role: "assistant", content: "settled" },
      ]);
      const parked = makeDriver(first, {
        workspaceRoot: ws,
        sessionId: "wudao-prov-12",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        tools: [gateTool],
        onPermissionAsk: async () => ({ kind: "allow" }),
        onProviderSwitch: seamFor(deepseekConfig(), () => {
          throw new Error("settle boom");
        }, log2),
      });
      parked.submit("run");
      await until(() => releaseTool !== undefined, "tool in flight");
      parked.submit("/provider glm");
      await until(() => log2.resolve.length === 1, "parked");
      releaseTool?.();
      await until(() => log2.builds.length === 1, "build attempted at settle");
      expect(noticesOf(parked)).toContain("⚠️ provider 切换到 glm 失败：settle boom——会话仍留在 deepseek（未记录切换）"); // ω99-166c-iii: #3 钉演进（孪生归一）
      expect(parked.getStatus().model?.provider).toBe("deepseek");
      const parkedJsonl = await readFile(join(ws, ".wudao", "sessions", "wudao-prov-12.jsonl"), "utf8").catch(() => "");
      expect(parkedJsonl).not.toContain("provider_change");
      parked.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Review round — MEDIUM: the provider_change entry folds on the RESUME side.
// ---------------------------------------------------------------------------

describe("review M — provider_change folds into the resumed model state", () => {
  const postSwitchEntries: readonly SessionEntry[] = [
    { role: "user", content: "hi" },
    { type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-08-19T00:00:00.000Z" },
    { role: "assistant", content: "answer" },
    { type: "provider_change", provider: "glm", model: "glm-4.6", from: "deepseek", at: "2026-08-19T01:00:00.000Z" },
  ];

  it("lastModelState folds provider_change (model + provider both move)", () => {
    expect(lastModelState(postSwitchEntries)).toEqual({ model: "glm-4.6", provider: "glm" });
    // Counterfactual pin: without the provider_change branch the fold returns
    // the PRE-switch state — exactly the stale read the review flagged.
    expect(lastModelState(postSwitchEntries.filter((e) => !("type" in e && e.type === "provider_change")))).toEqual({
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
  });

  it("a session ending in a provider switch writes NO spurious model_change at the next boundary", async () => {
    const last = lastModelState(postSwitchEntries);
    expect(last).toEqual({ model: "glm-4.6", provider: "glm" });
    const written: string[] = [];
    await recordModelState(
      { appendEntry: async (_id, entry) => { written.push(JSON.stringify(entry)); } },
      "s",
      { apiKey: "k", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6", provider: "glm" },
      last,
    );
    expect(written).toEqual([]); // nothing diverges — no spurious model_change
  });

  it("readNewestSessionSummary (statusline / session-list seam) shows the POST-switch identity", async () => {
    const ws = await tmpWs();
    try {
      const dir = join(ws, ".wudao", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "latest.jsonl"),
        [
          JSON.stringify({ role: "user", content: "hi" }),
          JSON.stringify({ type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-08-19T00:00:00.000Z" }),
          JSON.stringify({ type: "provider_change", provider: "glm", model: "glm-4.6", from: "deepseek", at: "2026-08-19T01:00:00.000Z" }),
        ].join("\n") + "\n",
        "utf8",
      );
      const summary = await readNewestSessionSummary(ws, "fallback");
      expect(summary.model).toBe("glm-4.6");
      expect(summary.provider).toBe("glm");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// M63 §C review round — the wizard placeholder's two driver contracts:
//   HIGH  a same-name /provider on the placeholder is a REAL switch (the
//         just-saved key rebuilds the live client; the no-op early-return
//         would ship the sentinel key into the first request → raw 401);
//   MEDIUM a prompt run on the placeholder is refused with the wizard
//         pointer (browse-only) — never a raw 401 from the endpoint.
// ---------------------------------------------------------------------------

/** The session-engine seam's shape, closed over a MUTABLE live config: the
 *  credentials-file fallback leg + the placeholder marker. */
function wizardSeam(
  live: { current: MutableProviderConfig },
  credentials: Record<string, string>,
  log: { resolve: string[]; builds: string[] },
) {
  return {
    resolve: (target: import("@wudao/providers").ProviderName) => {
      log.resolve.push(target);
      let r = resolveProviderSwitch({ target, env: HERMETIC_ENV, current: live.current });
      if (!r.ok && r.reason === "missing-key") {
        r = resolveProviderSwitch({ target, env: HERMETIC_ENV, current: live.current, credentials });
      }
      return r;
    },
    build: (config: ProviderConfig) => {
      log.builds.push(`${config.provider}/${config.apiKey}`);
      applyProviderConfig(live.current, config);
      return usageModel("WIZARD-LIVE-OK");
    },
    isPlaceholderLive: () => live.current.apiKey === WIZARD_PLACEHOLDER_KEY,
  };
}

describe("driver /provider — the wizard placeholder (M63 §C review round)", () => {
  it("HIGH: same-name switch on the placeholder resolves+rebuilds with the just-saved key; the first prompt runs on it", async () => {
    const ws = await tmpWs();
    try {
      // The no-key boot's exact live shape: the selected provider with the
      // sentinel key (deepseek placeholder), and a deepseek key the wizard
      // just saved to the credentials file.
      const live = {
        current: asMutableConfig({
          apiKey: WIZARD_PLACEHOLDER_KEY,
          baseURL: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          provider: "deepseek",
        }),
      };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const replacement = usageModel("WIZARD-LIVE-OK");
      const driver = makeDriver(createScriptedModel([{ role: "assistant", content: "should never serve" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-wiz-1",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: {
          ...wizardSeam(live, { deepseek: "sk-wizard-ds" }, log),
          build: (config: ProviderConfig) => {
            log.builds.push(`${config.provider}/${config.apiKey}`);
            applyProviderConfig(live.current, config);
            return replacement;
          },
        },
      });
      driver.submit("/provider deepseek");
      await until(() => log.builds.length === 1, "the same-name switch builds");
      // The rebuild carried the SAVED key — not the sentinel.
      expect(log.builds[0]).toBe(`deepseek/sk-wizard-ds`);
      expect(noticesOf(driver)).toContain("供应商 → deepseek (deepseek-v4-flash) —— 已记录（provider_change 条目）并应用"); // ω99-166f-ii: 钉随源演进
      // The entry names the placeholder→real transition.
      const jsonl = await readJsonlWhen(ws, "wudao-wiz-1", ['"type":"provider_change"']);
      expect(jsonl).toContain("\"type\":\"provider_change\"");
      // The first prompt runs on the REBUILT client (the placeholder's
      // seeded model never fires).
      driver.submit("hello after the wizard");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "WIZARD-LIVE-OK"), "run served by the rebuilt client");
      expect(replacement.calls).toBe(1);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("HIGH companion: a same-name switch on a REAL key stays the no-op (batch A's pinned behavior unchanged)", async () => {
    const ws = await tmpWs();
    try {
      const live = { current: asMutableConfig(deepseekConfig()) };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const driver = makeDriver(createScriptedModel([{ role: "assistant", content: "x" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-wiz-2",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: wizardSeam(live, {}, log),
      });
      driver.submit("/provider deepseek");
      await until(() => noticesOf(driver).includes("（已在 deepseek 上"), "no-op notice"); // ω99-166f-ii: 钉随源演进
      expect(log.builds).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("MEDIUM: a prompt on the placeholder is refused with the wizard pointer — no model call, no state change", async () => {
    const ws = await tmpWs();
    try {
      const live = {
        current: asMutableConfig({
          apiKey: WIZARD_PLACEHOLDER_KEY,
          baseURL: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          provider: "deepseek",
        }),
      };
      const seeded = usageModel("must-not-serve");
      const driver = makeDriver(seeded, {
        workspaceRoot: ws,
        sessionId: "wudao-wiz-3",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: wizardSeam(live, {}, { resolve: [], builds: [] }),
      });
      driver.submit("hello there");
      // A plain prompt rides the async mention-expansion seam before
      // submitCore — the refusal entry lands a tick later.
      await until(() => driver.getHistory().some((e) => e.kind === "error"), "the refusal entry");
      const errors = driver.getHistory().filter((e) => e.kind === "error");
      expect(errors.length).toBe(1);
      expect(errors[0]?.text).toContain("只读浏览模式");
      expect(errors[0]?.text).toContain("去配置");
      expect(seeded.calls).toBe(0); // nothing reached a provider
      expect(driver.getStatus().busy).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// 0.3.32c kimi-401 — the key-save hot refresh
// ---------------------------------------------------------------------------
describe("0.3.32c kimi-401 — the same-name key refresh (a settings key save)", () => {
  it("the user's exact sequence: T0 cross switch borrows the pool (warned); the key save + same-name /provider rebuilds on the SAVED key, model kept", async () => {
    // A fresh hermetic home (settings reads) + a hand-built matrix riding the
    // driver's availableModels TEST SEAM (availableModels(env) reads the
    // registry through the process-default path — a per-test home is
    // invisible to it; the file's 封闭性 rule). Two kimi models so the
    // "model kept" leg is observable (the builtin matrix has only k3-256k —
    // the default and the /model pick would be identical).
    const home = mkdtempSync(join(tmpdir(), "m63-refresh-"));
    const env: NodeJS.ProcessEnv = { WUDAO_GLOBAL_HOME: home };
    const matrix = [
      { provider: "kimi-code", model: "k3-256k", source: "profile" as const },
      { provider: "kimi-code", model: "kimi-for-coding", source: "registry" as const },
    ];
    const ws = await tmpWs();
    try {
      // The boot shape: a deepseek live config (a workspace .env pin) — the
      // T0 fallback borrows its key across the kimi endpoint.
      const live = { current: asMutableConfig(deepseekConfig()) };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const credentials: Record<string, string> = {}; // grows when "settings" saves
      const replacement = usageModel("KIMI-REFRESH-OK");
      const driver = makeDriver(createScriptedModel([{ role: "assistant", content: "seed" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-refresh-1",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        // Hermetic matrix for the driver's own /model + preserve checks.
        availableModels: matrix,
        onProviderSwitch: {
          // The 0.3.32c seam contract: the credentials snapshot rides EVERY
          // resolve (the file legs are dead code on a retry-only lane).
          resolve: (target) => {
            log.resolve.push(target);
            return resolveProviderSwitch({ target, env, current: live.current, credentials });
          },
          build: (config) => {
            log.builds.push(`${config.provider}/${config.model}/${config.apiKey}`);
            applyProviderConfig(live.current, config);
            return replacement;
          },
          keyRefreshPending: () => keyRefreshPending(live.current, credentials),
        },
      });
      // T0 — switch to kimi-code with NO kimi key anywhere: the pool is
      // borrowed (the deepseek key rides to api.kimi.com — the 401 trap) and
      // the landing notice names the risk + the fix.
      driver.submit("/provider kimi-code");
      await until(() => log.builds.length === 1, "T0 switch builds");
      expect(log.builds[0]).toBe("kimi-code/k3-256k/sk-live");
      expect(noticesOf(driver)).toContain("⚠️ 没有 kimi-code 的独立密钥");
      // The user picks the second model before hitting the 401s (the seeded
      // client never serves again after the rebuild — elided).
      driver.submit("/model kimi-for-coding");
      await until(() => driver.getStatus().model?.label === "kimi-for-coding", "the model pick lands");
      // T1 — the settings page saves a kimi key; the hot-refresh submits the
      // same-name /provider. It is a REAL switch now: rebuilt on the SAVED
      // key, the /model pick KEPT (the resolve's default would reset it).
      credentials["kimi-code"] = "sk-kimi-saved";
      driver.submit("/provider kimi-code");
      await until(() => log.builds.length === 2, "the refresh switch builds");
      expect(log.builds[1]).toBe("kimi-code/kimi-for-coding/sk-kimi-saved");
      expect(noticesOf(driver)).toContain("供应商 → kimi-code (kimi-for-coding) —— 已记录（provider_change 条目）并应用"); // ω99-166f-ii: 钉随源演进
      // The next prompt runs on the refreshed client — the saved key is the
      // one the rebuilt pool carries.
      driver.submit("hello after the save");
      await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "KIMI-REFRESH-OK"), "run served by the refreshed client");
      expect(replacement.calls).toBe(1);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("companion: a same-name /provider with the file key already in the pool stays the no-op", async () => {
    const ws = await tmpWs();
    try {
      const live = { current: asMutableConfig(deepseekConfig()) };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const credentials = { deepseek: "sk-live" }; // already one of the pool
      const driver = makeDriver(createScriptedModel([{ role: "assistant", content: "x" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-refresh-2",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onProviderSwitch: {
          resolve: (target) => {
            log.resolve.push(target);
            return resolveProviderSwitch({ target, env: HERMETIC_ENV, current: live.current, credentials });
          },
          keyRefreshPending: () => keyRefreshPending(live.current, credentials),
        },
      });
      driver.submit("/provider deepseek");
      await until(() => noticesOf(driver).includes("（已在 deepseek 上"), "no-op notice"); // ω99-166f-ii: 钉随源演进
      expect(log.builds).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("0.3.32d the mid-stream race: the settings save's refresh PARKS instead of being refused — lands at settle (the kimi-401 second layer)", async () => {
    // The user's exact trap (0.3.33, session a3f99de9): the 401 retry is
    // STREAMING on the borrowed key when the settings save submits the
    // same-name refresh — the mid-stream guard refused it (one-shot, dropped
    // forever), every later prompt kept the stale pool. The refresh is
    // settings-originated and endpoint-PRESERVING: it must ride the busy-park
    // and land at the run's settle, while a REAL cross-provider switch stays
    // refused mid-stream (pinned by the wudao-prov-3 test above).
    const home = mkdtempSync(join(tmpdir(), "m63-midstream-"));
    const env: NodeJS.ProcessEnv = { WUDAO_GLOBAL_HOME: home };
    const matrix = [
      { provider: "kimi-code", model: "k3-256k", source: "profile" as const },
      { provider: "kimi-code", model: "kimi-for-coding", source: "registry" as const },
    ];
    const ws = await tmpWs();
    try {
      const live = { current: asMutableConfig(deepseekConfig()) };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const credentials: Record<string, string> = {};
      let entered = false;
      let releaseModel: (() => void) | undefined;
      const streaming: ModelClient = {
        async generate(): Promise<AgentMessage> {
          entered = true;
          await new Promise<void>((resolve) => {
            releaseModel = resolve;
          });
          return { role: "assistant", content: "streaming-done" };
        },
      };
      const replacement = usageModel("KIMI-MIDSTREAM-OK");
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-midstream-1",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        availableModels: matrix,
        onProviderSwitch: {
          resolve: (target) => {
            log.resolve.push(target);
            return resolveProviderSwitch({ target, env, current: live.current, credentials });
          },
          // The borrowed build (T0) hands back the STREAMING client the retry
          // hangs in; the refresh build (saved key) hands the replacement.
          build: (config) => {
            log.builds.push(`${config.provider}/${config.model}/${config.apiKey}`);
            applyProviderConfig(live.current, config);
            return config.apiKey === "sk-kimi-saved" ? replacement : streaming;
          },
          keyRefreshPending: () => keyRefreshPending(live.current, credentials),
        },
      });
      // T0 — the borrow switch (idle): live becomes kimi-code riding the
      // deepseek pool.
      driver.submit("/provider kimi-code");
      await until(() => log.builds.length === 1, "T0 switch builds");
      expect(log.builds[0]).toBe("kimi-code/k3-256k/sk-live");
      // The user's retry streams on the borrowed key…
      driver.submit("你好 retry");
      await until(() => entered, "the retry's model call is streaming");
      await wait(); // let the driver consume model_call_started
      // …and the settings save lands mid-stream: the refresh must PARK.
      credentials["kimi-code"] = "sk-kimi-saved";
      driver.submit("/provider kimi-code");
      await wait();
      expect(noticesOf(driver)).not.toContain("⚠️ 运行中无法 /provider（任务进行中）");
      expect(noticesOf(driver)).toContain("供应商 → kimi-code (k3-256k) —— 已排队"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉：k3-256k 款排队前缀）
      // The streaming call settles (its 401 lands) — the parked refresh
      // builds on the SAVED key and records its entry.
      releaseModel?.();
      await until(() => log.builds.length === 2, "the parked refresh lands at settle");
      expect(log.builds[1]).toBe("kimi-code/k3-256k/sk-kimi-saved");
      expect(noticesOf(driver)).toContain("供应商切换已在运行收束时落地"); // ω99-166f-ii: 钉随源演进
      // The next prompt runs on the saved key's client.
      driver.submit("hello after settle");
      await until(
        () => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "KIMI-MIDSTREAM-OK"),
        "run served by the refreshed client",
      );
      const jsonl = await readJsonlWhen(ws, "wudao-midstream-1", ['"type":"provider_change"', '"provider":"kimi-code"']);
      expect(jsonl).toContain("\"type\":\"provider_change\"");
      expect(jsonl).toContain("\"provider\":\"kimi-code\"");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("config-drift leg: a same-name refresh driven by an ENDPOINT change (baseUrl drift, keys untouched) also parks mid-stream and lands at settle", async () => {
    // The settings row save lane (baseUrl/wire rewrite in the provider's
    // registry row) is NOT a key save — the pool is untouched, so
    // keyRefreshPending stays false throughout. The refresh trigger is
    // configRefreshPending: a fresh resolve of the live provider would change
    // the connection. Same carve-out, same park-at-settle discipline.
    const home = mkdtempSync(join(tmpdir(), "m63-cfgdrift-"));
    const env: NodeJS.ProcessEnv = { WUDAO_GLOBAL_HOME: home };
    const matrix = [
      { provider: "kimi-code", model: "k3-256k", source: "profile" as const },
      { provider: "kimi-code", model: "kimi-for-coding", source: "registry" as const },
    ];
    const ws = await tmpWs();
    try {
      const live = { current: asMutableConfig(deepseekConfig()) };
      const log = { resolve: [] as string[], builds: [] as string[] };
      const credentials: Record<string, string> = {};
      // The registry row's endpoint: api.kimi.com/coding until the settings
      // save rewrites it to the relay.
      const RELAY = "https://relay.example/v1";
      let registeredBase: string | undefined;
      let entered = false;
      let releaseModel: (() => void) | undefined;
      const streaming: ModelClient = {
        async generate(): Promise<AgentMessage> {
          entered = true;
          await new Promise<void>((resolve) => {
            releaseModel = resolve;
          });
          return { role: "assistant", content: "streaming-done" };
        },
      };
      const replacement = usageModel("KIMI-CFGDRIFT-OK");
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-cfgdrift-1",
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        availableModels: matrix,
        onProviderSwitch: {
          resolve: (target) => {
            log.resolve.push(target);
            const r = resolveProviderSwitch({ target, env, current: live.current, credentials });
            if (!r.ok || registeredBase === undefined) return r;
            return { ...r, config: { ...r.config, baseURL: registeredBase } };
          },
          // Mirror the session-engine seam: pending = a fresh resolve would
          // change the connection (baseUrl/wire), compared via the shared
          // helper. Keys never drift in this test.
          configRefreshPending: () => {
            const r = resolveProviderSwitch({ target: live.current.provider ?? "kimi-code", env, current: live.current, credentials });
            return configRefreshPending(live.current, r.ok ? (registeredBase === undefined ? r.config : { ...r.config, baseURL: registeredBase }) : undefined);
          },
          keyRefreshPending: () => keyRefreshPending(live.current, credentials),
          build: (config) => {
            log.builds.push(`${config.provider}/${config.model}/${config.baseURL}`);
            applyProviderConfig(live.current, config);
            return config.baseURL === RELAY ? replacement : streaming;
          },
        },
      });
      // T0 — the borrow switch (idle): live becomes kimi-code on the default
      // endpoint with the borrowed pool. No drift yet.
      driver.submit("/provider kimi-code");
      await until(() => log.builds.length === 1, "T0 switch builds");
      expect(log.builds[0]).toBe("kimi-code/k3-256k/https://api.kimi.com/coding");
      expect(driver.keyRefreshPending()).toBe(false);
      // A prompt streams on the default endpoint…
      driver.submit("你好 retry");
      await until(() => entered, "the retry's model call is streaming");
      await wait();
      // …and the settings row save rewrites the endpoint mid-stream. The
      // same-name refresh is endpoint-CHANGING but settings-originated: park,
      // don't refuse.
      registeredBase = RELAY;
      driver.submit("/provider kimi-code");
      await wait();
      expect(noticesOf(driver)).not.toContain("⚠️ 运行中无法 /provider（任务进行中）");
      expect(noticesOf(driver)).toContain("供应商 → kimi-code (k3-256k) —— 已排队"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉：k3-256k 款排队前缀）
      // The streaming call settles — the parked refresh rebuilds on the NEW
      // endpoint and records its entry.
      releaseModel?.();
      await until(() => log.builds.length === 2, "the parked config refresh lands at settle");
      expect(log.builds[1]).toBe("kimi-code/k3-256k/https://relay.example/v1");
      expect(noticesOf(driver)).toContain("供应商切换已在运行收束时落地"); // ω99-166f-ii: 钉随源演进
      // The next prompt runs on the new endpoint's client.
      driver.submit("hello after settle");
      await until(
        () => driver.getHistory().some((e) => e.kind === "assistant" && e.text === "KIMI-CFGDRIFT-OK"),
        "run served by the re-endpointed client",
      );
      const jsonl = await readJsonlWhen(ws, "wudao-cfgdrift-1", ['"type":"provider_change"']);
      expect(jsonl).toContain("\"type\":\"provider_change\"");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
