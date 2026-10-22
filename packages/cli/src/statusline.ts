// M53 §3 — the statusline JSON contract. `snapshotForStatusline()` (a driver
// method) is the SINGLE data source: the TUI's bottom bar, the web status
// line, and `wudao statusline --json` all render the same snapshot shape.
// The standalone CLI form rebuilds the same shape from the newest session
// file + env (no live driver exists in a fresh process — a statusline script
// polls it; debouncing is the CONSUMER's job, per the contract).
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DriverStatus } from "./driver/agent-driver.js";
import { formatTokensK } from "./log.js";
import { modeLabel } from "./permission.js";
import { SEGMENT_SEP } from "./tui/theme.js";
// M63 §B: the credentials count (count only, never values).
import { credentialsFileStatus } from "./credentials.js";

/** The machine-readable statusline state (spec §3: model/provider/mode/
 *  session/ctx/cache/sidecar/bg/board). All fields JSON-safe. */
export interface StatuslineSnapshot {
  readonly version: string;
  readonly model: string;
  readonly provider?: string;
  readonly mode: string;
  readonly session: { readonly id: string; readonly id8: string; readonly name?: string };
  readonly busy: boolean;
  readonly queued: number;
  readonly ctx: { readonly used: number | null; readonly window: number; readonly nearLimit: boolean } | null;
  readonly cache: { readonly percent: number } | null;
  readonly board: { readonly done: number; readonly total: number } | null;
  readonly sidecar: { readonly checks: number; readonly breakerOpen: boolean } | null;
  readonly bg: { readonly active: number; readonly spawned: number };
  /** Bounded live magnitudes (never content — a statusline must not leak the
   *  streaming answer). */
  readonly live: { readonly answerChars: number; readonly reasoningChars: number; readonly busyTools: number };
  /** M56 §1: the key pool (`keys n/m` — available/total). Omitted when this
   *  frontend has no pool to report. */
  readonly keys?: { readonly available: number; readonly total: number };
  /** M63 §B: the credentials file's key COUNT (`credentials N keys`) — never
   *  values. Omitted when no file exists (the standalone form reads it). */
  readonly credentials?: { readonly count: number };
  /** ω99-253: #5 — the agent root's git branch (the TUI bar's branch segment —
   *  the workspace anchor's one property). "HEAD" = detached, verbatim;
   *  omitted when the driver reported null/absent (non-repo / read failure
   *  / the standalone form, which spawns nothing) — the zero-render gate.
   *  The value is CACHED in the driver (boot + run-settle + root-switch
   *  reads); building a snapshot never spawns. */
  readonly gitBranch?: string | null;
}

/** The identity-carrying meta a driver cannot know by itself (model label,
 *  provider name, session name) — supplied by the frontend that owns them. */
export interface StatuslineMeta {
  readonly version: string;
  readonly model: string;
  readonly provider?: string;
  readonly sessionName?: string;
  /** M56 §1: the provider's key pool — the `keys n/m` segment's live source
   *  (availability moves as 429 cooldowns land and lapse). */
  readonly keys?: { readonly snapshot: () => { readonly total: number; readonly available: number; readonly cooling: number } };
}

/** Pure: fold a driver status snapshot (+ meta) into the contract shape. */
export function buildStatuslineSnapshot(status: DriverStatus, meta: StatuslineMeta): StatuslineSnapshot {
  const keySnapshot = meta.keys?.snapshot();
  return {
    version: meta.version,
    model: meta.model,
    ...(meta.provider !== undefined ? { provider: meta.provider } : {}),
    mode: status.mode,
    session: {
      id: status.sessionId,
      id8: status.sessionId.slice(0, 8),
      ...(meta.sessionName !== undefined ? { name: meta.sessionName } : {}),
    },
    busy: status.busy,
    queued: status.queued.length,
    ctx: status.ctxTokens === null ? null : {
      used: status.ctxTokens.used,
      window: status.ctxTokens.window,
      nearLimit: status.ctxTokens.nearLimit,
    },
    cache: status.cachePercent === null ? null : { percent: Math.round(status.cachePercent) },
    board: status.boardProgress,
    sidecar: status.sidecar,
    bg: status.bg,
    live: {
      answerChars: status.live.answer.length,
      reasoningChars: status.live.reasoning.length,
      busyTools: status.live.busyTools.length,
    },
    ...(keySnapshot !== undefined ? { keys: { available: keySnapshot.available, total: keySnapshot.total } } : {}),
    // ω99-253: the cached branch rides along only when the driver reported
    // one (null and absent both omit — old-driver fixtures stay byte-equal).
    ...(typeof status.gitBranch === "string" && status.gitBranch !== "" ? { gitBranch: status.gitBranch } : {}),
  };
}

/** The one-line human form (what a bare `wudao statusline` prints and the
 *  TUI's dim bar shows). Segments with no data are omitted. */
export function formatStatuslineLine(s: StatuslineSnapshot): string {
  const segments: string[] = [`wudao · ${s.model} · ${s.session.id8}`];
  // ω99-253: the branch segment rides right after the head (which checkout
  // this session works in — identity-adjacent, the web advanced face's twin
  // position). Verbatim name; "HEAD" is a detached checkout shown honestly.
  if (typeof s.gitBranch === "string" && s.gitBranch !== "") segments.push(s.gitBranch);
  // 0.3.13: the display word (workspace shows as accept); s.mode itself is
  // the raw wire value and stays untouched in the snapshot's JSON form.
  segments.push(`模式 ${modeLabel(s.mode as Parameters<typeof modeLabel>[0])}`); // ω99-190: #1
  if (s.ctx !== null) {
    segments.push(`ctx ${s.ctx.used === null ? "…" : formatTokensK(s.ctx.used)}/${formatTokensK(s.ctx.window)}${s.ctx.nearLimit ? " ⚠" : ""}`);
  }
  if (s.cache !== null) segments.push(`cache ${s.cache.percent}%`);
  if (s.board !== null) segments.push(`▣ ${s.board.done}/${s.board.total}`);
  if (s.bg.spawned > 0) segments.push(`bg ${s.bg.active}/${s.bg.spawned}`);
  if (s.sidecar !== null && s.sidecar.checks > 0) {
    segments.push(`sidecar ${s.sidecar.checks}${s.sidecar.breakerOpen ? " 🛡✕" : ""}`);
  }
  if (s.busy) segments.push("busy");
  if (s.queued > 0) segments.push(`queued ${s.queued}`);
  if (s.keys !== undefined) segments.push(`keys ${s.keys.available}/${s.keys.total}`);
  // M63 §B: count only — a statusline must never carry a key value.
  if (s.credentials !== undefined && s.credentials.count > 0) segments.push(`credentials ${s.credentials.count} keys`);
  return segments.join(SEGMENT_SEP);
}

// ---------------------------------------------------------------------------
// The standalone form: `wudao statusline [--json]` — snapshot rebuilt from the
// newest session file + env (there is no live driver in this process).
// ---------------------------------------------------------------------------

interface SessionSummary {
  readonly id: string;
  readonly name?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly messages: number;
}

async function newestSessionId(root: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(join(root, ".wudao", "sessions"));
  } catch {
    return undefined;
  }
  let acc: { id: string; mtimeMs: number } | undefined;
  for (const n of names) {
    if (!n.endsWith(".jsonl") || n.startsWith("side-")) continue;
    const id = n.slice(0, -6);
    try {
      const s = await stat(join(root, ".wudao", "sessions", n));
      if (acc === undefined || s.mtimeMs > acc.mtimeMs) acc = { id, mtimeMs: s.mtimeMs };
    } catch {
      // raced deletion — skip
    }
  }
  return acc?.id;
}

/** Read the newest session's summary (model-state entries + name + count). */
export async function readNewestSessionSummary(root: string, fallbackId: string): Promise<SessionSummary> {
  const id = (await newestSessionId(root)) ?? fallbackId;
  const out: SessionSummary = { id, messages: 0 };
  try {
    const text = await readFile(join(root, ".wudao", "sessions", `${id}.jsonl`), "utf8");
    let messages = 0;
    let model: string | undefined;
    let provider: string | undefined;
    let name: string | undefined;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const e = parsed as Record<string, unknown>;
      if (typeof e["role"] === "string") messages += 1;
      else if (e["type"] === "model_change" && typeof e["model"] === "string") {
        model = e["model"];
        if (typeof e["provider"] === "string") provider = e["provider"];
      } else if (e["type"] === "provider_change" && typeof e["model"] === "string") {
        // M63 §A review: the same fold as model_change — a session ending on
        // a provider switch shows the POST-switch identity, not the stale one.
        model = e["model"];
        if (typeof e["provider"] === "string") provider = e["provider"];
      } else if (e["type"] === "session_name" && typeof e["name"] === "string") {
        name = e["name"];
      }
    }
    return { id, messages, ...(name !== undefined ? { name } : {}), ...(model !== undefined ? { model } : {}), ...(provider !== undefined ? { provider } : {}) };
  } catch {
    return out;
  }
}

/** The standalone snapshot: newest session + env model, no live state. */
export async function statuslineFromWorkspace(root: string, env: NodeJS.ProcessEnv, version: string): Promise<StatuslineSnapshot> {
  const session = await readNewestSessionSummary(root, "—");
  const envModel = env.WUDAO_MODEL?.trim();
  // M63 §B: the credentials file's key count (count only — never values).
  const credentials = await credentialsFileStatus(env);
  return {
    version,
    model: session.model ?? envModel ?? "unset",
    ...(session.provider !== undefined ? { provider: session.provider } : {}),
    mode: "workspace",
    session: {
      id: session.id,
      id8: session.id.slice(0, 8),
      ...(session.name !== undefined ? { name: session.name } : {}),
    },
    busy: false,
    queued: 0,
    ctx: null,
    cache: null,
    board: null,
    sidecar: null,
    bg: { active: 0, spawned: 0 },
    live: { answerChars: 0, reasoningChars: 0, busyTools: 0 },
    ...(credentials.keyCount > 0 ? { credentials: { count: credentials.keyCount } } : {}),
  };
}
