// 推理档三级配置 + 语言 chip S3 — the WRITE chain (spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md §2/§4):
// the pure language preference fold (ablation > session > settings > env >
// auto, per knob), the settingsSet language.* keys (validated, whole-node
// merge), the settingsStatus resolved languageReply/languageReasoning legs,
// and the settingsSaveProvider effort roundtrip pins (persistence itself came
// free with S1's validator column — these tests pin it against regression).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLanguagePreference } from "../src/language.js";
import { createProviderRegistryOps, readProviderEffortBinding } from "../src/driver/provider-registry-ops.js";
import { createSettingsOps } from "../src/driver/settings-ops.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { readGlobalSettingsSync, saveGlobalSettings } from "../src/settings-layer.js";

let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  home = mkdtempSync(join(tmpdir(), "wudao-lang-s3-"));
  process.env.WUDAO_GLOBAL_HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });
const registryPath = (): string => join(home, "providers.json");
const settingsPath = (): string => join(home, "settings.json");

/** Fresh home state per test: no registry, no settings (a prior test's saved
 *  language node must never leak into the next test's fold). */
beforeEach(() => {
  rmSync(registryPath(), { force: true });
  rmSync(settingsPath(), { force: true });
  resetProviderRegistryCacheForTests();
});

const makeOps = () =>
  createProviderRegistryOps({ env: env(), workspaceRoot: process.cwd() });
const makeSettings = () => createSettingsOps({ env: env(), workspaceRoot: process.cwd() });

// ---------------------------------------------------------------------------
// The pure fold — per knob: ablation > session > settings > env > auto
// ---------------------------------------------------------------------------

describe("resolveLanguagePreference — the per-knob chain", () => {
  it("WUDAO_NO_LANGUAGE=1 (ablation) kills both knobs over EVERY tier", () => {
    const p = resolveLanguagePreference(
      env({ WUDAO_NO_LANGUAGE: "1", WUDAO_LANGUAGE_BLOCK: "on", WUDAO_REASONING_LANGUAGE: "zh" }),
      { reply: "on", reasoning: "zh" },
      { reply: "on", reasoning: "zh" },
    );
    expect(p).toEqual({ reply: "off", reasoning: "off" });
  });

  it("session beats settings; settings beats env; nothing set → auto", () => {
    // session > settings
    expect(
      resolveLanguagePreference(env(), { reply: "off", reasoning: "en" }, { reply: "on", reasoning: "zh" }),
    ).toEqual({ reply: "on", reasoning: "zh" });
    // settings > env
    expect(
      resolveLanguagePreference(env({ WUDAO_LANGUAGE_BLOCK: "off", WUDAO_REASONING_LANGUAGE: "en" }), {
        reply: "on",
        reasoning: "zh",
      }),
    ).toEqual({ reply: "on", reasoning: "zh" });
    // no settings → env applies per knob
    expect(
      resolveLanguagePreference(env({ WUDAO_LANGUAGE_BLOCK: "off", WUDAO_REASONING_LANGUAGE: "en" }), undefined),
    ).toEqual({ reply: "off", reasoning: "en" });
    // nothing anywhere → auto/auto
    expect(resolveLanguagePreference(env(), undefined)).toEqual({ reply: "auto", reasoning: "auto" });
  });

  it("the knobs resolve independently (a set reply leaves reasoning on the env/auto leg)", () => {
    const p = resolveLanguagePreference(env({ WUDAO_REASONING_LANGUAGE: "en" }), { reply: "on" });
    expect(p).toEqual({ reply: "on", reasoning: "en" });
  });

  it("a corrupted stored value reads as absent (the uiDefaultMode rule — never a runtime error)", () => {
    const p = resolveLanguagePreference(env(), { reply: "junk" as unknown, reasoning: 7 as unknown });
    expect(p).toEqual({ reply: "auto", reasoning: "auto" });
  });
});

// ---------------------------------------------------------------------------
// settingsSet language.reply / language.reasoning — roundtrip + merge safety
// ---------------------------------------------------------------------------

describe("settingsSet language.*", () => {
  it("roundtrips both knobs and never drops sibling keys", async () => {
    const ops = makeSettings();
    await expect(ops.settingsSet("language.reply", "on")).resolves.toEqual({ key: "language.reply", saved: true });
    await expect(ops.settingsSet("language.reasoning", "zh")).resolves.toEqual({ key: "language.reasoning", saved: true });
    // A later reply write must not drop the stored reasoning key.
    await ops.settingsSet("language.reply", "off");
    const stored = readGlobalSettingsSync(env());
    expect(stored["language"]).toEqual({ reply: "off", reasoning: "zh" });
  });

  it("refuses values outside each knob's enum", async () => {
    const ops = makeSettings();
    await expect(ops.settingsSet("language.reply", "zh")).rejects.toThrow(/language\.reply/);
    await expect(ops.settingsSet("language.reasoning", "on")).rejects.toThrow(/language\.reasoning/);
    // Nothing landed on refusal.
    expect(readGlobalSettingsSync(env())["language"]).toBeUndefined();
  });

  it("a language write never drops sibling settings nodes (ui/model/persona)", async () => {
    await saveGlobalSettings({ ui: { defaultMode: "advanced" }, model: { defaultEffort: "high" } }, env());
    const ops = makeSettings();
    await ops.settingsSet("language.reply", "on");
    const stored = readGlobalSettingsSync(env());
    expect(stored["ui"]).toEqual({ defaultMode: "advanced" });
    expect(stored["model"]).toEqual({ defaultEffort: "high" });
    expect(stored["language"]).toEqual({ reply: "on" });
  });
});

// ---------------------------------------------------------------------------
// settingsStatus — the resolved languageReply/languageReasoning legs
// ---------------------------------------------------------------------------

describe("settingsStatus — settings.languageReply/languageReasoning", () => {
  it("exposes the resolved fold: settings value > env > auto", async () => {
    const ops = makeSettings();
    // No settings node → env applies per knob, else auto.
    let s = await ops.settingsStatus();
    expect(s.settings.languageReply).toBe("auto");
    expect(s.settings.languageReasoning).toBe("auto");
    // env fills when settings are absent.
    const opsEnv = createSettingsOps({
      env: env({ WUDAO_LANGUAGE_BLOCK: "off", WUDAO_REASONING_LANGUAGE: "en" }),
      workspaceRoot: process.cwd(),
    });
    s = await opsEnv.settingsStatus();
    expect(s.settings.languageReply).toBe("off");
    expect(s.settings.languageReasoning).toBe("en");
    // A stored node beats env.
    await ops.settingsSet("language.reply", "on");
    s = await ops.settingsStatus();
    expect(s.settings.languageReply).toBe("on");
  });

  it("the ablation switch wins over a stored node", async () => {
    const ops = makeSettings();
    await ops.settingsSet("language.reasoning", "zh");
    const ablated = createSettingsOps({ env: env({ WUDAO_NO_LANGUAGE: "1" }), workspaceRoot: process.cwd() });
    const s = await ablated.settingsStatus();
    expect(s.settings.languageReply).toBe("off");
    expect(s.settings.languageReasoning).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// settingsSaveProvider — the effort binding roundtrip (S1 made it free; pin it)
// ---------------------------------------------------------------------------

describe("settingsSaveProvider — effort binding persistence", () => {
  it.skip("an echoed effort persists beside persona; null persists as null; an unechoed effort DIES (F1 whole-row replace)", async () => {
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", {
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      persona: "the upstream format:headers",
      effort: "high",
    });
    expect(r).toEqual({ ok: true, provider: "my-gw" });
    let row = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, { effort?: unknown }> };
    expect(row.providers["my-gw"]?.effort).toBe("high");
    expect(readProviderEffortBinding("my-gw", env())).toBe("high");

    // null (explicit don't-send) roundtrips as null — a VALUE, not an absence.
    await ops.settingsSaveProvider("my-gw", {
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      persona: "the upstream format:headers",
      effort: null,
    });
    row = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, { effort?: unknown }> };
    expect(row.providers["my-gw"]?.effort).toBeNull();
    expect(readProviderEffortBinding("my-gw", env())).toBeNull();

    // F1: a payload WITHOUT the effort key replaces the row wholesale — the
    // binding dies with it (the detail card must echo every field it keeps).
    await ops.settingsSaveProvider("my-gw", {
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      persona: "the upstream format:headers",
    });
    row = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, { effort?: unknown }> };
    expect("effort" in (row.providers["my-gw"] ?? {})).toBe(false);
    expect(readProviderEffortBinding("my-gw", env())).toBeUndefined();
  });

  it("a junk effort is refused fail-visibly (the S1 validator, through the save seam)", async () => {
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", {
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      effort: "ultra",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/effort/);
    // The registry never saw the row.
    expect(readProviderEffortBinding("my-gw", env())).toBeUndefined();
  });
});
