// M63 §B — the credentials file (the M57-reserved slot, now real):
// `~/.wudao/.credentials.yaml` (WUDAO_GLOBAL_HOME honored). One provider key
// per line, `PROVIDER_ID: <key>` — a YAML-lite shape parsed with ZERO
// dependencies (comments + quoted/unquoted scalar values; anything nested,
// list-like, or malformed is SKIPPED, never thrown: a bad line must not take
// the harness down, and a skipped line can never leak a key by accident).
//
// SECURITY POSTURE (spec §B):
//   - mode 0600 is ENFORCED ON EVERY WRITE (chmod after the atomic rename —
//     an editor or restore that loosened the file is repaired by the next
//     save, and a fresh file is never observable group/world-readable);
//   - KEY VALUES ARE NEVER LOGGED, ECHOED, OR RETURNED by anything built on
//     this module — status surfaces (doctor, statusline, the web settings
//     page) get COUNTS ONLY ("credentials file: N keys"), and the save op's
//     reply carries the provider + saved flag, never the key;
//   - the file is a FALLBACK key source for provider-profile resolution,
//     strictly AFTER env vars: any env key (WUDAO_API_KEY / OPENAI_API_KEY /
//     WUDAO_API_KEYS pool) wins over the file — a CI env key must not be
//     silently shadowed by a stale on-disk entry (documented at the
//     resolution seam in @wudao/providers config.ts);
//   - ω99-2b: the DIRECTORY tier is hardened too — every write rides the
//     private-storage primitive (dir 0700, Windows icacls, directory links
//     refused), so the 0600 file never sits in a group-walkable 0755 tree.
import { readFile, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalHome } from "./settings-layer.js";
import { writePrivateFile, writePrivateFileSync } from "./private-storage.js";

/** Where the credentials file lives (M57 reserved the name; M63 §B fills it). */
export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), ".credentials.yaml");
}

/** M63 §C: the wizard boot's stand-in key. The session machinery (key pool,
 *  model construction) requires a non-empty key, but the browse-only session
 *  must never look keyed — every consumer (resolveProviderSwitch's pool
 *  filter, the same-provider switch carve-out, the run guard) treats this
 *  sentinel as ABSENT, so it can never ride a live request. Lives here (a
 *  leaf module) so provider.ts / run.ts / session-engine share one constant
 *  without an import cycle. */
export const WIZARD_PLACEHOLDER_KEY = "wudao-wizard-unconfigured";

/** Provider ids the file accepts: letter first, then letters/digits/_/-. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A parsed credentials map: provider id → API key. Values are secrets —
 *  never stringify, log, or serialize one into a status payload. */
export type CredentialsMap = Readonly<Record<string, string>>;

/** Parse the YAML-lite body. Pure; lenient (bad lines skip, nothing throws). */
export function parseCredentialsYaml(text: string): CredentialsMap {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine !== rawLine.trim() && rawLine.trim() !== "") continue; // indented = nested block — not a credential
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Only a top-level `id: value` scalar counts. Nested YAML (an `id:` with
    // an indented block) leaves the value empty → skipped; its child lines
    // carry leading whitespace → skipped by the guard above.
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (m === null) continue;
    const id = m[1] ?? "";
    let value = (m[2] ?? "").trim();
    if (value === "") continue; // empty value = no key
    // Matched surrounding quotes (single or double) — the only quoting the
    // format supports; anything else rides raw.
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        value = value.slice(1, -1);
      }
    }
    if (value === "") continue; // "" / '' — quotes around nothing = no key
    out[id] = value;
  }
  return out;
}

/** Deterministic serialization: fixed header, ids sorted (byte-stable output
 *  regardless of insertion order — diffs stay minimal). */
export function formatCredentialsYaml(map: CredentialsMap): string {
  const ids = Object.keys(map).filter((id) => ID_RE.test(id) && (map[id] ?? "").trim() !== "").sort();
  const lines = [
    "# wudao credentials (M63 §B) — one key per line: PROVIDER_ID: <key>",
    "# managed by `wudao ui` settings; mode 0600 is enforced on every write",
  ];
  for (const id of ids) lines.push(`${id}: ${map[id]}`);
  return `${lines.join("\n")}\n`;
}

/** Read the file (async). Absent/unreadable/malformed → {} — the fallback
 *  source must never hard-fail a startup. */
export async function readCredentialsFile(env: NodeJS.ProcessEnv = process.env): Promise<CredentialsMap> {
  try {
    return parseCredentialsYaml(await readFile(credentialsFilePath(env), "utf8"));
  } catch {
    return {};
  }
}

/** Sync twin for the sync resolution seam (buildRunPlan). Same leniency. */
export function readCredentialsFileSync(env: NodeJS.ProcessEnv = process.env): CredentialsMap {
  try {
    return parseCredentialsYaml(readFileSync(credentialsFilePath(env), "utf8"));
  } catch {
    return {};
  }
}

/** Write the whole map via the private-storage primitive (ω99-2b): dir 0700,
 *  same-dir tmp-file created at 0600 + atomic rename, then chmod 0600 — the
 *  enforcement point (a pre-loosened path is repaired by the next save, and
 *  the parent chain is refused if any directory link rides it). Returns the
 *  path + key count (count only: callers surface "N keys", never values). */
export async function writeCredentialsFile(
  map: CredentialsMap,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly path: string; readonly keyCount: number }> {
  const path = credentialsFilePath(env);
  await writePrivateFile(path, formatCredentialsYaml(map));
  return { path, keyCount: Object.keys(map).length };
}

/** Sync write twin (same atomic + 0600 + private-directory contract). */
export function writeCredentialsFileSync(
  map: CredentialsMap,
  env: NodeJS.ProcessEnv = process.env,
): { readonly path: string; readonly keyCount: number } {
  const path = credentialsFilePath(env);
  writePrivateFileSync(path, formatCredentialsYaml(map));
  return { path, keyCount: Object.keys(map).length };
}

/** Set ONE provider's key (read-modify-write; other keys untouched). Throws
 *  on an invalid id or empty key — the error names the id, never a value. */
export async function saveProviderKey(
  provider: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly path: string; readonly keyCount: number }> {
  const id = provider.trim();
  if (!ID_RE.test(id)) throw new Error(`invalid credentials id "${id}" (expected letter first, then [A-Za-z0-9_-])`);
  const value = key.trim();
  if (value === "") throw new Error(`empty key for "${id}" — nothing to save`);
  const current = await readCredentialsFile(env);
  return writeCredentialsFile({ ...current, [id]: value }, env);
}

/** The status face every surface reports: counts only, never values. Absent
 *  file → count 0; unreadable mode → modeOk false (doctor warns + hints the
 *  repair that the next write performs anyway). */
export interface CredentialsFileStatus {
  readonly path: string;
  readonly keyCount: number;
  /** Octal permission string ("600") when the file exists. */
  readonly mode?: string;
  /** False when the on-disk mode is looser than 0600. */
  readonly modeOk: boolean;
}

export async function credentialsFileStatus(env: NodeJS.ProcessEnv = process.env): Promise<CredentialsFileStatus> {
  const path = credentialsFilePath(env);
  try {
    const info = await stat(path);
    const octal = (info.mode & 0o777).toString(8);
    const keys = parseCredentialsYaml(await readFile(path, "utf8"));
    return { path, keyCount: Object.keys(keys).length, mode: octal, modeOk: modeOkOnThisPlatform(info.mode) };
  } catch {
    return { path, keyCount: 0, modeOk: true };
  }
}

/** Sync twin for sync status surfaces (doctor's check). */
export function credentialsFileStatusSync(env: NodeJS.ProcessEnv = process.env): CredentialsFileStatus {
  const path = credentialsFilePath(env);
  try {
    const info = statSync(path);
    const octal = (info.mode & 0o777).toString(8);
    const keys = parseCredentialsYaml(readFileSync(path, "utf8"));
    return { path, keyCount: Object.keys(keys).length, mode: octal, modeOk: modeOkOnThisPlatform(info.mode) };
  } catch {
    return { path, keyCount: 0, modeOk: true };
  }
}

/** win32 has no enforced POSIX mode bits (a 0600 create reads back 0666) —
 *  the 0600 contract is vacuous there, so status reports modeOk rather than
 *  flagging a "repair" that cannot succeed. */
function modeOkOnThisPlatform(mode: number): boolean {
  if (process.platform === "win32") return true;
  return (mode & 0o777) === 0o600;
}
