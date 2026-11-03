// ω-1a — tool_call id uniqueness for name-as-id endpoints.
//
// Some OpenAI-compatible endpoints (GLM/Qwen compat modes) echo a tool call's
// `id` back as the FUNCTION NAME. Parallel same-name calls in one assistant
// turn then share one id: everything downstream that keys on tool_call_id
// (loop result pairing, session JSONL, outbound history serialization) lets
// the later call overwrite — or drop — the earlier one, and strict endpoints
// reject the replayed history outright on duplicate tool_call ids.
//
// Contract (both directions live here; core never sees the suffix):
//   - inbound (once a full ToolCall list is parsed): `dedupeToolCallIds`
//     disambiguates duplicates with a `#n` suffix (the first keeps its id);
//   - outbound (assistant tool_calls AND tool_result ids): restore the
//     provider-native shape by stripping `${name}#${integer}` — an exact
//     match only, so real ids (`call_*` / `toolu_*`) pass through untouched.
// The scope is ONE assistant message (the wire's own uniqueness scope), and
// resume needs no registry: outbound stripping is shape-based, so persisted
// deduped ids strip identically on every later request.
import type { ToolCall } from "@wudao-org/core";

/** Is this the name-as-id shape the dedupe applies to (id echoes the name)?
 *  Empty ids/names are excluded — a missing id on a missing name is
 *  degenerate, and a `#2` suffix on an empty name would be nonsense. */
const isNameAsId = (id: string, name: string): boolean => id !== "" && id === name;

/** The exact `${name}#${integer}` shape `dedupeToolCallIds` mints (and the
 *  restore strips). `#` is not a function-name character for the providers
 *  in play, so a real provider id never collides with the shape. */
const hasSuffix = (id: string, name: string): boolean =>
  name !== "" && id.length > name.length + 1 && id.startsWith(`${name}#`) && /^\d+$/.test(id.slice(name.length + 1));

/** Inbound: dedupe parallel same-name tool calls from a name-as-id endpoint.
 *  Only the name-as-id shape is touched — within ONE assistant message the
 *  2nd+ occurrence becomes `${name}#2`, `${name}#3`, …; an id that is not
 *  the function name (a real `call_*` id) passes through even when repeated
 *  and never consumes a counter slot. Order is preserved and no input object
 *  is mutated (unchanged elements keep their reference). */
export function dedupeToolCallIds(calls: readonly ToolCall[]): ToolCall[] {
  const seen = new Map<string, number>();
  return calls.map((tc) => {
    if (!isNameAsId(tc.id, tc.name)) return tc;
    const n = (seen.get(tc.name) ?? 0) + 1;
    seen.set(tc.name, n);
    return n === 1 ? tc : { ...tc, id: `${tc.name}#${n}` };
  });
}

/** Outbound: restore the provider-native shape — strip the `#n` suffix when
 *  the id is EXACTLY `${name}#${integer}`; anything else returns as-is
 *  (idempotent, and a no-op on real provider ids). */
export function restoreToolCallIds(calls: readonly ToolCall[]): ToolCall[] {
  return calls.map((tc) => (hasSuffix(tc.id, tc.name) ? { ...tc, id: tc.name } : tc));
}

/** Outbound, single-id form — the tool_result message path, where the call
 *  list isn't at hand but the tool name rides the message itself. */
export function restoreToolCallId(id: string, name: string): string {
  return hasSuffix(id, name) ? name : id;
}
