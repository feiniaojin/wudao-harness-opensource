// packages/providers/src/persona/runtime.ts
import type { LayerFlags, PersonaDefinition, ResolvedPersona } from "./types.js";
import { effectiveLayers } from "./schema.js";

export interface PersonaRuntimeSlots {
  readonly sessionId?: string;
  readonly uuid?: () => string;
  readonly now?: () => Date;
}

export interface PersonaRuntime {
  current: ResolvedPersona | null;
  readonly slots: PersonaRuntimeSlots;
}

export function createPersonaRuntime(initial: ResolvedPersona | null = null, slots: PersonaRuntimeSlots = {}): PersonaRuntime {
  return { current: initial, slots };
}

export function resolvePersona(persona: PersonaDefinition, layers?: Partial<LayerFlags>): ResolvedPersona {
  return { definition: persona, layers: effectiveLayers(persona, layers) };
}

/** `<id>` 或 `<id>:headers[,body][,prompt]`——非空、无重复、无未知层。层列表
 * 分隔符：`,`（WUDAO_PERSONA 既有语法）与 `+`（设置页写入的规范形态）等价。 */
export function parsePersonaSpec(spec: string): { ok: true; id: string; layers?: Partial<LayerFlags> } | { ok: false; error: string } {
  const colon = spec.indexOf(":");
  const id = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  if (id === "") return { ok: false, error: `persona id missing in "${spec}"` };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return { ok: false, error: `persona id "${id}" is not kebab-case` };
  if (colon === -1) return { ok: true, id };
  const parts = spec.slice(colon + 1).split(/[,+]/).map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) return { ok: false, error: `empty layer list in "${spec}"` };
  const layers: Partial<LayerFlags> = {};
  for (const p of parts) {
    if (p !== "headers" && p !== "body" && p !== "prompt") return { ok: false, error: `unknown layer "${p}" (allowed: headers, body, prompt)` };
    if (layers[p as keyof LayerFlags] !== undefined) return { ok: false, error: `duplicate layer "${p}"` };
    (layers as Record<string, boolean>)[p] = true;
  }
  return { ok: true, id, layers };
}
