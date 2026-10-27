// M51 §2 — diagnostic baseline-diff. write-verify (M46) answers "is this
// file still valid"; this layer answers "what did THIS write/edit NEWLY
// break": a per-file baseline of diagnostic lines captured BEFORE the bytes
// land (reusing the M46 per-extension checker probes verbatim), then the
// post-write verify outcome is set-diffed against it — only NEW lines ride
// the tool result (after the verify output, with the [diagnostics new: N]
// source label). Budgets: ≤10 new lines per file, ≤30 per turn (a rolling
// window — the tool seam has no turn signal, so "the last 60s of writes" is
// the documented approximation); the per-file baseline is cached 5s (rapid
// successive edits diff against the burst's STARTING state, so intermediate
// errors are not re-reported as new) and bounded to an LRU of 50 files.
import { readFile } from "node:fs/promises";
import {
  verifyWrittenFile,
  MAX_NEW_DIAGNOSTICS_PER_FILE,
  MAX_NEW_DIAGNOSTICS_PER_TURN,
  type DiagnosticsLayer,
  type WriteVerifyConfig,
  type WriteVerifyOutcome,
} from "@wudao/core";

/** Per-file baseline freshness window. */
export const BASELINE_TTL_MS = 5_000;
/** Maximum baselines held at once (LRU, insertion-order eviction). */
export const BASELINE_LRU_LIMIT = 50;
/** The per-turn approximation: emitted lines within this window share the
 *  ≤30 budget. Generous for a turn (multi-file batch edits), short enough
 *  that two separate turns never share a budget. */
const TURN_WINDOW_MS = 60_000;

/** The M46 checker entry, as an injection seam (tests script it). */
export type VerifyFn = (args: {
  readonly absPath: string;
  readonly content: string;
  readonly workspaceRoot: string;
  readonly config: WriteVerifyConfig;
}) => Promise<WriteVerifyOutcome>;

/** Run the per-extension checker over each path's CURRENT on-disk content →
 *  Map<path, diagnostic lines>. A missing file is an empty baseline (the
 *  next write is a create — nothing pre-existed). Never throws. */
export async function captureBaseline(args: {
  readonly paths: readonly string[];
  readonly workspaceRoot: string;
  readonly config: WriteVerifyConfig;
  readonly verify?: VerifyFn;
}): Promise<Map<string, readonly string[]>> {
  const verify = args.verify ?? verifyWrittenFile;
  const out = new Map<string, readonly string[]>();
  for (const path of args.paths) {
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (content === undefined) {
      out.set(path, []);
      continue;
    }
    const outcome = await verify({ absPath: path, content, workspaceRoot: args.workspaceRoot, config: args.config });
    out.set(path, outcome.status === "fail" ? [...outcome.errors] : []);
  }
  return out;
}

export interface DiagnosticsOptions {
  readonly workspaceRoot: string;
  readonly config: WriteVerifyConfig;
  /** Injection seams for tests: the checker entry and the clock. */
  readonly verify?: VerifyFn;
  readonly now?: () => number;
}

/** Build the layer the write/edit tools call around a successful write. */
export function createDiagnosticsLayer(options: DiagnosticsOptions): DiagnosticsLayer {
  const verify = options.verify ?? verifyWrittenFile;
  const now = options.now ?? Date.now;
  // Insertion-ordered LRU: key order IS recency order (re-insert refreshes).
  const cache = new Map<string, { at: number; set: ReadonlySet<string> }>();
  // Timestamps of emitted diagnostic lines — the rolling turn budget.
  const turnLog: number[] = [];

  const lruPut = (path: string, entry: { at: number; set: ReadonlySet<string> }): void => {
    cache.delete(path);
    cache.set(path, entry);
    if (cache.size > BASELINE_LRU_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  return {
    async beforeWrite(absPath: string): Promise<void> {
      const t = now();
      const hit = cache.get(absPath);
      if (hit !== undefined && t - hit.at < BASELINE_TTL_MS) {
        lruPut(absPath, hit); // fresh: reuse, refresh recency only
        return;
      }
      const baseline = await captureBaseline({
        paths: [absPath],
        workspaceRoot: options.workspaceRoot,
        config: options.config,
        verify,
      });
      lruPut(absPath, { at: t, set: new Set(baseline.get(absPath) ?? []) });
    },

    async afterWrite(event): Promise<readonly string[]> {
      if (event.outcome.status !== "fail") return [];
      const baseline = cache.get(event.absPath);
      // No baseline (the write raced the layer, or beforeWrite was skipped):
      // stay silent — reporting unverifiable lines as "new" would mislabel
      // pre-existing errors and train the model to ignore the section.
      if (baseline === undefined) return [];
      const fresh = event.outcome.errors
        .filter((line) => !baseline.set.has(line))
        .slice(0, MAX_NEW_DIAGNOSTICS_PER_FILE);
      const t = now();
      while (turnLog.length > 0 && t - (turnLog[0] as number) > TURN_WINDOW_MS) turnLog.shift();
      const budget = Math.max(0, MAX_NEW_DIAGNOSTICS_PER_TURN - turnLog.length);
      const granted = fresh.slice(0, budget);
      for (let i = 0; i < granted.length; i += 1) turnLog.push(t);
      return granted;
    },
  };
}
