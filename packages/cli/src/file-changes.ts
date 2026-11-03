// M32 §2 — external-change injection. Between model calls the harness probes
// the session's read-state table (mtime only — cheap); a file that changed
// externally since the model last saw it is re-read and delivered to the model
// as a <file_changed> unified-diff note through the MetaNote channel, then the
// table entry is refreshed (the new version counts as read). The probe is an
// OBSERVER: bounded (≤5 files per round, ~20ms budget, round-robin cursor so
// a large table is not starved) and fail-open (a broken probe never breaks
// the run — the freshness gate in edit/write_file still fails closed).
import { readFile, stat, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { hashContent, readStateEntry, type ReadStateTable } from "@wudao-org/core";

/** Hard cap on one <file_changed> note (unified header + hunks). */
export const NOTE_CAP_BYTES = 8 * 1024;
/** Files probed per model call (round-robin across calls). */
export const DEFAULT_MAX_FILES_PER_ROUND = 5;
/** Wall-clock budget per probe round (advisory — one fs call cannot be
 *  preempted; the budget is checked before each NEXT file). */
export const DEFAULT_PROBE_BUDGET_MS = 20;
/** Context lines around each diff hunk (unified-diff default). */
const HUNK_CONTEXT = 3;
/** LCS cells before the diff degrades to a whole-file replace hunk. */
const MAX_LCS_CELLS = 250_000;
/** Head preview (lines/bytes) for the no-snapshot degradation path. */
const HEAD_PREVIEW_LINES = 20;
const HEAD_PREVIEW_BYTES = 2 * 1024;

// ---------------------------------------------------------------------------
// Line diff → unified hunks (zero deps; deterministic)
// ---------------------------------------------------------------------------

type Op = { type: "ctx" | "del" | "add"; text: string };

function splitLines(content: string): string[] {
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** LCS line diff. Above MAX_LCS_CELLS the whole file becomes one replace
 *  hunk — a pathological diff must not burn the probe's budget. */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:] (row-major flat Uint32Array).
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  const cell = (i: number, j: number): number => dp[at(i, j)] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[at(i, j)] = a[i] === b[j]
        ? cell(i + 1, j + 1) + 1
        : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      ops.push({ type: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j] ?? "" });
    j += 1;
  }
  return ops;
}

/** The unified-diff body: hunks with HUNK_CONTEXT context lines. */
export function unifiedDiffBody(oldContent: string, newContent: string): string[] {
  const ops = diffOps(splitLines(oldContent), splitLines(newContent));
  // Position-tag every op (the line numbers it would occupy in old/new).
  let oldNo = 1;
  let newNo = 1;
  const tagged = ops.map((op) => {
    const t = { ...op, oldNo, newNo };
    if (op.type === "ctx") {
      oldNo += 1;
      newNo += 1;
    } else if (op.type === "del") {
      oldNo += 1;
    } else {
      newNo += 1;
    }
    return t;
  });
  // Merge [change-context, change+context] index windows into hunks.
  const hunks: string[] = [];
  let idx = 0;
  while (idx < tagged.length) {
    if (tagged[idx]?.type === "ctx") {
      idx += 1;
      continue;
    }
    const from = Math.max(0, idx - HUNK_CONTEXT);
    let to = Math.min(tagged.length, idx + HUNK_CONTEXT + 1);
    // Extend while another change lands inside (or touches) the window.
    for (let k = idx + 1; k < to && k < tagged.length; k += 1) {
      if (tagged[k]?.type !== "ctx") to = Math.min(tagged.length, k + HUNK_CONTEXT + 1);
    }
    const window = tagged.slice(from, to);
    const oldLines = window.filter((t) => t.type !== "add");
    const newLines = window.filter((t) => t.type !== "del");
    const oldStart = (oldLines[0] ?? window[0])?.oldNo ?? 1;
    const newStart = (newLines[0] ?? window[0])?.newNo ?? 1;
    const count = (c: number): string => (c === 1 ? "" : `,${c}`);
    const lines = window.map((t) => (t.type === "ctx" ? ` ${t.text}` : t.type === "del" ? `-${t.text}` : `+${t.text}`));
    hunks.push([`@@ -${oldStart}${count(oldLines.length)} +${newStart}${count(newLines.length)} @@`, ...lines].join("\n"));
    idx = to;
  }
  return hunks;
}

/** One <file_changed> note: unified header + capped hunks. Truncation is at
 *  line granularity — the model gets the head of the diff plus an explicit
 *  re-read marker, never a silently empty note. */
export function buildFileChangedNote(relPath: string, oldContent: string, newContent: string): string {
  const open = `<file_changed path="${relPath}">`;
  const header = `--- a/${relPath}\n+++ b/${relPath}`;
  const close = `</file_changed>`;
  const marker = `… (diff truncated at 8KB — re-read ${relPath} for the rest)`;
  const cap = NOTE_CAP_BYTES
    - Buffer.byteLength(`${open}\n${header}\n${close}`, "utf8")
    - Buffer.byteLength(marker, "utf8") - 2;
  let used = 0;
  let truncated = false;
  const rows: string[] = [];
  outer: for (const hunk of unifiedDiffBody(oldContent, newContent)) {
    for (const line of hunk.split("\n")) {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (used + bytes > Math.max(0, cap)) {
        truncated = true;
        break outer;
      }
      used += bytes;
      rows.push(line);
    }
  }
  const body = rows.length > 0 && !truncated
    ? rows.join("\n")
    : `${rows.length > 0 ? `${rows.join("\n")}\n` : ""}${marker}`;
  return `${open}\n${header}\n${body}\n${close}`;
}

/** Degraded note for files whose snapshot was not retained (past the
 *  read-state cap): a re-read hint + the current head. */
export function buildFileChangedNoSnapshotNote(relPath: string, newContent: string): string {
  const lines = splitLines(newContent).slice(0, HEAD_PREVIEW_LINES);
  let used = 0;
  const rows: string[] = [];
  for (const [i, text] of lines.entries()) {
    const row = `${i + 1}→ ${text}`;
    if (used + Buffer.byteLength(row, "utf8") + 1 > HEAD_PREVIEW_BYTES) break;
    used += Buffer.byteLength(row, "utf8") + 1;
    rows.push(row);
  }
  return [
    `<file_changed path="${relPath}">`,
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    "(changed externally; snapshot not retained — current head follows, re-read for the rest)",
    ...rows,
    `</file_changed>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface ExternalChangeProber {
  /** One probe round: stat up to maxFiles table entries (round-robin),
   *  re-read + note the changed ones. Never throws. */
  probe(): Promise<void>;
}

export function createExternalChangeProber(options: {
  readonly readState: ReadStateTable;
  readonly workspaceRoot: string;
  /** MetaNote channel: notes land in the loop's metaNotes queue. */
  readonly push: (text: string) => void;
  readonly maxFiles?: number;
  readonly budgetMs?: number;
  /** Injectable clock (tests); defaults to Date.now. */
  readonly now?: () => number;
}): ExternalChangeProber {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES_PER_ROUND;
  const budgetMs = options.budgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const now = options.now ?? ((): number => Date.now());
  let cursor = 0;
  // Table keys are REALPATHs (resolveWorkspacePath resolves symlinks — on
  // macOS /var is /private/var), so the workspace root must be realpath'd
  // too or relative() decorates every note with ../../ segments.
  let rootReal: string | undefined;

  const relPathOf = async (absPath: string): Promise<string> => {
    rootReal ??= await realpath(options.workspaceRoot).catch(() => options.workspaceRoot);
    return relative(rootReal, absPath);
  };

  const probeFile = async (absPath: string): Promise<void> => {
    const table = options.readState;
    const entry = table.get(absPath);
    if (entry === undefined) return;
    const st = await stat(absPath).catch(() => undefined);
    if (st === undefined) {
      // Vanished externally: nothing to diff against anymore.
      table.delete(absPath);
      return;
    }
    if (st.mtimeMs === entry.mtimeMs) return; // unchanged — the cheap path
    const content = await readFile(absPath, "utf8").catch(() => undefined);
    if (content === undefined) return;
    if (hashContent(content) === entry.contentHash) {
      // Touched but byte-identical: refresh the mtime, no note.
      table.record(absPath, readStateEntry(content, st.mtimeMs));
      return;
    }
    const relPath = await relPathOf(absPath);
    const note = entry.content === undefined
      ? buildFileChangedNoSnapshotNote(relPath, content)
      : buildFileChangedNote(relPath, entry.content, content);
    options.push(note);
    // Treat the new version as read (spec §2: 注入后更新读状态表).
    table.record(absPath, readStateEntry(content, st.mtimeMs));
  };

  return {
    async probe(): Promise<void> {
      try {
        const paths = [...options.readState.entries().keys()];
        if (paths.length === 0) return;
        const started = now();
        const limit = Math.min(maxFiles, paths.length);
        for (let checked = 0; checked < limit; checked += 1) {
          if (checked > 0 && now() - started > budgetMs) break; // budget checked between files
          const absPath = paths[cursor % paths.length] ?? "";
          if (absPath === "") continue;
          cursor += 1;
          try {
            await probeFile(absPath);
          } catch {
            // Per-file isolation: one odd file must not cancel the round.
          }
        }
      } catch {
        // Fail-open observer.
      }
    },
  };
}
