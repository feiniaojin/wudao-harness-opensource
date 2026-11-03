// Provider management Task 2 — the CLI-side registry seams, red-first:
// the three hardcoded member tables (boot, /model, the settings matrix) all
// resolve through the effective profile view; the gates (save-key /
// test-connection, /provider validation, the plugin `model:` shorthand)
// widen to registry ids; the context window threads the per-model chain
// (model contextLength → provider default → env) into every build point.
//
// One tmp WUDAO_GLOBAL_HOME for the whole file: the memoized default-path
// read sees the fixture below (overlay + custom + one invalid entry), and
// the explicit-path seam covers the registry-absent cases.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentialsFileSync } from "../src/credentials.js";
import { buildRunPlan } from "../src/run.js";
import { availableModels } from "../src/commands/model.js";
import { createScriptedModel } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { validateProviderName, resolveProviderSwitch, providerRows } from "../src/commands/provider.js";
import { createSettingsOps, buildProviderMatrix, envSelectedProvider } from "../src/driver/settings-ops.js";
import { mapAgentModel } from "../src/plugins.js";
import {
  loadEffectiveProfiles,
  loadProviderRegistry,
  resetProviderRegistryCacheForTests,
  resolveSessionWindowTokens,
} from "../src/provider-registry.js";
import { resolveProviderConfigResult } from "@wudao-org/providers";

let home: string;
let bareHome: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  home = mkdtempSync(join(tmpdir(), "wudao-provreg-"));
  bareHome = mkdtempSync(join(tmpdir(), "wudao-provreg-bare-"));
  process.env.WUDAO_GLOBAL_HOME = home;
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: {
        // overlay: registry models + a provider-level window default
        deepseek: { defaultContextLength: 96000, models: [{ name: "deepseek-chat", contextLength: 128000 }] },
        // custom: fully registered OpenAI-compatible gateway (T4b: an
        // explicit reasoningFormat — the field the wire card must carry so a
        // web edit-save round-trips it instead of dropping it)
        "my-gw": {
          label: "My Gateway",
          baseUrl: "https://gw.example.com/v1",
          defaultModel: "m-x",
          reasoningFormat: "qwen-chat-template",
          defaultContextLength: 200000,
          models: [{ name: "m-big", contextLength: 1000000 }],
        },
        // invalid: a custom without a baseUrl — fail-visible, never resolves
        "broken-entry": { defaultModel: "no-base" },
        // custom saved without defaultModel/models: selectable id, model-less —
        // R-M2: switching to it must refuse naming the fix
        modelless: { baseUrl: "https://modelless.example/v1" },
        // mixed-case id: registry ids are case-sensitive (rider M1)
        "Mixed-Case-Gw": { baseUrl: "https://mc.example/v1", defaultModel: "mc-x" },
      },
    }),
    "utf8",
  );
  resetProviderRegistryCacheForTests();
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(bareHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const e: Record<string, string> = { WUDAO_GLOBAL_HOME: home };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v;
  return e;
};

describe("loadEffectiveProfiles / loadProviderRegistry (the one read seam)", () => {
  it("merges the fixture: 4 builtins + my-gw; the invalid entry never joins", () => {
    const profiles = loadEffectiveProfiles();
    expect(profiles.has("my-gw")).toBe(true);
    expect(profiles.has("deepseek")).toBe(true);
    expect(profiles.has("broken-entry")).toBe(false);
    expect(profiles.get("my-gw")?.custom).toBe(true);
    expect(profiles.get("deepseek")?.custom).toBe(false);
  });
  it("carries the fail-visible invalid rows for the settings page", () => {
    const r = loadProviderRegistry();
    expect(r.invalid).toEqual([{ id: "broken-entry", reason: expect.stringContaining("baseUrl") }]);
  });
  it("an explicit path reads a DIFFERENT registry fresh (isolated home → builtins only)", () => {
    const profiles = loadEffectiveProfiles(join(bareHome, "providers.json"));
    expect([...profiles.keys()]).toEqual(["deepseek", "glm", "qwen", "wudao", "anthropic", "kimi", "minimax", "glm-code", "kimi-code", "minimax-code"]); // 0.3.12: anthropic; 0.3.26: the coding-plan gateways; 0.3.30: kimi/minimax pay APIs
  });
});

describe("run.ts boot — the registry-aware plan", () => {
  it("buildRunPlan resolves a registry custom (baseUrl + defaultModel from the registry)", () => {
    const plan = buildRunPlan({ prompt: "hi", env: env({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "my-gw" }) });
    expect(plan.kind).toBe("real");
    if (plan.kind === "real") {
      expect(plan.config.provider).toBe("my-gw");
      expect(plan.config.baseURL).toBe("https://gw.example.com/v1");
      expect(plan.config.model).toBe("m-x");
      // T4b fixture: my-gw registers an explicit format — the boot config
      // threads it (the same field the wire card now carries for the round-trip).
      expect(plan.config.reasoningFormat).toBe("qwen-chat-template");
    }
  });
  it("an overlay rides the builtin (deepseek-chat beats the compiled default)", () => {
    const plan = buildRunPlan({ prompt: "hi", env: env({ WUDAO_API_KEY: "k" }) });
    expect(plan.kind).toBe("real");
    if (plan.kind === "real") expect(plan.config.model).toBe("deepseek-v4-flash");
  });
  it("an unknown provider still fails fast at boot (the T1 throw shape)", () => {
    expect(() => buildRunPlan({ prompt: "hi", env: env({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "grok" }) })).toThrow(
      /unknown provider "grok"/,
    );
  });
});

describe("/model — availableModels over the effective view", () => {
  it("includes registry models with their contextLength", () => {
    const list = availableModels(env());
    const big = list.find((c) => c.provider === "my-gw" && c.model === "m-big");
    expect(big).toBeDefined();
    expect(big?.source).toBe("registry");
    expect(big?.contextLength).toBe(1000000);
    const overlay = list.find((c) => c.provider === "deepseek" && c.model === "deepseek-chat");
    expect(overlay?.contextLength).toBe(128000);
    expect(overlay?.source).toBe("registry");
  });
  it("the custom's defaultModel row is present (source registry)", () => {
    const row = availableModels(env()).find((c) => c.provider === "my-gw" && c.model === "m-x");
    expect(row?.source).toBe("registry");
  });
  it("the invalid entry's models never appear (fail-visible ≠ selectable)", () => {
    expect(availableModels(env()).some((c) => c.provider === "broken-entry")).toBe(false);
  });
  it("builtin defaults stay profile-sourced rows", () => {
    const row = availableModels(env()).find((c) => c.provider === "glm");
    expect(row?.model).toBe("glm-4.6");
    expect(row?.source).toBe("profile");
  });
  it("the env override rides the WUDAO_PROVIDER owner — including a registry custom", () => {
    const row = availableModels(env({ WUDAO_MODEL: "m-env", WUDAO_PROVIDER: "my-gw" })).find((c) => c.source === "env");
    expect(row?.provider).toBe("my-gw");
    expect(row?.model).toBe("m-env");
  });
  it("T4b (T5-review M1): an uncataloged model inherits the provider-level defaultContextLength; a per-model entry still wins", () => {
    const list = availableModels(env());
    // deepseek's overlay sets defaultContextLength 96000 and catalogs only
    // deepseek-chat (128000): the default model has NO per-model entry, so the
    // provider default must fill its choice (the picker's window placeholder
    // otherwise under-reports the session window).
    const def = list.find((c) => c.provider === "deepseek" && c.model === "deepseek-v4-flash");
    expect(def?.contextLength).toBe(96000);
    // per-model beats provider default …
    const overlay = list.find((c) => c.provider === "deepseek" && c.model === "deepseek-chat");
    expect(overlay?.contextLength).toBe(128000);
    // … and a builtin with NEITHER registry data NOR a doc-verified pin
    // still omits the field (反馈① 收口: glm-4.6 now carries its builtin
    // 204_800 pin; wudao-preview stays uncataloged).
    const glm = list.find((c) => c.provider === "glm" && c.model === "glm-4.6");
    expect(glm?.contextLength).toBe(204_800);
    const wudaoRow = list.find((c) => c.provider === "wudao" && c.model === "wudao-preview");
    expect(wudaoRow !== undefined && "contextLength" in wudaoRow).toBe(false);
  });
});

describe("/provider — validation + switch resolution over the registry", () => {
  it("validateProviderName accepts builtin ∪ registry ids, refuses the rest", () => {
    expect(validateProviderName("my-gw")).toEqual({ ok: true, name: "my-gw" });
    expect(validateProviderName("deepseek")).toEqual({ ok: true, name: "deepseek" });
    expect(validateProviderName("broken-entry").ok).toBe(false);
    expect(validateProviderName("grok").ok).toBe(false);
  });
  it("resolveProviderSwitch lands on the registry custom (endpoint + default model)", () => {
    const r = resolveProviderSwitch({
      target: "my-gw",
      env: env({}),
      current: { apiKey: "live", apiKeys: ["live"], reasoningEffort: undefined, reasoningReplay: undefined },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("my-gw");
      expect(r.config.baseURL).toBe("https://gw.example.com/v1");
      expect(r.config.model).toBe("m-x");
    }
  });
  it("the bare /provider listing includes the registry row", () => {
    const rows = providerRows(env({ WUDAO_API_KEY: "k" }), (name) =>
      resolveProviderSwitch({
        target: name,
        env: env({}),
        current: { apiKey: "k", apiKeys: ["k"], reasoningEffort: undefined, reasoningReplay: undefined },
      }),
    );
    expect(rows.map((r) => r.name)).toContain("my-gw");
    expect(rows.find((r) => r.name === "my-gw")?.dot).toBe("configured");
  });
  it("a custom saved without defaultModel/models refuses the switch naming the fix (R-M2 mirror)", () => {
    // hand-build the degenerate registry shape: custom, no model anywhere
    const r = resolveProviderSwitch({
      target: "modelless",
      env: env({}),
      current: { apiKey: "k", apiKeys: ["k"], reasoningEffort: undefined, reasoningReplay: undefined },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/modelless/);
      expect(r.reason).toBe("needs-model");
    }
  });
  it("an id that is neither builtin nor registered refuses with reason \"unknown\" (M3)", () => {
    const r = resolveProviderSwitch({
      target: "grok",
      env: env({}),
      current: { apiKey: "k", apiKeys: ["k"], reasoningEffort: undefined, reasoningReplay: undefined },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.error).toMatch(/unknown provider "grok"/);
    }
  });
  it("a mixed-case registry id switches exactly (case-sensitive ids)", () => {
    const r = resolveProviderSwitch({
      target: "Mixed-Case-Gw",
      env: env({}),
      current: { apiKey: "k", apiKeys: ["k"], reasoningEffort: undefined, reasoningReplay: undefined },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("Mixed-Case-Gw");
      expect(r.config.baseURL).toBe("https://mc.example/v1");
      expect(r.config.model).toBe("mc-x");
    }
  });
});

describe("settings ops — the widened gates + the merged matrix", () => {
  let ops: ReturnType<typeof createSettingsOps>;
  let fetches: { url: string; auth: string; body: string }[];
  beforeEach(() => {
    fetches = [];
    ops = createSettingsOps({
      env: env({ WUDAO_API_KEY: "k" }),
      workspaceRoot: process.cwd(),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        fetches.push({ url: String(url), auth: String((init?.headers as Record<string, string>)["authorization"]), body: String(init?.body) });
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }] }), { status: 200 });
      }) as typeof fetch,
    });
  });

  it("settingsSaveKey accepts a registry custom id", async () => {
    const r = await ops.settingsSaveKey("my-gw", "gw-key");
    expect(r.saved).toBe(true);
    expect(readCredentialsFileSync(env({}))["my-gw"]).toBe("gw-key");
  });
  it("settingsTestConnection probes the registry custom's endpoint (no throw)", async () => {
    const r = await ops.settingsTestConnection("my-gw");
    expect(r.state).toBe("ok");
    expect(fetches.length).toBe(1);
    expect(fetches[0]?.url).toBe("https://gw.example.com/v1/chat/completions");
    expect(fetches[0]?.auth).toBe("Bearer gw-key"); // the file key saved by the saveKey test above (env pool belongs to the SELECTED provider, deepseek)
    expect(JSON.parse(fetches[0]?.body ?? "{}").model).toBe("m-x");
  });
  it("both gates still refuse ids that are neither builtin nor registered", async () => {
    await expect(ops.settingsSaveKey("grok", "k")).rejects.toThrow(/unknown provider/);
    await expect(ops.settingsTestConnection("grok")).rejects.toThrow(/unknown provider/);
  });
  it("the provider matrix comes from the merged view and badges the invalid entry", () => {
    const matrix = buildProviderMatrix(env({ WUDAO_API_KEY: "k" }), {});
    const gw = matrix.find((c) => c.provider === "my-gw");
    expect(gw?.endpoint).toBe("https://gw.example.com/v1");
    expect(gw?.defaultModel).toBe("m-x");
    expect(gw?.keySource).toBeNull(); // deepseek is the env-selected one; the credentials map is empty
    const broken = matrix.find((c) => c.provider === "broken-entry");
    expect(broken?.invalidReason).toBeTruthy();
  });
  it("T4b: cards map the profile's reasoningFormat — the registry custom's explicit format and the builtins' own (display; overlay saves never ride it)", () => {
    const matrix = buildProviderMatrix(env({ WUDAO_API_KEY: "k" }), {});
    // The custom's REGISTERED format surfaces on its card (the wire half of
    // the round-trip: without it, a web edit-save of the custom replaces the
    // row and silently drops the format).
    expect(matrix.find((c) => c.provider === "my-gw")?.reasoningFormat).toBe("qwen-chat-template");
    // Builtins map theirs too (read-only display semantics — the builtin
    // overlay save payload stays {label, baseUrl, models} and the server's
    // overlay merge preserves the compiled default).
    expect(matrix.find((c) => c.provider === "deepseek")?.reasoningFormat).toBe("deepseek");
    expect(matrix.find((c) => c.provider === "glm")?.reasoningFormat).toBe("zai");
    // The invalid stub row carries no profile — no format to map.
    expect(matrix.find((c) => c.provider === "broken-entry")?.reasoningFormat).toBeUndefined();
  });
  it("envSelectedProvider widens to the registry", () => {
    expect(envSelectedProvider(env({ WUDAO_PROVIDER: "my-gw" }))).toBe("my-gw");
    expect(envSelectedProvider(env({}))).toBe("deepseek");
  });
  it("settingsStatus carries the merged matrix + invalid rows", async () => {
    const status = await ops.settingsStatus();
    expect(status.providers.some((c) => c.provider === "my-gw")).toBe(true);
    expect(status.providers.some((c) => c.provider === "broken-entry")).toBe(true);
  });

  // Task 5 — the defaultModel pick accepts registry ids (the same widened
  // gate the saveKey/testConnection gates got in T2): a custom provider's
  // model may be the persisted default; an id neither builtin nor in the
  // registry still refuses.
  it("model.defaultModel accepts a registry custom id and reads it back", async () => {
    await expect(ops.settingsSet("model.defaultModel", { provider: "my-gw", model: "m-big" })).resolves.toEqual({
      key: "model.defaultModel",
      saved: true,
    });
    const s = await ops.settingsStatus();
    expect(s.defaultModel).toEqual({ provider: "my-gw", model: "m-big" });
  });
  it("model.defaultModel still refuses ids neither builtin nor registered", async () => {
    await expect(ops.settingsSet("model.defaultModel", { provider: "ghost", model: "m" })).rejects.toThrow(
      /known provider/,
    );
  });

  // R-M4 — a modelless custom being the SELECTED provider must not surface a
  // bare "" as settingsStatus.current.model: a placeholder names the state
  // (the invalid/modelless badges carry the fix story). The choices side
  // already filters empty models (availableModels' push drops model "").
  it("a modelless custom as current never exposes a bare empty model string", async () => {
    const modellessOps = createSettingsOps({ env: env({ WUDAO_PROVIDER: "modelless" }), workspaceRoot: process.cwd() });
    const s = await modellessOps.settingsStatus();
    expect(s.current.provider).toBe("modelless");
    expect(s.current.model).not.toBe("");
    expect(typeof s.current.model).toBe("string"); // placeholder, not null/undefined on the wire
    // The switchable choices list never carries an empty model name either.
    expect(availableModels(env({ WUDAO_PROVIDER: "modelless" })).every((c) => c.model !== "")).toBe(true);
  });
});

describe("plugins — the model: shorthand gate", () => {
  it("a bare registry id pins that provider", () => {
    expect(mapAgentModel("my-gw")).toEqual({ provider: "my-gw" });
    expect(mapAgentModel("deepseek")).toEqual({ provider: "deepseek" });
    expect(mapAgentModel("unknown-pick")).toEqual({});
  });
  it("mixed-case registry ids pin EXACTLY; the lowercase fallbacks stay (M1)", () => {
    // raw spelling first — a mixed-case id is a case-sensitive registry key
    expect(mapAgentModel("Mixed-Case-Gw")).toEqual({ provider: "Mixed-Case-Gw" });
    expect(mapAgentModel("mixed-case-gw")).toEqual({ provider: "Mixed-Case-Gw" }); // case-insensitive registry hit
    expect(mapAgentModel("MY-GW")).toEqual({ provider: "my-gw" });
    // the historic builtin tolerance survives
    expect(mapAgentModel("Deepseek")).toEqual({ provider: "deepseek" });
    // a mixed-case id that matches nothing lowercased to nothing pins nothing
    expect(mapAgentModel("Nope-Gw")).toEqual({});
  });
  it("R-N1: one trim semantics — lookups AND the prefix branch return the trimmed value", () => {
    // whitespace never blocks the gate...
    expect(mapAgentModel("  deepseek  ")).toEqual({ provider: "deepseek" });
    expect(mapAgentModel("  my-gw  ")).toEqual({ provider: "my-gw" });
    // ...and the <provider>-… shorthand pins the TRIMMED model, not the raw
    // string (the old branch returned the untrimmed original).
    expect(mapAgentModel("  deepseek-chat  ")).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });
});

describe("the §7 window chain at the CLI layer", () => {
  it("resolveSessionWindowTokens: per-model contextLength beats the env default", () => {
    const w = resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: 64000,
      provider: "my-gw",
      model: "m-big",
    });
    expect(w).toBe(1000000);
  });
  it("provider default covers uncataloged models; env covers registry-absent providers", () => {
    expect(
      resolveSessionWindowTokens({ effective: undefined, envWindowTokens: 64000, provider: "my-gw", model: "m-uncataloged" }),
    ).toBe(200000);
    expect(
      resolveSessionWindowTokens({ effective: undefined, envWindowTokens: 128000, provider: "deepseek", model: "deepseek-v4-flash" }),
    ).toBe(96000); // the overlay's provider-level default
    const w = resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: 64000,
      provider: "deepseek",
      model: "whatever",
      profiles: loadEffectiveProfiles(join(bareHome, "providers.json")),
    });
    expect(w).toBe(64000); // no registry → the env value, byte-identical status quo
  });
  it("the explicit autoCompactWindow knob keeps winning over the per-model value", () => {
    const w = resolveSessionWindowTokens({
      effective: { autoCompactWindow: 150000 },
      envWindowTokens: 64000,
      provider: "my-gw",
      model: "m-big",
    });
    expect(w).toBe(150000);
  });
  it("the boot window equals the per-model value (buildRunPlan + the chain agree)", () => {
    const plan = buildRunPlan({
      prompt: "hi",
      env: env({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "my-gw", WUDAO_MODEL: "m-big" }),
    });
    expect(plan.kind).toBe("real");
    if (plan.kind !== "real") return;
    const w = resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: 64000,
      provider: plan.config.provider,
      model: plan.config.model,
    });
    expect(w).toBe(1000000);
  });
  it("the subagent model resolver resolves registry customs (role pins)", () => {
    // agents/index.ts threads the effective view into resolveProviderConfigResult
    const r = resolveProviderConfigResult(env({ WUDAO_API_KEY: "k" }), { provider: "my-gw" }, undefined, loadEffectiveProfiles());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.baseURL).toBe("https://gw.example.com/v1");
  });
});

// Task 5 — the driver's status picker data (DriverStatus.model.choices) now
// carries each choice's registered contextLength so the UI can show the
// window placeholder (T4 consumes the same contract). The explicit
// availableModels seam pins the mapping; entries without a cataloged window
// keep the field absent (never 0 / null).
describe("DriverStatus.model.choices carries contextLength", () => {
  it("registry-cataloged choices thread their window; uncataloged stay absent", () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "x" }]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      sessionMeta: { provider: "my-gw", model: "m-x" },
      availableModels: [
        { provider: "my-gw", model: "m-big", source: "registry", contextLength: 1000000 },
        { provider: "my-gw", model: "m-x", source: "registry" },
      ],
    });
    const model = driver.getStatus().model;
    expect(model).not.toBeNull();
    const big = model?.choices.find((c) => c.model === "m-big");
    const mx = model?.choices.find((c) => c.model === "m-x");
    expect(big?.contextLength).toBe(1000000);
    expect(mx !== undefined && "contextLength" in mx).toBe(false);
    driver.dispose();
  });
});
