import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import { buildRunPlan, buildUiBootPlan, formatOneShotResumeLine, lastModelState, modelStateDivergence, recordModelState } from "../src/run.js";
import { WIZARD_PLACEHOLDER_KEY } from "../src/credentials.js";

describe("buildRunPlan", () => {
  it("returns a 'no-key' plan when no provider config resolves", () => {
    const plan = buildRunPlan({ prompt: "hi", env: {} });
    expect(plan.kind).toBe("no-key");
  });
  it("returns a 'real' plan with the provider config when a key is set", () => {
    // R3-T002 随源演进：哨兵形——目录外模型须有网关覆盖（否则选型时刻拒）。
    const plan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k", WUDAO_MODEL: "wudao-1", WUDAO_BASE_URL: "https://gw.example/v1" } });
    expect(plan.kind).toBe("real");
    if (plan.kind === "real") expect(plan.config.model).toBe("wudao-1");
  });
});

describe("buildRunPlan — provider selection", () => {
  it("passes the --provider selection through to the resolved config", () => {
    const plan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k" }, provider: "glm" });
    expect(plan.kind).toBe("real");
    if (plan.kind === "real") {
      expect(plan.config.provider).toBe("glm");
      expect(plan.config.model).toBe("glm-4.6");
    }
  });
  it("passes the --reasoning-effort selection through", () => {
    const plan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k" }, reasoningEffort: "max" });
    if (plan.kind === "real") expect(plan.config.reasoningEffort).toBe("max");
  });
  it("reads WUDAO_PROVIDER / WUDAO_REASONING_EFFORT from env", () => {
    const plan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "qwen", WUDAO_REASONING_EFFORT: "low" } });
    if (plan.kind === "real") {
      expect(plan.config.provider).toBe("qwen");
      expect(plan.config.reasoningEffort).toBe("low");
    }
  });
  it("throws on an unknown provider name", () => {
    expect(() => buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k" }, provider: "bogus" })).toThrow(/unknown provider "bogus"/);
  });
  it("throws on an invalid reasoning effort", () => {
    expect(() => buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k" }, reasoningEffort: "ultra" })).toThrow(/invalid reasoning effort "ultra"/);
  });
  it("wudao without WUDAO_BASE_URL → no-key plan carrying the reason", () => {
    const plan = buildRunPlan({ prompt: "hi", env: { WUDAO_API_KEY: "k" }, provider: "wudao" });
    expect(plan.kind).toBe("no-key");
    if (plan.kind === "no-key") expect(plan.reason).toBe("wudao provider needs WUDAO_BASE_URL");
  });
  it("plain no-key plan has no reason (byte-stable guidance)", () => {
    const plan = buildRunPlan({ prompt: "hi", env: {} });
    if (plan.kind === "no-key") expect(plan.reason).toBeUndefined();
  });
  // R3-T002 续（默认 provider 键）：无旗标无 env 时，设置存的默认 pick 连
  // provider 一起生效；旗标/env 仍胜出（优先序 --provider > env > 设置）。
  it("stored pick 的 provider 在无显式选择时生效（glm-code boot）", async () => {
    const plan = buildRunPlan({
      prompt: "hi",
      env: { WUDAO_API_KEY: "k" },
      credentials: { "glm-code": "sk-glm" },
      storedModelDefaults: { model: { provider: "glm-code" as never, model: "glm-5.3" } },
    });
    expect(plan.kind).toBe("real");
    if (plan.kind === "real") {
      expect(plan.config.provider).toBe("glm-code");
      expect(plan.config.model).toBe("glm-5.3");
    }
    // 旗标胜出
    const flagged = buildRunPlan({
      prompt: "hi",
      env: { WUDAO_API_KEY: "k" },
      provider: "qwen",
      storedModelDefaults: { model: { provider: "glm-code" as never, model: "glm-5.3" } },
    });
    if (flagged.kind === "real") expect(flagged.config.provider).toBe("qwen");
    // env 胜出
    const envPinned = buildRunPlan({
      prompt: "hi",
      env: { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" },
      storedModelDefaults: { model: { provider: "glm-code" as never, model: "glm-5.3" } },
    });
    if (envPinned.kind === "real") expect(envPinned.config.provider).toBe("glm");
  });
});

// ---------------------------------------------------------------------------
// M63 §C — the `wudao ui` boot plan: readiness join first (a file key ANYWHERE
// boots that provider for real), the wizard placeholder when nobody is ready,
// exit only when not even a placeholder resolves.
// ---------------------------------------------------------------------------
describe("buildUiBootPlan", () => {
  it("a resolving env key → real, no notice", () => {
    const p = buildUiBootPlan({ prompt: "", env: { WUDAO_API_KEY: "k" } });
    expect(p.kind).toBe("real");
    if (p.kind === "real") {
      expect(p.config.provider).toBe("deepseek");
      expect(p.notice).toBeUndefined();
    }
  });

  it("no key anywhere → wizard: placeholder config for the selected provider (sentinel key, real endpoint/model)", () => {
    const p = buildUiBootPlan({ prompt: "", env: {}, credentials: {} });
    expect(p.kind).toBe("wizard");
    if (p.kind !== "wizard") return;
    expect(p.config.provider).toBe("deepseek");
    expect(p.config.apiKey).toBe(WIZARD_PLACEHOLDER_KEY);
    expect(p.config.apiKeys).toBeUndefined();
    expect(p.config.baseURL).toBe("https://api.deepseek.com");
    expect(p.config.model).toBe("deepseek-v4-flash");
    expect(p.notice).toContain("新手向导");
  });

  it("the placeholder mirrors the real resolution (env model + effort carry) — only the key is blank", () => {
    // R3-T002 随源演进：目录外模型须有网关覆盖（哨兵形）；镜像断言不变。
    const p = buildUiBootPlan({ prompt: "", env: { WUDAO_MODEL: "deepseek-r2", WUDAO_BASE_URL: "https://gw.example/v1", WUDAO_REASONING_EFFORT: "high" }, credentials: {} });
    if (p.kind !== "wizard") throw new Error("expected wizard");
    expect(p.config.model).toBe("deepseek-r2");
    expect(p.config.reasoningEffort).toBe("high");
  });

  it("--provider flag rides the placeholder (qwen)", () => {
    const p = buildUiBootPlan({ prompt: "", env: {}, provider: "qwen", credentials: {} });
    if (p.kind !== "wizard") throw new Error("expected wizard");
    expect(p.config.provider).toBe("qwen");
    expect(p.config.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("readiness join: a file key for ANOTHER provider boots it for real, with a naming notice", () => {
    // deepseek selected (default) but only glm has a file key → boot glm.
    const p = buildUiBootPlan({ prompt: "", env: {}, credentials: { glm: "sk-glm-file" } });
    expect(p.kind).toBe("real");
    if (p.kind === "real") {
      expect(p.config.provider).toBe("glm");
      expect(p.config.apiKey).toBe("sk-glm-file");
      expect(p.notice).toContain("booting glm");
    }
  });

  it("the ready-and-selected file key still resolves through buildRunPlan's own fallback (no notice)", () => {
    const p = buildUiBootPlan({ prompt: "", env: {}, credentials: { deepseek: "sk-ds" } });
    expect(p.kind).toBe("real");
    if (p.kind === "real") {
      expect(p.config.provider).toBe("deepseek");
      expect(p.notice).toBeUndefined();
    }
  });

  it("exit only when not even a placeholder resolves: wudao selected, no URL, nothing ready", () => {
    const p = buildUiBootPlan({ prompt: "", env: {}, provider: "wudao", credentials: {} });
    expect(p.kind).toBe("exit");
    if (p.kind === "exit") {
      expect(p.message).toContain("wudao provider needs WUDAO_BASE_URL");
      expect(p.message).toContain("新手向导");
    }
    // ...but a ready file key for another provider boots instead of exiting.
    const rescued = buildUiBootPlan({ prompt: "", env: {}, provider: "wudao", credentials: { glm: "k" } });
    expect(rescued.kind).toBe("real");
  });

  it("WUDAO_PROVIDER from the PROCESS env rides the placeholder (review LOW 1)", () => {
    // index.ts omits input.env in production — the selected provider must
    // come from the same env the matrix was built with.
    const p = buildUiBootPlan({ prompt: "", env: { WUDAO_PROVIDER: "qwen" }, credentials: {} });
    if (p.kind !== "wizard") throw new Error("expected wizard");
    expect(p.config.provider).toBe("qwen");
  });

  it("the readiness-substitution boot carries --reasoning-effort (review LOW 2)", () => {
    const p = buildUiBootPlan({ prompt: "", env: {}, reasoningEffort: "high", credentials: { glm: "sk-glm-file" } });
    expect(p.kind).toBe("real");
    if (p.kind === "real") {
      expect(p.config.provider).toBe("glm");
      expect(p.config.reasoningEffort).toBe("high");
    }
  });

  it("a wudao URL via env makes the wudao placeholder bootable", () => {
    const p = buildUiBootPlan({ prompt: "", env: { WUDAO_BASE_URL: "https://gw.example/v1" }, provider: "wudao", credentials: {} });
    if (p.kind !== "wizard") throw new Error("expected wizard");
    expect(p.config.baseURL).toBe("https://gw.example/v1");
  });
});

// ---------------------------------------------------------------------------
// M25 §A3: one-shot resume banner — `resumed <id> (N messages)`; M28: when the
// session carries model-state entries the line shows the last model + effort.
// ---------------------------------------------------------------------------

describe("formatOneShotResumeLine", () => {
  it("composes id + message count (legacy sessions without model-state entries)", () => {
    expect(formatOneShotResumeLine("wudao-m1-abcd1234", 12)).toBe("已恢复 wudao-m1-abcd1234（12 条消息）"); // ω99-172: 钉随源演进
  });
  it("count is the caller's business (empty → the caller skips the line)", () => {
    expect(formatOneShotResumeLine("abc12345", 0)).toBe("已恢复 abc12345（0 条消息）"); // ω99-172: 钉随源演进
  });
  it("with model state: resumed <id> · last model: <model> (effort <level>)", () => {
    expect(formatOneShotResumeLine("wudao-m1", 12, { model: "deepseek-v4-flash", provider: "deepseek", effort: "high" }))
      .toBe("已恢复 wudao-m1 · 上次模型：deepseek-v4-flash（推理档 high）"); // ω99-172: 钉随源演进
  });
  it("non-default providers are disambiguated; missing effort reads as off", () => {
    expect(formatOneShotResumeLine("wudao-m1", 3, { model: "glm-4.6", provider: "glm" }))
      .toBe("已恢复 wudao-m1 · 上次模型：glm · glm-4.6（推理档 off）"); // ω99-172: 钉随源演进
  });
  it("an explicit off transition is displayed as off", () => {
    expect(formatOneShotResumeLine("s", 1, { model: "glm-4.6", provider: "glm", effort: "off" }))
      .toBe("已恢复 s · 上次模型：glm · glm-4.6（推理档 off）"); // ω99-172: 钉随源演进
  });
});

// ---------------------------------------------------------------------------
// M28: model-state entries — deriving the last recorded state from session
// entries and deciding whether this run diverges from it.
// ---------------------------------------------------------------------------

describe("lastModelState", () => {
  it("empty session → no state", () => {
    expect(lastModelState([])).toEqual({});
  });
  it("last model_change / thinking_level_change in entry order win", () => {
    const entries = [
      { type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "t1" },
      { role: "user", content: "hi" },
      { type: "thinking_level_change", level: "high" },
      { type: "model_change", model: "glm-4.6", provider: "glm", at: "t2" },
      { role: "assistant", content: "hello" },
      { type: "thinking_level_change", level: "off" },
    ] as const;
    expect(lastModelState(entries)).toEqual({ model: "glm-4.6", provider: "glm", effort: "off" });
  });
  it("model state without any thinking-level entry carries no effort", () => {
    expect(lastModelState([{ type: "model_change", model: "qwen3-max", provider: "qwen", at: "t" }])).toEqual({
      model: "qwen3-max",
      provider: "qwen",
    });
  });
});

describe("modelStateDivergence", () => {
  const NOW = new Date("2026-08-16T02:00:00.000Z");
  const ds = { provider: "deepseek" as const, model: "deepseek-v4-flash" };

  it("fresh session records its initial model; no effort entry when none is configured", () => {
    const d = modelStateDivergence(ds, {}, NOW);
    expect(d).toEqual({ modelChange: { type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-08-16T02:00:00.000Z" } });
    expect(d.effortChange).toBeUndefined();
  });
  it("fresh session with an effort records model + level", () => {
    const d = modelStateDivergence({ ...ds, reasoningEffort: "high" }, {}, NOW);
    expect(d.modelChange).toBeDefined();
    expect(d.effortChange).toEqual({ type: "thinking_level_change", level: "high" });
  });
  it("identical state on resume → no entries", () => {
    expect(modelStateDivergence(ds, { model: "deepseek-v4-flash", provider: "deepseek", effort: "off" }, NOW)).toEqual({});
    expect(
      modelStateDivergence(
        { ...ds, reasoningEffort: "high" },
        { model: "deepseek-v4-flash", provider: "deepseek", effort: "high" },
        NOW,
      ),
    ).toEqual({});
  });
  it("provider change → model_change (same model name, different provider)", () => {
    const d = modelStateDivergence(
      { provider: "glm", model: "glm-4.6" },
      { model: "glm-4.6", provider: "wudao", effort: "off" },
      NOW,
    );
    expect(d.modelChange).toEqual({ type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-08-16T02:00:00.000Z" });
    expect(d.effortChange).toBeUndefined();
  });
  it("effort change on resume → thinking_level_change (including transitions to off)", () => {
    const toOff = modelStateDivergence(ds, { model: "deepseek-v4-flash", provider: "deepseek", effort: "high" }, NOW);
    expect(toOff.modelChange).toBeUndefined();
    expect(toOff.effortChange).toEqual({ type: "thinking_level_change", level: "off" });
    const toMax = modelStateDivergence(
      { ...ds, reasoningEffort: "max" },
      { model: "deepseek-v4-flash", provider: "deepseek", effort: "low" },
      NOW,
    );
    expect(toMax.effortChange).toEqual({ type: "thinking_level_change", level: "max" });
  });
  it("model change and effort change can both fire in one resume", () => {
    const d = modelStateDivergence(
      { provider: "glm", model: "glm-4.6", reasoningEffort: "high" },
      { model: "deepseek-v4-flash", provider: "deepseek", effort: "off" },
      NOW,
    );
    expect(d.modelChange?.model).toBe("glm-4.6");
    expect(d.effortChange?.level).toBe("high");
  });
  it("entries without a provider omit the field", () => {
    const d = modelStateDivergence({ model: "custom-model" }, {}, NOW);
    expect(d.modelChange).toEqual({ type: "model_change", model: "custom-model", at: "2026-08-16T02:00:00.000Z" });
  });
});

// End-to-end composition over the REAL store: two runs in one session — a
// fresh run records its initial model before any message; a diverging resume
// records the switch before its messages; --continue displays the last state.
describe("model-state wiring over the real session store", () => {
  it("run 1 (fresh) → run 2 (switched provider+effort) → resume line shows the last model", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-model-state-"));
    try {
      const store = createJsonlSessionStore(root);

      // Run 1: fresh session, glm @ high.
      const run1 = buildRunPlan({ prompt: "p", env: { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" }, reasoningEffort: "high" });
      expect(run1.kind).toBe("real");
      if (run1.kind !== "real") return;
      const last1 = lastModelState(await store.loadSessionEntries("sess"));
      expect(last1).toEqual({}); // fresh
      await recordModelState(store, "sess", run1.config, last1);
      await store.append("sess", { role: "user", content: "first turn" });
      await store.append("sess", { role: "assistant", content: "first answer" });

      // Entries precede every message in the file.
      const afterRun1 = await store.loadSessionEntries("sess");
      expect(afterRun1[0]?.type).toBe("model_change");
      expect(afterRun1[1]?.type).toBe("thinking_level_change");
      expect(afterRun1[2]).toEqual({ role: "user", content: "first turn" });
      // The message view is untouched.
      expect(await store.load("sess")).toEqual([
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first answer" },
      ]);

      // Run 2: resume the same session with qwen @ no effort — divergence
      // recorded before this run's messages land.
      const run2 = buildRunPlan({ prompt: "p", env: { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "qwen" } });
      expect(run2.kind).toBe("real");
      if (run2.kind !== "real") return;
      const last2 = lastModelState(await store.loadSessionEntries("sess"));
      expect(last2).toEqual({ model: "glm-4.6", provider: "glm", effort: "high" });
      await recordModelState(store, "sess", run2.config, last2);
      await store.append("sess", { role: "user", content: "second turn" });

      const afterRun2 = await store.loadSessionEntries("sess");
      const kinds = afterRun2.map((e) => e.type ?? e.role);
      // The switch entries sit between run 1's messages and run 2's message.
      expect(kinds).toEqual([
        "model_change", "thinking_level_change",
        "user", "assistant",
        "model_change", "thinking_level_change",
        "user",
      ]);

      // --continue startup line names the last model + effort.
      const finalState = lastModelState(afterRun2);
      expect(formatOneShotResumeLine("sess", 3, finalState)).toBe(
        "已恢复 sess · 上次模型：qwen · qwen3-max（推理档 off）", // ω99-172: 钉随源演进
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// R6 quickwin — the Ctrl+S pick defaults reach the `wudao ui` boot: pure
// input seam (index.ts reads the global tier and passes the already-read
// StoredModelDefaults), applied to EVERY config this boot resolves (real /
// ready-substitution / wizard placeholder) with flag/env precedence.
describe("buildUiBootPlan — stored pick defaults (r6 quickwin)", () => {
  // 机器态隔离（gate 红 2026-08-30）：S2 的 per-provider effort binding 经
  // defaultProviderRegistryPath 读真实 ~/.wudao/providers.json——开发机上
  // 已存在 deepseek.effort 绑定，污染 fold 结果（stored 'max' 被顶成
  // 'medium'）。全部 env 钉进一次性家目录，注册表读取确定性为空。
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "wudao-run-test-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });

  const dm = { provider: "deepseek", model: "deepseek-v4-pro" };

  it("applies the stored model + effort when nothing explicit pins them (real boot)", () => {
    const p = buildUiBootPlan({
      prompt: "",
      env: env({ WUDAO_API_KEY: "k" }),
      storedModelDefaults: { model: dm, effort: "max" },
    });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.model).toBe("deepseek-v4-pro");
    expect(p.config.reasoningEffort).toBe("max");
  });

  it("the wizard placeholder boot applies them too (byte-identical to a keyed boot)", () => {
    const p = buildUiBootPlan({
      prompt: "",
      env: env({}),
      credentials: {},
      storedModelDefaults: { model: dm, effort: "high" },
    });
    if (p.kind !== "wizard") throw new Error("expected wizard");
    expect(p.config.model).toBe("deepseek-v4-pro");
    expect(p.config.reasoningEffort).toBe("high");
    expect(p.config.apiKey).toBe(WIZARD_PLACEHOLDER_KEY); // the ghost-key shape survives the fold
  });

  it("explicit wins: WUDAO_MODEL / the --reasoning-effort flag / env effort beat the stored values", () => {
    const envModel = buildUiBootPlan({
      prompt: "",
      // R3-T002 随源演进：目录外模型须有网关覆盖（哨兵形），显式胜出断言不变。
      env: env({ WUDAO_API_KEY: "k", WUDAO_MODEL: "env-model", WUDAO_BASE_URL: "https://gw.example/v1" }),
      storedModelDefaults: { model: dm, effort: "max" },
    });
    if (envModel.kind !== "real") throw new Error("expected real");
    expect(envModel.config.model).toBe("env-model");
    const flagEffort = buildUiBootPlan({
      prompt: "",
      env: env({ WUDAO_API_KEY: "k" }),
      reasoningEffort: "low",
      storedModelDefaults: { effort: "max" },
    });
    if (flagEffort.kind !== "real") throw new Error("expected real");
    expect(flagEffort.config.reasoningEffort).toBe("low");
    const envEffort = buildUiBootPlan({
      prompt: "",
      env: env({ WUDAO_API_KEY: "k", WUDAO_REASONING_EFFORT: "low" }),
      storedModelDefaults: { effort: "max" },
    });
    if (envEffort.kind !== "real") throw new Error("expected real");
    expect(envEffort.config.reasoningEffort).toBe("low");
  });

  it("R3-T002 续随源演进：stored 默认现在连 provider 一起选（旧「跨行不应用」假设退役）", () => {
    // 旧语义：boot 恒 deepseek，存了他行的默认只等 provider 匹配才补模型。
    // 新语义（用户令「优先 glm」）：无旗标/env 时 stored 的 provider 就是
    // boot provider——成对生效；旗标/env 仍胜出（见 buildRunPlan 钉）。
    const p = buildUiBootPlan({
      prompt: "",
      env: env({ WUDAO_API_KEY: "k" }),
      storedModelDefaults: { model: { provider: "glm", model: "glm-4.6" }, effort: "max" },
    });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.provider).toBe("glm");
    expect(p.config.model).toBe("glm-4.6");
    expect(p.config.reasoningEffort).toBe("max"); // effort is provider-free
  });

  it("the readiness-substitution boot folds them as well", () => {
    const p = buildUiBootPlan({
      prompt: "",
      env: env({}),
      credentials: { glm: "sk-glm-file" },
      storedModelDefaults: { model: { provider: "glm", model: "glm-4-air" } },
    });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.provider).toBe("glm");
    expect(p.config.model).toBe("glm-4-air");
  });

  it("no stored defaults input → byte-identical to the old resolution", () => {
    const p = buildUiBootPlan({ prompt: "", env: env({ WUDAO_API_KEY: "k" }) });
    if (p.kind !== "real") throw new Error("expected real");
    expect(p.config.model).toBe("deepseek-v4-flash");
    expect(p.config.reasoningEffort).toBeUndefined();
  });
});
