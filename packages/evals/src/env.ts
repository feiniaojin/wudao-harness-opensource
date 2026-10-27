// Minimal .env loader (same semantics as the CLI): walk up from cwd looking
// for a .env file, set keys that are not already in the environment. Exposed
// as a pure-ish function for unit tests (env injected, never mutated globally
// here — the caller decides).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export const ENV_FILE_NAME = ".env";

/** Parse .env text into key/value pairs. Comments (#) and blank lines skipped;
 *  surrounding quotes stripped. Later duplicate keys win. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = val;
  }
  return out;
}

/** Find the nearest .env walking up from startDir (max 6 levels). Returns the
 *  parsed contents merged under `base` (existing values win), or base when no
 *  file exists anywhere. */
export function loadEnvFrom(startDir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, ENV_FILE_NAME), "utf8");
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      const parent = dirname(dir);
      if (parent === dir) return base;
      dir = parent;
      continue;
    }
    const parsed = parseEnvFile(text);
    const merged: NodeJS.ProcessEnv = { ...base };
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in merged)) merged[k] = v;
    }
    return merged;
  }
  return base;
}
