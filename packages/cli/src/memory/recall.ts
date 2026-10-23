// M49 §1 — bounded auto-recall. At every run start the session picks ≤4
// active memories / ≤2400 chars by greedy scoring (tag match against the user
// prompt + the recent-session tags, weak content overlap) and projects them
// through the MetaNote channel — the MODEL sees them on the run's first call,
// the persisted conversation never gains a message. The low-authority lead is
// fixed text so the model treats recalls as hints, not instructions.
import type { MemoryEntry } from "./store.js";
import { tokenSet } from "../tokenize.js";

export const RECALL_MAX_ITEMS = 4;
export const RECALL_MAX_CHARS = 2400;
export const RECALL_LEAD = "Relevant memories (auto-recalled, may be imperfect):";
/** 夜移 015 (#22, 真 CC memoryScan MAX_MEMORY_FILES): the runtime's active
 *  pool is capped to the NEWEST entries — bounds read-side cost and ranking
 *  dilution as the store grows (file order = append order, slice the tail). */
export const RECALL_POOL_CAP = 200;
/** ω99-6a (MiMo memory service.ts:83 memory_search_score_floor, the no-SQLite
 *  landing): a RELATIVE score floor — cutoff = topScore * 0.15, the top hit is
 *  always kept. `score > 0` alone lets the pure-overlap tail share the budget
 *  with 5-tag strong matches; the floor cuts it. Relative, not absolute,
 *  because scores scale with the query — a fixed floor wipes out low-score
 *  queries entirely or waves everything through on high-score ones. ω99-6b:
 *  the bare ratio was cut for a CONTINUOUS similarity domain — in wudao's
 *  tiered integer domain it cannot reach the (1,2] cliff at mid-strong tops,
 *  so recallCutoff below composes it with the tier pin. */
export const RECALL_FLOOR_RATIO = 0.15;

/** ω99-6b (wudao 自研, 修 6a 照搬常数之洞): wudao 的分域是分层整数, 不是
 *  MiMo 的连续相似度 —— score = tagHits*2 + min(1, overlap*0.1), ≥1 tag
 *  命中 ∈ [2,∞), 纯 overlap ∈ (0,1], 断崖在 (1,2]。中强 top (2 tag = 4
 *  分) 下裸比例 relative 0.6 够不到断崖, 1.0 纯 overlap 弱尾漏过占预算。
 *  tier 最小值把地板钉到断崖上; 无参考有此机制 (MiMo 无分层分域概念,
 *  真 CC memdir 无地板, aider 是绝对阈值)。 */
export const RECALL_TAG_TIER_MIN = 2;

/** The selection cutoff for a pool whose best score is `top` — an entry is
 *  kept iff score ≥ cutoff (the floor gates SELECTION, never ranking). Pool
 *  top reaches the tag tier → the floor rides the cliff max(relative,
 *  tierMin): the whole pure-overlap tail (≤1) sits below the tag tier (≥2)
 *  and falls at once. Top below the tier (no tag hits in the entire pool) →
 *  the bare ratio keeps weak queries from emptying out. */
export function recallCutoff(top: number): number {
  const relative = top * RECALL_FLOOR_RATIO;
  return top >= RECALL_TAG_TIER_MIN ? Math.max(relative, RECALL_TAG_TIER_MIN) : relative;
}
/** 夜移 015 (#22, 真 CC memoryAge): one note-level caveat when any selected
 *  entry is ≥2 days old — stale file:line cites read MORE authoritative than
 *  they are, and the model never learns an entry's age without this. */
export const RECALL_STALENESS_NOTE =
  "Note: memories are point-in-time observations, not live state — file/line citations and behavior claims may be outdated. Verify against current code before asserting as fact.";

/** 夜移 025: neutralize the note container's structural tokens in untrusted
 *  stored bytes before interpolation — newlines become a visible literal
 *  `\n` (a forged "- [fact] …" line needs its own line) and tag-shaped
 *  `<system_note>`/`</system_note>` bytes get their `<` escaped to `&lt;`
 *  (the note rides the MetaNote projection's envelope; raw bytes would
 *  close it early). Escapes are visible, never silently stripped. Adapted
 *  from Strands' injection/_xml lesson, but scoped to THIS container's
 *  tokens — it is a <system_note> envelope + markdown list, not XML, and
 *  code-like memories legitimately contain `<`/`>`/`&`. Idempotent. */
export function escapeRecallField(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/<((\/)?\s*system_note\s*)>/gi, "&lt;$1>");
}

/** Whole days between `created` and `now` (floored; clock skew clamps to 0;
 *  junk timestamps read as fresh — parseEntry already bounds the damage). */
export function memoryAgeDays(created: string, now: number = Date.now()): number {
  const t = Date.parse(created);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** The model-facing age label — models are poor at date arithmetic, so the
 *  suffix carries the arithmetic instead of the raw timestamp. */
export function memoryAgeLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export interface RecallInput {
  /** The active memory pool (store.active()). */
  readonly entries: readonly MemoryEntry[];
  /** The run's user prompt. */
  readonly prompt: string;
  /** Tags mined from the recent session(s) — the second greedy signal. */
  readonly recentTags?: readonly string[];
  /** Deterministic-test injection seam for the age annotation (夜移 015). */
  readonly now?: number;
}

export interface RecallResult {
  /** The selected entries, best first (possibly empty). */
  readonly selected: readonly MemoryEntry[];
  /** The MetaNote payload (undefined when nothing was selected). */
  readonly note: string | undefined;
}

/** Greedy bounded recall (pure — the caller bumps hits / pushes the note).
 *  Only ACTIVE entries are candidates (defense in depth — callers hand in
 *  store.active(), pending suggestions must never surface unreviewed). */
export function recallMemories(input: RecallInput): RecallResult {
  const pool = input.entries.filter((e) => e.status === "active");
  if (pool.length === 0) return { selected: [], note: undefined };
  const now = input.now ?? Date.now();
  const promptTokens = tokenSet(input.prompt);
  const recent = new Set((input.recentTags ?? []).map((t) => t.toLowerCase()));

  const scored = pool
    .map((entry) => {
      let tagScore = 0;
      for (const tag of entry.tags) {
        const t = tag.toLowerCase();
        if (promptTokens.has(t) || recent.has(t)) tagScore += 1;
      }
      // Weak content-overlap signal, capped at 1 (tags dominate by design).
      let overlap = 0;
      for (const t of tokenSet(entry.content)) if (promptTokens.has(t)) overlap += 1;
      return { entry, score: tagScore * 2 + Math.min(1, overlap * 0.1) };
    })
    .filter((s) => s.score > 0)
    // Deterministic order: score desc, newer first, then id ascending — never
    // hits (telemetry is observed only; it must not steer ranking yet).
    .sort((a, b) =>
      b.score - a.score
      || (a.entry.created < b.entry.created ? 1 : a.entry.created > b.entry.created ? -1 : 0)
      || (a.entry.id < b.entry.id ? -1 : 1));

  // ω99-6a: the floor gates SELECTION, never ranking — the score>0 filter
  // above stays (a floor can only tighten), and the top hit trivially clears
  // its own cutoff. Sorted descending, so the first below-floor entry ends
  // the loop — everything after it is only weaker.
  const top = scored[0]?.score ?? 0;
  const cutoff = recallCutoff(top);

  const selected: MemoryEntry[] = [];
  let used = 0;
  for (const s of scored) {
    if (s.score < cutoff) break;
    if (selected.length >= RECALL_MAX_ITEMS) break;
    // 夜移 015: overhead 32 → 48 — the line now also carries the age suffix.
    const cost = s.entry.content.length + s.entry.tags.join(",").length + 48;
    if (selected.length > 0 && used + cost > RECALL_MAX_CHARS) break;
    selected.push(s.entry);
    used += cost;
  }
  if (selected.length === 0) return { selected: [], note: undefined };
  const lines = selected.map((e) => {
    // 夜移 015 (真 CC memoryAge): the age label rides the metadata parens —
    // "models are poor at date arithmetic", the suffix does it for them.
    // 夜移 025: content/tags are untrusted stored bytes — escaped so they
    // can never forge note lines or the envelope framing.
    const parts = [
      ...(e.tags.length > 0 ? [`tags: ${e.tags.map(escapeRecallField).join(", ")}`] : []),
      memoryAgeLabel(memoryAgeDays(e.created, now)),
    ];
    return `- [${e.kind}${e.scope === "user" ? "/user" : ""}] ${escapeRecallField(e.content)} (${parts.join("; ")})`;
  });
  // The caveat is note-level framing (like RECALL_LEAD), never item budget —
  // it must survive even a full RECALL_MAX_CHARS list.
  if (selected.some((e) => memoryAgeDays(e.created, now) >= 2)) lines.push(RECALL_STALENESS_NOTE);
  return { selected, note: [RECALL_LEAD, ...lines].join("\n") };
}

/** The next-session pending-review notice (§1 待审): lists every unsurfaced
 *  pending entry once, with the confirm/drop verbs. */
export function formatPendingReview(entries: readonly MemoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  // 夜移 025: id and content are untrusted stored bytes (parseEntry only
  // checks typeof string) — escaped so a hostile entry can't forge the
  // review-verb instruction line below.
  const lines = entries.map((e) => `  ${escapeRecallField(e.id)} [${e.kind}/${e.scope}] ${escapeRecallField(e.content)}`);
  return [
    `🧠 ${entries.length} memory suggestion(s) awaiting review:`,
    ...lines,
    "confirm with /memory ok <id>, drop with /memory del <id>, list all with /memory list",
  ].join("\n");
}
