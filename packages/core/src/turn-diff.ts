// 夜移 032 (codex turn_diff_tracker.rs port) — the per-run net file-change
// ledger. Five sequential edits to one file leave five receipts and no answer
// to "what did THIS run actually change?"; the tracker keeps codex's
// baseline/current algebra: per path, the FIRST write's pre-state is the
// baseline and the LAST write's bytes are the current, so the run's net diff
// is one before→after pair no matter how many writes landed (codex
// baseline_by_path / current_by_path; the first-seen guard in apply_update).
// Scope v1 (deliberate divergences from codex):
//   * write_file/edit at the top-level session only — child sidechains and
//     bookkeeping workspaces (agent memory, title calls) never report; codex
//     merges every environment keyed by environment_id.
//   * no rename pairs (wudao's write path has no move primitive) and no
//     revision-keyed render cache (wudao renders once at run end, not
//     continuously into a live pane) — both YAGNI here.
//   * shell mutations are outside the ledger by construction; M32's
//     external-change prober owns observing the filesystem, not this.
//   * an identical-net write is still listed (evidence a run rewrote bytes
//     to the same content); codex's renderer drops left==right pairs.

/** How the run first saw the file. */
export type TurnDiffOp = "created" | "modified";

export interface TurnDiffFile {
  /** The path as recorded (absolute — tools report their resolved target;
   *  the display-relative mapping is the renderer's job). */
  readonly path: string;
  /** created (first write this run was a create) vs modified. */
  readonly op: TurnDiffOp;
  /** Pre-state of the FIRST write this run; undefined = created. */
  readonly before: string | undefined;
  /** Bytes of the LAST write this run. */
  readonly after: string;
  /** How many writes touched the path this run (retry/rewrite evidence). */
  readonly writes: number;
}

export interface TurnDiffTracker {
  /** One committed write_file/edit mutation. Call AFTER the bytes land (a
   *  failed write is not evidence). First record for a path fixes the
   *  baseline; later records only advance `after`. */
  record(path: string, before: string | undefined, after: string): void;
  /** Clear for the next run (the previous run's result becomes the next
   *  baseline — it is not carried over). */
  resetRun(): void;
  /** The net ledger, sorted by path (deterministic — no insertion-order
   *  leak from the backing map). */
  files(): readonly TurnDiffFile[];
}

interface Slot {
  before: string | undefined;
  after: string;
  writes: number;
}

export function createTurnDiffTracker(): TurnDiffTracker {
  const byPath = new Map<string, Slot>();
  return {
    record(path, before, after) {
      const slot = byPath.get(path);
      if (slot === undefined) {
        byPath.set(path, { before, after, writes: 1 });
        return;
      }
      slot.after = after;
      slot.writes += 1;
    },
    resetRun() {
      byPath.clear();
    },
    files() {
      return [...byPath.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, s]) => ({ path, op: s.before === undefined ? ("created" as const) : ("modified" as const), before: s.before, after: s.after, writes: s.writes }));
    },
  };
}

/** The one-line receipt preview for the run's net change (the notice text;
 *  the full diff rides the notice detail). Pure — shared by the cli driver
 *  surfaces. `rel` maps an absolute recorded path to its display path. */
export function formatTurnDiffPreview(
  files: readonly TurnDiffFile[],
  rel: (absPath: string) => string,
  maxListed = 3,
): string {
  if (files.length === 0) return "";
  const parts = files.slice(0, maxListed).map((f) => {
    const name = rel(f.path);
    return f.op === "created" ? `${name}(新建)` : `${name}(×${f.writes})`;
  });
  const rest = files.length - Math.min(files.length, maxListed);
  const list = rest > 0 ? `${parts.join(" · ")} 等 ${files.length} 文件` : parts.join(" · ");
  return `回合净变更 ${files.length} 文件：${list}`;
}
