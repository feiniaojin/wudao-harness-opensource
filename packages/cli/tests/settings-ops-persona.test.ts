// SDD 2026-08-23 persona Task 5 — the persona ops behind the web settings
// page's persona tab (personaList/personaGet/personaSave/personaDelete), the
// settingsSet `persona.id` whitelist entry, settingsStatus's personaId, and
// the settingsSaveProvider persona three-state passthrough (T4 made the
// registry round-trip it; this pins the OP path).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsOps, readGlobalDefaultPersonaId } from "../src/driver/settings-ops.js";
import { createProviderRegistryOps, readProviderPersonaBinding } from "../src/driver/provider-registry-ops.js";
import { defaultProviderRegistryPath } from "@wudao/providers";

let home: string;
let root: string;
let savedHome: string | undefined;

// The matrix build's effective-profile read goes through the PROCESS-default
// registry memo (loadEffectiveProfiles() takes no path — the pre-existing
// buildProviderMatrix contract), so matrix-level assertions on customs need
// WUDAO_GLOBAL_HOME in BOTH deps.env and process.env (the
// provider-registry-ops.test.ts pattern). Fresh home per test ⇒ fresh memo
// key ⇒ no cross-test staleness.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wudao-persona-home-"));
  root = mkdtempSync(join(tmpdir(), "wudao-persona-root-"));
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

const ops = () => createSettingsOps({ env: env(), workspaceRoot: root });

/** Drop one workspace persona file into <root>/.wudao/personas/. */
function writeWorkspacePersona(id: string, def: Record<string, unknown>): void {
  const dir = join(root, ".wudao", "personas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(def), "utf8");
}

/** The UI's create payload (T6's buildPersonaDefinition output shape). */
const UI_DEF = {
  id: "alpha",
  displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-custom": "1" } },
} as const;

describe("personaList", () => {
  it("merges the three tiers: builtin (read-only) + global (editable) + workspace (read-only), with layers labels", async () => {
    await ops().personaSave(UI_DEF);
    writeWorkspacePersona("team-persona", {
      id: "team-persona",
      displayName: "Team",
      source: { kind: "workspace-source", provenance: "repo", pinnedVersion: "1" },
      headers: { anthropic: { "x-team": "1" } },
    });
    const { personas } = await ops().personaList();
    const byId = new Map(personas.map((p) => [p.id, p]));
    // builtins list, not editable
    expect(byId.get("anthropic-cli")).toMatchObject({ source: "builtin", editable: false, layers: "headers+prompt" });
    expect(byId.get("deepseek-native")).toMatchObject({ source: "builtin", layers: "headers+prompt" });
    expect(byId.get("openai-responses")).toMatchObject({ source: "builtin", layers: "headers+body+prompt" });
    expect(byId.get("cursor")).toMatchObject({ source: "builtin", layers: "headers" });
    // the saved global persona: editable
    expect(byId.get("alpha")).toMatchObject({ source: "global", editable: true, layers: "headers", displayName: "Alpha" });
    // the workspace persona: read-only surface
    expect(byId.get("team-persona")).toMatchObject({ source: "workspace", editable: false, layers: "headers" });
  });
});

describe("personaGet", () => {
  it("returns a known persona's full definition (builtin here)", async () => {
    const { definition } = await ops().personaGet("anthropic-cli");
    expect(definition.id).toBe("anthropic-cli");
    expect(definition.headers.anthropic?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns a saved global persona's definition", async () => {
    await ops().personaSave(UI_DEF);
    const { definition } = await ops().personaGet("alpha");
    expect(definition.displayName).toBe("Alpha");
  });

  it("an unknown id rejects (the 404 semantics)", async () => {
    await expect(ops().personaGet("no-such-persona")).rejects.toThrow(/unknown persona/);
  });
});

describe("personaSave", () => {
  it("writes a valid UI-shaped definition to <home>/personas/<id>.json", async () => {
    const r = await ops().personaSave(UI_DEF);
    expect(r).toEqual({ ok: true });
    expect(existsSync(join(home, "personas", "alpha.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "personas", "alpha.json"), "utf8")).displayName).toBe("Alpha");
  });

  it("refuses an invalid definition with the validator's per-field errors — nothing written", async () => {
    const r = await ops().personaSave({ id: "Bad_Id", displayName: "", headers: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.startsWith("id:"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("displayName:"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("source:"))).toBe(true);
    expect(existsSync(join(home, "personas"))).toBe(false);
  });

  it("refuses an id colliding with a builtin persona", async () => {
    const r = await ops().personaSave({ ...UI_DEF, id: "anthropic-cli", displayName: "Fake CC" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("anthropic-cli");
    expect(existsSync(join(home, "personas", "claude-code.json"))).toBe(false);
  });

  it("refuses an id colliding with a workspace persona", async () => {
    writeWorkspacePersona("team-persona", {
      id: "team-persona",
      displayName: "Team",
      source: { kind: "workspace-source", provenance: "repo", pinnedVersion: "1" },
      headers: {},
    });
    const r = await ops().personaSave({ ...UI_DEF, id: "team-persona", displayName: "Shadow" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("team-persona");
  });

  it("updates an existing GLOBAL persona in place (same id re-save)", async () => {
    await ops().personaSave(UI_DEF);
    const r = await ops().personaSave({ ...UI_DEF, displayName: "Alpha 2" });
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(home, "personas", "alpha.json"), "utf8")).displayName).toBe("Alpha 2");
  });
});

describe("personaDelete", () => {
  it("reports the reference inventory when the persona is bound and unbind is absent", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha" });
    await regOps.settingsSaveProvider("other-gw", { baseUrl: "https://other.example.com/v1", persona: "alpha" });
    await o.settingsSet("persona.id", "alpha");

    const r = await o.personaDelete("alpha");
    expect(r).toEqual({
      ok: false,
      references: { providers: ["my-gw", "other-gw"], isGlobalDefault: true },
    });
    // Refused delete: everything still in place.
    expect(existsSync(join(home, "personas", "alpha.json"))).toBe(true);
    expect(readProviderPersonaBinding("my-gw", env())).toBe("alpha");
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha");
  });

  it("unbind:true clears card bindings (key-absent), clears the global default, deletes the file", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha" });
    // A sibling card with a DIFFERENT persona stays untouched; a card with no
    // persona key stays key-absent.
    await regOps.settingsSaveProvider("other-gw", { baseUrl: "https://other.example.com/v1", persona: "beta-p" });
    await regOps.settingsSaveProvider("third-gw", { baseUrl: "https://third.example.com/v1", persona: null });
    await o.settingsSet("persona.id", "alpha");

    const r = await o.personaDelete("alpha", true);
    expect(r).toEqual({ ok: true });
    expect(existsSync(join(home, "personas", "alpha.json"))).toBe(false);
    // bound card → key ABSENT (undefined = follow global again), not null.
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
    // siblings preserved verbatim (their own persona states intact).
    expect(readProviderPersonaBinding("other-gw", env())).toBe("beta-p");
    expect(readProviderPersonaBinding("third-gw", env())).toBeNull();
    const reg = JSON.parse(readFileSync(defaultProviderRegistryPath(env()), "utf8")) as { providers: Record<string, { persona?: string | null }> };
    expect(reg.providers["third-gw"]?.persona).toBe(null);
    expect("persona" in (reg.providers["my-gw"] ?? {})).toBe(false);
    // global default cleared.
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });

  it("an unbound, non-default global persona deletes outright (no unbind needed)", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    expect(await o.personaDelete("alpha")).toEqual({ ok: true });
    expect(existsSync(join(home, "personas", "alpha.json"))).toBe(false);
  });

  it("a builtin id refuses; a workspace id refuses; an unknown id refuses", async () => {
    const o = ops();
    await expect(o.personaDelete("anthropic-cli")).rejects.toThrow(/内置/);
    writeWorkspacePersona("team-persona", {
      id: "team-persona",
      displayName: "Team",
      source: { kind: "workspace-source", provenance: "repo", pinnedVersion: "1" },
      headers: {},
    });
    await expect(o.personaDelete("team-persona")).rejects.toThrow(/工作区/);
    await expect(o.personaDelete("ghost-persona")).rejects.toThrow(/unknown persona/);
  });
});

describe("settingsSet persona.id (the 8th writable key)", () => {
  it("writes a registry-existing id; settingsStatus surfaces it as settings.personaId", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    expect(await o.settingsSet("persona.id", "alpha")).toEqual({ key: "persona.id", saved: true });
    const status = await o.settingsStatus();
    expect(status.settings.personaId).toBe("alpha");
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha");
  });

  it('"" clears the default (key-absent), read back as undefined/null', async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    await o.settingsSet("persona.id", "alpha");
    expect(await o.settingsSet("persona.id", "")).toEqual({ key: "persona.id", saved: true });
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
    expect((await o.settingsStatus()).settings.personaId).toBeNull();
  });

  it("a builtin id is a valid value too (defaults may pin builtins)", async () => {
    await expect(ops().settingsSet("persona.id", "anthropic-cli")).resolves.toEqual({ key: "persona.id", saved: true });
  });

  it("an unknown id refuses; a non-string refuses; the whitelist still rejects foreign keys", async () => {
    const o = ops();
    await expect(o.settingsSet("persona.id", "ghost-persona")).rejects.toThrow(/persona.id/);
    await expect(o.settingsSet("persona.id", 42)).rejects.toThrow(/persona.id/);
    await expect(o.settingsSet("persona.default", "x")).rejects.toThrow(/unknown settings key/);
  });
});

// SDD 2026-08-23 persona layer-selection Task 1 — the global default accepts
// the layer-qualified form `<id>[:layers]`（parsePersonaSpec 语法，`+`/`,` 连
// 接）：合法 = id 在注册表 + 层名 ∈ {headers,body,prompt}；坏 spec/未知 id 在
// 写入侧拒绝（消息带 persona.id 字段路径）。纯 id 路径逐字节不变。
describe("settingsSet persona.id layer-qualified (id:layers)", () => {
  it("accepts a qualified builtin id; stored verbatim; settingsStatus echoes it", async () => {
    const o = ops();
    await expect(o.settingsSet("persona.id", "anthropic-cli:headers")).resolves.toEqual({ key: "persona.id", saved: true });
    expect(readGlobalDefaultPersonaId(env())).toBe("anthropic-cli:headers");
    expect((await o.settingsStatus()).settings.personaId).toBe("anthropic-cli:headers");
  });

  it("accepts a \"+\"-joined multi-layer qualified saved-global persona", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    await expect(o.settingsSet("persona.id", "alpha:headers+prompt")).resolves.toEqual({ key: "persona.id", saved: true });
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha:headers+prompt");
  });

  it("rejects bad layer name / empty layer list / unknown id with qualifier — nothing written", async () => {
    const o = ops();
    await expect(o.settingsSet("persona.id", "anthropic-cli:bogus")).rejects.toThrow(/persona\.id/);
    await expect(o.settingsSet("persona.id", "anthropic-cli:")).rejects.toThrow(/persona\.id/);
    await expect(o.settingsSet("persona.id", "ghost-persona:headers")).rejects.toThrow(/persona\.id/);
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });

  it("plain id round-trip stays byte-identical (no :layers appended)", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    await o.settingsSet("persona.id", "alpha");
    expect(readGlobalDefaultPersonaId(env())).toBe("alpha");
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).persona).toEqual({ id: "alpha" });
  });
});

// 同一语法贯通 provider 卡片三态的字符串态：shape 校验接受 `id[:layers]`，坏
// spec 拒绝；未知 id 仍可保存（卡片路径校验形状不校验注册表存在性——未知
// 绑定由 resolveActivePersona resolve-time fail-closed 处理，与纯 id 行为一致）。
describe("settingsSaveProvider persona layer-qualified (id:layers)", () => {
  it("card binding accepts qualified refs and round-trips them verbatim", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha:headers" });
    expect(readProviderPersonaBinding("my-gw", env())).toBe("alpha:headers");
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "anthropic-cli:prompt+headers" });
    expect(readProviderPersonaBinding("my-gw", env())).toBe("anthropic-cli:prompt+headers");
    // 三态不变：null = 强制无；键缺省 = 跟随全局。
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: null });
    expect(readProviderPersonaBinding("my-gw", env())).toBeNull();
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1" });
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
  });

  it("a bad layer name refuses the card save (the registry row is untouched); an unknown qualified id still saves", async () => {
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha:headers" });
    const bad = await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha:bogus" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("persona");
    // 拒绝的写入不动已有行。
    expect(readProviderPersonaBinding("my-gw", env())).toBe("alpha:headers");
    // 未知 id + 合法限定：可保存（resolve-time fail-closed，不卡保存）。
    const ghost = await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "ghost-persona:headers" });
    expect(ghost).toEqual({ ok: true, provider: "my-gw" });
    expect(readProviderPersonaBinding("my-gw", env())).toBe("ghost-persona:headers");
  });
});

// 限定引用按「解析后的 id」参与 personaDelete 的引用盘点与解绑——否则限定绑
// 定/限定默认对 delete 不可见，删除后留下悬空引用。
describe("personaDelete sees qualified references (parsed-id match)", () => {
  it("qualified card binding + qualified global default count as references; unbind clears both", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha:headers" });
    await regOps.settingsSaveProvider("other-gw", { baseUrl: "https://other.example.com/v1", persona: "beta-p" });
    await o.settingsSet("persona.id", "alpha:prompt");

    const r = await o.personaDelete("alpha");
    expect(r).toEqual({ ok: false, references: { providers: ["my-gw"], isGlobalDefault: true } });

    const done = await o.personaDelete("alpha", true);
    expect(done).toEqual({ ok: true });
    expect(existsSync(join(home, "personas", "alpha.json"))).toBe(false);
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
    expect(readProviderPersonaBinding("other-gw", env())).toBe("beta-p");
    expect(readGlobalDefaultPersonaId(env())).toBeUndefined();
  });
});

describe("settingsStatus personaId", () => {
  it("null when never written (the T6 wire's optional shape)", async () => {
    const status = await ops().settingsStatus();
    expect(status.settings.personaId).toBeNull();
  });
});

describe("settingsSaveProvider persona passthrough (the op path's three states)", () => {
  it("absent → key-absent; 'alpha' → bound; null → forced-none — all through the OP", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    // absent: no persona key rides the config.
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1" });
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
    // bound: an id value.
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha" });
    expect(readProviderPersonaBinding("my-gw", env())).toBe("alpha");
    // forced-none: explicit null.
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: null });
    expect(readProviderPersonaBinding("my-gw", env())).toBeNull();
    // back to absent: a config WITHOUT the key clears an existing binding
    // (the wholesale-replace rule — the web form's full payload discipline).
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1" });
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
  });

  it("settingsStatus cards carry the binding (T7's echo source): absent / id / null; builtins without a row omit the key", async () => {
    const o = ops();
    await o.personaSave(UI_DEF);
    const regOps = createProviderRegistryOps({ env: env(), workspaceRoot: root });
    const card = async (id: string): Promise<{ persona?: string | null } | undefined> =>
      (await o.settingsStatus()).providers.find((c) => c.provider === id);
    // a row WITHOUT the key → the card key is ABSENT (undefined, not null).
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1" });
    expect((await card("my-gw"))?.persona).toBeUndefined();
    // builtins with NO row never carry the key either.
    expect((await card("deepseek"))?.persona).toBeUndefined();
    expect((await card("glm"))?.persona).toBeUndefined();
    // bound → the id rides the card.
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: "alpha" });
    expect((await card("my-gw"))?.persona).toBe("alpha");
    // forced-none → explicit null rides the card (a VALUE, never collapsed).
    await regOps.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: null });
    expect((await card("my-gw"))?.persona).toBeNull();
    // a builtin OVERLAY row can carry the binding too.
    await regOps.settingsSaveProvider("deepseek", { persona: "alpha" });
    expect((await card("deepseek"))?.persona).toBe("alpha");
    expect((await card("glm"))?.persona).toBeUndefined();
  });
});
