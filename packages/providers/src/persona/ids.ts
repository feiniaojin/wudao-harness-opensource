// Persona IDs — the single source of truth for functional identifiers.
// Both builtins and tests import from here; cleanup scripts skip this file.
export const PERSONA_IDS = {
  ANTHROPIC_CLI: "anthropic-cli",
  OPENAI_RESPONSES: "openai-responses",
  CURSOR: "cursor",
  MULTI_WIRE: "multi-wire",
  DEEPSEEK_NATIVE: "deepseek-native",
} as const;

export type PersonaId = (typeof PERSONA_IDS)[keyof typeof PERSONA_IDS];
