// M63 §B — the CLI-side settings handler: the provider-card matrix, the
// save path (0600 + status-only reply), the test-connection classifier and
// its three human failure states (mocked fetch), and the settingsSet
// allowlist writing the GLOBAL tier.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderMatrix,
  classifyTestResponse,
  createSettingsOps,
  envSelectedProvider,
  readGlobalDefaultPersonaId,
  readStoredModelDefaults,
  settingsReadiness,
  withSettingsOps,
} from "../src/driver/settings-ops.js";
import { globalSettingsPath } from "../src/settings-layer.js";
import { credentialsFilePath, readCredentialsFileSync } from "../src/credentials.js";
// 0.3.32c kimi-401 — the key-save hot-refresh wrapper test's seam mirrors
// session-engine's (snapshot on every resolve + keyRefreshPending).
import { resolveProviderSwitch, applyProviderConfig, keyRefreshPending, configRefreshPending } from "../src/commands/provider.js";
import { asMutableConfig } from "../src/commands/model.js";
import { createProviderRegistryOps } from "../src/driver/provider-registry-ops.js";
import { buildTool, createScriptedModel } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wudao-setops-home-"));
  root = mkdtempSync(join(tmpdir(), "wudao-setops-root-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A fetch double: (status, body) or a reject for transport failures. */
function fakeFetch(script: { status?: number; body?: string; reject?: Error }[]): typeof fetch {
  let i = 0;
  return (async (_url: unknown, _init?: unknown) => {
    const s = script[Math.min(i++, script.length - 1)];
    if (s === undefined) throw new Error("no more scripted responses");
    if (s.reject !== undefined) throw s.reject;
    return new Response(s.body ?? "", { status: s.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("buildProviderMatrix (the status dots' source)", () => {
  it("full matrix: env key marks the SELECTED provider ready; others key off the file", () => {
    const matrix = buildProviderMatrix(
      env({ WUDAO_API_KEY: "env-key", WUDAO_PROVIDER: "glm" }),
      { deepseek: "file-key" },
    );
    expect(matrix.map((c) => c.provider)).toEqual(["deepseek", "glm", "qwen", "wudao", "anthropic", "kimi", "minimax", "glm-code", "kimi-code", "minimax-code"]);
    const deepseek = matrix[0];
    const glm = matrix[1];
    const qwen = matrix[2];
    const wudao = matrix[3];
    const anthropic = matrix[4];
    if (deepseek === undefined || glm === undefined || qwen === undefined || wudao === undefined || anthropic === undefined) throw new Error("matrix incomplete");
    // deepseek: no env attribution (glm is selected) but a file key + profile
    // endpoint → ready via credentials.
    expect(deepseek).toMatchObject({ status: "ready", keySource: "credentials", endpoint: "https://api.deepseek.com" });
    // glm: the env pool keys the selected provider → ready via env.
    expect(glm).toMatchObject({ status: "ready", keySource: "env" });
    // qwen: no key anywhere → missing-key (profile endpoint exists).
    expect(qwen).toMatchObject({ status: "missing-key", keySource: null });
    // wudao: no key AND no baseUrl — missing-key wins as the primary blocker.
    expect(wudao).toMatchObject({ status: "missing-key", endpoint: null });
    // anthropic (0.3.12): no key anywhere → missing-key, profile endpoint set.
    expect(anthropic).toMatchObject({ status: "missing-key", keySource: null, endpoint: "https://api.anthropic.com" });
    // 0.3.13 (#215): the wire column rides the card — anthropic's compiled-in
    // pin shows; the openai-compatible builtins stay wire-less (absent).
    expect(anthropic.wire).toBe("anthropic");
    expect(deepseek?.wire).toBeUndefined();
    // 0.3.26: the coding-plan gateways ride the same matrix (anthropic wire +
    // their coding-plan endpoints; keyless here → missing-key like anthropic).
    const glmCode = matrix.find((c) => c.provider === "glm-code");
    expect(glmCode).toMatchObject({ status: "missing-key", keySource: null, endpoint: "https://open.bigmodel.cn/api/anthropic", wire: "anthropic" });
  });

  it("wudao with a key but no endpoint → missing-endpoint; the env base override applies to the selected provider", () => {
    const matrix = buildProviderMatrix(
      env({ WUDAO_PROVIDER: "wudao", WUDAO_BASE_URL: "https://gw.example/v1" }),
      { wudao: "file-key" },
    );
    expect(matrix[3]).toMatchObject({ status: "ready", keySource: "credentials", endpoint: "https://gw.example/v1" });
    // ...and without the override the same file key cannot reach ready.
    const noUrl = buildProviderMatrix(env({ WUDAO_PROVIDER: "wudao" }), { wudao: "file-key" });
    expect(noUrl[3]).toMatchObject({ status: "missing-endpoint" });
  });

  it("envSelectedProvider defaults to deepseek and validates", () => {
    expect(envSelectedProvider(env())).toBe("deepseek");
    expect(envSelectedProvider(env({ WUDAO_PROVIDER: "qwen" }))).toBe("qwen");
    expect(envSelectedProvider(env({ WUDAO_PROVIDER: "bogus" }))).toBe("deepseek");
  });

  // 用户反馈 2026-08-29 ①:「上下文窗口是空的,继承供应商默认 —— 那默认是
  // 多少?」An empty per-model window resolves through the SAME chain the
  // runtime uses (model ctx → defaultContextLength → WUDAO_CONTEXT_WINDOW →
  // 64000), and the card must carry that tail so the edit form's 继承 hint
  // shows the number the row would actually get.
  it("windowFallback rides every effective-profile card: the env tail (builtins), the provider default when set (用户反馈 2026-08-29 ①)", async () => {
    const matrix = buildProviderMatrix(env({ WUDAO_CONTEXT_WINDOW: "128000" }), {});
    const deepseek = matrix[0];
    if (deepseek === undefined) throw new Error("deepseek card missing");
    // No registry overlay → the env tail is what an empty window inherits.
    expect(deepseek.windowFallback).toBe(128000);
    // No env pin → the compiled default. 用户反馈 2026-08-29:64k 是上个世纪
    // 的——多数模型 200k、不少 1M;未知模型(无 per-model 无 provider 默认)
    // 的兜底从 64000 提到 200000。
    const plain = buildProviderMatrix(env(), {});
    expect(plain[0]?.windowFallback).toBe(200000);
    // A registry custom WITH defaultContextLength: the fallback IS the
    // provider default (the resolution chain's middle step wins).
    // buildProviderMatrix's effective view reads process.env's registry
    // home — the seeded home must be THE process home (the persona-suite
    // pattern; fresh home ⇒ fresh memo key ⇒ no staleness).
    const saved = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
      const save = await regOps.settingsSaveProvider("acme", {
        baseUrl: "https://acme.test/v1",
        defaultModel: "acme-one",
        defaultContextLength: 200000,
        models: [{ name: "acme-one" }],
      });
      expect(save.ok).toBe(true);
      const withCustom = buildProviderMatrix(env({ WUDAO_CONTEXT_WINDOW: "128000" }), {});
      const acme = withCustom.find((c) => c.provider === "acme");
      if (acme === undefined) throw new Error("acme card missing");
      expect(acme.defaultContextLength).toBe(200000);
      expect(acme.windowFallback).toBe(200000); // the provider default wins the tail
    } finally {
      if (saved === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = saved;
    }
  });

  it("0.3.28 ②: registeredBaseUrl — absent on plain builtins, the RAW overlay value once written", async () => {
    // No overlay: a plain builtin carries NO registeredBaseUrl (absence IS
    // the no-overlay state — the builtin edit form seeds empty = compiled
    // default); baseUrl stays the effective/compiled base.
    const plain = buildProviderMatrix(env(), {});
    const glmPlain = plain.find((c) => c.provider === "glm");
    if (glmPlain === undefined) throw new Error("glm card missing");
    expect("registeredBaseUrl" in glmPlain).toBe(false);
    expect(glmPlain.baseUrl).toBeDefined();
    // An overlay with a baseUrl on a BUILTIN id (the ② feature): both the
    // raw overlay (registeredBaseUrl — the edit form's seed) and the
    // effective merge (baseUrl) surface on the card.
    const saved = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
      const save = await regOps.settingsSaveProvider("deepseek", {
        baseUrl: "https://mirror.test/v1",
        models: [{ name: "deepseek-chat" }],
      });
      expect(save.ok).toBe(true);
      const withOverlay = buildProviderMatrix(env(), {});
      const ds = withOverlay.find((c) => c.provider === "deepseek");
      if (ds === undefined) throw new Error("deepseek card missing");
      expect(ds.registeredBaseUrl).toBe("https://mirror.test/v1");
      expect(ds.baseUrl).toBe("https://mirror.test/v1");
      // The untouched sibling builtin still carries no overlay field.
      const glmOverlay = withOverlay.find((c) => c.provider === "glm");
      if (glmOverlay !== undefined) expect("registeredBaseUrl" in glmOverlay).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = saved;
    }
  });
});

describe("settingsSaveKey (the write path)", () => {
  it("writes the credentials file 0600 and replies status-only", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    const r = await ops.settingsSaveKey("deepseek", "sk-save-me");
    expect(r).toEqual({ provider: "deepseek", saved: true, keyCount: 1 });
    expect(JSON.stringify(r)).not.toContain("sk-save-me");
    // 0600 octal is posix-only (win32 reports no enforced mode bits).
    if (process.platform !== "win32") {
      expect((statSync(credentialsFilePath(env())).mode & 0o777).toString(8)).toBe("600");
    }
    expect(readFileSync(credentialsFilePath(env()), "utf8")).toContain("deepseek: sk-save-me");
  });

  it("rejects providers outside the matrix", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSaveKey("openai", "k")).rejects.toThrow(/unknown provider/);
  });
});

describe("settingsTestConnection (mocked fetch, three human states)", () => {
  it("401 → Key 无效或无余额", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root, fetchImpl: fakeFetch([{ status: 401, body: '{"error":"auth"}' }]) });
    const r = await ops.settingsTestConnection("deepseek", { key: "sk-bad" });
    expect(r).toEqual({ ok: false, state: "auth", message: "Key 无效或无余额——检查是否复制完整、账户是否有余额" });
  });

  it("timeout / transport rejection → 网络不通", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    const ops = createSettingsOps({ env: env(), workspaceRoot: root, fetchImpl: fakeFetch([{ reject: abort }]), testTimeoutMs: 50 });
    const r = await ops.settingsTestConnection("deepseek", { key: "sk-x" });
    expect(r).toEqual({ ok: false, state: "network", message: "网络不通——检查网络或稍后再试" });
    const refused = new Error("fetch failed");
    const ops2 = createSettingsOps({ env: env(), workspaceRoot: root, fetchImpl: fakeFetch([{ reject: refused }]) });
    expect(await ops2.settingsTestConnection("glm", { key: "sk-x" })).toMatchObject({ state: "network" });
  });

  it("model 404 (and the 400 model-not-found body) → 模型名不存在", async () => {
    const ops = createSettingsOps({
      env: env(),
      workspaceRoot: root,
      fetchImpl: fakeFetch([
        { status: 404, body: '{"error":{"message":"Model not found"}}' },
        { status: 400, body: '{"error":{"message":"Model Not Exist, please check"}}' },
      ]),
    });
    expect(await ops.settingsTestConnection("deepseek", { key: "sk-x", model: "nope-1" })).toMatchObject({
      state: "model",
      message: "模型名不存在——试试推荐模型",
    });
    expect(await ops.settingsTestConnection("deepseek", { key: "sk-x", model: "nope-2" })).toMatchObject({ state: "model" });
  });

  it("200 → 连接成功; other statuses carry the HTTP code", async () => {
    const ops = createSettingsOps({
      env: env(),
      workspaceRoot: root,
      fetchImpl: fakeFetch([{ status: 200, body: '{"choices":[]}' }, { status: 429, body: "slow down" }]),
    });
    expect(await ops.settingsTestConnection("qwen", { key: "sk-x" })).toEqual({ ok: true, state: "ok", message: "连接成功" });
    expect(await ops.settingsTestConnection("qwen", { key: "sk-x" })).toMatchObject({ state: "http", message: "服务返回异常 (HTTP 429)" });
  });

  it("key resolution: pasted key beats env beats file; no key anywhere → no-key", async () => {
    // File has deepseek; env pool selects glm; testing glm without a paste
    // uses the env key; testing deepseek uses the file; testing qwen → no-key.
    const credsEnv = env({ WUDAO_API_KEY: "env-key", WUDAO_PROVIDER: "glm" });
    const ops0 = createSettingsOps({ env: credsEnv, workspaceRoot: root });
    await ops0.settingsSaveKey("deepseek", "file-key");
    const seenAuth: string[] = [];
    const fetchSpy = (async (_u: unknown, init?: RequestInit) => {
      seenAuth.push(String((init?.headers as Record<string, string>)["authorization"] ?? ""));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ops = createSettingsOps({ env: credsEnv, workspaceRoot: root, fetchImpl: fetchSpy });
    expect(await ops.settingsTestConnection("glm")).toMatchObject({ state: "ok" }); // env key
    expect(await ops.settingsTestConnection("deepseek")).toMatchObject({ state: "ok" }); // file key
    expect(await ops.settingsTestConnection("qwen")).toMatchObject({ state: "no-key" }); // nothing
    expect(await ops.settingsTestConnection("glm", { key: "pasted" })).toMatchObject({ state: "ok" }); // paste wins
    expect(seenAuth).toEqual(["Bearer env-key", "Bearer file-key", "Bearer pasted"]);
  });

  it("0.3.28 ③: anthropic wire probes /v1/messages (x-api-key + version; bearerAuth dual-sends); openai wire byte-identical", async () => {
    // The user-facing bug: the coding-plan gateways (anthropic wire) got the
    // openai-style /chat/completions probe → 404 → misreported as 「模型名不存
    // 在」. The probe now mirrors settingsListModels' wire awareness.
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const spy = (async (u: unknown, init?: RequestInit) => {
      seen.push({ url: String(u), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ops = createSettingsOps({ env: env(), workspaceRoot: root, fetchImpl: spy });
    // glm-code: anthropic wire + the bearerAuth pin → dual-send.
    expect(await ops.settingsTestConnection("glm-code", { key: "sk-x" })).toMatchObject({ state: "ok" });
    expect(seen[0]?.url).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
    expect(seen[0]?.headers["x-api-key"]).toBe("sk-x");
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer sk-x");
    // The real anthropic builtin: same wire, NO bearerAuth → no Bearer header.
    expect(await ops.settingsTestConnection("anthropic", { key: "sk-a" })).toMatchObject({ state: "ok" });
    expect(seen[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[1]?.headers["x-api-key"]).toBe("sk-a");
    expect(seen[1]?.headers["authorization"]).toBeUndefined();
    // The openai wire keeps the historical URL/headers byte-identical.
    expect(await ops.settingsTestConnection("deepseek", { key: "sk-d" })).toMatchObject({ state: "ok" });
    expect(seen[2]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[2]?.headers["authorization"]).toBe("Bearer sk-d");
    expect(seen[2]?.headers["x-api-key"]).toBeUndefined();
  });

  it("wudao without an endpoint → no-endpoint; unknown provider throws", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root, fetchImpl: fakeFetch([]) });
    expect(await ops.settingsTestConnection("wudao", { key: "k" })).toMatchObject({ state: "no-endpoint" });
    await expect(ops.settingsTestConnection("bogus", { key: "k" })).rejects.toThrow(/unknown provider/);
  });

  it("classifyTestResponse: the pure classifier's buckets", () => {
    expect(classifyTestResponse(null, "")).toBe("network");
    expect(classifyTestResponse(401, "")).toBe("auth");
    expect(classifyTestResponse(403, "")).toBe("auth");
    expect(classifyTestResponse(404, "")).toBe("model");
    expect(classifyTestResponse(400, "Model Not Exist")).toBe("model");
    expect(classifyTestResponse(400, "bad request about params")).toBe("http");
    expect(classifyTestResponse(500, "")).toBe("http");
  });
});

describe("settingsStatus", () => {
  it("carries the matrix, the credentials COUNT (never values), settings values, and the env identity", async () => {
    const ops = createSettingsOps({ env: env({ WUDAO_MODEL: "deepseek-x", WUDAO_REASONING_EFFORT: "high" }), workspaceRoot: root });
    await ops.settingsSaveKey("glm", "sk-glm-secret");
    const s = await ops.settingsStatus();
    expect(s.providers.length).toBe(10); // 0.3.12: anthropic; 0.3.26: the coding-plan gateways; 0.3.30: kimi/minimax pay APIs
    expect(s.credentials.keyCount).toBe(1);
    expect(JSON.stringify(s)).not.toContain("sk-glm-secret");
    // M63 §D tri-state: the mode key was never written in this fixture → null
    // (the wizard-completed "simple" is written explicitly, not defaulted).
    // M64-visual §4: ui.theme/ui.accent carry the same tri-state shape.
    // persona-settings T5: personaId joins the same absence-is-null rule.
    // ω99-236: docSuiteEnabled joins (default true — the doc trio's opt-out
    // gate; absence on the wire degrades to true, here it always resolves).
    // ω99-287: #5 — desktopBackgroundOnClose joins (default false, 同形演进).
    expect(s.settings).toEqual({ memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 0, uiTheme: null, uiAccent: null, personaId: null, permissionsDefaultMode: null, languageReply: "auto", languageReasoning: "auto", docSuiteEnabled: true, desktopBackgroundOnClose: false, schedulesLaunchAgent: false, schedulesLaunchAgentSupported: process.platform === "darwin" });
    expect(s.current).toEqual({ provider: "deepseek", model: "deepseek-x", effort: "high" });
    expect(s.envKey).toBe(false);
    expect(s.efforts).toContain("high");
  });

  it("M63 §C readiness: any ready provider → true; the pure join matches the payload", async () => {
    // No key anywhere → not ready.
    const bare = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await bare.settingsStatus()).readiness).toBe(false);
    // One file key (glm) → ready even though the env-selected provider is deepseek.
    await bare.settingsSaveKey("glm", "sk-glm");
    const s = await bare.settingsStatus();
    expect(s.readiness).toBe(true);
    expect(settingsReadiness(s.providers)).toBe(true); // same pure rule
    expect(settingsReadiness([{ provider: "deepseek", label: "deepseek", status: "missing-key", keySource: null, endpoint: null, defaultModel: "m" }])).toBe(false);
  });

  it("M63 §C wizardCompletedVersion: written through settingsSet, read back by settingsStatus", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings.wizardCompletedVersion).toBe(0);
    await ops.settingsSet("wizard.completedVersion", 3);
    expect((await ops.settingsStatus()).settings.wizardCompletedVersion).toBe(3);
  });
});

describe("settingsSet (the GLOBAL-tier writer)", () => {
  it("writes ui.defaultMode and memoryEnabled; the receipt carries no value echo", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("ui.defaultMode", "advanced")).toEqual({ key: "ui.defaultMode", saved: true });
    expect(await ops.settingsSet("memoryEnabled", false)).toEqual({ key: "memoryEnabled", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["ui"]).toEqual({ defaultMode: "advanced" });
    expect(saved["memoryEnabled"]).toBe(false);
    // The status face reads the written values back.
    const s = await ops.settingsStatus();
    // ω99-236: docSuiteEnabled joins (default true, 同形演进——见 settingsStatus 钉注).
    // ω99-287（续，标记见上）: desktopBackgroundOnClose joins (default false, 同形演进).
    expect(s.settings).toEqual({ memoryEnabled: false, uiDefaultMode: "advanced", wizardCompletedVersion: 0, uiTheme: null, uiAccent: null, personaId: null, permissionsDefaultMode: null, languageReply: "auto", languageReasoning: "auto", docSuiteEnabled: true, desktopBackgroundOnClose: false, schedulesLaunchAgent: false, schedulesLaunchAgentSupported: process.platform === "darwin" });
    // M63 §D: the explicit 简洁 tier reads back as "simple" (the wizard's
    // completion write); only ABSENCE reports null.
    expect(await ops.settingsSet("ui.defaultMode", "simple")).toEqual({ key: "ui.defaultMode", saved: true });
    expect((await ops.settingsStatus()).settings.uiDefaultMode).toBe("simple");
  });

  it("M78-buddy §4: \"buddy\" is an allowlisted ui.defaultMode value and round-trips through settingsStatus", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("ui.defaultMode", "buddy")).toEqual({ key: "ui.defaultMode", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["ui"]).toEqual({ defaultMode: "buddy" });
    expect((await ops.settingsStatus()).settings.uiDefaultMode).toBe("buddy");
    // The refusal message names the full enumeration now.
    await expect(ops.settingsSet("ui.defaultMode", "fancy")).rejects.toThrow(/"buddy"/);
  });

  it("refuses unknown keys, wrong types, and escalation keys", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("nope", 1)).rejects.toThrow(/unknown settings key/);
    await expect(ops.settingsSet("ui.defaultMode", "fancy")).rejects.toThrow(/simple/);
    await expect(ops.settingsSet("memoryEnabled", "yes")).rejects.toThrow(/boolean/);
    await expect(ops.settingsSet("autoMode", true)).rejects.toThrow(/unknown settings key/);
    // M63 §C: the wizard version marker is a non-negative integer or nothing.
    await expect(ops.settingsSet("wizard.completedVersion", "1")).rejects.toThrow(/non-negative integer/);
    await expect(ops.settingsSet("wizard.completedVersion", -1)).rejects.toThrow(/non-negative integer/);
    await expect(ops.settingsSet("wizard.completedVersion", 1.5)).rejects.toThrow(/non-negative integer/);
  });
});

// M64-visual §4 — the ui.theme/ui.accent channel: the SAME tri-state shape
// as ui.defaultMode (absent = null on the wire; the web app resolves null →
// dark / green itself), written through the allowlisted settingsSet into the
// ui node of the GLOBAL tier.
describe("settingsSet ui.theme / ui.accent (M64-visual §4)", () => {
  it("absent = null; an explicit write reads back; sibling ui keys survive", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings).toMatchObject({ uiTheme: null, uiAccent: null });
    await ops.settingsSet("ui.theme", "light");
    await ops.settingsSet("ui.accent", "blue");
    expect((await ops.settingsStatus()).settings).toMatchObject({ uiTheme: "light", uiAccent: "blue" });
    // The write MERGES into the ui node (never replaces a sibling key).
    await ops.settingsSet("ui.defaultMode", "simple");
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["ui"]).toEqual({ theme: "light", accent: "blue", defaultMode: "simple" });
    // Round-trip the other values too (dark + the remaining accents).
    await ops.settingsSet("ui.theme", "dark");
    await ops.settingsSet("ui.accent", "black");
    await ops.settingsSet("ui.accent", "green");
    expect((await ops.settingsStatus()).settings).toMatchObject({ uiTheme: "dark", uiAccent: "green" });
  });

  it("accepts only the enumerated values (the writer mirrors ui.defaultMode's shape)", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("ui.theme", "sepia")).rejects.toThrow(/"light" | "dark"/);
    await expect(ops.settingsSet("ui.theme", null)).rejects.toThrow(/"light" | "dark"/);
    await expect(ops.settingsSet("ui.accent", "red")).rejects.toThrow(/"black" | "blue" | "green"/);
    await expect(ops.settingsSet("ui.accent", 7)).rejects.toThrow(/"black" | "blue" | "green"/);
  });

  it("a hand-corrupted stored value still reads back null (the reader validates)", async () => {
    writeGlobalByHand(globalSettingsPath(env()), `${JSON.stringify({ ui: { theme: "sepia", accent: 42, defaultMode: "ok" } })}\n`, "utf8");
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings).toMatchObject({ uiTheme: null, uiAccent: null, uiDefaultMode: null });
  });

  it("keys outside the allowlist still refuse", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("ui.font", "mono")).rejects.toThrow(/unknown settings key/);
    await expect(ops.settingsSet("theme", "dark")).rejects.toThrow(/unknown settings key/);
  });
});

// Review M1 — a legal GLOBAL escalation key (the user's own M60 slack node)
// must survive a preference write; only keys the write INTRODUCES refuse.
// The legal node is seeded BY HAND (writeFile) — this writer must never be
// the thing that introduces an escalation key in the first place.
import { writeFileSync as writeGlobalByHand } from "node:fs";
import { saveGlobalSettings } from "../src/settings-layer.js";

describe("settingsSet vs legal global escalation keys (review M1)", () => {
  it("a hand-written slack node survives a memoryEnabled toggle, untouched", async () => {
    const slack = { enabled: true, allowSenders: ["u@example.com"] };
    writeGlobalByHand(globalSettingsPath(env()), `${JSON.stringify({ slack }, null, 2)}\n`, "utf8");
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("memoryEnabled", false)).resolves.toEqual({ key: "memoryEnabled", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["slack"]).toEqual(slack); // preserved verbatim
    expect(saved["memoryEnabled"]).toBe(false);
  });

  it("a write that would INTRODUCE an escalation key still refuses", async () => {
    await expect(saveGlobalSettings({ autoMode: true }, env())).rejects.toThrow(/拒绝引入/); // ω99-183: 钉随源演进
    // And replacing a non-escalation record stays unaffected.
    await expect(saveGlobalSettings({ memoryEnabled: true }, env())).resolves.toBe(globalSettingsPath(env()));
  });
});

// R6 quickwin (pi model-selector pattern) — the Ctrl+S pick defaults:
// model.defaultModel ({provider, model}) and model.defaultEffort (a matrix
// level) write through the SAME allowlisted settingsSet into a merged `model`
// node of the GLOBAL tier; settingsStatus surfaces them (null = never
// written); readStoredModelDefaults is the pure, corrupt-proof reader the
// `wudao ui` boot consumes (run.test.ts covers the boot application).
describe("settingsSet model.defaultModel / model.defaultEffort (r6 quickwin)", () => {
  it("writes the pair into a merged model node; settingsStatus reads both back", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("model.defaultModel", { provider: "glm", model: "glm-4.6" })).toEqual({ key: "model.defaultModel", saved: true });
    // The node MERGES: an effort write never drops the stored model.
    expect(await ops.settingsSet("model.defaultEffort", "max")).toEqual({ key: "model.defaultEffort", saved: true });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["model"]).toEqual({ defaultModel: { provider: "glm", model: "glm-4.6" }, defaultEffort: "max" });
    const s = await ops.settingsStatus();
    expect(s.defaultModel).toEqual({ provider: "glm", model: "glm-4.6" });
    expect(s.defaultEffort).toBe("max");
  });

  it("absent = null; only the enumerated shapes/values are writable", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    const bare = await ops.settingsStatus();
    expect(bare.defaultModel).toBeNull();
    expect(bare.defaultEffort).toBeNull();
    await expect(ops.settingsSet("model.defaultModel", { provider: "nope", model: "m" })).rejects.toThrow(/known provider/);
    await expect(ops.settingsSet("model.defaultModel", { provider: "glm" })).rejects.toThrow(/non-blank model/);
    await expect(ops.settingsSet("model.defaultModel", "glm/glm-4.6")).rejects.toThrow(/\{ provider, model \}/);
    await expect(ops.settingsSet("model.defaultEffort", "ultra")).rejects.toThrow(/model.defaultEffort must be one of/);
    await expect(ops.settingsSet("model.default", "x")).rejects.toThrow(/unknown settings key/);
  });

  it("readStoredModelDefaults: a hand-corrupted node reads as absence, never throws", async () => {
    writeGlobalByHand(
      globalSettingsPath(env()),
      `${JSON.stringify({ model: { defaultModel: { provider: 42, model: "" }, defaultEffort: "ultra" } })}\n`,
      "utf8",
    );
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    const s = await ops.settingsStatus();
    expect(s.defaultModel).toBeNull();
    expect(s.defaultEffort).toBeNull();
    // The pure reader agrees on the same record shape.
    expect(readStoredModelDefaults({ model: { defaultModel: { provider: 42 } } })).toEqual({});
    expect(readStoredModelDefaults({})).toEqual({});
    expect(readStoredModelDefaults({ model: "flat" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// cc-plugins C1 — the plugin-management ops over the A1/A2 marketplace engine
// (the same engine /plugin and `wudao plugin` drive). Fixtures are LOCAL
// market directories (the copier path — no git, no network); every op runs
// against an isolated global home. The rescan seam is a recording spy (the
// real rescanExtensions reads the process's real global home).
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { installedPluginsPath, marketplacesDir } from "../src/marketplace.js";

const C1_SKILL_MD = "---\nname: greet\ndescription: Greet a user warmly\n---\n\n# Greet\n\nAlways say hello.\n";
const C1_COMMAND_MD = "---\ndescription: Say hello to someone\n---\n\nSay hello to $ARGUMENTS.";

function c1WritePlugin(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

/** A local-dir market: `alpha` carries every asset class (skills 1 · commands
 *  1 · hooks 1 · MCP 1 — the detail counts), `beta` is a bare manifest
 *  (all-zero counts), `gamma` is a git-location source (detail null — only
 *  inspectable by cloning). */
function c1Market(dir: string, name = "m"): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name,
      description: `the ${name} market`,
      plugins: [
        { name: "alpha", source: "./plugins/alpha", description: "full fixture", version: "1.0.0" },
        { name: "beta", source: "./plugins/beta" },
        { name: "gamma", source: "some-owner/some-repo" },
      ],
    }),
    "utf8",
  );
  const alpha = join(dir, "plugins", "alpha");
  c1WritePlugin(alpha, { name: "alpha", version: "1.0.0", description: "full fixture" });
  mkdirSync(join(alpha, "skills", "greet"), { recursive: true });
  writeFileSync(join(alpha, "skills", "greet", "SKILL.md"), C1_SKILL_MD, "utf8");
  mkdirSync(join(alpha, "commands"), { recursive: true });
  writeFileSync(join(alpha, "commands", "hello.md"), C1_COMMAND_MD, "utf8");
  writeFileSync(join(alpha, ".mcp.json"), JSON.stringify({ mcpServers: { "alpha-srv": { command: "echo" } } }), "utf8");
  mkdirSync(join(alpha, "hooks"), { recursive: true });
  writeFileSync(join(alpha, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hook" }] }] } }), "utf8");
  c1WritePlugin(join(dir, "plugins", "beta"), { name: "beta" });
  return dir;
}

/** The C1 test bed: isolated home + workspace + a rescan spy factory. */
function c1Bed(): {
  home: string;
  ws: string;
  market: string;
  env: NodeJS.ProcessEnv;
  ops: (extra?: { readonly isBusy?: () => boolean; readonly rescan?: () => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }> }) => ReturnType<typeof createSettingsOps> & { rescanCalls(): number };
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "c1-ops-home-"));
  const ws = mkdtempSync(join(tmpdir(), "c1-ops-ws-"));
  const market = c1Market(mkdtempSync(join(tmpdir(), "c1-ops-market-")));
  const e: NodeJS.ProcessEnv = { WUDAO_GLOBAL_HOME: home };
  const makeOps = (extra?: { readonly isBusy?: () => boolean; readonly rescan?: () => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }> }): ReturnType<typeof createSettingsOps> & { rescanCalls(): number } => {
    let calls = 0;
    const rescan = extra?.rescan ?? (async () => {
      calls += 1;
      return { skills: 7, plugins: 3, hooks: 2 };
    });
    const ops = createSettingsOps({ env: e, workspaceRoot: ws, ...(extra?.isBusy !== undefined ? { isBusy: extra.isBusy } : {}), rescan });
    return Object.assign(ops, { rescanCalls: () => calls });
  };
  const cleanup = (): void => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(market, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { home, ws, market, env: e, ops: makeOps, cleanup };
}

describe("cc-plugins C1: plugin ops over the marketplace engine", () => {
  it("pluginList on a fresh home: the empty installed list", async () => {
    const b = c1Bed();
    try {
      expect(await b.ops().pluginList()).toEqual({ installed: [] });
    } finally {
      b.cleanup();
    }
  });

  it("marketplace add + list: the engine row, discover entries, local detail counts (git sources null), and NO rescan", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      const info = await ops.pluginMarketAdd(b.market);
      expect(info).toMatchObject({ name: "m", description: "the m market" });
      expect(typeof info.addedAt).toBe("string");
      expect(ops.rescanCalls()).toBe(0); // add never rescans (B1 law)

      const list = await ops.pluginMarketList();
      expect(ops.rescanCalls()).toBe(0);
      expect(list.marketplaces.length).toBe(1);
      const m = list.marketplaces[0];
      if (m === undefined) throw new Error("market row missing");
      expect(m.name).toBe("m");
      expect(m.plugins.length).toBe(3);
      const [alpha, beta, gamma] = m.plugins;
      if (alpha === undefined || beta === undefined || gamma === undefined) throw new Error("entries missing");
      // alpha: every asset class counted by the loader dry-run
      expect(alpha).toMatchObject({ name: "alpha", description: "full fixture", version: "1.0.0", detail: { skills: 1, commands: 1, agents: 0, hooks: 1, mcp: 1 } });
      // beta: a bare manifest loads — all-zero counts (NOT null)
      expect(beta).toMatchObject({ name: "beta", detail: { skills: 0, commands: 0, agents: 0, hooks: 0, mcp: 0 } });
      // gamma: a git-location source — inspectable only by cloning → null
      expect(gamma).toMatchObject({ name: "gamma", detail: null });
    } finally {
      b.cleanup();
    }
  });

  it("marketplace add: source-validation errors pass through verbatim", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await expect(ops.pluginMarketAdd("no-such-path-anywhere")).rejects.toThrow(/cannot parse marketplace source "no-such-path-anywhere".*(owner\/repo|git URL)/s);
      // A duplicate add (explicit name) keeps the engine's typed wording.
      await ops.pluginMarketAdd(b.market);
      await expect(ops.pluginMarketAdd(b.market, "m")).rejects.toThrow(/already exists.*remove it first/s);
      // An unsafe explicit name is the engine's invalid-name refusal.
      await expect(ops.pluginMarketAdd(b.market, "../escape")).rejects.toThrow(/not a safe directory name/);
      expect(ops.rescanCalls()).toBe(0);
    } finally {
      b.cleanup();
    }
  });

  it("install: user scope lands under the global plugins root, the reply carries dir + InstallDetail + the rescan receipt; pluginList sees it enabled", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      const r = await ops.pluginInstall("alpha", "m", "user");
      expect(r.dir).toBe(join(b.home, "plugins", "alpha"));
      expect(r.detail).toEqual({ skills: 1, commands: 1, agents: 0, hooks: 1, mcp: 1 });
      expect(r.rescan).toEqual({ skills: 7, plugins: 3, hooks: 2 });
      expect(ops.rescanCalls()).toBe(1);
      expect((await ops.pluginList()).installed).toEqual([
        { id: "alpha@m", name: "alpha", market: "m", scope: "user", enabled: true, version: "1.0.0" },
      ]);
    } finally {
      b.cleanup();
    }
  });

  it("install: project scope lands under the workspace's .wudao/plugins; a bad scope refuses before any engine call", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      const r = await ops.pluginInstall("alpha", "m", "project");
      expect(r.dir).toBe(join(b.ws, ".wudao", "plugins", "alpha"));
      // The record stores the workspace's REALPATH (the A2 normalization —
      // macOS /var vs /private/var never splits one workspace in two).
      expect(JSON.parse(readFileSync(installedPluginsPath(b.env), "utf8"))).toEqual([
        expect.objectContaining({ name: "alpha", market: "m", scope: "project", root: realpathSync(b.ws) }),
      ]);
      // A scope outside the grammar is a usage error, not an engine call.
      const before = readFileSync(installedPluginsPath(b.env), "utf8");
      await expect(ops.pluginInstall("alpha", "m", "global" as "user")).rejects.toThrow(/scope.*(user|project)/i);
      expect(ops.rescanCalls()).toBe(1); // only the project install's
      expect(readFileSync(installedPluginsPath(b.env), "utf8")).toBe(before);
    } finally {
      b.cleanup();
    }
  });

  it("install failures pass through: unknown market, unknown plugin, duplicate install", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await expect(ops.pluginInstall("alpha", "nope", "user")).rejects.toThrow(/marketplace "nope" is not registered/);
      await ops.pluginMarketAdd(b.market);
      await expect(ops.pluginInstall("ghost", "m", "user")).rejects.toThrow(/has no plugin "ghost"/);
      await ops.pluginInstall("alpha", "m", "user");
      await expect(ops.pluginInstall("alpha", "m", "user")).rejects.toThrow(/already installed.*uninstall it first/s);
    } finally {
      b.cleanup();
    }
  });

  it("disable/enable flip the enabledPlugins state (registry kept), each with a rescan; the bare name resolves one install", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      await ops.pluginInstall("alpha", "m", "user");
      expect(await ops.pluginDisable("alpha")).toEqual({ id: "alpha", enabled: false, rescan: { skills: 7, plugins: 3, hooks: 2 } });
      expect((await ops.pluginList()).installed[0]).toMatchObject({ id: "alpha@m", enabled: false });
      expect(await ops.pluginEnable("alpha@m")).toEqual({ id: "alpha@m", enabled: true, rescan: { skills: 7, plugins: 3, hooks: 2 } });
      expect((await ops.pluginList()).installed[0]).toMatchObject({ enabled: true });
      expect(ops.rescanCalls()).toBe(3); // install + disable + enable
    } finally {
      b.cleanup();
    }
  });

  it("uninstall removes dir + registry row and rescans; busy refuses BEFORE any engine call with the /clear-family notice", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      await ops.pluginInstall("alpha", "m", "user");
      const dir = join(b.home, "plugins", "alpha");
      expect(existsSync(dir)).toBe(true);

      // Busy: the directory-deleting op refuses; nothing is touched.
      const busyOps = b.ops({ isBusy: () => true });
      await expect(busyOps.pluginUninstall("alpha")).rejects.toThrow("⚠️ 运行中无法卸载插件（任务进行中）");
      expect(existsSync(dir)).toBe(true);
      expect((await busyOps.pluginList()).installed.length).toBe(1);
      expect(busyOps.rescanCalls()).toBe(0);

      const r = await ops.pluginUninstall("alpha");
      expect(r).toEqual({ id: "alpha", warnings: [], rescan: { skills: 7, plugins: 3, hooks: 2 } });
      expect(existsSync(dir)).toBe(false);
      expect((await ops.pluginList()).installed).toEqual([]);
      expect(JSON.parse(readFileSync(installedPluginsPath(b.env), "utf8"))).toEqual([]);
    } finally {
      b.cleanup();
    }
  });

  it("marketplace update re-copies a local market and never rescans; unknown markets pass the engine's not-found through", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      // Upstream gains a description change → the updated row reflects it.
      writeFileSync(
        join(b.market, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: "m", description: "refreshed", plugins: [{ name: "alpha", source: "./plugins/alpha" }] }),
        "utf8",
      );
      const updated = await ops.pluginMarketUpdate("m");
      expect(updated).toMatchObject({ name: "m", description: "refreshed" });
      expect(ops.rescanCalls()).toBe(0);
      await expect(ops.pluginMarketUpdate("ghost")).rejects.toThrow(/is not registered/);
    } finally {
      b.cleanup();
    }
  });

  it("marketplace remove cascades the uninstall and rescans; busy refuses; a corrupt install registry warns and removes nothing", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      await ops.pluginInstall("alpha", "m", "user");

      // Busy: the cascade deletes plugin dirs → the /clear-family refusal.
      const busyOps = b.ops({ isBusy: () => true });
      await expect(busyOps.pluginMarketRemove("m")).rejects.toThrow("⚠️ 运行中无法移除市场（任务进行中）");
      expect(existsSync(marketplacesDir(b.env))).toBe(true);
      expect((await busyOps.pluginMarketList()).marketplaces.length).toBe(1);
      expect(busyOps.rescanCalls()).toBe(0);

      const r = await ops.pluginMarketRemove("m");
      expect(r).toEqual({ removedPlugins: ["alpha"], warnings: [], rescan: { skills: 7, plugins: 3, hooks: 2 } });
      expect((await ops.pluginMarketList()).marketplaces).toEqual([]);
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(false);
      await expect(ops.pluginMarketRemove("m")).rejects.toThrow(/is not registered/);
    } finally {
      b.cleanup();
    }
  });

  it("marketplace remove over a corrupt installed.json: warns in the reply (removedPlugins empty), still removes the market", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      mkdirSync(join(b.home, "plugins"), { recursive: true });
      writeFileSync(installedPluginsPath(b.env), "{not json", "utf8");
      const r = await ops.pluginMarketRemove("m");
      expect(r.removedPlugins).toEqual([]);
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0]).toMatch(/installed\.json is not valid JSON/);
      expect((await ops.pluginMarketList()).marketplaces).toEqual([]);
      expect(ops.rescanCalls()).toBe(1);
    } finally {
      b.cleanup();
    }
  });

  it("the MOUNTED port probes the live driver for busy (withSettingsOps wiring): refusal mid-run, proceeds at idle", async () => {
    const b = c1Bed();
    try {
      const ops = b.ops();
      await ops.pluginMarketAdd(b.market);
      await ops.pluginInstall("alpha", "m", "user");

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gated = buildTool({
        name: "read_file",
        description: "gated read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        execute: async () => {
          await gate;
          return { content: "GATED" };
        },
      });
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
        { role: "assistant", content: "DONE" },
      ]);
      const driver = createAgentDriver({ model, tools: [gated], systemPrompt: "s", summarize: summarizeToolCall, workspaceRoot: b.ws });
      const port = withSettingsOps(driver, { env: b.env, workspaceRoot: b.ws, rescan: async () => ({ skills: 0, plugins: 0, hooks: 0 }) });
      const uninstall = port.pluginUninstall;
      if (uninstall === undefined) throw new Error("plugin ops not mounted on the port");

      driver.submit("go");
      await new Promise((r) => setTimeout(r, 30));
      // Workspace mode auto-allows read_file, but the guard stays: whatever
      // parks a permission ask gets answered so the tool is genuinely IN
      // FLIGHT (awaiting the gate inside execute).
      if (driver.getStatus().pendingPermission !== null) driver.answerPermission(true);
      await new Promise((r) => setTimeout(r, 30));
      expect(driver.getStatus().busy).toBe(true);
      // Mid-run: the mounted port refuses BEFORE any engine call — the dir
      // and the registry record are intact (the op-layer busy law, probed
      // from the live driver — the web client's only guard).
      await expect(uninstall("alpha")).rejects.toThrow("⚠️ 运行中无法卸载插件（任务进行中）");
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(true);
      expect((await port.pluginList!()).installed.length).toBe(1);

      release();
      // The run needs its final model turn to settle — poll for idle.
      // ω99-197: #1 内联 until（ablation 同款）——固定 2s for-轮询改 4s 带名超时（预算不足形：负载下 final turn 沉降可超 2s）
      await until(() => driver.getStatus().busy === false, "uninstall run settle");
      expect(driver.getStatus().busy).toBe(false);
      const done = await uninstall("alpha");
      expect(done).toMatchObject({ id: "alpha" });
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

// SDD 2026-08-23 persona Task 4 — the read side of the global default persona
// (settings.json persona.id, the LAST leg of the chain env > binding >
// default > none). The write side (the settingsSet allowlist) is Task 5; here
// the reader must be tolerant: absent file/node, a blank string (Task 5's
// clear writes ""), or a corrupt node all read as undefined — never a throw,
// never a phantom id (the uiTheme rule).
describe("readGlobalDefaultPersonaId (Task 4 read side)", () => {
  it("absent settings file → undefined (the whole chain leg is simply off)", () => {
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });

  it("persona.id string → the id", async () => {
    await saveGlobalSettings({ persona: { id: "alpha" } }, env());
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha");
  });

  it("a sibling key on the persona node survives the read (merge-shaped node, not wholesale)", async () => {
    await saveGlobalSettings({ persona: { id: "alpha", note: "x" } }, env());
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha");
  });

  it("blank string reads as absent (Task 5's clear writes \"\")", async () => {
    await saveGlobalSettings({ persona: { id: "" } }, env());
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });

  it("a corrupt persona node (string / array / numeric id) reads as undefined, never throws", async () => {
    await saveGlobalSettings({ persona: "alpha" }, env());
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
    await saveGlobalSettings({ persona: ["alpha"] }, env());
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
    await saveGlobalSettings({ persona: { id: 42 } }, env());
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });
});

// 0.3.11（用户反馈：权限档两入口 1:1 联动）— the PERSISTED default permission
// mode: settingsSet writes permissions.defaultMode (whole-node merge — the
// cross-tier allow/deny rules are siblings), settingsStatus reads the
// GLOBAL-tier value (mirroring the boot's read; legacy names migrate there,
// never here), retired and legacy names are refused.
describe("settingsSet permissions.defaultMode (0.3.11; 0.3.14 four)", () => {
  it("absent = null; the four shield tiers round-trip; sibling rule lists survive the merge", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings).toMatchObject({ permissionsDefaultMode: null });
    // Seed a hand-written permissions node carrying RULES (the pre-existing
    // cross-tier feature) — the defaultMode write must merge, not replace.
    writeGlobalByHand(
      globalSettingsPath(env()),
      `${JSON.stringify({ permissions: { allow: ["shell:git status"] } }, null, 2)}\n`,
      "utf8",
    );
    await ops.settingsSet("permissions.defaultMode", "auto");
    expect((await ops.settingsStatus()).settings).toMatchObject({ permissionsDefaultMode: "auto" });
    const saved = JSON.parse(readFileSync(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["permissions"]).toEqual({ allow: ["shell:git status"], defaultMode: "auto" });
    await ops.settingsSet("permissions.defaultMode", "ask");
    await ops.settingsSet("permissions.defaultMode", "plan");
    expect((await ops.settingsStatus()).settings).toMatchObject({ permissionsDefaultMode: "plan" });
    await ops.settingsSet("permissions.defaultMode", "workspace");
    expect((await ops.settingsStatus()).settings).toMatchObject({ permissionsDefaultMode: "workspace" });
  });

  it("accepts only the four shield tiers — read-only and the legacy names are not persistable", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await expect(ops.settingsSet("permissions.defaultMode", "read-only")).rejects.toThrow(/"workspace" \| "ask" \| "auto" \| "plan"/);
    await expect(ops.settingsSet("permissions.defaultMode", "default")).rejects.toThrow(/"workspace" \| "ask" \| "auto" \| "plan"/);
    await expect(ops.settingsSet("permissions.defaultMode", "acceptEdits")).rejects.toThrow(/"workspace" \| "ask" \| "auto" \| "plan"/);
    await expect(ops.settingsSet("permissions.defaultMode", 1)).rejects.toThrow(/"workspace" \| "ask" \| "auto" \| "plan"/);
    await expect(ops.settingsSet("permissions.defaultMode", null)).rejects.toThrow(/"workspace" \| "ask" \| "auto" \| "plan"/);
  });

  it("a hand-corrupted stored value reads back null (the reader validates), and the value never echoes", async () => {
    writeGlobalByHand(globalSettingsPath(env()), `${JSON.stringify({ permissions: { defaultMode: "yolo" } })}\n`, "utf8");
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect((await ops.settingsStatus()).settings).toMatchObject({ permissionsDefaultMode: null });
  });
});

// 0.3.32c kimi-401 — the settingsSaveKey hot-refresh wrapper: a key saved
// for the LIVE provider must reach the RUNNING session. The file write alone
// left the live pool carrying whatever the last switch resolved (the
// reported trap: a cross-provider switch before any target key existed
// borrowed the boot provider's key → 401; saving the key then retried
// against the stale live config — same 401 forever).
describe("withSettingsOps settingsSaveKey — the 0.3.32c key-save hot-refresh", () => {
  it("saving a key for the LIVE provider re-applies it in place (same-name /provider through the funnel)", async () => {
    const e = env();
    // The post-T0 live shape: labeled kimi-code, pool still the OLD
    // provider's borrowed key. The seam mirrors session-engine's.
    const live = asMutableConfig({
      apiKey: "sk-deepseek-live",
      apiKeys: ["sk-deepseek-live"],
      baseURL: "https://api.kimi.com/coding",
      model: "k3-256k",
      provider: "kimi-code",
    });
    const builds: string[] = [];
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      sessionMeta: { provider: "kimi-code", model: "k3-256k" },
      onProviderSwitch: {
        resolve: (target) => resolveProviderSwitch({ target, env: e, current: live, credentials: readCredentialsFileSync(e) }),
        build: (config) => {
          builds.push(`${config.provider}/${config.apiKey}`);
          applyProviderConfig(live, config);
          return createScriptedModel([{ role: "assistant", content: "refreshed" }]);
        },
        keyRefreshPending: () => keyRefreshPending(live, readCredentialsFileSync(e)),
      },
    });
    const port = withSettingsOps(driver, { env: e, workspaceRoot: root, rescan: async () => ({ skills: 0, plugins: 0, hooks: 0 }) });
    // Before the save: nothing to refresh (no file key yet).
    expect(driver.keyRefreshPending()).toBe(false);
    const out = await port.settingsSaveKey("kimi-code", "sk-kimi-saved");
    expect(out).toMatchObject({ provider: "kimi-code", saved: true });
    // The wrapper submitted the same-name /provider; the rebuild carried
    // the SAVED key — not the stale borrowed pool key.
    for (let i = 0; i < 100 && builds.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(builds).toEqual(["kimi-code/sk-kimi-saved"]);
    const notices = driver.getHistory().map((x) => (x.kind === "notice" ? x.text : "")).join("\n");
    expect(notices).toContain("供应商 → kimi-code (k3-256k)");
    // And the negative control: a save for a NON-live provider never
    // submits a switch (the next /provider to IT picks the file key up).
    await port.settingsSaveKey("glm", "sk-glm-irrelevant");
    await new Promise((r) => setTimeout(r, 50));
    expect(builds).toEqual(["kimi-code/sk-kimi-saved"]);
  });
});

// 2026-08-31 feedback — the config-save hot-refresh: a provider-ROW save
// (the settings page's model config: baseUrl/models) for the LIVE provider
// must reach the running session too, no manual re-switch. The key lane
// (above) covers settingsSaveKey; this lane covers settingsSaveProvider —
// and only CONNECTION drift fires (a models-only save changes nothing the
// live client reads).
describe("withSettingsOps settingsSaveProvider — the config-save hot-refresh", () => {
  it("a LIVE-provider row save whose endpoint drifted re-applies it in place; a models-only save never submits", async () => {
    const e = env();
    const live = asMutableConfig({
      apiKey: "sk-live",
      apiKeys: ["sk-live"],
      baseURL: "https://api.kimi.com/coding",
      model: "k3-256k",
      provider: "kimi-code",
      // A real boot/switch config carries the profile's wire fold — without
      // it the drift probe reads wire undefined vs the profile pin on every
      // check (a permanent false positive).
      wire: "anthropic",
    });
    const RELAY = "https://relay.example/v1";
    let registeredBase: string | undefined;
    const builds: string[] = [];
    const resolveHere = (target: string) => {
      const r = resolveProviderSwitch({ target, env: e, current: live, credentials: readCredentialsFileSync(e) });
      if (!r.ok || registeredBase === undefined) return r;
      return { ...r, config: { ...r.config, baseURL: registeredBase } };
    };
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      sessionMeta: { provider: "kimi-code", model: "k3-256k" },
      onProviderSwitch: {
        resolve: resolveHere,
        configRefreshPending: () => {
          if (live.provider === undefined) return false;
          const r = resolveHere(live.provider);
          return configRefreshPending(live, r.ok ? r.config : undefined);
        },
        keyRefreshPending: () => keyRefreshPending(live, readCredentialsFileSync(e)),
        build: (config) => {
          builds.push(`${config.provider}/${config.baseURL}`);
          applyProviderConfig(live, config);
          return createScriptedModel([{ role: "assistant", content: "refreshed" }]);
        },
      },
    });
    const port = withSettingsOps(driver, { env: e, workspaceRoot: root, rescan: async () => ({ skills: 0, plugins: 0, hooks: 0 }) });
    // Negative first: a models-only save (endpoint untouched) never submits.
    const modelsOnly = await port.settingsSaveProvider("kimi-code", { models: [{ name: "k3-256k" }] });
    expect(modelsOnly.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(builds).toEqual([]);
    // The endpoint save: the registry row now pins the relay — the wrapper's
    // pending check sees the connection drift and submits the same-name
    // refresh through the funnel.
    registeredBase = RELAY;
    const out = await port.settingsSaveProvider("kimi-code", { baseUrl: RELAY, models: [{ name: "k3-256k" }] });
    expect(out.ok).toBe(true);
    for (let i = 0; i < 100 && builds.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(builds).toEqual(["kimi-code/https://relay.example/v1"]);
    const notices = driver.getHistory().map((x) => (x.kind === "notice" ? x.text : "")).join("\n");
    expect(notices).toContain("供应商 → kimi-code (k3-256k)");
    // Idempotent: after the rebuild the live config matches the registry —
    // a repeat save submits nothing.
    await port.settingsSaveProvider("kimi-code", { baseUrl: RELAY, models: [{ name: "k3-256k" }] });
    await new Promise((r) => setTimeout(r, 60));
    expect(builds).toEqual(["kimi-code/https://relay.example/v1"]);
  });
});
