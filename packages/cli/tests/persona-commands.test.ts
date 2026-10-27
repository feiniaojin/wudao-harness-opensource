// packages/cli/tests/persona-commands.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao/core";
import { createPersonaRuntime, resolvePersona } from "@wudao/providers";
import type { PersonaDefinition, PersonaRegistry } from "@wudao/providers";
import {
  parsePersonaArgument, resolvePersonaSwitch, resolveBootstrapPersona,
  personaSwitchBreaksCache, recordPersonaChange, formatPersonaList,
  layerOverrideFor, PERSONA_SWITCH_CACHE_NOTE, resolveActivePersona,
  applyPersonaChainAfterProviderSwitch,
} from "../src/commands/persona.js";

const ccDef: PersonaDefinition = {
  id: "cc", displayName: "Anthropic CLI",
  source: { kind: "workspace-source", provenance: "http.ts:34", pinnedVersion: "claude-cli 2.x" },
  headers: { anthropic: { "user-agent": "wudao-harness/2.0.0 (external, cli)" } },
  prompt: { system: { mode: "prefix", text: "You are Claude Code.\n" } },
  confidence: "byte-verified",
};
const dshDef: PersonaDefinition = {
  id: "owire", displayName: "OWire",
  source: { kind: "workspace-source", provenance: "ref/dsh", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-client": "owire" } },
};
const registry: PersonaRegistry = { personas: [ccDef, dshDef], errors: [] };

// 解析链（spec §1）测试的独立注册表：alpha/beta 两枚最小合法 persona。
const alphaDef: PersonaDefinition = {
  id: "alpha", displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "test:alpha", pinnedVersion: "1" },
  headers: {},
};
const betaDef: PersonaDefinition = {
  id: "beta", displayName: "Beta",
  source: { kind: "workspace-source", provenance: "test:beta", pinnedVersion: "1" },
  headers: {},
};
const chainRegistry: PersonaRegistry = { personas: [alphaDef, betaDef], errors: [] };

describe("parsePersonaArgument", () => {
  it("list / off / switch / flags", () => {
    expect(parsePersonaArgument("")).toEqual({ kind: "list" });
    expect(parsePersonaArgument("--off")).toEqual({ kind: "off" });
    expect(parsePersonaArgument("off")).toEqual({ kind: "off" });
    expect(parsePersonaArgument("cc")).toEqual({ kind: "switch", id: "cc" });
    expect(parsePersonaArgument("cc --headers-only")).toEqual({ kind: "switch", id: "cc", flag: "--headers-only" });
    expect(parsePersonaArgument("cc --with-prompt")).toEqual({ kind: "switch", id: "cc", flag: "--with-prompt" });
  });
  it("fail-closed on garbage", () => {
    expect(parsePersonaArgument("--headers-only")).toEqual({ ok: false, error: expect.stringContaining("--headers-only") });
    expect(parsePersonaArgument("cc --wat")).toEqual({ ok: false, error: expect.stringContaining("--wat") });
    expect(parsePersonaArgument("cc dsh")).toEqual({ ok: false, error: expect.any(String) });
  });
  it("layerOverrideFor semantics", () => {
    // Fix round 1（spec §10.1 mask）：旗标携带**完整启用集**——--with-prompt =
    // 缺省三元组 + prompt（对无 defaultLayers 的 persona 与历史 overlay 结果逐
    // 字节一致；显式集在 effectiveLayers 的 mask 语义下不再叠加缺省）。
    expect(layerOverrideFor("--headers-only")).toEqual({ headers: true, body: false, prompt: false });
    expect(layerOverrideFor("--with-prompt")).toEqual({ headers: true, body: true, prompt: true });
    expect(layerOverrideFor(undefined)).toBeUndefined();
  });
});

describe("resolvePersonaSwitch / resolveBootstrapPersona", () => {
  it("switch resolves with default layers; flag overrides", () => {
    const r = resolvePersonaSwitch(registry, "cc");
    expect(r.ok && r.resolved.layers).toEqual({ headers: true, body: true, prompt: false }); // 默认层集
    const h = resolvePersonaSwitch(registry, "cc", "--headers-only");
    expect(h.ok && h.resolved.layers).toEqual({ headers: true, body: false, prompt: false });
    const p = resolvePersonaSwitch(registry, "cc", "--with-prompt");
    expect(p.ok && p.resolved.layers).toEqual({ headers: true, body: true, prompt: true });
  });
  it("unknown id fail-closed with the registry's known ids in the error", () => {
    const r = resolvePersonaSwitch(registry, "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cc");
  });
  it("bootstrap: absent config → null; present → resolved; bad id → error", () => {
    expect(resolveBootstrapPersona(registry, {})).toEqual({ ok: true, resolved: null });
    const ok = resolveBootstrapPersona(registry, { persona: { id: "owire" } });
    expect(ok.ok && ok.resolved?.definition.id).toBe("owire");
    const bad = resolveBootstrapPersona(registry, { persona: { id: "zzz" } });
    expect(bad.ok).toBe(false);
  });
});

describe("personaSwitchBreaksCache", () => {
  const base = resolvePersonaSwitch(registry, "cc")!;
  const prompted = resolvePersonaSwitch(registry, "cc", "--with-prompt")!;
  it("prompt on either side breaks; headers/body never do", () => {
    expect(personaSwitchBreaksCache(null, base.resolved!)).toBe(false);
    expect(personaSwitchBreaksCache(base.resolved!, null)).toBe(false);
    expect(personaSwitchBreaksCache(null, prompted.resolved!)).toBe(true);
    expect(personaSwitchBreaksCache(prompted.resolved!, base.resolved!)).toBe(true);
  });
});

describe("recordPersonaChange + formatPersonaList", () => {
  it("appends a persona_change generic entry with cold receipt data", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-rec-"));
    try {
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s1",
        to: { id: "cc", layers: { headers: true, body: false, prompt: true } },
        from: { id: null },
        coldTurnExpected: true, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries("s1");
      const e = entries[entries.length - 1] as { type: string; data: any };
      expect(e.type).toBe("persona_change");
      expect(e.data).toMatchObject({ id: "cc", layers: ["headers", "prompt"], coldTurnExpected: true });
      expect(e.data.attribution).toBe("persona:cc:headers+prompt");
      expect(e.data.at).toBe("2026-08-23T01:02:03.000Z");
    } finally { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  it("off entry carries id null and a stable attribution", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-off-"));
    try {
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s2", to: { id: null, layers: { headers: false, body: false, prompt: false } },
        coldTurnExpected: false, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries("s2");
      const e = entries[entries.length - 1] as { type: string; data: any };
      expect(e.type).toBe("persona_change");
      expect(e.data.id).toBeNull();
      expect(e.data.attribution).toBe("persona:off:off");
    } finally { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  it("formatPersonaList marks the current persona and shows layers/source/confidence", () => {
    const out = formatPersonaList(registry, "cc");
    expect(out).toContain("cc");
    expect(out).toContain("← current");
    expect(out).toContain("owire");
    expect(out).toContain("byte-verified");
    expect(out.split("← current").length - 1).toBe(1); // 有且只有一个 current 标记
  });
  it("PERSONA_SWITCH_CACHE_NOTE names the cold turn", () => {
    expect(PERSONA_SWITCH_CACHE_NOTE).toContain("变冷"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉：note 常量值钉）
  });
  it("spec is optional-additive: present → data.spec (the effective qualified ref); absent → no spec key", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-spec-"));
    try {
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s4",
        to: { id: "cc", layers: { headers: true, body: true, prompt: false }, spec: "cc:headers" },
        coldTurnExpected: false, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s4",
        to: { id: "owire", layers: { headers: true, body: true, prompt: false } },
        coldTurnExpected: false, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries("s4");
      const withSpec = entries[entries.length - 2] as { type: string; data: any };
      const withoutSpec = entries[entries.length - 1] as { type: string; data: any };
      expect(withSpec.type).toBe("persona_change");
      expect(withSpec.data.spec).toBe("cc:headers");
      expect(withSpec.data.id).toBe("cc"); // id 仍是裸 id——spec 是附加字段
      expect("spec" in withoutSpec.data).toBe(false);
    } finally { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  it("reason is optional-additive: present → data.reason; absent → no reason key (old readers unaffected)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-reason-"));
    try {
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s3",
        to: { id: "cc", layers: { headers: true, body: true, prompt: false } },
        reason: "provider-switch",
        coldTurnExpected: false, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s3",
        to: { id: "owire", layers: { headers: true, body: true, prompt: false } },
        coldTurnExpected: false, now: new Date("2026-08-23T01:02:03.000Z"),
      });
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries("s3");
      const withReason = entries[entries.length - 2] as { type: string; data: any };
      const withoutReason = entries[entries.length - 1] as { type: string; data: any };
      expect(withReason.type).toBe("persona_change");
      expect(withReason.data.reason).toBe("provider-switch");
      expect("reason" in withoutReason.data).toBe(false);
    } finally { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  it("formatPersonaList provenance marks current row; omitted provenance = byte-identical legacy", () => {
    const legacy = formatPersonaList(chainRegistry, "alpha");
    const marked = formatPersonaList(chainRegistry, "alpha", "bound:beta");
    expect(marked).toContain("← current [bound:beta]");
    expect(legacy).toContain("← current");
    expect(legacy).not.toContain("[bound:");
  });
});

describe("resolveActivePersona (spec §1 chain)", () => {
  it("env wins over binding and default", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: resolvePersona(alphaDef), bindingId: "beta", defaultId: "beta" });
    expect(r.provenance).toBe("env"); expect(r.resolved?.definition.id).toBe("alpha");
  });
  it("binding beats default", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: "beta", defaultId: "alpha" });
    expect(r.provenance).toBe("binding"); expect(r.resolved?.definition.id).toBe("beta");
  });
  it("explicit null binding = forced none, overrides default", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: null, defaultId: "alpha" });
    expect(r.provenance).toBe("none"); expect(r.resolved).toBeNull();
  });
  it("undefined binding falls to default", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: undefined, defaultId: "alpha" });
    expect(r.provenance).toBe("default");
  });
  it("stale binding id falls through to default with warning (resolve-time, fail-closed)", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: "ghost", defaultId: "alpha" });
    expect(r.provenance).toBe("default"); expect(r.warning).toContain("ghost");
  });
  it("stale default id → none with warning", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: undefined, defaultId: "ghost" });
    expect(r.provenance).toBe("none"); expect(r.warning).toContain("ghost");
  });
  it("nothing set → none, no warning", () => {
    const r = resolveActivePersona(chainRegistry, { envPersona: null, bindingId: undefined, defaultId: undefined });
    expect(r.provenance).toBe("none"); expect(r.warning).toBeUndefined();
  });
});

// SDD 2026-08-23 persona layer-selection Task 1 — the two PERSISTED reference
// points (provider card binding / settings.json global default) accept the
// layer-qualified form `<id>[:layers]`（既有 parsePersonaSpec 语法，`+`/`,` 连
// 接）。限定层集 = **完整启用集**（spec §10.1 fix round 1：`anthropic-cli:headers`
// = 只启用 headers——经 resolvePersona/effectiveLayers 的 mask 语义生效，未列出
// 的层关、defaultLayers 不参与）；纯 id 路径与历史逐字节一致（spec ===
// undefined、层集走缺省）。
describe("resolveActivePersona layer-qualified refs (id:layers)", () => {
  it("qualified binding resolves with the layer MASK and echoes spec; a plain id keeps spec undefined + default layers", () => {
    const q = resolveActivePersona(registry, { envPersona: null, bindingId: "cc:headers", defaultId: "owire" });
    expect(q.provenance).toBe("binding");
    expect(q.resolved?.definition.id).toBe("cc");
    // mask：只启用 headers——body/prompt 关（即使 body 缺省开）。
    expect(q.resolved?.layers).toEqual({ headers: true, body: false, prompt: false });
    expect(q.spec).toBe("cc:headers");
    const plain = resolveActivePersona(registry, { envPersona: null, bindingId: "cc", defaultId: "owire" });
    expect(plain.provenance).toBe("binding");
    expect(plain.spec).toBeUndefined();
    // 纯 id 与 resolvePersona(ccDef) 逐字节一致（缺省层集，无 mask）。
    expect(plain.resolved?.layers).toEqual(resolvePersona(ccDef).layers);
  });
  it("qualified default leg: owire:prompt means ONLY the prompt layer (mask) + spec", () => {
    const r = resolveActivePersona(registry, { envPersona: null, bindingId: undefined, defaultId: "owire:prompt" });
    expect(r.provenance).toBe("default");
    expect(r.resolved?.definition.id).toBe("owire");
    expect(r.resolved?.layers).toEqual({ headers: false, body: false, prompt: true });
    expect(r.spec).toBe("owire:prompt");
  });
  it("\"+\"-joined multi-layer parses; mask keeps exactly the listed layers; spec echoes in canonical form", () => {
    const r = resolveActivePersona(registry, { envPersona: null, bindingId: "cc:prompt+headers", defaultId: undefined });
    expect(r.provenance).toBe("binding");
    expect(r.resolved?.layers).toEqual({ headers: true, body: false, prompt: true });
    expect(r.spec).toBe("cc:headers+prompt");
  });
  it("fail-closed: unknown id WITH qualifier / bad layer name on the binding → warning + fall through to default", () => {
    const ghost = resolveActivePersona(registry, { envPersona: null, bindingId: "ghost:headers", defaultId: "owire" });
    expect(ghost.provenance).toBe("default");
    expect(ghost.resolved?.definition.id).toBe("owire");
    expect(ghost.warning).toContain("ghost:headers");
    const bogus = resolveActivePersona(registry, { envPersona: null, bindingId: "cc:bogus", defaultId: "owire" });
    expect(bogus.provenance).toBe("default");
    expect(bogus.resolved?.definition.id).toBe("owire");
    expect(bogus.warning).toContain("cc:bogus");
    expect(bogus.warning).toContain("unknown layer");
  });
  it("fail-closed: bad default spec alone → none with warning", () => {
    const r = resolveActivePersona(registry, { envPersona: null, bindingId: undefined, defaultId: "cc:bogus" });
    expect(r.provenance).toBe("none");
    expect(r.resolved).toBeNull();
    expect(r.warning).toContain("cc:bogus");
  });
  it("applyPersonaChainAfterProviderSwitch carries spec for a qualified winner (provider-switch record source)", () => {
    const runtime = createPersonaRuntime(null);
    const follow = applyPersonaChainAfterProviderSwitch(runtime, registry, { envPersona: null, bindingId: "cc:headers", defaultId: undefined });
    expect(follow.provenance).toBe("binding");
    expect(follow.spec).toBe("cc:headers");
    expect(follow.changed).toBe(true);
    // plain-id follow stays spec-free (byte-identical legacy record shape).
    const runtime2 = createPersonaRuntime(null);
    const plainFollow = applyPersonaChainAfterProviderSwitch(runtime2, registry, { envPersona: null, bindingId: "cc", defaultId: undefined });
    expect(plainFollow.spec).toBeUndefined();
  });
});
