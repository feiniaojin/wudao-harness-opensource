// Runtime provider registry (Task 1 of the provider-management plan):
// ~/.wudao/providers.json → validated user entries → the effective profile
// view (builtins ⊕ overlays ⊕ customs) → context-window resolution and the
// resolveProviderConfigResult registry leg. Pure functions + fs seams; every
// fs test runs in its own tmpdir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProviderRegistrySync,
  writeProviderRegistrySync,
  effectiveProfiles,
  validateUserProviderEntry,
  resolveContextWindowTokens,
  defaultProviderRegistryPath,
  isBuiltinProviderName,
  resolveProviderConfigResult,
} from "../src/index.js";

// 反馈① 收口 (2026-08-29 夜): the doc-verified builtin context pins. The
// authoritative copy (with sources) lives on PROVIDER_PROFILES in config.ts;
// this local mirror lets the merge tests assert shapes without re-importing
// internals — if config.ts pins change, update both (config.test.ts snapshots
// fail first anyway).
const PROFILE_PIN_SNAPSHOT = {
  deepseek: [
    { name: "deepseek-v4-flash", contextLength: 1_000_000 },
    { name: "deepseek-v4-pro", contextLength: 1_000_000 },
    { name: "deepseek-v4-flash-vision-exp", contextLength: 1_000_000 },
  ],
  glm: [{ name: "glm-4.6", contextLength: 204_800 }],
  qwen: [{ name: "qwen3-max", contextLength: 262_144 }],
} as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "provider-registry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isBuiltinProviderName", () => {
  it("accepts exactly the five builtin ids (0.3.12: +anthropic)", () => {
    for (const id of ["deepseek", "glm", "qwen", "wudao", "anthropic"]) expect(isBuiltinProviderName(id)).toBe(true);
  });
  it("rejects everything else (case, prefixes, ids, empties)", () => {
    for (const id of ["", "DEEPSEEK", "Deepseek", "openai", "my-gateway", "1abc", "deep-seek", "deepseek ", "grok"]) {
      expect(isBuiltinProviderName(id)).toBe(false);
    }
  });
});

describe("validateUserProviderEntry", () => {
  it("accepts a minimal custom entry (baseUrl only) and sanitizes unknown fields away", () => {
    const r = validateUserProviderEntry("my-gw", { baseUrl: "https://gw.example.com/v1", futureField: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ baseUrl: "https://gw.example.com/v1" });
    }
  });
  it("accepts a builtin overlay without baseUrl (overlay ≠ custom)", () => {
    const r = validateUserProviderEntry("deepseek", { defaultContextLength: 64000 });
    expect(r.ok).toBe(true);
  });
  it("requires the id to match the credentials id charset", () => {
    for (const id of ["1abc", "has space", "a.b", "-lead", "_lead", ""]) {
      const r = validateUserProviderEntry(id, { baseUrl: "https://gw/v1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/id/);
    }
  });
  it("requires http(s) baseUrl when present", () => {
    for (const baseUrl of ["ftp://x", "notaurl", ""]) {
      const r = validateUserProviderEntry("my-gw", { baseUrl });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/baseUrl/);
    }
  });
  it("requires custom (non-builtin) entries to carry a baseUrl", () => {
    const r = validateUserProviderEntry("my-gw", { defaultModel: "m-x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/baseUrl/);
  });
  it("bounds defaultContextLength to a positive integer ≤ 10,000,000", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 10_000_001]) {
      expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", defaultContextLength: bad }).ok).toBe(false);
    }
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", defaultContextLength: 1 }).ok).toBe(true);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", defaultContextLength: 10_000_000 }).ok).toBe(true);
  });
  it("validates model entries: non-empty unique names, bounded contextLength", () => {
    expect(
      validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", models: [{ name: "m-x" }, { name: "m-x" }] }).ok,
    ).toBe(false);
    expect(
      validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", models: [{ name: "" }] }).ok,
    ).toBe(false);
    expect(
      validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", models: [{ name: "m", contextLength: 0 }] }).ok,
    ).toBe(false);
    expect(
      validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", models: [{ name: "m", contextLength: 10_000_001 }] }).ok,
    ).toBe(false);
    expect(
      validateUserProviderEntry("my-gw", {
        baseUrl: "https://gw/v1",
        models: [{ name: "m-x", contextLength: 1000000 }, { name: "m-lite" }],
      }).ok,
    ).toBe(true);
  });
  it("checks reasoningFormat against the matrix and windowMode against the union", () => {
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", reasoningFormat: "bogus" }).ok).toBe(false);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", reasoningFormat: "openrouter" }).ok).toBe(true);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", windowMode: "tokens" }).ok).toBe(false);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", windowMode: "shared" }).ok).toBe(true);
  });
  it("0.3.13 #215: wire must be one of the protocol ids (fail-visible, not silently dropped)", () => {
    const ok = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", wire: "anthropic" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.wire).toBe("anthropic");
    const ok2 = validateUserProviderEntry("gw", { baseUrl: "https://g/v1" });
    expect(ok2.ok && ok2.value.wire).toBeUndefined(); // absence is a choice
    const bad = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", wire: "grpc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("openai-chat");
    const badType = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", wire: 7 });
    expect(badType.ok).toBe(false);
  });

  it("rejects non-object entries and wrong-typed known fields", () => {
    for (const cfg of ["str", 42, null, true, ["array"]]) {
      expect(validateUserProviderEntry("my-gw", cfg).ok).toBe(false);
    }
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", label: 7 }).ok).toBe(false);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", thinkingLevelMap: { high: 3 } }).ok).toBe(false);
    expect(validateUserProviderEntry("my-gw", { baseUrl: "https://gw/v1", supportsReasoningEffort: "yes" }).ok).toBe(false);
  });
});

describe("readProviderRegistrySync — fault tolerance", () => {
  it("missing file → empty entries, no invalid", () => {
    const r = readProviderRegistrySync(join(dir, "absent.json"));
    expect(r.entries.size).toBe(0);
    expect(r.invalid).toEqual([]);
  });
  it("malformed JSON → empty entries + an invalid row, never a throw", () => {
    const p = join(dir, "providers.json");
    writeFileSync(p, "{ not json", "utf8");
    const r = readProviderRegistrySync(p);
    expect(r.entries.size).toBe(0);
    expect(r.invalid.length).toBe(1);
    expect(r.invalid[0]?.reason).toMatch(/JSON/i);
  });
  it("wrong version / wrong shape → file-level invalid rows", () => {
    const p = join(dir, "providers.json");
    writeFileSync(p, JSON.stringify({ version: 2, providers: {} }), "utf8");
    expect(readProviderRegistrySync(p).invalid[0]?.reason).toMatch(/version/);
    writeFileSync(p, JSON.stringify({ version: 1, providers: ["nope"] }), "utf8");
    expect(readProviderRegistrySync(p).invalid[0]?.reason).toMatch(/providers/i);
  });
  it("per-entry: valid entries load, invalid entries surface with reasons", () => {
    const p = join(dir, "providers.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        providers: {
          "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" },
          "bad-url": { baseUrl: "ftp://nope" },
          "1bad-id": { baseUrl: "https://gw/v1" },
          "no-base": { defaultModel: "m" },
        },
      }),
      "utf8",
    );
    const r = readProviderRegistrySync(p);
    expect([...r.entries.keys()]).toEqual(["my-gw"]);
    expect(r.entries.get("my-gw")).toEqual({ baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" });
    expect(r.invalid.map((x) => x.id).sort()).toEqual(["1bad-id", "bad-url", "no-base"]);
    for (const row of r.invalid) expect(row.reason).toBeTruthy();
  });
});

describe("writeProviderRegistrySync — atomic 0600 roundtrip", () => {
  it("writes then reads back identical entries with 0600 perms", () => {
    const p = join(dir, "providers.json");
    const file = {
      version: 1,
      providers: {
        "my-gw": {
          baseUrl: "https://gw.example.com/v1",
          defaultModel: "m-x",
          defaultContextLength: 1000000,
          models: [{ name: "m-x", contextLength: 1000000 }, { name: "m-lite" }],
        },
      },
    };
    writeProviderRegistrySync(p, file);
    // 0600 is a POSIX observability contract — win32 has no enforced mode
    // bits (a 0600 create reads back 0666); the write path itself is tested
    // everywhere, the mode leg only where it is observable.
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    const back = readProviderRegistrySync(p);
    expect(back.invalid).toEqual([]);
    expect(back.entries.get("my-gw")).toEqual(file.providers["my-gw"]);
  });
  it("creates the parent directory when missing", () => {
    const p = join(dir, "nested", "deeper", "providers.json");
    writeProviderRegistrySync(p, { version: 1, providers: {} });
    expect(readProviderRegistrySync(p).entries.size).toBe(0);
  });
});

describe("effectiveProfiles — builtins ⊕ overlays ⊕ customs", () => {
  it("seeds all ten builtins — doc-verified context pins ride, unpinned builtins stay bare", () => {
    const m = effectiveProfiles(new Map());
    expect([...m.keys()]).toEqual([
      "deepseek",
      "glm",
      "qwen",
      "wudao",
      "anthropic",
      "kimi",
      "minimax",
      "glm-code",
      "kimi-code",
      "minimax-code",
    ]);
    for (const id of ["deepseek", "glm", "qwen", "wudao", "anthropic", "kimi", "minimax", "glm-code", "kimi-code", "minimax-code"]) {
      const p = m.get(id);
      expect(p?.custom).toBe(false);
      expect(p?.defaultContextLength).toBeUndefined();
    }
    // 反馈① 收口 (2026-08-29 夜): the three doc-verified catalogs carry
    // their pins; wudao/anthropic have nothing verifiable to pin.
    expect(m.get("deepseek")?.models).toEqual(PROFILE_PIN_SNAPSHOT.deepseek);
    expect(m.get("glm")?.models).toEqual(PROFILE_PIN_SNAPSHOT.glm);
    expect(m.get("qwen")?.models).toEqual(PROFILE_PIN_SNAPSHOT.qwen);
    expect(m.get("wudao")?.models).toEqual([]);
    expect(m.get("anthropic")?.models).toEqual([]);
    // 0.3.30 两套拆分: kimi/minimax 按量目录 + 重指向后的 kimi-code 订阅
    // 网关 (config.test.ts pins the exact entries; here only their presence).
    expect(m.get("kimi")?.models.length).toBe(4);
    expect(m.get("minimax")?.models.length).toBe(1);
    expect(m.get("glm-code")?.models.length).toBe(2);
    expect(m.get("kimi-code")?.models.length).toBe(1);
    expect(m.get("minimax-code")?.models.length).toBe(1);
  });
  it("merges a builtin overlay field-by-field (reasoningFormat overrides deepseek)", () => {
    const m = effectiveProfiles(
      new Map([
        [
          "deepseek",
          {
            defaultContextLength: 64000,
            models: [{ name: "deepseek-chat", contextLength: 128000 }],
            reasoningFormat: "zai",
            supportsReasoningEffort: false,
          },
        ],
      ]),
    );
    const ds = m.get("deepseek");
    expect(ds?.custom).toBe(false);
    expect(ds?.models).toEqual([{ name: "deepseek-chat", contextLength: 128000 }]);
    expect(ds?.defaultContextLength).toBe(64000);
    expect(ds?.reasoningFormat).toBe("zai");
    expect(ds?.supportsReasoningEffort).toBe(false);
    // untouched base fields survive
    expect(ds?.label).toBe("deepseek");
    expect(ds?.defaultBaseUrl).toBe("https://api.deepseek.com");
    expect(ds?.defaultModel).toBe("deepseek-v4-flash");
  });
  it("overlay models replace wholesale — the builtin pins drop out with them", () => {
    const m = effectiveProfiles(new Map([["glm", { models: [{ name: "glm-4.7" }] }]]));
    expect(m.get("glm")?.models).toEqual([{ name: "glm-4.7" }]);
    // an untouched builtin keeps its pins (反馈① 收口)
    expect(m.get("qwen")?.models).toEqual(PROFILE_PIN_SNAPSHOT.qwen);
  });
  it("builds a custom profile: label/id default, requiresBaseUrl, reasoningFormat none default", () => {
    const m = effectiveProfiles(new Map([["my-gw", { label: "My Gateway", baseUrl: "https://gw/v1", defaultModel: "m-x" }]]));
    expect(m.size).toBe(11); // ten builtins (0.3.26: +three coding-plan gateways; 0.3.30: +kimi/minimax pay APIs) + the custom
    const gw = m.get("my-gw");
    expect(gw?.custom).toBe(true);
    expect(gw?.label).toBe("My Gateway");
    expect(gw?.defaultBaseUrl).toBe("https://gw/v1");
    expect(gw?.defaultModel).toBe("m-x");
    expect(gw?.requiresBaseUrl).toBe(true);
    expect(gw?.reasoningFormat).toBe("none");
    expect(gw?.models).toEqual([]);
  });
  it("defensively skips custom entries without a baseUrl (read-time validation reports them)", () => {
    const m = effectiveProfiles(new Map([["bare", { defaultModel: "m" }]]));
    expect(m.has("bare")).toBe(false);
    expect(m.size).toBe(10); // the ten builtins alone
  });
  it("a custom without explicit reasoningFormat keeps an explicit one", () => {
    const m = effectiveProfiles(new Map([["gw2", { baseUrl: "https://g2/v1", reasoningFormat: "openrouter" }]]));
    expect(m.get("gw2")?.reasoningFormat).toBe("openrouter");
  });
  it("0.3.13 #215: wire rides the profile — absent stays absent, a custom's wire lands, an overlay's wire beats the builtin pin", () => {
    // absent → absent (wire-less customs stay byte-identical to history)
    const bare = effectiveProfiles(new Map([["gw3", { baseUrl: "https://g3/v1" }]]));
    expect(bare.get("gw3")?.wire).toBeUndefined();
    expect(bare.get("deepseek")?.wire).toBeUndefined(); // builtins without a pin stay unpinned
    // a custom's wire IS the profile fact the resolution chain reads
    const withWire = effectiveProfiles(new Map([["ant-gw", { baseUrl: "https://a/v1", wire: "anthropic" }]]));
    expect(withWire.get("ant-gw")?.wire).toBe("anthropic");
    // an overlay's wire overrides the builtin's compiled-in pin (anthropic stays anthropic; deepseek reroutes)
    const overlay = effectiveProfiles(new Map([["deepseek", { wire: "anthropic" }]]));
    expect(overlay.get("deepseek")?.wire).toBe("anthropic");
    expect(overlay.get("anthropic")?.wire).toBe("anthropic");
  });
  it("0.3.13 #215: a selected custom's wire resolves onto the config with NO env/selection override (the whole point)", () => {
    const providers = effectiveProfiles(new Map([["ant-gw", { baseUrl: "https://a/v1", defaultModel: "m-a", wire: "anthropic" }]]));
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "ant-gw" }, undefined, providers);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.wire).toBe("anthropic");
    // selection.wire still beats the profile (the explicit override wins)
    const r2 = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "ant-gw", wire: "openai-chat" }, undefined, providers);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.config.wire).toBe("openai-chat");
  });
});

describe("resolveContextWindowTokens — model → provider default → env", () => {
  const profiles = effectiveProfiles(
    new Map([
      [
        "my-gw",
        {
          baseUrl: "https://gw/v1",
          defaultModel: "m-x",
          defaultContextLength: 500000,
          models: [{ name: "m-x", contextLength: 1000000 }, { name: "m-lite" }],
        },
      ],
      ["gw-bare", { baseUrl: "https://bare/v1", defaultModel: "a" }],
    ]),
  );
  it("1) an explicit per-model contextLength wins", () => {
    expect(resolveContextWindowTokens(profiles, "my-gw", "m-x", 64000)).toBe(1000000);
  });
  it("2) a model entry without contextLength falls to the provider default", () => {
    expect(resolveContextWindowTokens(profiles, "my-gw", "m-lite", 64000)).toBe(500000);
  });
  it("3) an unknown model falls to the provider default", () => {
    expect(resolveContextWindowTokens(profiles, "my-gw", "m-other", 64000)).toBe(500000);
  });
  it("4) a provider without defaultContextLength falls to the env value", () => {
    expect(resolveContextWindowTokens(profiles, "gw-bare", "a", 64000)).toBe(64000);
    expect(resolveContextWindowTokens(profiles, "gw-bare", "a", 128000)).toBe(128000);
  });
  it("5) an unknown provider falls to the env value", () => {
    expect(resolveContextWindowTokens(profiles, "nobody", "a", 99000)).toBe(99000);
  });
});

// 反馈① 收口 (2026-08-29 夜): the compiled default window rose 64k → 200k,
// but the builtin catalog still pinned NO per-model windows — a 1M model
// (deepseek v4 line) rode a 200k fallback and autocompacted at ~12% of its
// real window. Pins go in ONLY for entries whose number comes from the
// provider's own docs (api-docs.deepseek.com/quick_start/pricing: CONTEXT
// LENGTH 1M for the whole v4 line; docs.z.ai/guides/llm/glm-4.6: 204_800;
// help.aliyun.com/en/model-studio/model-qwen3-max: 262_144). Everything
// unverifiable stays on the env tail — a wrong pin is worse than the
// fallback.
describe("builtin catalog context pins — 2026-08-29 反馈① 收口", () => {
  const builtins = effectiveProfiles(new Map());
  it("deepseek pins the whole documented v4 line at 1M (pricing page: one CONTEXT LENGTH row)", () => {
    for (const m of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]) {
      expect(resolveContextWindowTokens(builtins, "deepseek", m, 200000)).toBe(1_000_000);
    }
  });
  it("glm-4.6 pins 204_800 (docs.z.ai); older glm names keep the fallback (4.5/4 were 128K)", () => {
    expect(resolveContextWindowTokens(builtins, "glm", "glm-4.6", 200000)).toBe(204_800);
    expect(resolveContextWindowTokens(builtins, "glm", "glm-4.5", 200000)).toBe(200000);
  });
  it("qwen3-max pins 262_144 (aliyun model studio)", () => {
    expect(resolveContextWindowTokens(builtins, "qwen", "qwen3-max", 200000)).toBe(262_144);
  });
  it("uncataloged builtins (wudao-preview, claude-sonnet-5) keep the env fallback", () => {
    expect(resolveContextWindowTokens(builtins, "wudao", "wudao-preview", 200000)).toBe(200000);
    expect(resolveContextWindowTokens(builtins, "anthropic", "claude-sonnet-5", 200000)).toBe(200000);
  });
  it("a user overlay's models list still REPLACES the builtin pins wholesale", () => {
    const overlaid = effectiveProfiles(
      new Map([["deepseek", { baseUrl: "https://gw/v1", models: [{ name: "gw-x", contextLength: 123456 }] }]]),
    );
    expect(resolveContextWindowTokens(overlaid, "deepseek", "gw-x", 200000)).toBe(123456);
    expect(resolveContextWindowTokens(overlaid, "deepseek", "deepseek-v4-flash", 200000)).toBe(200000);
  });
  it("an overlay row with an EMPTY ctx inherits the compiled pin for that name (freeze hazard, 2026-08-29 夜)", () => {
    // The real machine hazard this pins: a card saved pre-pins echoes the
    // v4 names with no contextLength (the /models pull adds bare names) —
    // replace-with-empty must NOT shadow the doc-verified 1M for a model the
    // user never pinned. Membership is the overlay's; an empty field means
    // "inherit", the same rule the edit form's empty ctx input documents.
    const overlaid = effectiveProfiles(
      new Map([
        [
          "deepseek",
          {
            models: [
              { name: "deepseek-v4-flash" },
              { name: "deepseek-v4-pro", contextLength: 500000 },
              { name: "unrelated-model" },
            ],
          },
        ],
      ]),
    );
    // empty ctx on a pinned name → the compiled pin fills in
    expect(resolveContextWindowTokens(overlaid, "deepseek", "deepseek-v4-flash", 200000)).toBe(1_000_000);
    // an explicit overlay ctx still wins
    expect(resolveContextWindowTokens(overlaid, "deepseek", "deepseek-v4-pro", 200000)).toBe(500000);
    // names the compiled catalog never pinned stay unpinned (fall through)
    expect(resolveContextWindowTokens(overlaid, "deepseek", "unrelated-model", 200000)).toBe(200000);
  });
});

describe("resolveProviderConfigResult — the registry leg", () => {
  const profiles = effectiveProfiles(
    new Map([
      [
        "my-gw",
        {
          baseUrl: "https://gw.example.com/v1",
          defaultModel: "m-x",
          reasoningFormat: "openrouter",
          defaultContextLength: 1000000,
          models: [{ name: "m-x", contextLength: 1000000 }],
        },
      ],
      ["deepseek", { defaultModel: "deepseek-chat", models: [{ name: "deepseek-chat", contextLength: 128000 }] }],
    ]),
  );

  it("resolves a custom provider from the registry (key + baseUrl ride the config)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "my-gw" }, undefined, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("my-gw");
      expect(r.config.baseURL).toBe("https://gw.example.com/v1");
      expect(r.config.model).toBe("m-x");
      expect(r.config.apiKey).toBe("k");
      expect(r.config.reasoningFormat).toBe("openrouter");
    }
  });
  it("custom key can come from the credentials map", () => {
    const r = resolveProviderConfigResult({}, { provider: "my-gw" }, { "my-gw": "filekey" }, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.apiKey).toBe("filekey");
  });
  it("an overlay rides builtin resolution (deepseek defaultModel overridden)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("deepseek");
      expect(r.config.model).toBe("deepseek-chat");
      expect(r.config.baseURL).toBe("https://api.deepseek.com");
    }
  });
  it("a custom profile without any baseUrl fails with the wudao-shaped reason", () => {
    const bare = effectiveProfiles(new Map()); // hand-build the degenerate shape
    bare.set("bare", { label: "bare", defaultModel: "m", requiresBaseUrl: true, models: [], custom: true });
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "bare" }, undefined, bare);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bare provider needs WUDAO_BASE_URL");
  });
  it("unknown provider still throws — with or without a registry map, naming the registry", () => {
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "grok" })).toThrow(
      /unknown provider "grok" \(expected one of: deepseek, glm, qwen, wudao, anthropic, kimi, minimax, glm-code, kimi-code, minimax-code, or a custom provider from the registry \(~\/\.wudao\/providers\.json\)\)/,
    );
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "grok" }, undefined, profiles)).toThrow(
      /unknown provider "grok"/,
    );
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "nope" }, {}, undefined, profiles)).toThrow(
      /unknown provider "nope"/,
    );
  });
  it("existing 3-arg call sites keep their exact behavior (no map passed)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "wudao" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wudao provider needs WUDAO_BASE_URL");
  });
});

describe("defaultProviderRegistryPath", () => {
  it("lives in ~/.wudao/providers.json, honoring the WUDAO_GLOBAL_HOME override", () => {
    expect(defaultProviderRegistryPath({})).toMatch(/\.wudao[/\\]providers\.json$/);
    expect(defaultProviderRegistryPath({ WUDAO_GLOBAL_HOME: "/tmp/iso" })).toBe(join("/tmp/iso", "providers.json"));
  });
});

// ---------------------------------------------------------------------------
// T1-review riders M1–M4.
// ---------------------------------------------------------------------------
describe("R-M1 — read errors are fail-visible (only ENOENT is the silent empty)", () => {
  // chmod 0o000 cannot make a file unreadable to its own owner on win32 —
  // the EACCES lane is untestable there (the read succeeds).
  it.skipIf(process.platform === "win32")("EACCES → empty entries + an unreadable-registry invalid row, never a throw", () => {
    const p = join(dir, "locked", "providers.json");
    mkdirSync(join(dir, "locked"), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, providers: {} }), "utf8");
    chmodSync(p, 0o000);
    try {
      const r = readProviderRegistrySync(p);
      expect(r.entries.size).toBe(0);
      expect(r.invalid.length).toBe(1);
      expect(r.invalid[0]?.id).toBe("(file)");
      expect(r.invalid[0]?.reason).toBe("unreadable registry: EACCES");
    } finally {
      chmodSync(p, 0o600); // restore so rmSync works everywhere
    }
  });
  it("EISDIR (a directory at the registry path) → the same fail-visible row", () => {
    const p = join(dir, "as-dir");
    mkdirSync(p);
    const r = readProviderRegistrySync(p);
    expect(r.entries.size).toBe(0);
    expect(r.invalid).toEqual([{ id: "(file)", reason: "unreadable registry: EISDIR" }]);
  });
  it("a missing file (ENOENT) stays the SILENT empty registry", () => {
    const r = readProviderRegistrySync(join(dir, "absent.json"));
    expect(r.entries.size).toBe(0);
    expect(r.invalid).toEqual([]);
  });
});

describe("R-M2 — a custom provider with no resolvable model fails fast", () => {
  const profiles = effectiveProfiles(
    new Map([["my-gw", { baseUrl: "https://gw.example.com/v1" }]]), // no defaultModel, no models
  );
  it("selection-time resolution THROWS, naming the provider and the two fixes", () => {
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "my-gw" }, undefined, profiles)).toThrow(
      /my-gw.*defaultModel.*models|my-gw.*models.*defaultModel/s,
    );
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "my-gw" }, undefined, profiles)).toThrow(
      /my-gw/,
    );
  });
  it("WUDAO_MODEL rescues the same provider (env model beats the empty default)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_MODEL: "m-env" }, { provider: "my-gw" }, undefined, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.model).toBe("m-env");
  });
  it("builtins never hit the guard (their defaultModel is always non-empty)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, profiles);
    expect(r.ok).toBe(true);
  });
});

describe("R-M3 — an overlay's requiresBaseUrl beats the builtin's defaultBaseUrl", () => {
  it("overlay requiresBaseUrl:true + no overlay baseUrl → the builtin default must NOT satisfy it", () => {
    const profiles = effectiveProfiles(new Map([["glm", { requiresBaseUrl: true }]]));
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "glm" }, undefined, profiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("glm provider needs WUDAO_BASE_URL");
  });
  it("the overlay's own baseUrl satisfies its own requiresBaseUrl", () => {
    const profiles = effectiveProfiles(
      new Map([["glm", { baseUrl: "https://my-mirror.example/v1", requiresBaseUrl: true }]]),
    );
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "glm" }, undefined, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.baseURL).toBe("https://my-mirror.example/v1");
  });
  it("the env URL satisfies it too", () => {
    const profiles = effectiveProfiles(new Map([["glm", { requiresBaseUrl: true }]]));
    const r = resolveProviderConfigResult(
      { WUDAO_API_KEY: "k", WUDAO_BASE_URL: "https://env.example/v1" },
      { provider: "glm" },
      undefined,
      profiles,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.baseURL).toBe("https://env.example/v1");
  });
  it("an overlay without requiresBaseUrl keeps the builtin default (status quo)", () => {
    const profiles = effectiveProfiles(new Map([["glm", { defaultContextLength: 64000 }]]));
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "glm" }, undefined, profiles);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
  });
});

// SDD 2026-08-24 reg-headers Task 1 (92 §3.4-1) — the reserved per-provider
// `headers` column: validated (fail-visible on junk shapes), persisted through
// the file seam, and NOT consumed — the effective-profile merge never surfaces
// it (wire-side consumption is a later batch).
describe("headers reservation — validated, persisted; ω99-64: consumed on the wire", () => {
  it("round-trips a legal string→string headers object through the file and folds it onto the EffectiveProfile (controller ruling: transport-layer fact)", () => {
    const cfg = { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", headers: { "X-Gateway": "wudao", "X-Trace": "t-1" } };
    const v = validateUserProviderEntry("my-gw", cfg);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.headers).toEqual({ "X-Gateway": "wudao", "X-Trace": "t-1" });
    const p = join(dir, "providers.json");
    writeProviderRegistrySync(p, { version: 1, providers: { "my-gw": cfg } });
    const back = readProviderRegistrySync(p);
    expect(back.invalid).toEqual([]);
    expect(back.entries.get("my-gw")?.headers).toEqual({ "X-Gateway": "wudao", "X-Trace": "t-1" });
    // ω99-64 REVERSES the old "reserved ≠ consumed" stance (headers are a
    // transport-layer endpoint fact like baseUrl/wire/balanceUrl): the merge
    // output now carries the headers fact, and resolution copies it onto
    // ProviderConfig.extraHeaders — the column reaches the wire.
    const merged = effectiveProfiles(back.entries).get("my-gw");
    expect(merged?.headers).toEqual({ "X-Gateway": "wudao", "X-Trace": "t-1" });
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "my-gw" }, undefined, effectiveProfiles(back.entries));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.extraHeaders).toEqual({ "X-Gateway": "wudao", "X-Trace": "t-1" });
  });
  it("refuses junk headers shapes into the invalid rows (numeric value / array), same display path", () => {
    const p = join(dir, "providers.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        providers: {
          "num-val": { baseUrl: "https://gw/v1", headers: { "X-A": 7 } },
          "arr-val": { baseUrl: "https://gw/v1", headers: ["X-A"] },
        },
      }),
      "utf8",
    );
    const r = readProviderRegistrySync(p);
    expect(r.entries.size).toBe(0);
    expect(r.invalid.map((x) => x.id).sort()).toEqual(["arr-val", "num-val"]);
    for (const row of r.invalid) expect(row.reason).toMatch(/headers/);
  });
});

describe("R-M4 — an overlay's reasoningFormat pins the resolved config", () => {
  it("overlay reasoningFormat rides the resolved ProviderConfig byte-for-byte", () => {
    const overlay = effectiveProfiles(new Map([["deepseek", { reasoningFormat: "qwen" }]]));
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, overlay);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningFormat).toBe("qwen");
  });
  it("without an overlay the resolved format is the builtin's pin (deepseek)", () => {
    const plain = effectiveProfiles(new Map());
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, plain);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningFormat).toBe("deepseek");
  });
});

// 2026-08-28 推理档三级配置 S1 — the per-provider effort binding, a THREE-STATE
// column mirroring `persona` (spec docs/superpowers/specs/2026-08-28-effort-
// tiering-language-chip-design.md §1): key absent = follow the global default;
// a string = bound level (must be a real REASONING_EFFORTS member — fail-visible,
// a junk value must never masquerade as "follow global"); explicit null =
// don't send the param at all (distinct from the literal "none" level, which
// IS a wire value). Like persona, deliberately not an EffectiveProfile fact.
describe("effort binding — validated three-state column", () => {
  it("accepts a bound level and echoes it through a registry roundtrip", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", effort: "high" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.effort).toBe("high");
    const file = join(dir, "providers.json");
    writeProviderRegistrySync(file, { version: 1, providers: { gw: r.value } });
    const back = readProviderRegistrySync(file).entries.get("gw");
    expect(back?.effort).toBe("high");
  });
  it("absence stays absence (follow-global is the default; historical rows byte-identical)", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("effort" in r.value).toBe(false);
  });
  it("explicit null = don't send (a VALUE, not absence)", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", effort: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.effort).toBeNull();
  });
  it("rejects junk levels fail-visibly (never silently 'follow global')", () => {
    for (const bad of ["ultra", "", "HIGH", 7, ["high"], {}]) {
      const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", effort: bad as unknown });
      expect(r.ok, `effort ${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.reason).toContain("effort");
    }
  });
});

// ω99-245: #2 — the supported-efforts OVERRIDE column (the capability catalog's
// user escape hatch): a registry row may declare what THIS endpoint accepts,
// wholesale-replacing the compiled-in family set (and its model pins) so a new
// model or an outdated catalog pin never bricks the card. Unlike `effort` above
// (binding-chain data) this IS an EffectiveProfile fact — the catalog reads it
// through the effective view, exactly like headers/wire/balanceUrl.
describe("efforts override — validated catalog-escape column (ω99-245)", () => {
  it("accepts a non-empty list of REASONING_EFFORTS members and echoes it through a roundtrip", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", efforts: ["low", "high"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.efforts).toEqual(["low", "high"]);
    const file = join(dir, "providers.json");
    writeProviderRegistrySync(file, { version: 1, providers: { gw: r.value } });
    const back = readProviderRegistrySync(file).entries.get("gw");
    expect(back?.efforts).toEqual(["low", "high"]);
  });
  it("absence stays absence (the derived family set applies; historical rows byte-identical)", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("efforts" in r.value).toBe(false);
  });
  it("rejects junk/empty shapes fail-visibly (junk must never widen the gate silently)", () => {
    for (const bad of ["high", 7, {}, [], ["ultra"], ["high", ""], ["high", 3]]) {
      const r = validateUserProviderEntry("gw", { baseUrl: "https://g/v1", efforts: bad as unknown });
      expect(r.ok, `efforts ${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.reason).toContain("efforts");
    }
  });
  it("folds into EffectiveProfile for overlays AND customs (overlay absent = derived)", () => {
    const view = effectiveProfiles(new Map([
      ["deepseek", { efforts: ["high"] }],
      ["my-gw", { baseUrl: "https://gw/v1", efforts: ["low", "none"] }],
    ]));
    expect(view.get("deepseek")?.efforts).toEqual(["high"]);
    expect(view.get("my-gw")?.efforts).toEqual(["low", "none"]);
    expect(view.get("glm")?.efforts).toBeUndefined();
  });
});
