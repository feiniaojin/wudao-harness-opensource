// packages/providers/tests/persona-apply.test.ts
import { describe, it, expect } from "vitest";
import { createPersonaRuntime, resolvePersona, parsePersonaSpec } from "../src/persona/runtime.js";
import { resolveTemplate, resolvePersonaHeaders, mergeBodyOverlay, applyWirePersona } from "../src/persona/apply.js";
import type { PersonaDefinition, ResolvedPersona } from "../src/persona/types.js";

const def: PersonaDefinition = {
  id: "t", displayName: "T",
  source: { kind: "workspace-source", provenance: "p", pinnedVersion: "v" },
  headers: { responses: { originator: "wudao_harness", session_id: "{{sessionId}}", "x-when": "{{iso8601}}", "x-rnd": "{{uuid}}" } },
  body: { responses: { reasoning: { effort: "high" }, store: false } },
};
const seeded = { sessionId: "sess-42", uuid: () => "fixed-uuid", now: () => new Date("2026-08-23T00:00:00.000Z") };

describe("runtime + apply", () => {
  it("resolvePersona defaults layers to {headers,body,prompt-false}; an explicit layer list is the COMPLETE enable set (mask, spec §10.1)", () => {
    expect(resolvePersona(def).layers).toEqual({ headers: true, body: true, prompt: false });
    expect(resolvePersona(def, { prompt: true }).layers).toEqual({ headers: false, body: false, prompt: true });
  });
  it("parsePersonaSpec: bare id / layer list / failures", () => {
    expect(parsePersonaSpec("openai-responses")).toEqual({ ok: true, id: "openai-responses" });
    expect(parsePersonaSpec("openai-responses:headers,prompt")).toEqual({ ok: true, id: "openai-responses", layers: { headers: true, prompt: true } });
    expect(parsePersonaSpec("openai-responses:").ok).toBe(false);
    expect(parsePersonaSpec("openai-responses:headers,headers").ok).toBe(false);
    expect(parsePersonaSpec("openai-responses:wat").ok).toBe(false);
    expect(parsePersonaSpec("BadId").ok).toBe(false);
  });
  it("resolveTemplate seeds deterministically", () => {
    expect(resolveTemplate("{{sessionId}}", seeded)).toBe("sess-42");
    expect(resolveTemplate("{{iso8601}}", seeded)).toBe("2026-08-23T00:00:00.000Z");
    expect(resolveTemplate("pre-{{uuid}}-post", seeded)).toBe("pre-fixed-uuid-post");
  });
  it("resolveTemplate fails closed on a missing sessionId slot", () => {
    expect(() => resolveTemplate("{{sessionId}}", { uuid: seeded.uuid, now: seeded.now })).toThrow(/sessionId/);
  });
  it("headers: defined protocol resolves all slots; undefined protocol and OFF layer are no-ops; auth keys skipped defensively", () => {
    const p = resolvePersona(def);
    expect(resolvePersonaHeaders(p, "responses", seeded)).toEqual({
      originator: "wudao_harness", session_id: "sess-42",
      "x-when": "2026-08-23T00:00:00.000Z", "x-rnd": "fixed-uuid",
    });
    expect(resolvePersonaHeaders(p, "openai-chat", seeded)).toEqual({});
    expect(resolvePersonaHeaders(resolvePersona(def, { headers: false }), "responses", seeded)).toEqual({});
    const authy: ResolvedPersona = { definition: { ...def, headers: { responses: { authorization: "x", originator: "o" } } }, layers: { headers: true, body: false, prompt: false } };
    expect(resolvePersonaHeaders(authy, "responses", seeded)).toEqual({ originator: "o" });
  });
  it("mergeBodyOverlay: scalar replace, one-level object deep-merge, undefined passthrough", () => {
    const base = { model: "m", max_tokens: 100, reasoning: { effort: "low", summary: "auto" } };
    expect(mergeBodyOverlay(base, { temperature: 0.2 })).toEqual({ model: "m", max_tokens: 100, reasoning: { effort: "low", summary: "auto" }, temperature: 0.2 });
    expect(mergeBodyOverlay(base, { max_tokens: 7 })).toMatchObject({ max_tokens: 7 });
    expect(mergeBodyOverlay(base, { reasoning: { effort: "high" } })).toEqual({ model: "m", max_tokens: 100, reasoning: { effort: "high", summary: "auto" } });
    expect(mergeBodyOverlay(base, undefined)).toBe(base);
  });
  it("applyWirePersona: null when no persona / both layers off / nothing defined; overlay only when body layer on", () => {
    expect(applyWirePersona(undefined, "responses")).toBeNull();
    const rt = createPersonaRuntime(resolvePersona(def), seeded);
    expect(applyWirePersona(rt, "responses")?.bodyOverlay).toEqual({ reasoning: { effort: "high" }, store: false });
    expect(applyWirePersona(rt, "openai-chat")).toBeNull();
    const off = createPersonaRuntime(resolvePersona(def, { headers: false, body: false }), seeded);
    expect(applyWirePersona(off, "responses")).toBeNull();
    // Fix round 1（spec §10.1 mask）：显式层集 = 完整启用集——"headers on,
    // body off" 必须把 headers 一并列出（旧 overlay 写法 {body:false} 在 mask
    // 语义下会把 headers 也关掉）。
    const headersOnly = createPersonaRuntime(resolvePersona(def, { headers: true, body: false }), seeded);
    expect(applyWirePersona(headersOnly, "responses")).toEqual({ headers: expect.objectContaining({ originator: "wudao_harness" }), bodyOverlay: undefined });
  });
  it("final-review I3: resolvePersonaHeaders defensively skips forbidden transport/auth keys for a programmatically-built definition", () => {
    // A programmatic definition bypasses load-time validation — the apply-side
    // skip is the backstop (single source: schema's FORBIDDEN_HEADER_KEYS).
    const rogue: PersonaDefinition = {
      ...def,
      headers: { responses: { Cookie: "session=steal", host: "evil.example", "content-type": "text/plain", connection: "close", originator: "ok" } },
    };
    expect(resolvePersonaHeaders(resolvePersona(rogue), "responses", seeded)).toEqual({ originator: "ok" });
  });
  it("final-review I4: applyWirePersona filters overlay keys to the per-protocol whitelist (programmatic bypass)", () => {
    const rogue: PersonaDefinition = {
      ...def,
      // `messages`/`stream` are not in the responses whitelist; `store` is.
      body: { responses: { store: false, messages: [], stream: true } },
    };
    const rt = createPersonaRuntime(resolvePersona(rogue), seeded);
    expect(applyWirePersona(rt, "responses")?.bodyOverlay).toEqual({ store: false });
    // Whitelisted keys still land byte-identically (regression pin).
    const clean: PersonaDefinition = { ...def, body: { responses: { store: false, temperature: 0.5 } } };
    expect(applyWirePersona(createPersonaRuntime(resolvePersona(clean), seeded), "responses")?.bodyOverlay)
      .toEqual({ store: false, temperature: 0.5 });
    // All keys filtered out → the overlay collapses to undefined; with no
    // headers either, applyWirePersona is null (no persona wire effect).
    const allBad: PersonaDefinition = { ...def, headers: {}, body: { responses: { messages: [] } } };
    expect(applyWirePersona(createPersonaRuntime(resolvePersona(allBad), seeded), "responses")).toBeNull();
  });
});
