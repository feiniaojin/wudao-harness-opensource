// 夜移 019 (#30 native-ts file-index, wudao 适配切片) — the Ctrl+P palette's
// path matcher, extracted from App.tsx's inline greedy scan into a pure
// module with real the upstream's file-index paradigms (restored-src/src/native-ts/
// file-index/index.ts — itself a TS port of the Rust nucleo wrapper):
//
//   • smart-case        — a lowercase query matches case-insensitively; ANY
//                         uppercase flips the whole query case-sensitive.
//   • bitmap pre-reject — one Int32 a–z bitmask per path; a path missing any
//                         needle LETTER is rejected in O(1) before the scan.
//                         Only a–z is encoded: CJK/digit/sep needle chars
//                         pass through untouched (wudao is CJK-heavy — the
//                         bitmap constrains, never excludes, non-letters).
//   • fused scoring     — the greedy indexOf positions ARE the score input:
//                         consecutive bonus, gap penalty, boundary (/ - _ .
//                         space) and camel bonuses accrue during the scan —
//                         no second pass (real the upstream's fused-scan insight).
//   • time-chunk build  — buildPathIndexAsync yields on ELAPSED ms
//                         (CHUNK_MS, not a path count: slow machines get
//                         smaller chunks and stay responsive), and search
//                         works on the ready PREFIX while the build runs
//                         (readyCount), so opening the palette never blocks
//                         on indexing a large tree.
//
// wudao divergences kept ON PURPOSE (pinned by tests, not inherited):
//   • the ui-review-r3 basename-bonus class separation (a match inside the
//     basename outranks the same shape in a dirname) — nucleo has no such
//     term; wudao's palette is file-first UX, and r3 shipped this for
//     exactly that reason.
//   • ties break by path ascending (determinism over "whatever order").
//   • the 'test' demotion from real the upstream formatis a mild pre-sort multiplier (0.95)
//     rather than their post-position ×1.05 — our cap slices by score.
export interface RankedHit {
  readonly path: string;
  readonly hits: ReadonlySet<number>;
  /** Sort key — HIGHER is better (the palette sorts descending). */
  readonly score: number;
}

export interface PathIndex {
  /** Indexed path count — grows during an async build (the ready prefix). */
  readonly size: number;
}

// nucleo-style constants (values from real the upstream's TS port).
const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR = 8;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
const MAX_QUERY_LEN = 64;
const CHUNK_MS = 4;
// ui-review-r3 P3: the basename class separation (see header).
const BASENAME_BONUS = 1000;
// Real the upstream's 'test' demotion (×1.05 on a lower-is-better position score) →
// here a ×0.95 pre-sort multiplier on a higher-is-better fuzz score.
const TEST_PATH_FACTOR = 0.95;

const isBoundary = (code: number): boolean =>
  code === 47 || code === 92 || code === 45 || code === 95 || code === 46 || code === 32; // / \ - _ . space
const isLower = (code: number): boolean => code >= 97 && code <= 122;
const isUpper = (code: number): boolean => code >= 65 && code <= 90;

/** Boundary/camel bonus for a match at `pos` in the ORIGINAL-case path
 *  (positions align between the lowercased and original haystack — same
 *  length; camel only ever fires in case-sensitive mode, but is computed
 *  uniformly). `first` enables the start-of-string bonus (needle[0]). */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0;
  const prev = path.charCodeAt(pos - 1);
  if (isBoundary(prev)) return BONUS_BOUNDARY;
  if (isLower(prev) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL;
  return 0;
}

/** Internal shared index state (typed arrays for the scan hot loop). */
interface IndexState {
  paths: readonly string[];
  lowerPaths: string[];
  charBits: Int32Array;
  /** Ready prefix length — `size` on a sync build; grows during async. */
  ready: number;
}

function dedupePaths(fileList: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of fileList) {
    if (line.length > 0 && !seen.has(line)) {
      seen.add(line);
      paths.push(line);
    }
  }
  return paths;
}

function indexOne(state: IndexState, i: number): void {
  const lp = state.paths[i]!.toLowerCase();
  state.lowerPaths[i] = lp;
  let bits = 0;
  for (let j = 0; j < lp.length; j++) {
    const c = lp.charCodeAt(j);
    if (c >= 97 && c <= 122) bits |= 1 << (c - 97);
  }
  state.charBits[i] = bits;
}

// The index's private scan state (typed arrays for the hot loop), attached
// at build time — the public PathIndex stays an opaque handle.
const stateOf = new WeakMap<PathIndex, IndexState>();

/** Build the index synchronously (small trees — the palette's common case). */
export function buildPathIndex(fileList: readonly string[]): PathIndex {
  const paths = dedupePaths(fileList);
  const state: IndexState = {
    paths,
    lowerPaths: new Array(paths.length),
    charBits: new Int32Array(paths.length),
    ready: 0,
  };
  for (let i = 0; i < paths.length; i++) indexOne(state, i);
  state.ready = paths.length;
  const index: PathIndex = {
    get size(): number {
      return state.ready;
    },
  };
  stateOf.set(index, state);
  return index;
}

export interface AsyncBuildOptions {
  /** Yield to the scheduler after this many ms of sync work (default 4). */
  readonly chunkMs?: number;
  /** Clock seam (default performance.now) — tests script it deterministically. */
  readonly now?: () => number;
  /** Yield seam (default a macrotask turn — browser-safe, no setImmediate). */
  readonly schedule?: () => Promise<void>;
}

export interface AsyncPathIndexBuild {
  readonly index: PathIndex;
  /** Resolves once the FIRST chunk is indexed — search returns partial
   *  results from then on (the ready prefix). */
  readonly queryable: Promise<void>;
  /** Resolves when the whole index is built. */
  readonly done: Promise<void>;
  /** The indexed-so-far count (search covers exactly [0, readyCount)). */
  readyCount(): number;
}

/** The async variant — identical result to buildPathIndex, but yields on
 *  elapsed time so a large tree never blocks the UI thread, and becomes
 *  queryable after its first chunk. */
export function buildPathIndexAsync(
  fileList: readonly string[],
  opts: AsyncBuildOptions = {},
): AsyncPathIndexBuild {
  const chunkMs = opts.chunkMs ?? CHUNK_MS;
  const now = opts.now ?? ((): number => performance.now());
  const schedule = opts.schedule ?? (async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  const state: IndexState = {
    paths: [],
    lowerPaths: [],
    charBits: new Int32Array(0),
    ready: 0,
  };
  const index: PathIndex = {
    get size(): number {
      return state.ready;
    },
  };
  stateOf.set(index, state);

  let markQueryable: () => void = (): void => {};
  const queryable = new Promise<void>((resolve) => {
    markQueryable = resolve;
  });

  const done = (async (): Promise<void> => {
    // Pass 1: dedupe (time-chunked the same way — huge raw lists pay here).
    const seen = new Set<string>();
    const paths: string[] = [];
    let chunkStart = now();
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!;
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        paths.push(line);
      }
      // Amortize the clock read: check every 256 iterations.
      if ((i & 0xff) === 0xff && now() - chunkStart > chunkMs) {
        await schedule();
        chunkStart = now();
      }
    }
    state.paths = paths;
    state.lowerPaths = new Array(paths.length);
    state.charBits = new Int32Array(paths.length);
    // Pass 2: index (ready prefix grows chunk by chunk).
    chunkStart = now();
    let firstChunk = true;
    for (let i = 0; i < paths.length; i++) {
      indexOne(state, i);
      if ((i & 0xff) === 0xff && now() - chunkStart > chunkMs) {
        state.ready = i + 1;
        if (firstChunk) {
          markQueryable();
          firstChunk = false;
        }
        await schedule();
        chunkStart = now();
      }
    }
    state.ready = paths.length;
    markQueryable();
  })();

  return {
    index,
    queryable,
    done,
    readyCount: (): number => state.ready,
  };
}

/** Search the index: greedy-subsequence positions (the highlight) fused with
 *  nucleo-style scoring; ranked descending, ties by path ascending, capped
 *  at `limit`. An empty query matches NOTHING here — the palette keeps its
 *  unfiltered listing lane for that. */
export function searchPathIndex(index: PathIndex, query: string, limit: number): readonly RankedHit[] {
  if (limit <= 0 || query.length === 0) return [];
  const state = stateOf.get(index)!;
  const ready = state.ready;

  // Smart-case (real the upstream format): lowercase query → case-insensitive.
  const caseSensitive = query !== query.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const nLen = Math.min(needle.length, MAX_QUERY_LEN);
  let needleBitmap = 0;
  for (let j = 0; j < nLen; j++) {
    const cc = needle.charCodeAt(j);
    if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97);
  }

  const best: { path: string; hits: Set<number>; fuzzScore: number }[] = [];
  let threshold = -Infinity;

  outer: for (let i = 0; i < ready; i++) {
    // O(1) pre-reject: the path must contain every needle LETTER.
    if ((state.charBits[i]! & needleBitmap) !== needleBitmap) continue;

    const haystack = caseSensitive ? state.paths[i]! : state.lowerPaths[i]!;
    // Greedy-earliest positions (identical to the old palette scan — the
    // highlight stays deterministic) fused with gap/consecutive accrual.
    let pos = haystack.indexOf(needle.charAt(0));
    if (pos === -1) continue;
    const positions: number[] = [pos];
    let gapPenalty = 0;
    let consecBonus = 0;
    let prev = pos;
    for (let j = 1; j < nLen; j++) {
      pos = haystack.indexOf(needle.charAt(j), prev + 1);
      if (pos === -1) continue outer;
      positions.push(pos);
      const gap = pos - prev - 1;
      if (gap === 0) consecBonus += BONUS_CONSECUTIVE;
      else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
      prev = pos;
    }

    // Gap-bound reject: when the cap is full, a path whose best-case score
    // (every bonus) minus known gap penalties can't beat the threshold
    // skips the boundary pass entirely (real the upstream's pruner).
    const ceiling = nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;
    if (best.length === limit && ceiling + consecBonus - gapPenalty <= threshold) continue;

    const path = state.paths[i]!;
    let score = nLen * SCORE_MATCH + consecBonus - gapPenalty;
    score += scoreBonusAt(path, positions[0]!, true);
    for (let j = 1; j < nLen; j++) score += scoreBonusAt(path, positions[j]!, false);
    // Short paths win ties (real the upstream format) — and wudao's basename class rides on
    // top (ui-review-r3): a match starting inside the basename separates
    // from the same shape buried in a dirname (higher-is-better → the
    // dirname shape PAYS, it does not earn).
    score += Math.max(0, 32 - (path.length >> 2));
    const firstHit = positions[0]!;
    if (firstHit < path.lastIndexOf("/") + 1) score -= BASENAME_BONUS;
    if (path.includes("test")) score *= TEST_PATH_FACTOR;

    if (best.length < limit) {
      best.push({ path, hits: new Set(positions), fuzzScore: score });
      if (best.length === limit) {
        best.sort((a, b) => b.fuzzScore - a.fuzzScore || (a.path < b.path ? -1 : 1));
        threshold = best[best.length - 1]!.fuzzScore;
      }
    } else if (score > threshold) {
      best.push({ path, hits: new Set(positions), fuzzScore: score });
      best.sort((a, b) => b.fuzzScore - a.fuzzScore || (a.path < b.path ? -1 : 1));
      best.pop();
      threshold = best[best.length - 1]!.fuzzScore;
    }
  }

  best.sort((a, b) => b.fuzzScore - a.fuzzScore || (a.path < b.path ? -1 : 1));
  return best.map(({ path, hits, fuzzScore }) => ({ path, hits, score: fuzzScore }));
}
