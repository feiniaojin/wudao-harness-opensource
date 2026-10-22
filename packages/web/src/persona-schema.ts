// persona-settings T6 — the CLIENT-SIDE mirror of the persona validation
// constants. The single source of truth is
// packages/providers/src/persona/schema.ts — except FORBIDDEN_HEADER_KEYS,
// whose single source since ω99-69 is
// packages/providers/src/header-validation.ts (schema.ts merely re-exports
// it); the web package never imports
// the providers package (protocol.ts is its only server knowledge), so the
// constants are hand-mirrored here for the form's IMMEDIATE feedback
// (forbidden-key red text, per-wire body dropdown options). The SERVER's
// validatePersonaDefinition is the real gate — this mirror is UX, not
// security (a stale mirror can only ever be laggier, never looser, than
// the server's own check).
import type { PersonaProtocolId } from "./protocol.js";

/** The three wire ids a persona's headers/body layers ride (mirror of
 *  providers PROTOCOL_IDS). */
export const PERSONA_PROTOCOL_IDS: readonly PersonaProtocolId[] = ["openai-chat", "anthropic", "responses"];

/** v1 冻结键集 (mirror of providers BODY_WHITELIST). The body layer's
 *  per-wire key dropdown is exactly this set — the form physically cannot
 *  type a non-whitelisted key. */
export const BODY_WHITELIST: Readonly<Record<PersonaProtocolId, readonly string[]>> = {
  "openai-chat": ["temperature", "top_p", "top_k", "max_tokens", "reasoning_effort", "reasoning", "stop", "metadata"],
  anthropic: ["temperature", "top_p", "top_k", "max_tokens", "thinking", "stop_sequences", "metadata"],
  responses: ["temperature", "top_p", "max_completion_tokens", "reasoning", "instructions", "store", "metadata"],
};

/** persona 永不控制的头 (mirror of providers FORBIDDEN_HEADER_KEYS — single
 *  source since ω99-69: packages/providers/src/header-validation.ts; kept
 *  equal by tests/omega99-72-forbidden-header-pin.test.ts, drift = red) —
 *  auth keys + hop-by-hop / transport-control headers. The form rejects
 *  these with red text the moment they are typed (server re-checks on
 *  save). */
export const FORBIDDEN_HEADER_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "content-type",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
]);

/** The header-value template slots (mirror of providers SLOT_RE) — the
 *  form's hint text under every header value input. */
export const TEMPLATE_SLOTS: readonly string[] = ["{{sessionId}}", "{{uuid}}", "{{iso8601}}"];

/** A header value's `{{…}}` parts must each be one of TEMPLATE_SLOTS
 *  (client-side pre-check; the server's checkHeaderMap is the gate). */
export function unknownTemplateSlots(value: string): readonly string[] {
  return value
    .split(/(\{\{[^}]*\}\})/)
    .filter((s) => s.startsWith("{{"))
    .filter((s) => !(TEMPLATE_SLOTS as readonly string[]).includes(s));
}

/** The persona id grammar (mirror of providers ID_RE) — kebab-case. */
export const PERSONA_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The layer-qualified reference syntax `<id>[:layers]` (iteration 2): the
 *  two PERSISTED persona references — settings.json persona.id (the global
 *  default) and a provider card's persona string — accept a layer qualifier:
 *  `the upstream format:headers` binds ONLY the headers layer, multi-layer joins
 *  with `+` (`headers+prompt`). The server's parsePersonaSpec is the gate;
 *  these helpers only compose/decompose the strings the pickers write. */
export const PERSONA_LAYER_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "全部层" },
  { value: "headers", label: "仅 headers" },
  { value: "prompt", label: "仅 prompt" },
  { value: "headers+prompt", label: "headers+prompt" },
];

/** Split an `<id>[:layers]` spec — a plain id yields an empty layer. */
export function splitPersonaSpec(spec: string): { id: string; layer: string } {
  const i = spec.indexOf(":");
  return i === -1 ? { id: spec, layer: "" } : { id: spec.slice(0, i), layer: spec.slice(i + 1) };
}

/** Compose an `<id>[:layers]` spec — an empty layer is the plain id (the
 *  byte-equal default: no qualifier means the definition's own layers). */
export function qualifyPersonaSpec(id: string, layer: string): string {
  return layer === "" ? id : `${id}:${layer}`;
}

/** Case-insensitive forbidden-key check (headers are case-insensitive;
 *  the server lowercases before checking). */
export function isForbiddenHeaderKey(key: string): boolean {
  return FORBIDDEN_HEADER_KEYS.has(key.trim().toLowerCase());
}
