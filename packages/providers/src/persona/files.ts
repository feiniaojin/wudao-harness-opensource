// packages/providers/src/persona/files.ts
// SDD 2026-08-23 persona Task 5 — the global-persona CRUD file helpers (spec
// §7: same package as loadPersonaRegistry, the write/delete halves of the
// seam the reader owns). One write discipline: validate FIRST (a refused
// definition never touches disk), then the house atomic write (tmp+rename,
// 0600 — the same posture as the global settings / providers.json writers).
// The ops layer (cli settings-ops personaSave/personaDelete) owns the
// tier-collision rules (builtin/workspace ids refuse) — these helpers are
// pure fs: they neither know nor check the other tiers.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePersonaDefinition } from "./schema.js";

/** The persona id grammar (schema.ts ID_RE, re-declared because schema keeps
 *  it private): kebab-case, no dots or slashes. deletePersonaDefinition takes
 *  a WIRE id — this guard is what keeps a traversal-shaped id ("../x") away
 *  from path resolution. */
const PERSONA_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The itemized form of validatePersonaDefinition's joined error string —
 *  the wire personaSave reply's `errors[]` shape (each entry field-path
 *  prefixed; the settings form matches them back to its rows). */
function splitErrors(joined: string): string[] {
  return joined.split("; ");
}

/** Validate + write one persona definition as `<dir>/<id>.json` (create or
 *  update — the file is keyed by the definition's OWN id). Returns the
 *  written id, or the validator's per-field errors with NOTHING on disk. */
export async function savePersonaDefinition(
  dir: string,
  definition: unknown,
): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const v = validatePersonaDefinition(definition);
  if (!v.ok) return { ok: false, errors: splitErrors(v.error) };
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${v.persona.id}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(v.persona, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  return { ok: true, id: v.persona.id };
}

/** Delete `<dir>/<id>.json`. True iff the file existed and the delete
 *  succeeded; a missing file (or a traversal-shaped id — see PERSONA_ID_RE)
 *  is false, never an error. */
export async function deletePersonaDefinition(dir: string, id: string): Promise<boolean> {
  if (!PERSONA_ID_RE.test(id)) return false;
  try {
    await rm(join(dir, `${id}.json`));
    return true;
  } catch {
    return false; // ENOENT (or any fs refusal) — nothing was deleted
  }
}

/** The tier-origin scan personaList needs: the set of PARSED persona ids in
 *  one directory (same keying rule as the registry reader — an id, not the
 *  filename). A missing dir is the empty set; a non-.json or unparsable file
 *  skips (the registry reader already reports those as its own errors). */
export async function personaIdsInDir(dir: string | undefined): Promise<Set<string>> {
  const ids = new Set<string>();
  if (dir === undefined) return ids;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return ids;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const id = (raw as Record<string, unknown>)["id"];
        if (typeof id === "string" && id !== "") ids.add(id);
      }
    } catch {
      // skip — the registry reader is the error-reporting site
    }
  }
  return ids;
}
