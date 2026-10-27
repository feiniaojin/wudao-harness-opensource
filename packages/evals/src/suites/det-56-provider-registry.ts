// Provider registry det-56 — the deterministic behavior pins for the runtime
// provider registry (provider management §3/§5/§7). Four seams, zero network,
// zero real-home reads (fixtures under the eval tmp root; the one process.env
// pin — WUDAO_GLOBAL_HOME — is saved and restored, det-53's pattern):
//
//   ① registry fixture three states  readProviderRegistrySync +
//      effectiveProfiles over injected providers.json files: a builtin
//      overlay merges field-by-field (compiled reasoning facts survive; the
//      overlay's model catalog REPLACES the empty builtin one wholesale), a
//      custom without baseUrl is FAIL-VISIBLE (one invalid row — never a
//      silent drop, never in the matrix), and malformed rows cost only
//      themselves while a malformed FILE demotes whole (one "(file)" row,
//      empty entries; a missing file is silently empty).
//   ② window chain four levels      resolveContextWindowTokens precedence
//      (model contextLength → provider defaultContextLength → env value) with
//      the settings knob as the TOP level, composed through misc-config's
//      resolveAutoCompactSettings — the same wiring the CLI's
//      resolveSessionWindowTokens makes: an explicit autoCompactWindow wins
//      over every model, clamps only ITSELF (100k–1M), and a malformed knob
//      keeps the chain result untouched.
//   ③ listModels parsing             the three /models response shapes through
//      the REAL ops (withSettingsOps → createProviderRegistryOps) with the
//      fetch seam injected: the OpenAI shape ({data:[{id}]}), the
//      OpenRouter/models.dev context_length prefill (positive integers only),
//      and the malformed lanes (non-JSON / missing data array → the shared
//      http state). Wire hygiene: GET ${defaultBaseUrl}/models with Bearer
//      <pasted key>.
//   ④ ProviderName widening          the builtin four (deepseek/glm/qwen/wudao)
//      still resolve through the full chain against the compiled profiles
//      (exact baseURL + defaultModel each; wudao keeps its explicit-baseUrl
//      gate), isProviderName stays exactly the closed four, and the widened
//      spelling accepts a registry custom id through
//      resolveProviderConfigResult's registry leg while an unknown id throws
//      the widened guard's message (the ops matrix carries the same test).
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadFileTool, createScriptedModel } from "@wudao/core";
import {
  PROVIDER_PROFILES,
  effectiveProfiles,
  isProviderName,
  readProviderRegistrySync,
  resolveContextWindowTokens,
  resolveProviderConfigResult,
} from "@wudao/providers";
import type { EffectiveProfile, ProviderModelEntry } from "@wudao/providers";
import { AUTO_COMPACT_WINDOW_MAX, AUTO_COMPACT_WINDOW_MIN, resolveAutoCompactSettings } from "wudao-harness/misc-config";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { withSettingsOps } from "wudao-harness/driver/settings-ops";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

/** One invalid row as the registry reports it (fail-visible). */
interface InvalidRow {
  readonly id: string;
  readonly reason: string;
}

/** A normalized settingsListModels outcome (evidence copy — unions stay out
 *  of the evidence interface). */
interface ModelsLane {
  readonly ok: boolean;
  readonly models: readonly { readonly name: string; readonly contextLength?: number }[];
  readonly state: string;
  readonly message: string;
}

export interface ProviderRegistryEvidence {
  // ① registry fixtures
  readonly overlayEntryKeys: readonly string[];
  readonly overlayInvalid: readonly InvalidRow[];
  readonly mergedDeepseek: EffectiveProfile | undefined;
  readonly untouchedGlm: EffectiveProfile | undefined;
  readonly customOk: EffectiveProfile | undefined;
  readonly badRowsInvalid: readonly InvalidRow[];
  readonly badRowsEntryCount: number;
  readonly badJsonInvalid: readonly InvalidRow[];
  readonly wrongVerInvalid: readonly InvalidRow[];
  readonly missingEntryCount: number;
  readonly missingInvalidCount: number;
  // ② window chain
  readonly winChain: {
    readonly byModel: number;
    readonly byProviderDefault: number;
    readonly byBuiltinPin: number;
    readonly byEnvBuiltin: number;
    readonly byEnvUnknownProvider: number;
  };
  readonly knob: {
    readonly knobWinsOverModel: number;
    readonly absentKeepsChain: number;
    readonly minClamp: number;
    readonly maxClamp: number;
    readonly chainBelowMinUncapped: number;
    readonly malformedKnobKeepsChain: number;
  };
  // ③ listModels shapes
  readonly openai: ModelsLane;
  readonly openrouter: ModelsLane;
  readonly notJson: ModelsLane;
  readonly noData: ModelsLane;
  readonly wire: readonly { readonly url: string; readonly auth: string }[];
  readonly listUnknownThrew: string;
  // ④ ProviderName widening
  readonly builtinResolve: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly baseURL: string;
    readonly model: string;
    readonly provider: string;
  }[];
  readonly wudaoNoUrl: { readonly ok: boolean; readonly reason: string };
  readonly customResolve: { readonly ok: boolean; readonly baseURL: string; readonly model: string; readonly provider: string };
  readonly resolveUnknownThrew: string;
  readonly closedTable: { readonly name: string; readonly accepted: boolean }[];
}

/** Write one registry fixture (the ONLY way the suite touches a providers.json). */
async function writeRegistry(root: string, file: string, body: unknown): Promise<string> {
  const path = join(root, file);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

const norm = (r: unknown): ModelsLane => {
  const x = r as { ok?: boolean; models?: ProviderModelEntry[]; state?: string; message?: string };
  return {
    ok: x.ok === true,
    models: (x.models ?? []).map((m) => (m.contextLength !== undefined ? { name: m.name, contextLength: m.contextLength } : { name: m.name })),
    state: x.state ?? "",
    message: x.message ?? "",
  };
};

export const det56Eval: EvalDefinition<{ readonly root: string }, ProviderRegistryEvidence> = {
  name: "det-56-provider-registry",
  kind: "deterministic",
  async setup(tmplDir) {
    await mkdir(tmplDir, { recursive: true });
    return { root: tmplDir };
  },
  async run({ root }): Promise<ProviderRegistryEvidence> {
    // ---- ① registry fixtures (injected paths — never the machine's home)
    const overlayLoad = readProviderRegistrySync(await writeRegistry(root, "reg-overlay.json", {
      version: 1,
      providers: {
        deepseek: {
          label: "公司 DeepSeek 网关",
          baseUrl: "https://gw.mycorp.invalid/v1",
          defaultModel: "deepseek-v4-flash",
          defaultContextLength: 400_000,
          models: [{ name: "deepseek-v4-flash", contextLength: 260_000 }, { name: "deepseek-v4" }],
          futureField: "dropped-by-the-sanitizer",
        },
        // Key hygiene at the read seam: a key pasted into the config is
        // dropped by the sanitizer — keys never live in providers.json.
        "custom-ok": { baseUrl: "https://api.mycorp.invalid/v1", defaultModel: "mycorp-1", apiKey: "sk-leak" },
        "custom-no-url": { label: "忘了 baseUrl" },
      },
    }));
    const overlayView = effectiveProfiles(overlayLoad.entries);
    const customOkEntry = overlayLoad.entries.get("custom-ok");

    const badRowsLoad = readProviderRegistrySync(await writeRegistry(root, "reg-bad-rows.json", {
      version: 1,
      providers: {
        "1bad": { baseUrl: "https://x.invalid" },
        arrayRow: [1, 2],
        "bad-url": { baseUrl: 42 },
      },
    }));
    const badJsonLoad = readProviderRegistrySync(await writeRegistry(root, "reg-bad-json.json", "{not json"));
    const wrongVerLoad = readProviderRegistrySync(await writeRegistry(root, "reg-wrong-ver.json", { version: 2, providers: {} }));
    const missingLoad = readProviderRegistrySync(join(root, "reg-absent.json"));

    // ---- ② the window chain: registry wins over env, the settings knob
    // wins over everything (the resolveSessionWindowTokens composition).
    const winProfiles = effectiveProfiles(readProviderRegistrySync(await writeRegistry(root, "reg-window.json", {
      version: 1,
      providers: {
        win: {
          baseUrl: "https://win.invalid/v1",
          defaultModel: "win-default",
          defaultContextLength: 300_000,
          models: [{ name: "win-big", contextLength: 200_000 }, { name: "win-plain" }],
        },
      },
    })).entries);
    const ENV_WINDOW = 64_000;
    const byModel = resolveContextWindowTokens(winProfiles, "win", "win-big", ENV_WINDOW);
    const winChain = {
      byModel,
      byProviderDefault: resolveContextWindowTokens(winProfiles, "win", "win-plain", ENV_WINDOW),
      // 反馈① 收口 (2026-08-29): the doc-verified builtin pins are a chain
      // level between user registry data and env — glm-4.6 = 204_800 beats
      // ENV_WINDOW.
      byBuiltinPin: resolveContextWindowTokens(winProfiles, "glm", "glm-4.6", ENV_WINDOW),
      byEnvBuiltin: resolveContextWindowTokens(winProfiles, "wudao", "wudao-preview", ENV_WINDOW),
      byEnvUnknownProvider: resolveContextWindowTokens(winProfiles, "ghost", "any", ENV_WINDOW),
    };
    const knob = {
      knobWinsOverModel: resolveAutoCompactSettings({ autoCompactWindow: 500_000 }, byModel).windowTokens,
      absentKeepsChain: resolveAutoCompactSettings({}, byModel).windowTokens,
      minClamp: resolveAutoCompactSettings({ autoCompactWindow: 50 }, byModel).windowTokens,
      maxClamp: resolveAutoCompactSettings({ autoCompactWindow: 50_000_000 }, byModel).windowTokens,
      chainBelowMinUncapped: resolveAutoCompactSettings({ autoCompactEnabled: false }, ENV_WINDOW).windowTokens,
      malformedKnobKeepsChain: resolveAutoCompactSettings({ autoCompactWindow: "huge" }, byModel).windowTokens,
    };

    // ---- ③ listModels through the real ops: pin the process home (the ops'
    // effective-profile read resolves via process.env — det-53's pattern),
    // inject the fetch seam, drive the three response shapes.
    const opsHome = join(root, "ops-home");
    await mkdir(opsHome, { recursive: true });
    const opsWs = await mkdtemp(join(root, "ws-"));
    const wire: { url: string; auth: string }[] = [];
    let next: { status: number; body: string } = { status: 200, body: "{}" };
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      wire.push({ url: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "") });
      return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const prevGlobalHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = opsHome;
    let openai: ModelsLane;
    let openrouter: ModelsLane;
    let notJson: ModelsLane;
    let noData: ModelsLane;
    let listUnknownThrew = "";
    try {
      const port = withSettingsOps(
        createAgentDriver({
          systemPrompt: "s",
          summarize: summarizeToolCall,
          model: createScriptedModel([{ role: "assistant", content: "ok" }]),
          tools: [createReadFileTool({ workspaceRoot: opsWs })],
        }),
        { env: { WUDAO_GLOBAL_HOME: opsHome }, workspaceRoot: opsWs, testTimeoutMs: 500, fetchImpl: fakeFetch },
      );
      // The port type marks the registry ops optional (older drivers) — the
      // wrapper makes their absence fail loudly instead of type-lying.
      const listModels = (provider: string, opts?: { readonly key?: string }): Promise<unknown> => {
        const fn = port.settingsListModels;
        if (fn === undefined) throw new Error("det-56: the wrapped port lacks settingsListModels");
        return fn(provider, opts);
      };
      // Shape 1 — OpenAI: plain ids, no context_length anywhere.
      next = { status: 200, body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) };
      openai = norm(await listModels("deepseek", { key: "sk-eval" }));
      // Shape 2 — OpenRouter/models.dev: context_length prefills ONLY when a
      // positive integer (0 / "789" drop it); rows without an id skip.
      next = {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: "or-big", context_length: 123_456 },
            { id: "or-zero", context_length: 0 },
            { id: "or-str", context_length: "789" },
            { id: "or-plain" },
            { weird: true },
          ],
        }),
      };
      openrouter = norm(await listModels("deepseek", { key: "sk-eval" }));
      // Shape 3 — malformed: non-JSON body, then no data array → http bucket.
      next = { status: 200, body: "not-json{" };
      notJson = norm(await listModels("deepseek", { key: "sk-eval" }));
      next = { status: 200, body: JSON.stringify({ object: "list" }) };
      noData = norm(await listModels("deepseek", { key: "sk-eval" }));
      // The widened matrix guard: an id absent from the effective view throws
      // (fail-fast) naming the matrix — before any fetch happens.
      try {
        await listModels("ghost", { key: "sk-eval" });
      } catch (e) {
        listUnknownThrew = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (prevGlobalHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevGlobalHome;
    }

    // ---- ④ the builtin four through the full resolve chain (explicit envs —
    // never the machine's), plus the widened spelling's two edges.
    const RESOLVE_ENV = { WUDAO_API_KEY: "sk-eval" };
    const builtinResolve = (["deepseek", "glm", "qwen", "wudao"] as const).map((name) => {
      const r = resolveProviderConfigResult(
        name === "wudao" ? { ...RESOLVE_ENV, WUDAO_BASE_URL: "https://wudao-gw.invalid/v1" } : RESOLVE_ENV,
        { provider: name },
      );
      return {
        name,
        ok: r.ok,
        baseURL: r.ok ? r.config.baseURL : "",
        model: r.ok ? r.config.model : "",
        provider: r.ok ? (r.config.provider ?? "") : "",
      };
    });
    const wudaoNoUrlRaw = resolveProviderConfigResult(RESOLVE_ENV, { provider: "wudao" });
    const wudaoNoUrl = wudaoNoUrlRaw.ok ? { ok: true, reason: "" } : { ok: false, reason: wudaoNoUrlRaw.reason };
    const customRaw = resolveProviderConfigResult(
      { ...RESOLVE_ENV, WUDAO_PROVIDER: "custom-ok" },
      {},
      undefined,
      overlayView,
    );
    const customResolve = customRaw.ok
      ? { ok: true, baseURL: customRaw.config.baseURL, model: customRaw.config.model, provider: customRaw.config.provider ?? "" }
      : { ok: false, baseURL: "", model: "", provider: "" };
    let resolveUnknownThrew = "";
    try {
      resolveProviderConfigResult({ WUDAO_API_KEY: "sk-eval" }, { provider: "ghost" });
    } catch (e) {
      resolveUnknownThrew = e instanceof Error ? e.message : String(e);
    }
    const closedTable = ["deepseek", "glm", "qwen", "wudao", "custom-ok", "zhipu"].map((name) => ({ name, accepted: isProviderName(name) }));

    return {
      overlayEntryKeys: customOkEntry !== undefined ? Object.keys(customOkEntry).sort() : ["(entry-missing)"],
      overlayInvalid: overlayLoad.invalid,
      mergedDeepseek: overlayView.get("deepseek"),
      untouchedGlm: overlayView.get("glm"),
      customOk: overlayView.get("custom-ok"),
      badRowsInvalid: badRowsLoad.invalid,
      badRowsEntryCount: badRowsLoad.entries.size,
      badJsonInvalid: badJsonLoad.invalid,
      wrongVerInvalid: wrongVerLoad.invalid,
      missingEntryCount: missingLoad.entries.size,
      missingInvalidCount: missingLoad.invalid.length,
      winChain,
      knob,
      openai,
      openrouter,
      notJson,
      noData,
      wire,
      listUnknownThrew,
      builtinResolve,
      wudaoNoUrl,
      customResolve,
      resolveUnknownThrew,
      closedTable,
    };
  },
  assertions(e: ProviderRegistryEvidence): string[] {
    const errs: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errs.push(what);
    };
    const j = (v: unknown): string => JSON.stringify(v);

    // ---- ① overlay 合并：逐字段覆盖 + 编译期推理事实幸存 + 目录整体替换
    const ds = PROVIDER_PROFILES.deepseek!;
    const md = e.mergedDeepseek;
    need(md !== undefined, `① overlay: deepseek must stay in the effective view, got ${md === undefined ? "absent" : "present"}`);
    if (md !== undefined) {
      need(md.label === "公司 DeepSeek 网关", `① overlay: label must be the overlay's, got ${j(md.label)}`);
      need(md.defaultBaseUrl === "https://gw.mycorp.invalid/v1", `① overlay: baseUrl must override the compiled default, got ${j(md.defaultBaseUrl)}`);
      need(md.defaultModel === "deepseek-v4-flash", `① overlay: defaultModel must be the overlay's, got ${j(md.defaultModel)}`);
      need(md.reasoningFormat === ds.reasoningFormat, `① overlay: the compiled reasoningFormat must survive an overlay that does not set one, got ${j(md.reasoningFormat)}`);
      need(md.windowMode === ds.windowMode, `① overlay: the compiled windowMode must survive, got ${j(md.windowMode)}`);
      need(md.acceptsReasoningOnlyFinish === ds.acceptsReasoningOnlyFinish, "① overlay: the compiled acceptsReasoningOnlyFinish must survive");
      need(
        j(md.models) === j([{ name: "deepseek-v4-flash", contextLength: 260_000 }, { name: "deepseek-v4" }]),
        `① overlay: the overlay's models must REPLACE the builtin catalog wholesale, got ${j(md.models)}`,
      );
      need(md.defaultContextLength === 400_000, `① overlay: defaultContextLength must ride the effective profile, got ${md.defaultContextLength}`);
      need(md.custom === false, "① overlay: a builtin overlay is never custom");
    }
    need(
      // 反馈① 收口 (2026-08-29): an untouched builtin is the compiled
      // profile PLUS its doc-verified context pins (glm-4.6 = 204_800);
      // only an unpinned builtin (wudao) materializes with an empty catalog.
      j(e.untouchedGlm) === j({ ...PROVIDER_PROFILES.glm, models: PROVIDER_PROFILES.glm.models ?? [], custom: false }),
      `① overlay: a builtin without an entry must be the compiled profile + its own context pins, got ${j(e.untouchedGlm)}`,
    );
    const co = e.customOk;
    need(co !== undefined, `① overlay: the valid custom must join the matrix, got ${co === undefined ? "absent" : "present"}`);
    if (co !== undefined) {
      need(co.custom === true, "① overlay: a non-builtin id is custom");
      need(co.label === "custom-ok", `① overlay: a custom without label defaults to its id, got ${j(co.label)}`);
      need(co.defaultBaseUrl === "https://api.mycorp.invalid/v1", `① overlay: the entry baseUrl becomes defaultBaseUrl, got ${j(co.defaultBaseUrl)}`);
      need(co.requiresBaseUrl === true, "① overlay: a custom pins requiresBaseUrl true");
      need(co.reasoningFormat === "none", `① overlay: a custom without reasoningFormat defaults to none, got ${j(co.reasoningFormat)}`);
    }
    // 自定义缺 baseUrl → invalid（fail-visible，一条都不静默丢弃）
    need(e.overlayInvalid.length === 1, `① invalid: exactly the custom-without-baseUrl row must be invalid, got ${j(e.overlayInvalid)}`);
    need(
      e.overlayInvalid[0]?.id === "custom-no-url" && e.overlayInvalid[0].reason.includes("needs a baseUrl"),
      `① invalid: the refusal must name the custom and the missing baseUrl, got ${j(e.overlayInvalid[0])}`,
    );
    // Key hygiene: the sanitizer drops unknown (key-bearing) fields.
    need(
      j(e.overlayEntryKeys) === j(["baseUrl", "defaultModel"]),
      `① hygiene: a key pasted into a registry config must be dropped by the sanitizer (keys never live in providers.json), got ${j(e.overlayEntryKeys)}`,
    );
    // 畸形行：只该行付出代价
    need(
      e.badRowsEntryCount === 0 && e.badRowsInvalid.length === 3,
      `① bad-rows: every malformed row costs only itself (0 entries, 3 invalid), got ${e.badRowsEntryCount} entries / ${e.badRowsInvalid.length} invalid`,
    );
    const reasons = e.badRowsInvalid.map((r) => `${r.id}:${r.reason}`).join("\n");
    need(reasons.includes('invalid provider id "1bad"'), `① bad-rows: the digit-first id must be refused, got ${j(reasons)}`);
    need(reasons.includes("entry must be an object (got array)"), `① bad-rows: the non-object row must be refused with its kind, got ${j(reasons)}`);
    need(reasons.includes("baseUrl must be a string"), `① bad-rows: the typed-field violation must be refused, got ${j(reasons)}`);
    // 畸形文件：整体降级 + 文件级 invalid 行；缺文件静默为空
    need(
      e.badJsonInvalid.length === 1 && e.badJsonInvalid[0]?.id === "(file)" && e.badJsonInvalid[0].reason.includes("invalid JSON"),
      `① bad-file: invalid JSON demotes whole with one file-level row, got ${j(e.badJsonInvalid)}`,
    );
    need(
      e.wrongVerInvalid.length === 1 && e.wrongVerInvalid[0]?.id === "(file)" && e.wrongVerInvalid[0].reason.includes("unsupported registry version 2"),
      `① bad-file: a wrong version demotes whole, got ${j(e.wrongVerInvalid)}`,
    );
    need(e.missingEntryCount === 0 && e.missingInvalidCount === 0, "① missing: an absent registry file is the silent empty registry (builtins cover everything)");

    // ---- ② 窗口链四级：模型目录 → provider 默认 → env；旋钮压一切
    need(e.winChain.byModel === 200_000, `② chain: the model's registered contextLength wins, got ${e.winChain.byModel}`);
    need(e.winChain.byProviderDefault === 300_000, `② chain: the provider default covers models without one, got ${e.winChain.byProviderDefault}`);
    need(e.winChain.byBuiltinPin === 204_800, `② chain: a doc-verified builtin pin beats env (反馈① 收口), got ${e.winChain.byBuiltinPin}`);
    need(e.winChain.byEnvBuiltin === 64_000, `② chain: a builtin with no registry data and no pin falls to the env value, got ${e.winChain.byEnvBuiltin}`);
    need(e.winChain.byEnvUnknownProvider === 64_000, `② chain: an unknown provider falls to the env value (never a throw), got ${e.winChain.byEnvUnknownProvider}`);
    need(e.knob.knobWinsOverModel === 500_000, `② knob: an explicit autoCompactWindow wins over every model, got ${e.knob.knobWinsOverModel}`);
    need(e.knob.absentKeepsChain === 200_000, `② knob: no knob keeps the chain result, got ${e.knob.absentKeepsChain}`);
    need(e.knob.minClamp === AUTO_COMPACT_WINDOW_MIN, `② knob: a sub-range knob clamps UP to the spec minimum, got ${e.knob.minClamp}`);
    need(e.knob.maxClamp === AUTO_COMPACT_WINDOW_MAX, `② knob: an over-range knob clamps DOWN to the spec maximum, got ${e.knob.maxClamp}`);
    need(e.knob.chainBelowMinUncapped === 64_000, `② knob: the clamp is the knob's own — a chain result below the minimum rides through uncapped, got ${e.knob.chainBelowMinUncapped}`);
    need(e.knob.malformedKnobKeepsChain === 200_000, `② knob: a malformed knob keeps the chain result, got ${e.knob.malformedKnobKeepsChain}`);

    // ---- ③ listModels 三形状 + wire 卫生
    need(
      e.openai.ok && j(e.openai.models) === j([{ name: "deepseek-chat" }, { name: "deepseek-reasoner" }]),
      `③ openai: plain ids parse bare (no contextLength key), got ${j(e.openai)}`,
    );
    need(
      e.openrouter.ok
        && j(e.openrouter.models) === j([
          { name: "or-big", contextLength: 123_456 },
          { name: "or-zero" },
          { name: "or-str" },
          { name: "or-plain" },
        ]),
      `③ openrouter: context_length prefills only positive integers (0/"789" drop it, id-less rows skip), got ${j(e.openrouter.models)}`,
    );
    need(
      !e.notJson.ok && e.notJson.state === "http" && e.notJson.message.includes("不是 JSON"),
      `③ malformed: a non-JSON /models body reads as the http state naming the cause, got ${j(e.notJson)}`,
    );
    need(
      !e.noData.ok && e.noData.state === "http" && e.noData.message.includes("data"),
      `③ malformed: a body without the data array reads as the http state, got ${j(e.noData)}`,
    );
    const dsBase = PROVIDER_PROFILES.deepseek.defaultBaseUrl!;
    need(
      e.wire.length === 4 && e.wire.every((w) => w.url === `${dsBase}/models` && w.auth === "Bearer sk-eval"),
      `③ wire: every probe must be GET ${dsBase}/models with the pasted key's bearer header, got ${j(e.wire)}`,
    );
    need(
      e.listUnknownThrew.includes('unknown provider "ghost"') && e.listUnknownThrew.includes("deepseek, glm, qwen, wudao"),
      `③ matrix: an absent id must throw naming the widened matrix before any fetch, got ${j(e.listUnknownThrew)}`,
    );

    // ---- ④ ProviderName 放宽：内置四家全链不回归
    const expected: Record<string, { readonly baseURL: string; readonly model: string }> = {
      deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash" },
      glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
      qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-max" },
      wudao: { baseURL: "https://wudao-gw.invalid/v1", model: "wudao-preview" },
    };
    for (const row of e.builtinResolve) {
      const exp = expected[row.name];
      need(
        exp !== undefined && row.ok && row.baseURL === exp.baseURL && row.model === exp.model && row.provider === row.name,
        `④ builtin: ${row.name} must resolve through the full chain to its compiled profile, got ${j(row)} (want ${j(exp)})`,
      );
    }
    need(
      !e.wudaoNoUrl.ok && e.wudaoNoUrl.reason.includes("needs WUDAO_BASE_URL"),
      `④ builtin: wudao without an explicit baseUrl still refuses (the gate the widening must not loosen), got ${j(e.wudaoNoUrl)}`,
    );
    need(
      e.customResolve.ok && e.customResolve.baseURL === "https://api.mycorp.invalid/v1" && e.customResolve.model === "mycorp-1" && e.customResolve.provider === "custom-ok",
      `④ widened: a registry custom id resolves against the registry view (baseUrl + defaultModel), got ${j(e.customResolve)}`,
    );
    need(
      e.resolveUnknownThrew.includes('unknown provider "ghost"') && e.resolveUnknownThrew.includes("custom provider from the registry"),
      `④ widened: an unknown id without a registry entry must throw the widened guard's message, got ${j(e.resolveUnknownThrew)}`,
    );
    const closed = Object.fromEntries(e.closedTable.map((r) => [r.name, r.accepted]));
    need(
      j(closed) === j({ deepseek: true, glm: true, qwen: true, wudao: true, "custom-ok": false, zhipu: false }),
      `④ closed: isProviderName stays exactly the builtin four (customs belong to the registry view, not the closed table), got ${j(closed)}`,
    );

    return errs;
  },
};
