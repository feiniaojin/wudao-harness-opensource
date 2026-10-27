// M62 §2 — data lifecycle + `wudao purge`. Transcripts, spills, and
// checkpoint snapshots are RUNTIME DATA, not memory: they self-expire so a
// long-lived workspace does not accumulate a plaintext archive forever.
//
//   cleanupPeriodDays   (default 30, scalar) — a cleanable file older than
//                       this leaves the workspace at startup.
//   softDeletePeriodDays (default 7)          — nothing is hard-deleted on
//                       the spot: expired files MOVE to `.wudao/trash/`
//                       first (recoverable by hand), and the trash itself
//                       is hard-deleted once its entries age out. Regret
//                       has a window.
//
// Cleanable categories (structurally exhaustive — nothing else is ever
// walked, so the never-list holds by construction):
//   .wudao/sessions/*.jsonl     expired session transcripts
//   .wudao/spill/**             tool-result spill files
//   .wudao/history/**           /rewind checkpoint snapshots
//   .wudao/logs/** + *.log      debug logs
//   .wudao/agent-memory/**      M64-B: PROJECT-tier agent memory (expires
//                               with cleanupPeriodDays; `wudao purge` still
//                               never touches memory, so the walk is
//                               sweep-only — buildPurgePlan opts out)
// NEVER touched: memory.jsonl, .wudao/agent-memory-local/ (M64-B local-tier
// agent memory — never cleaned), settings*.json, experiments.jsonl,
// agents/skills/rules dirs, global history.jsonl, mcp.json, keybindings,
// plugins, extensions, workflows, wt, evals, search-index, plan.md,
// agents-stats.json, the USER tier's <globalHome>/agent-memory (outside the
// workspace by construction) — and the CURRENT session file (the caller
// passes it as a skip so `--resume` of an old session never races the sweep).
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Default retention before a cleanable file leaves the workspace. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
/** Default soft-delete window (trash residency) before a hard delete. */
export const DEFAULT_SOFT_DELETE_PERIOD_DAYS = 7;

export interface LifecycleSettings {
  readonly cleanupPeriodDays: number;
  readonly softDeletePeriodDays: number;
}

/** Resolve the two lifecycle scalars from the effective settings record
 *  (tolerant: junk → default + warning, never fatal). */
export function resolveLifecycleSettings(
  effective: Readonly<Record<string, unknown>> | undefined,
  warn: (m: string) => void = () => {},
): LifecycleSettings {
  const dayValue = (key: string, fallback: number): number => {
    const raw = effective?.[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      warn(`⚠️ settings: "${key}" must be a positive number of days; using the default (${fallback})`);
      return fallback;
    }
    return raw;
  };
  return {
    cleanupPeriodDays: dayValue("cleanupPeriodDays", DEFAULT_CLEANUP_PERIOD_DAYS),
    softDeletePeriodDays: dayValue("softDeletePeriodDays", DEFAULT_SOFT_DELETE_PERIOD_DAYS),
  };
}

/** One cleanable (or trashed) file with the facts the plan prints. */
export interface CleanableEntry {
  /** Absolute path. */
  readonly absPath: string;
  /** Path relative to the workspace's .wudao (the purge plan prints this). */
  readonly relPath: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** Walk one cleanable root recursively, collecting files with stats. */
async function walkFiles(root: string, relBase: string, out: CleanableEntry[], filter?: (rel: string) => boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // no such root — nothing cleanable there
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkFiles(full, rel, out, filter);
    } else if (entry.isFile()) {
      if (filter !== undefined && !filter(rel)) continue;
      try {
        const s = await stat(full);
        out.push({ absPath: full, relPath: rel, bytes: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* raced away — skip */
      }
    }
  }
}

/** Every cleanable file in the workspace's .wudao (all ages — callers
 *  filter). The current-session skip protects a `--resume`d transcript.
 *  M64-B §B: the PROJECT-tier agent-memory tree joins the walked roots
 *  (memory expires with cleanupPeriodDays); `wudao purge` opts OUT
 *  (includeAgentMemory:false) to keep its "never memory" contract — only
 *  TIME expires memory. */
export async function collectCleanableFiles(
  workspaceRoot: string,
  skipAbs: readonly string[] = [],
  opts: { readonly includeAgentMemory?: boolean } = {},
): Promise<CleanableEntry[]> {
  const root = resolve(workspaceRoot);
  const wudao = join(root, ".wudao");
  const skip = new Set(skipAbs.map((p) => resolve(p)));
  const out: CleanableEntry[] = [];
  await walkFiles(join(wudao, "sessions"), "sessions", out, (rel) => rel.endsWith(".jsonl"));
  await walkFiles(join(wudao, "spill"), "spill", out);
  await walkFiles(join(wudao, "history"), "history", out);
  await walkFiles(join(wudao, "logs"), "logs", out);
  if (opts.includeAgentMemory !== false) {
    await walkFiles(join(wudao, "agent-memory"), "agent-memory", out);
  }
  // Loose debug logs directly under .wudao (a.log) — the legacy spelling.
  let top: readonly { name: string; isFile(): boolean }[] = [];
  try {
    top = await readdir(wudao, { withFileTypes: true });
  } catch {
    top = [];
  }
  for (const entry of top) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const full = join(wudao, entry.name);
    try {
      const s = await stat(full);
      out.push({ absPath: full, relPath: entry.name, bytes: s.size, mtimeMs: s.mtimeMs });
    } catch {
      /* raced */
    }
  }
  return out.filter((e) => !skip.has(e.absPath));
}

/** The trash tree's files (rel paths mirror the .wudao structure). */
export async function collectTrashFiles(workspaceRoot: string): Promise<CleanableEntry[]> {
  const out: CleanableEntry[] = [];
  await walkFiles(join(resolve(workspaceRoot), ".wudao", "trash"), "", out);
  return out;
}

/** The `.wudao/trash/` path a soft-deleted file lands at (collision →
 *  `-2`, `-3`, … before the extension, deterministic). */
export async function trashTargetFor(trashDir: string, relPath: string): Promise<string> {
  const target = join(trashDir, relPath);
  try {
    await stat(target);
  } catch {
    return target; // free
  }
  const ext = relPath.endsWith(".jsonl") ? ".jsonl" : "";
  const stem = ext === "" ? relPath : relPath.slice(0, -ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = join(trashDir, `${stem}-${n}${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

export interface SweepResult {
  /** Files moved into .wudao/trash (soft-deleted) this run. */
  readonly softDeleted: readonly CleanableEntry[];
  /** Trash files hard-deleted this run (aged past softDeletePeriodDays). */
  readonly hardDeleted: readonly CleanableEntry[];
  readonly softDeletedBytes: number;
  readonly hardDeletedBytes: number;
}

/** Move one file into the trash (soft delete). Never throws.
 *  M62 fix: the trash entry's mtime is RESET to the trash time (`now`) so
 *  `softDeletePeriodDays` counts from WHEN the file was trashed, not the
 *  original file's age — otherwise an already-expired file (mtime past the
 *  cleanup window) is also past the trash window and hard-deletes within
 *  the same sweep, making the recoverable window illusory for aged files. */
async function softDelete(workspaceRoot: string, entry: CleanableEntry, now: number): Promise<boolean> {
  try {
    const trashDir = join(resolve(workspaceRoot), ".wudao", "trash");
    const target = await trashTargetFor(trashDir, entry.relPath);
    await mkdir(dirname(target), { recursive: true });
    await rename(entry.absPath, target);
    const t = new Date(now);
    await utimes(target, t, t).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The startup lifecycle scan: (a) expired cleanable files move into
 *  `.wudao/trash/`, (b) trash entries older than softDeletePeriodDays are
 *  hard-deleted. Best-effort — a failure on one file never stops the scan. */
export async function runLifecycleSweep(
  workspaceRoot: string,
  settings: LifecycleSettings,
  now: number = Date.now(),
  skipAbs: readonly string[] = [],
): Promise<SweepResult> {
  const retentionMs = settings.cleanupPeriodDays * 86_400_000;
  const softMs = settings.softDeletePeriodDays * 86_400_000;
  const candidates = (await collectCleanableFiles(workspaceRoot, skipAbs))
    .filter((e) => now - e.mtimeMs > retentionMs);
  const softDeleted: CleanableEntry[] = [];
  for (const entry of candidates) {
    if (await softDelete(workspaceRoot, entry, now)) softDeleted.push(entry);
  }
  const hardDeleted: CleanableEntry[] = [];
  for (const entry of await collectTrashFiles(workspaceRoot)) {
    if (now - entry.mtimeMs <= softMs) continue;
    try {
      await rm(entry.absPath, { force: true });
      hardDeleted.push(entry);
    } catch {
      /* best-effort */
    }
  }
  const bytes = (list: readonly CleanableEntry[]): number => list.reduce((n, e) => n + e.bytes, 0);
  return { softDeleted, hardDeleted, softDeletedBytes: bytes(softDeleted), hardDeletedBytes: bytes(hardDeleted) };
}

/** The `wudao purge` plan: every cleanable file regardless of age (the
 *  command is the explicit "clean my runtime data now" surface). Trash is
 *  NOT part of the plan — purged files soft-delete into .wudao/trash and the
 *  regular lifecycle sweep hard-deletes aged entries (softDeletePeriodDays). */
export interface PurgePlan {
  readonly entries: readonly CleanableEntry[];
  readonly totalBytes: number;
}

export async function buildPurgePlan(workspaceRoot: string, skipAbs: readonly string[] = []): Promise<PurgePlan> {
  // M64-B §B: purge never touches memory (its long-standing contract) —
  // project-tier agent memory expires with cleanupPeriodDays via the
  // lifecycle SWEEP, not the explicit purge.
  const entries = await collectCleanableFiles(workspaceRoot, skipAbs, { includeAgentMemory: false });
  return { entries, totalBytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

/** Execute a purge: soft-delete every planned file (the same .wudao/trash/
 *  window as the lifecycle scan — purge is reversible for
 *  softDeletePeriodDays). --dry-run callers never reach here. The trash
 *  entry's mtime is reset to the trash time (see softDelete) so the window
 *  counts from purge time, not the original file's age. */
export async function executePurge(workspaceRoot: string, plan: PurgePlan, now: number = Date.now()): Promise<SweepResult> {
  const softDeleted: CleanableEntry[] = [];
  for (const entry of plan.entries) {
    if (await softDelete(workspaceRoot, entry, now)) softDeleted.push(entry);
  }
  return {
    softDeleted,
    hardDeleted: [],
    softDeletedBytes: softDeleted.reduce((n, e) => n + e.bytes, 0),
    hardDeletedBytes: 0,
  };
}

/** Human size for the plan/notice lines. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The one-line startup notice (count + bytes; "" when nothing happened). */
export function formatSweepNotice(result: SweepResult): string {
  if (result.softDeleted.length === 0 && result.hardDeleted.length === 0) return "";
  const parts: string[] = [];
  if (result.softDeleted.length > 0) {
    parts.push(`已将 ${result.softDeleted.length} 个文件（${formatBytes(result.softDeletedBytes)}）移入 .wudao/trash`); // ω99-194: #1
  }
  if (result.hardDeleted.length > 0) {
    parts.push(`已彻底清除 ${result.hardDeleted.length} 个回收站文件（${formatBytes(result.hardDeletedBytes)}）——超软删除窗口`); // ω99-194: #2
  }
  return `♻️ 生命周期：${parts.join("，")}`; // ω99-194: #3
}

/** The purge plan's printed form (path + size + age per line). */
export function formatPurgePlan(plan: PurgePlan, now: number = Date.now()): string {
  const lines = [`清除计划——${plan.entries.length} 个文件，${formatBytes(plan.totalBytes)}（软删除至 .wudao/trash；软删除窗口内可恢复）：`]; // ω99-194: #4
  for (const e of [...plan.entries].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
    const ageDays = Math.floor((now - e.mtimeMs) / 86_400_000);
    lines.push(`  ${e.relPath}  ${formatBytes(e.bytes)}  ${ageDays} 天前`); // ω99-194: #5
  }
  return lines.join("\n");
}

/** /doctor's trash summary (0 files → null). */
export async function trashStats(workspaceRoot: string): Promise<{ files: number; bytes: number; oldestDays: number } | null> {
  const files = await collectTrashFiles(workspaceRoot);
  if (files.length === 0) return null;
  const now = Date.now();
  const oldest = Math.max(...files.map((f) => now - f.mtimeMs));
  return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), oldestDays: Math.floor(oldest / 86_400_000) };
}
