// packages/providers/src/persona/registry.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersonaDefinition } from "./types.js";
import { validatePersonaDefinition } from "./schema.js";
import { BUILTIN_PERSONAS } from "./builtins.js";

export interface PersonaRegistry {
  readonly personas: readonly PersonaDefinition[];
  readonly errors: readonly string[];
}

async function readDirPersonas(dir: string | undefined, label: string, errors: string[]): Promise<Map<string, { persona: PersonaDefinition; filename: string }>> {
  const out = new Map<string, { persona: PersonaDefinition; filename: string }>();
  if (dir === undefined) return out;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out; // 目录不存在 = 该层级为空，不是错误
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      const v = validatePersonaDefinition(raw);
      if (!v.ok) { errors.push(`${label}/${name}: ${v.error}`); continue; }
      out.set(v.persona.id, { persona: v.persona, filename: name });
    } catch (err) {
      errors.push(`${label}/${name}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** 内置 → global(~/.wudao/personas) → workspace(<ws>/.wudao/personas)，同 id 后者胜。 */
export async function loadPersonaRegistry(dirs: { readonly globalDir?: string; readonly workspaceDir?: string }): Promise<PersonaRegistry> {
  const errors: string[] = [];
  const merged = new Map<string, { persona: PersonaDefinition; filename: string }>();
  for (const p of BUILTIN_PERSONAS) merged.set(p.id, { persona: p, filename: "" });
  for (const [id, value] of (await readDirPersonas(dirs.globalDir, "global", errors)).entries()) merged.set(id, value);
  for (const [id, value] of (await readDirPersonas(dirs.workspaceDir, "workspace", errors)).entries()) merged.set(id, value);
  const personas = [...merged.values()]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((v) => v.persona);
  return { personas, errors };
}

export function lookupPersona(registry: PersonaRegistry, id: string): PersonaDefinition | undefined {
  return registry.personas.find((p) => p.id === id);
}
