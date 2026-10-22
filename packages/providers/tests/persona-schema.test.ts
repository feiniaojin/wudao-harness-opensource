// packages/providers/tests/persona-schema.test.ts
import { describe, it, expect } from "vitest";
import { validatePersonaDefinition, effectiveLayers } from "../src/persona/schema.js";
import type { PersonaDefinition } from "../src/persona/types.js";

const good = {
  id: "openai-responses", displayName: "OpenAI Responses",
  source: { kind: "workspace-source", provenance: "responses client.rs", pinnedVersion: "responses 0.x" },
  headers: { responses: { originator: "wudao_harness", session_id: "{{sessionId}}" } },
  body: { responses: { store: false } },
};

describe("validatePersonaDefinition", () => {
  it("accepts a minimal valid persona and normalizes nothing", () => {
    const r = validatePersonaDefinition({ id: "dsh", displayName: "dsh", source: { kind: "workspace-source", provenance: "p", pinnedVersion: "v" }, headers: {} });
    expect(r.ok).toBe(true);
  });
  it("accepts the codex-shaped persona", () => {
    expect(validatePersonaDefinition(good).ok).toBe(true);
  });
  it("rejects unknown top-level keys (fail-closed)", () => {
    const r = validatePersonaDefinition({ ...good, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown");
  });
  it("rejects unknown protocol ids in headers/body", () => {
    expect(validatePersonaDefinition({ ...good, headers: { gemini: {} } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, body: { gemini: {} } }).ok).toBe(false);
  });
  it("rejects body keys outside the per-protocol whitelist", () => {
    expect(validatePersonaDefinition({ ...good, body: { responses: { temperature: 0.2 } } }).ok).toBe(true);
    expect(validatePersonaDefinition({ ...good, body: { responses: {evil_key: 1} } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, body: { "openai-chat": { thinking: {} } } }).ok).toBe(false);
  });
  it("rejects auth header keys in persona header maps", () => {
    expect(validatePersonaDefinition({ ...good, headers: { responses: { authorization: "x" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { anthropic: { "x-api-key": "x" } } }).ok).toBe(false);
  });
  it("final-review I3: rejects hop-by-hop / transport-semantic headers too (case-insensitive)", () => {
    // The brief's exact expansion set, one representative per family + case variants.
    expect(validatePersonaDefinition({ ...good, headers: { responses: { cookie: "a=b" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { responses: { Cookie: "a=b" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { "openai-chat": { host: "evil.example" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { "openai-chat": { Host: "evil.example" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { "openai-chat": { "Content-Type": "text/plain" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { "openai-chat": { "content-length": "1" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { anthropic: { connection: "close" } } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { anthropic: { "transfer-encoding": "chunked" } } }).ok).toBe(false);
    for (const k of ["keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]) {
      const r = validatePersonaDefinition({ ...good, headers: { responses: { [k]: "x" } } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(k);
    }
    // The error names the forbidden key (diagnosable, not a generic reject).
    const named = validatePersonaDefinition({ ...good, headers: { responses: { cookie: "a=b" } } });
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.error).toContain("cookie");
  });
  it("rejects non-kebab ids, empty provenance, non-string header values", () => {
    expect(validatePersonaDefinition({ ...good, id: "Bad_Id" }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, source: { kind: "workspace-source", provenance: "", pinnedVersion: "v" } }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, headers: { responses: { n: 3 } } }).ok).toBe(false);
  });
  it("rejects unknown template slots in header values", () => {
    expect(validatePersonaDefinition({ ...good, headers: { responses: { x: "{{wat}}" } } }).ok).toBe(false);
  });
  it("rejects toolNameMap with duplicate display names or key==value", () => {
    const prompt = { toolNameMap: { read_file: "Read", write_file: "Read" } };
    expect(validatePersonaDefinition({ ...good, prompt }).ok).toBe(false);
    expect(validatePersonaDefinition({ ...good, prompt: { toolNameMap: { read_file: "read_file" } } }).ok).toBe(false);
  });
});

// SDD 2026-08-23 layer-selection fix round 1 — spec §10.1: an EXPLICIT layer
// qualifier lists the COMPLETE enable set (`claude-code:headers` = 只启用
// headers). effectiveLayers therefore MASKS when a qualifier is present
// (unlisted layers off, defaultLayers ignored); the unqualified path keeps
// the historical defaults byte-identical.
describe("effectiveLayers (spec §10.1: explicit qualifier = complete enable set)", () => {
  const def: PersonaDefinition = {
    id: "openai-responses", displayName: "OpenAI Responses",
    source: { kind: "workspace-source", provenance: "responses client.rs", pinnedVersion: "responses 0.x" },
    headers: { responses: { originator: "wudao_harness" } },
    body: { responses: { store: false } },
  };
  it("no qualifier → the historical defaults path, byte-identical: {headers,body on, prompt off}", () => {
    expect(effectiveLayers(def)).toEqual({ headers: true, body: true, prompt: false });
    expect(effectiveLayers(def, undefined)).toEqual({ headers: true, body: true, prompt: false });
  });
  it("defaultLayers participates ONLY on the unqualified path (a qualifier ignores it)", () => {
    const pinned: PersonaDefinition = { ...def, defaultLayers: { prompt: true } };
    expect(effectiveLayers(pinned)).toEqual({ headers: true, body: true, prompt: true });
    expect(effectiveLayers(pinned, { headers: true })).toEqual({ headers: true, body: false, prompt: false });
  });
  it("mask-when-qualified: unlisted layers are OFF; explicit false honored", () => {
    expect(effectiveLayers(def, { prompt: true })).toEqual({ headers: false, body: false, prompt: true });
    expect(effectiveLayers(def, { headers: true, prompt: true })).toEqual({ headers: true, body: false, prompt: true });
    expect(effectiveLayers(def, { headers: false })).toEqual({ headers: false, body: false, prompt: false });
  });
  it("an all-absent override reads as NO qualifier (defensive: parsePersonaSpec never emits {})", () => {
    expect(effectiveLayers(def, {})).toEqual({ headers: true, body: true, prompt: false });
  });
});
