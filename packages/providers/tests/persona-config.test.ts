// Task 11: ProviderConfig.persona + WUDAO_PERSONA env + package exports
import { describe, it, expect } from "vitest";
import { resolveProviderConfigResult } from "../src/config.js";
import {
  createAnthropicProvider,
  createResponsesProvider,
  withPersona,
  createPersonaRuntime,
  loadPersonaRegistry,
  lookupPersona,
  BUILTIN_PERSONAS,
  parsePersonaSpec,
  applyWirePersona,
  validatePersonaDefinition,
} from "../src/index.js";

const BASE_ENV = {
  WUDAO_API_KEY: "k",
  OPENAI_BASE_URL: "https://x/v1",
  OPENAI_MODEL: "m",
} as const;

describe("ProviderConfig.persona + WUDAO_PERSONA", () => {
  it("absent env → persona undefined", () => {
    const r = resolveProviderConfigResult({ ...BASE_ENV } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.persona).toBeUndefined();
  });

  it("bare id → {id} only; layer list → partial flags", () => {
    const a = resolveProviderConfigResult({
      ...BASE_ENV,
      WUDAO_PERSONA: "openai-responses",
    } as any);
    expect(a.ok && a.config.persona).toEqual({ id: "openai-responses" });

    const b = resolveProviderConfigResult({
      ...BASE_ENV,
      WUDAO_PERSONA: "openai-responses:headers,prompt",
    } as any);
    expect(b.ok && b.config.persona).toEqual({
      id: "openai-responses",
      layers: { headers: true, prompt: true },
    });
  });

  it("bad spec fails closed with a reason", () => {
    const r = resolveProviderConfigResult({
      ...BASE_ENV,
      WUDAO_PERSONA: "openai-responses:wat",
    } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("WUDAO_PERSONA");
  });

  it("package exports the persona surface + both new adapters", () => {
    expect(typeof createAnthropicProvider).toBe("function");
    expect(typeof createResponsesProvider).toBe("function");
    expect(typeof withPersona).toBe("function");
    expect(typeof createPersonaRuntime).toBe("function");
    expect(typeof loadPersonaRegistry).toBe("function");
    expect(typeof lookupPersona).toBe("function");
    expect(Array.isArray(BUILTIN_PERSONAS)).toBe(true);
    expect(typeof parsePersonaSpec).toBe("function");
    expect(typeof applyWirePersona).toBe("function");
    expect(typeof validatePersonaDefinition).toBe("function");
  });
});
