// M64-A §A — the on-disk session registry: `<globalHome>/run/u<uid>/`
// (0700 — the OS-user isolation boundary), one `<session>.sock` per live
// session plus a `registry.json` entry per session (name, socket, pid, tier).
// Local-first, zero server: discovery = read the file, probe liveness
// (pid alive AND socket present), skip bad entries — a corrupt row never
// blocks delivery. Naming follows the spec: /rename or --name; default =
// cwd directory name + a 2-char suffix; same-name live sessions pick
// variant names; same-name addressing falls back to the short identifier.
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomInt } from "node:crypto";
import { resolveGlobalHome } from "../settings-layer.js";
import { type PeerTier } from "./defs.js";

export interface PeerRegistryEntry {
  readonly sessionId: string;
  readonly name: string;
  readonly socket: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly tier: PeerTier;
}

export const PEER_REGISTRY_FILE = "registry.json";
/** macOS sun_path is 104 bytes; keep headroom under the global home. */
const SOCKET_PATH_MAX = 96;

/** The per-OS-user run dir: `<globalHome>/run/u<uid>` (0700). A shared
 *  WUDAO_GLOBAL_HOME therefore still isolates OS users from each other —
 *  nobody else's sockets, nobody else's registry. */
export function peerRunDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(resolveGlobalHome(env), "run", `u${uid}`);
}

/** `<runDir>/<session>.sock` — hashed down when the full path would exceed
 *  the unix-socket name limit (the registry records the real path either
 *  way, so discovery never depends on the derivation).
 *
 *  win32: filesystem AF_UNIX paths cannot be listened on (libuv refuses with
 *  EACCES) — the same inbox semantics ride a named pipe
 *  `\\.\pipe\wudao-<runDir-hash>-<session>` instead. The pipe name is unique
 *  per (user, session) and dies with the listener, so the posix stale-socket
 *  file dance does not apply. */
export function peerSocketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\wudao-${peerPipeStem(sessionId, env)}`;
  }
  const direct = join(peerRunDir(env), `${sessionId}.sock`);
  if (direct.length <= SOCKET_PATH_MAX) return direct;
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i += 1) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return join(peerRunDir(env), `m${h.toString(16)}.sock`);
}

/** win32 pipe-name stem: FNV-1a over the runDir + sessionId — stable for the
 *  same (user, session) pair, unique across sessions, charset-safe. */
function peerPipeStem(sessionId: string, env: NodeJS.ProcessEnv): string {
  const scope = peerRunDir(env);
  let h = 0x811c9dc5;
  for (const s of [scope, sessionId]) {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${h.toString(16)}-${sessionId.replace(/[^\w.-]+/g, "-").slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Sanitize a cwd basename into a peer-name stem: [A-Za-z0-9._-], ≤24 chars. */
export function peerNameStem(workspaceRoot: string): string {
  const raw = basename(workspaceRoot === "" ? process.cwd() : workspaceRoot)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-]+$/g, "")
    .slice(0, 24);
  return raw === "" ? "session" : raw;
}

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) out += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return out;
}

/** The default name: cwd stem + 2-char suffix (`wudao-harness-a7`). */
export function defaultPeerName(workspaceRoot: string): string {
  return `${peerNameStem(workspaceRoot)}-${randomSuffix(2)}`;
}

/** Pick a name not taken by a live entry: fresh 2-char suffixes first (the
 *  缺省 shape), then `-2`, `-3` … variants when the suffix space collides
 *  (活会话同名 → 变体名). Bounded; returns the base itself when nothing free
 *  (registration still proceeds — the short id disambiguates). */
export function pickPeerName(workspaceRoot: string, taken: ReadonlySet<string>): string {
  const stem = peerNameStem(workspaceRoot);
  for (let i = 0; i < 24; i += 1) {
    const candidate = `${stem}-${randomSuffix(2)}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${stem}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return stem;
}

/** The short identifier for same-name addressing: the LAST 8 chars of the
 *  session id (the distinctive tail — ids share the "wudao-" head, so a head
 *  prefix would identify nothing). send_message accepts name, short id, or
 *  full id. */
export function peerShortId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

// ---------------------------------------------------------------------------
// The registry file
// ---------------------------------------------------------------------------

interface RegistryFileShape {
  readonly version: 1;
  readonly entries: readonly PeerRegistryEntry[];
}

function validEntry(v: unknown): PeerRegistryEntry | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.sessionId !== "string" || e.sessionId === "") return undefined;
  if (typeof e.name !== "string" || e.name === "") return undefined;
  if (typeof e.socket !== "string" || e.socket === "") return undefined;
  if (typeof e.pid !== "number" || !Number.isInteger(e.pid)) return undefined;
  if (typeof e.startedAt !== "number" || !Number.isFinite(e.startedAt)) return undefined;
  return {
    sessionId: e.sessionId,
    name: e.name,
    socket: e.socket,
    pid: e.pid,
    startedAt: e.startedAt,
    tier: e.tier === "bypass" ? "bypass" : "normal",
  };
}

/** Read every parseable entry (bad rows are skipped, never fatal — 坏条目
 *  剔除不阻塞投递). Absent/corrupt file → []. */
export async function readPeerRegistry(env: NodeJS.ProcessEnv = process.env): Promise<PeerRegistryEntry[]> {
  let text: string;
  try {
    text = await readFile(join(peerRunDir(env), PEER_REGISTRY_FILE), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<RegistryFileShape>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.map(validEntry).filter((e): e is PeerRegistryEntry => e !== undefined);
  } catch {
    return [];
  }
}

async function writePeerRegistry(entries: readonly PeerRegistryEntry[], env: NodeJS.ProcessEnv): Promise<void> {
  const dir = peerRunDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, PEER_REGISTRY_FILE);
  // Symlinked registry = someone pointing us at another user's tree — refuse.
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new Error(`${path} is a symlink — peer registry refused`);
  const body = `${JSON.stringify({ version: 1, entries } satisfies RegistryFileShape, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${randomInt(1_000_000)}`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/** Is a pid alive? (signal 0 probe; ESRCH = dead, EPERM = alive but not ours.) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Entries that look live: pid alive AND socket file present. Dead entries
 *  are pruned from the file (self-healing; a crashed session disappears from
 *  discovery on the next listing). */
export async function listLiveEntries(env: NodeJS.ProcessEnv = process.env): Promise<PeerRegistryEntry[]> {
  const all = await readPeerRegistry(env);
  const live: PeerRegistryEntry[] = [];
  let dirty = false;
  for (const entry of all) {
    // win32: the socket is a named PIPE (\\.\pipe\…) — no filesystem stat;
    // pid liveness is the whole probe (the pipe dies with its listener).
    const socketOk = process.platform === "win32"
      ? true
      : await stat(entry.socket).then((s) => s.isSocket?.() ?? true).catch(() => false);
    if (pidAlive(entry.pid) && socketOk) {
      live.push(entry);
      continue;
    }
    dirty = true;
  }
  if (dirty) await writePeerRegistry(live, env).catch(() => {});
  return live;
}

/** Register (or refresh) this session's entry. Read-modify-write over the
 *  live set; concurrent writers lose at most a stale sibling row, which the
 *  next listLiveEntries self-heals. Returns the WRITTEN entry (with the
 *  possibly-adjusted unique name). */
export async function registerPeerSession(input: {
  readonly sessionId: string;
  readonly name?: string;
  readonly socket: string;
  readonly tier: PeerTier;
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<PeerRegistryEntry> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const live = await listLiveEntries(env);
  const taken = new Set(live.filter((e) => e.sessionId !== input.sessionId).map((e) => e.name));
  const name = input.name !== undefined && input.name !== ""
    ? (taken.has(input.name) ? pickPeerName(input.workspaceRoot, taken) : input.name)
    : pickPeerName(input.workspaceRoot, taken);
  const entry: PeerRegistryEntry = {
    sessionId: input.sessionId,
    name,
    socket: input.socket,
    pid: process.pid,
    startedAt: now(),
    tier: input.tier,
  };
  await writePeerRegistry([...live.filter((e) => e.sessionId !== input.sessionId), entry], env);
  return entry;
}

/** Update this session's entry (rename / tier refresh); no-op when absent. */
export async function updatePeerSession(patch: { readonly sessionId: string; readonly name?: string; readonly tier?: PeerTier; readonly env?: NodeJS.ProcessEnv }): Promise<PeerRegistryEntry | undefined> {
  const env = patch.env ?? process.env;
  const all = await readPeerRegistry(env);
  let updated: PeerRegistryEntry | undefined;
  const next: PeerRegistryEntry[] = [];
  for (const entry of all) {
    if (entry.sessionId !== patch.sessionId) {
      next.push(entry);
      continue;
    }
    updated = {
      ...entry,
      ...(patch.name !== undefined && patch.name !== "" ? { name: patch.name } : {}),
      ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
    };
    next.push(updated);
  }
  if (updated !== undefined) await writePeerRegistry(next, env);
  return updated;
}

/** Remove this session's entry (dispose). Never throws. */
export async function unregisterPeerSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const all = await readPeerRegistry(env);
  const next = all.filter((e) => e.sessionId !== sessionId);
  if (next.length !== all.length) await writePeerRegistry(next, env).catch(() => {});
}

/** Best-effort stale-socket cleanup at startup/dispose. Never throws. */
export async function removeSocketFile(socketPath: string): Promise<void> {
  await unlink(socketPath).catch(() => {});
}

// ---------------------------------------------------------------------------
// Addressing (send_message's `to`)
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { readonly ok: true; readonly entry: PeerRegistryEntry }
  | { readonly ok: false; readonly error: string; readonly candidates?: readonly PeerRegistryEntry[] };

/** Resolve a `to` query against the live entries: exact name (case-folded),
 *  short id (first-6), or full session id. Same-name live sessions are
 *  AMBIGUOUS by name — the error lists `name (shortId)` candidates and the
 *  sender re-addresses by short id (同名寻址加短标识). */
export function resolvePeerTarget(entries: readonly PeerRegistryEntry[], query: string): ResolveResult {
  const q = query.trim();
  if (q === "") return { ok: false, error: "send_message: \"to\" is empty" };
  const byId = entries.find((e) => e.sessionId === q);
  if (byId !== undefined) return { ok: true, entry: byId };
  // Short-id addressing: a ≥4-char SUFFIX of the session id (the tail is the
  // distinctive part; several sessions may share a suffix — ambiguous).
  if (q.length >= 4) {
    const byShort = entries.filter((e) => e.sessionId.endsWith(q));
    if (byShort.length === 1) return { ok: true, entry: byShort[0] as PeerRegistryEntry };
    if (byShort.length > 1) {
      return {
        ok: false,
        error: `send_message: "${q}" matches ${byShort.length} sessions — address one by its full id or name`,
        candidates: byShort,
      };
    }
  }
  const folded = q.toLowerCase();
  const byName = entries.filter((e) => e.name.toLowerCase() === folded);
  if (byName.length === 1) return { ok: true, entry: byName[0] as PeerRegistryEntry };
  if (byName.length > 1) {
    return {
      ok: false,
      error: `send_message: ${byName.length} live sessions are named "${q}" — address one by short id: ${byName.map((e) => `${e.name} (${peerShortId(e.sessionId)})`).join(", ")}`,
      candidates: byName,
    };
  }
  return { ok: false, error: `send_message: no live session "${q}" (list_agents lists them)` };
}
