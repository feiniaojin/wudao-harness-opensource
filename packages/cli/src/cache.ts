// M24 cache observability + miss attribution (B3).
//
// The tracking model wraps a real ModelClient: it serializes every request
// with the ONE canonical serializer (@wudao/providers serializePrompt — the
// same bytes det-06 and the fork tests pin), accumulates session-wide usage,
// and, when a call's cache MISS spikes (miss > 2× the rolling 3-call mean
// AND > 4k), diffs the two serialized prompts to name the first divergent
// message → `⚠️ cache break at <tool> result (turn N)`.
//
// Pure helpers (formatting, detection) are exported for tests; the CLI
// frontends inject their own renderers.
import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import { serializePrompt } from "@wudao/providers";

/** Below this many cumulative prompt tokens the hit rate is noise → hidden. */
export const CACHE_FLOOR_TOKENS = 1024;
/** A miss must exceed 2× this window's rolling mean … */
const MISS_SPIKE_FACTOR = 2;
/** … AND this many tokens, to count as a break. */
const MISS_SPIKE_FLOOR_TOKENS = 4096;
/** How many previous calls form the rolling mean. */
const MISS_WINDOW = 3;
/** ω99-33 — the counted prompt must SHRINK by at least this (under
 *  append-only serialization growth) to read as a reasoning-cohort
 *  detachment: the provider dropped the run's server-side reasoning from the
 *  billed prompt when a fresh user message opened a new run. Mirrors the
 *  spike floor so a detachment and an eviction need the same evidence mass. */
const COHORT_DETACH_FLOOR_TOKENS = 4096;
/** ω99-33 — a miss bounded by the counted-prompt growth (plus this slack for
 *  the provider's block-quantized hit/miss accounting) is growth-explained:
 *  the request genuinely added that much context (a big new turn, or the
 *  reasoning cohort onboarding mid-run). Not a spike, not an eviction. */
const GROWTH_EXPLAINED_SLACK_TOKENS = 1024;

export function formatCachePercent(hit: number, promptTokens: number): string {
  if (promptTokens <= 0) return "--";
  return `${((hit / promptTokens) * 100).toFixed(1)}%`;
}

/** `cache 94.2% (hit 45.2k / miss 2.7k)` — the per-turn info line. */
export function formatUsageLine(u: ModelUsage): string {
  // M62 §7: the fallback receipt annotation (ordered fallbackModel chain).
  const fallback = u.fallbackModel !== undefined ? ` [回退 ${u.fallbackModel}${u.fallbackFrom !== undefined ? `（自 ${u.fallbackFrom}）` : ""}]` : ""; // ω99-188: #1
  // M63 §A: the provider-switch cold receipt — colder than a model switch,
  // so the line says what was reprocessed, not just "cold".
  const cold = u.coldTurnExpected === true ? ` [冷：${u.cacheBreakAttribution ?? "预期"}]` : ""; // ω99-188: #2
  return `缓存 ${formatCachePercent(u.cacheHitTokens, u.promptTokens)}（命中 ${kb(u.cacheHitTokens)} / 未命中 ${kb(u.cacheMissTokens)}）${fallback}${cold}`; // ω99-188: #3
}

function kb(n: number): string {
  return `${Math.round(n / 100) / 10}k`;
}

/** 夜移 008: non-empty line count of a serialization (truncation compare). */
function nonEmptyLines(s: string): number {
  let n = 0;
  for (const l of s.split("\n")) if (l.length > 0) n += 1;
  return n;
}

/**
 * 夜移 008: token estimate of a pure extension's appended delta — CJK-aware
 * at the code-unit level (a CJK char ≈ 1 token, the same split the
 * providers' replayed-reasoning estimator uses; everything else ≈ 4
 * units/token). Without the CJK clause, a 5k-char Chinese turn would
 * estimate at 1.25k tokens and a delta-sized miss would misfire the
 * eviction hint.
 */
function deltaTokens(prev: string, curr: string): number {
  if (!curr.startsWith(prev)) return Math.ceil(Math.max(0, curr.length - prev.length) / 4);
  const delta = curr.slice(prev.length);
  let cjk = 0;
  let others = 0;
  for (let i = 0; i < delta.length; i += 1) {
    if (delta.charCodeAt(i) >= 0x2e80) cjk += 1;
    else others += 1;
  }
  return cjk + Math.ceil(others / 4);
}

/** Session-cumulative usage. The 1KB noise floor keeps early single-turn
 *  numbers (which are always ~0% — nothing is cached yet) out of the UI. */
export class CacheStats {
  private prompt = 0;
  private hit = 0;
  private completion = 0;
  private calls = 0;

  record(u: ModelUsage): void {
    this.prompt += u.promptTokens;
    this.hit += u.cacheHitTokens;
    this.completion += u.completionTokens ?? 0;
    this.calls += 1;
  }

  get promptTokens(): number {
    return this.prompt;
  }

  get callCount(): number {
    return this.calls;
  }

  /** M55 §A3 (/cost): cumulative cache-HIT tokens across the session. */
  get hitTokens(): number {
    return this.hit;
  }

  /** M55 §A3 (/cost): cumulative completion tokens across the session. */
  get completionTokens(): number {
    return this.completion;
  }

  /** Cumulative hit percentage; null under the noise floor. */
  get percent(): number | null {
    if (this.prompt < CACHE_FLOOR_TOKENS) return null;
    return (this.hit / this.prompt) * 100;
  }

  /** `cache 87%` for the resident TUI footer; null while under the floor. */
  get footerLabel(): string | null {
    const pct = this.percent;
    return pct === null ? null : `cache ${Math.round(pct)}%`;
  }

  /** One-line run/session summary; null when no usage was ever reported. */
  summaryLine(): string | null {
    if (this.calls === 0) return null;
    const miss = this.prompt - this.hit;
    return `缓存：${formatCachePercent(this.hit, this.prompt)}（命中 ${kb(this.hit)} / 未命中 ${kb(miss)}，${this.calls} 次模型调用）`; // ω99-188: #4
  }
}

// ---------------------------------------------------------------------------
// Break attribution (B3) — pure diff over the canonical serialization.
// serializePrompt layout: line 0 = system, lines 1..T = tools (the stable
// header), then one line per message (the append-only tail).
// ---------------------------------------------------------------------------

export interface CacheBreakInput {
  /** The previous request's serialization (undefined on the first call). */
  readonly prevSerialized: string | undefined;
  /** The current request's serialization. */
  readonly currSerialized: string;
  /** The current request's messages (role/name for the report). */
  readonly currMessages: readonly AgentMessage[];
  /** The current call's miss tokens. */
  readonly missTokens: number;
  /** ω99-28 T2 — the current row's TOTAL prompt tokens (the tier's
   *  denominator). The wrapper always passes it (it lives on the same usage
   *  row as missTokens); absent (a hand-built input) the tier degrades to
   *  the miss magnitude alone — never an invented denominator. */
  readonly promptTokens?: number;
  /** ω99-33 — the PREVIOUS main-chain row's promptTokens (the counted-prompt
   *  growth is the cohort forensics input: under append-only serialization a
   *  SHRINKING counted prompt means the provider detached its server-side
   *  reasoning cohort; a miss bounded by the growth is growth-explained).
   *  Absent (hand-built inputs, the first observed row) the classifier runs
   *  the legacy delta-only accounting, byte-identically. */
  readonly prevPromptTokens?: number;
  /** Miss tokens of the previous calls (up to 3, excluding the current). */
  readonly recentMisses: readonly number[];
  /** ω99-24 C — the current row was stamped cold-and-expected (an M24
   *  declaration: a bundle mount/unmount, a provider switch): a detected
   *  break renders as ONE info line naming the CAUSE, not ⚠️ anomaly
   *  wording — a by-design break is not a failure. */
  readonly expectedColdAttribution?: string;
  /** ω99-24 C — the row right AFTER an expected break: its residual miss
   *  spike is the declared break's aftershock (the provider re-storing the
   *  new prefix), not an eviction — the suspicion line is suppressed
   *  (one-shot; a later spike still reports). */
  readonly afterExpectedBreak?: boolean;
}

/** ω99-28 T2 — the cost tier every break report carries: `— miss 18.4k/19.5k
 *  (94.4%)` (the usage line's k formatting). A label alone can lie: the
 *  ω99-26 campaign's turn 5 said "system/tools header" while the row paid
 *  0.2k — a real early-header change re-misses ~the whole prompt, so the
 *  label and the cost belong on the SAME line for the reader to judge. */
const costTier = (missTokens: number, promptTokens: number | undefined): string => {
  if (promptTokens === undefined || promptTokens <= 0) return ` — miss ${kb(missTokens)}`;
  const pct = ((missTokens / promptTokens) * 100).toFixed(1);
  return ` — miss ${kb(missTokens)}/${kb(promptTokens)} (${pct}%)`;
};

/** The first line that CHANGED between two serializations. A pure extension
 *  (curr = prev + appended lines, the append-only invariant) returns -1 —
 *  growth is not a break. Both inputs end with "\n", so the trailing empty
 *  split element is dropped first. */
function firstDivergentLine(a: string, b: string): number {
  const la = a.split("\n");
  if (la.at(-1) === "") la.pop();
  const lb = b.split("\n");
  if (lb.at(-1) === "") lb.pop();
  const n = Math.min(la.length, lb.length);
  for (let i = 0; i < n; i += 1) {
    if (la[i] !== lb[i]) return i;
  }
  return -1;
}

/** 0-based turn number of a message index: how many assistant messages
 *  precede it (a tool result of turn k follows turn k's assistant message). */
function turnOfMessageIndex(messages: readonly AgentMessage[], index: number): number {
  let assistants = 0;
  for (let i = 0; i < index && i < messages.length; i += 1) {
    if (messages[i]?.role === "assistant") assistants += 1;
  }
  return Math.max(0, assistants - 1);
}

/** Returns the `⚠️ cache break at …` warning (or, on a row declared
 *  cold-and-expected, the `ℹ️ expected: <cause>` info line — ω99-24 C), or
 *  undefined when the miss is ordinary (no baseline yet, no spike, or a
 *  delta-explained miss). ω99-28 T2: EVERY report carries the cost tier —
 *  the label names the place, the tier says what it PAID. ω99-28 T3: a
 *  fresh session's opening user message (a same-client subagent's first
 *  call — the input IS one user message) renders as the ℹ️ cold-start line,
 *  not ⚠️ noise. */
export function detectCacheBreak(input: CacheBreakInput): string | undefined {
  const tier = costTier(input.missTokens, input.promptTokens);
  // ω99-24 C — a declared row renders any break it detects as ONE info line
  // naming the declared cause; the raw ⚠️ line stays for undeclared rows.
  // ω99-28 T2: both forms append the cost tier (a declared break still paid).
  const expectedOrRaw = (raw: string, turn: number): string =>
    input.expectedColdAttribution !== undefined
      ? `ℹ️ expected: ${input.expectedColdAttribution} (turn ${turn})${tier}`
      : raw;
  if (input.prevSerialized === undefined) return undefined;
  if (input.recentMisses.length === 0) return undefined;
  const mean = input.recentMisses.reduce((a, b) => a + b, 0) / input.recentMisses.length;
  if (!(input.missTokens > MISS_SPIKE_FACTOR * mean && input.missTokens > MISS_SPIKE_FLOOR_TOKENS)) {
    return undefined;
  }
  const line = firstDivergentLine(input.prevSerialized, input.currSerialized);
  if (line < 0) {
    const turn = input.currMessages.filter((m) => m.role === "assistant").length;
    // A strict-prefix curr (fewer lines) is a history TRUNCATION (a branch
    // cut) — the worst kind of break, and the min-length line compare reads
    // it as "identical". Attribute it before the eviction check mislabels it.
    const prevLines = nonEmptyLines(input.prevSerialized);
    const currLines = nonEmptyLines(input.currSerialized);
    if (currLines < prevLines) {
      return expectedOrRaw(`⚠️ cache break: history truncated (turn ${turn})${tier}`, turn);
    }
    // 夜移 008 (the upstream format break-forensics port, hardened): pure extension —
    // the ONLY legitimate miss source is the appended delta. A miss far
    // beyond what the delta can explain means the provider re-processed the
    // PREFIX: eviction/TTL, not a harness defect. (The old code was silent
    // here for every pure extension, conflating a benign big new turn with
    // a provider eviction.)
    //
    // ω99-33 — cohort-aware accounting first (when the pair of counted sizes
    // is available AND the history carries reasoning — the cohort's
    // substrate): reasoning providers bill a SERVER-SIDE reasoning cohort
    // (the model's own generated reasoning, re-attached to each tool-call
    // continuation and detached when a fresh user message opens a new run) —
    // a face serializePrompt is structurally blind to (M47: no reasoning
    // bytes; the probe evidence showed even client-REPLAYED reasoning is
    // stripped before counting, so the counted cohort never rides our bytes).
    // The counted-prompt GROWTH under append-only serialization names both
    // false shapes the campaign hit:
    //   growth ≤ −floor  ⇒ the cohort LEFT (prompt shrank while history only
    //     grew) — a named transition, not an anomaly;
    //   miss ≤ growth + slack ⇒ the context genuinely grew by the miss (big
    //     turn, or the cohort ONBOARDING mid-run) — growth-explained, silent.
    // A reasoning-free history gates the whole branch OFF: without the
    // substrate, a miss beyond the delta keeps its legacy eviction reading.
    // A true eviction (prompt grew normally, hit collapsed) matches neither
    // rule and keeps the ⚠️ below.
    const historyCarriesReasoning = input.currMessages.some(
      (m) => m.role === "assistant" && typeof m.reasoning === "string" && m.reasoning !== "",
    );
    if (historyCarriesReasoning && input.prevPromptTokens !== undefined && input.promptTokens !== undefined) {
      const growth = input.promptTokens - input.prevPromptTokens;
      if (growth <= -COHORT_DETACH_FLOOR_TOKENS) {
        return expectedOrRaw(`ℹ️ reasoning-replay transition — provider detached the run's reasoning cohort (turn ${turn})${tier}`, turn);
      }
      if (input.missTokens <= growth + GROWTH_EXPLAINED_SLACK_TOKENS) {
        return undefined;
      }
    }
    const unexplained = input.missTokens - deltaTokens(input.prevSerialized, input.currSerialized);
    if (unexplained > MISS_SPIKE_FLOOR_TOKENS) {
      // ω99-24 C — the row right after an EXPECTED break: its residual spike
      // is the declared break's aftershock (the provider re-storing the new
      // prefix), not an eviction. Suppressed once; later spikes still report.
      if (input.afterExpectedBreak) return undefined;
      return expectedOrRaw(`⚠️ cache miss spike beyond appended delta — provider-side eviction? (turn ${turn})${tier}`, turn);
    }
    return undefined;
  }
  // Map the divergent line back onto the request shape. Non-empty lines are:
  // [system] + tools + messages (each serialized line ends with "\n").
  const toolCount = Math.max(0, input.currSerialized.split("\n").filter((l) => l.length > 0).length - 1 - input.currMessages.length);
  if (line <= toolCount) {
    const turn = input.currMessages.filter((m) => m.role === "assistant").length;
    return expectedOrRaw(`⚠️ cache break at system/tools header (turn ${turn})${tier}`, turn);
  }
  const messageIndex = line - 1 - toolCount;
  const m = input.currMessages[messageIndex];
  if (m === undefined) return undefined;
  const turn = turnOfMessageIndex(input.currMessages, messageIndex);
  // ω99-28 T3 — the cold-start shape: the input is EXACTLY a fresh session's
  // first call (one opening user message). On the shared wrapper this is a
  // same-client subagent's debut (the campaign logged five of them as ⚠️
  // "cache break at user message (turn 0)"): the child's system line is the
  // frozen parent's and its tool list prefixes the parent's, so the first
  // divergent line lands on the child's opening user message. That class is
  // by design (every session starts cold; the cost is the tail only) — info,
  // not anomaly. Deliberately NARROWER than "turn 0 user": a REWRITTEN
  // opening message in a longer input is a mid-session rewrite and keeps ⚠️.
  if (m.role === "user" && messageIndex === 0 && input.currMessages.length === 1 && input.expectedColdAttribution === undefined) {
    return `ℹ️ cold start — first call of a fresh session (tail-only cost)${tier}`;
  }
  if (m.role === "tool") {
    return expectedOrRaw(`⚠️ cache break at ${m.name} result (turn ${turn})${tier}`, turn);
  }
  return expectedOrRaw(`⚠️ cache break at ${m.role} message (turn ${turn})${tier}`, turn);
}

// ---------------------------------------------------------------------------
// ω99-28 T3 — the break-line guard: one cache event per line, always.
// ---------------------------------------------------------------------------

/** ω99-28 T3 — line discipline for the break/notice channel. The streaming
 *  renderers write reasoning/assistant deltas WITHOUT a trailing newline
 *  (the ω99-26 campaign's ⚠️ lines stuck to thinking-text tails at
 *  :222/:395/:443/:546/:560/:666/:1000/:1933 — two line-anchored censuses
 *  undercounted them). The delta sites `feed` the guard every chunk they
 *  write; the warning site calls `breakLine`, which prepends a newline
 *  exactly when the stream is mid-line, so a cache event ALWAYS occupies a
 *  full line of its own. */
export function createBreakLineGuard(write: (s: string) => void): { readonly feed: (s: string) => void; readonly breakLine: (line: string) => void } {
  let atLineStart = true;
  return {
    feed: (s: string): void => {
      if (s.length > 0) atLineStart = s.endsWith("\n");
    },
    breakLine: (line: string): void => {
      if (!atLineStart) write("\n");
      write(`${line}\n`);
      atLineStart = true;
    },
  };
}

// ---------------------------------------------------------------------------
// ω-5a I19 — context-window identity (wrapper-minted, observability only).
// ---------------------------------------------------------------------------

/** The window a usage row belongs to. `call` is the wrapper's 1-based usage-row
 *  ordinal (monotonic across windows). */
export interface ContextWindowInfo {
  readonly id: string;
  readonly call: number;
}

/** The M24 attribution join: the first usage row observed on a window. */
export interface ContextWindowFirstCall {
  readonly promptTokens: number;
  readonly cacheHitTokens: number;
  readonly coldTurnExpected?: true;
  readonly cacheBreakAttribution?: string;
}

/** Fired when the window id ADVANCES — any structural prefix change beyond
 * the system line (compaction, /edit branch cut, provider-switch rebuild),
 * i.e. firstDivergentLine > 0; append-only growth never advances. The
 * initial mint is silent (a fresh process/resume IS a new window, with no
 * predecessor to report) — UNLESS the construction site passed `mintedFrom`
 * (review I1): a wrapper built as a REPLACEMENT then reports one SYNTHETIC
 * advance on its first observed row, so the predecessor's id lands in the
 * JSONL instead of dying silently. */
export interface WindowAdvance {
  readonly from: string;
  readonly to: string;
  readonly atCall: number;
  /** First divergent line's mapped cause, best-effort ("message:<role>" |
   *  "system/tools header"). ABSENT on a synthetic (mintedFrom) advance —
   *  no divergent line exists for a wrapper replacement. */
  readonly divergedAt?: string;
  /** The first usage row observed on the new window — the row the wrapper
   *  was observing when the advance fired (synthetic advances included). */
  readonly firstCall?: ContextWindowFirstCall;
}

/** The firstCall snapshot of a usage row (the M24 attribution join). */
function firstCallOf(u: ModelUsage): ContextWindowFirstCall {
  return {
    promptTokens: u.promptTokens,
    cacheHitTokens: u.cacheHitTokens,
    ...(u.coldTurnExpected === true ? { coldTurnExpected: true as const } : {}),
    ...(u.cacheBreakAttribution !== undefined ? { cacheBreakAttribution: u.cacheBreakAttribution } : {}),
  };
}

/** Map a divergent line index onto a best-effort cause (the same mapping
 * detectCacheBreak reports). */
function divergedAtLabel(serialized: string, messages: readonly AgentMessage[], line: number): string {
  const toolCount = Math.max(0, serialized.split("\n").filter((l) => l.length > 0).length - 1 - messages.length);
  if (line <= toolCount) return "system/tools header";
  const m = messages[line - 1 - toolCount];
  return `message:${m?.role ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// The tracking wrapper.
// ---------------------------------------------------------------------------

export interface CacheTrackingOptions {
  /** Fires with every reported usage plus the cumulative stats (TUI footer).
   *  ω-5a I19: widens with a third argument — the row's context window
   *  (wrapper-minted id + call ordinal). Existing 2-arg callbacks keep
   *  compiling; the id NEVER rides the request bytes.
   *  ω99-8b: widens with a fourth argument — the row's querySource tag
   *  (undefined = untagged main call). Observer-neutral: the callback still
   *  fires for EVERY call, tagged or not; whether a tagged row is recorded
   *  is the LEDGER's decision (the cost recorders skip "subagent" — the
   *  task tool's forwarder owns that row, so a same-client child counts
   *  exactly once). */
  readonly onUsage?: (usage: ModelUsage, cumulative: CacheStats, window: ContextWindowInfo, querySource?: string) => void;
  /** P0-1 (the upstream projectcache-stats port): fires once per MAIN-call usage row — rows
   *  whose ModelInput carried a querySource tag (title/btw/summarizer/
   *  reflection/ask-reviewer side calls ride OTHER prefixes; comparing them
   *  against the main chain would misread as waste). The per-turn
   *  waste-attribution seam; observer-only, like onUsage. */
  readonly onTurnUsage?: (usage: ModelUsage) => void;
  /** Fires with an attribution warning when a miss spike is detected (B3). */
  readonly onBreak?: (warning: string) => void;
  /** M63 §A: stamp the FIRST observed usage with the M58 §A cold-turn pair
   *  (coldTurnExpected + this attribution) — the frontends pass the
   *  provider-switch attribution when they build the replacement client, so
   *  the first turn on the new endpoint names WHY its hit rate is 0. */
  readonly coldFirstTurnAttribution?: string;
  /** ω99-24 B: a live ONE-SHOT poll — the extension seam (rescanExtensionsAt)
   *  parks the LAST bundle-lifecycle attribution; the NEXT main-call usage
   *  row stamps coldTurnExpected + cacheBreakAttribution with it. The M24
   *  declaration: a bundle mount/unmount break is EXPECTED and NAMED, not an
   *  anomaly. Main calls only (side calls ride other prefixes and must not
   *  consume the park); a row already stamped upstream wins over this. */
  readonly pendingColdAttribution?: () => string | undefined;
  /** ω-5a I19: fires when the window id advances (receipts ride the caller —
   *  the session engine writes the context_window JSONL entry from it). */
  readonly onWindowAdvance?: (info: WindowAdvance) => void;
  /** Review I1 (fix round): the predecessor wrapper's window id, handed by
   *  the construction site when this wrapper REPLACES a live one (the
   *  /provider rebuild). The first observed row fires one SYNTHETIC advance
   *  from it — the switch lands a context_window receipt instead of the old
   *  id vanishing. Absent (fresh process, resume) → the mint stays silent. */
  readonly mintedFrom?: string;
  /** ω-5a I23: cold-cache checkpoint feed — called once per observed usage
   *  row with the construction site's identity (it knows the live provider
   *  config; a function identity follows /provider switches). */
  readonly coldCache?: {
    readonly identity: string | (() => string);
    readonly noteUsage: (identity: string, promptTokens: number) => void;
  };
}

export interface CacheTrackingModel extends ModelClient {
  readonly stats: CacheStats;
  /** Review I1: the wrapper's LIVE window id — the construction site hands
   *  it to a replacement wrapper's `mintedFrom` at a /provider rebuild. */
  currentWindowId(): string;
  /** ω99-34: the /clear rotation reset. The frontends call this AT the
   *  rotation event (the REPL's onSessionRotated site, the engine's
   *  onSessionCleared seam) — the wrapper cannot infer a rotation from the
   *  bytes alone (a fresh-session prefix is indistinguishable from a
   *  mid-session rewrite, which is exactly why the untreated pair
   *  misreported `⚠️ cache break at user message (turn 0)` — campaign
   *  /tmp/o33-campaign.log:1709). Clears the MAIN chain's diff state
   *  (prevSerialized / prevPromptTokens / recentMisses / windowBase) and
   *  the one-shot consumption slots; stats stay cumulative (the session
   *  ledger spans rotations); side-chain-irrelevant state is untouched
   *  (side rows never touched it to begin with — ω99-31). */
  rotate(): void;
}

/** Wrap a ModelClient so every generate/stream call feeds cache stats and
 *  miss attribution. The wrapped model is what frontends hand to the loop AND
 *  to subagents — usage accounting stays session-wide. ω99-31: the BREAK
 *  observation chain is MAIN-only — querySource is the chain identity, so a
 *  tagged side row records usage and forwards onUsage but never enters the
 *  detection chain (prevSerialized / recentMisses / windowBase), never feeds
 *  the cold-cache checkpoint, and never consumes the one-shot cold
 *  attributions; cross-chain switches are state resets, never diff inputs. */
export function createCacheTrackingModel(model: ModelClient, options: CacheTrackingOptions = {}): CacheTrackingModel {
  const stats = new CacheStats();
  let prevSerialized: string | undefined;
  // ω99-33 — the main chain's previous counted-prompt size (paired with
  // prevSerialized at the SAME finally seam, from the last usage row this
  // call's provider emitted — side rows never touch it). The cohort
  // forensics input; undefined until the second main call, exactly like
  // prevSerialized.
  let prevPromptTokens: number | undefined;
  let pendingMainPromptTokens: number | undefined;
  const recentMisses: number[] = [];
  // M63 §A: consumed by the FIRST observed usage (absent on later turns —
  // only the first call on a switched endpoint is the cold one).
  let coldFirst = options.coldFirstTurnAttribution;
  // ω99-24 C — armed when the last emitted break was an EXPECTED one; the
  // next call's residual miss spike is that break's aftershock and is
  // suppressed once (a later spike is a fresh, real signal).
  let afterExpectedBreak = false;
  // ω-5a I19: the context-window identity. Minted per wrapper instance (a
  // new process/wrapper = a new window; a resumed prefix is presumptively
  // cold), advanced on any structural prefix divergence (firstDivergentLine
  // > 0 — the same signal detectCacheBreak reads), NEVER on append-only
  // growth. `windowBase` is the serialization the current window opened
  // with; updating it on every observed row keeps multiple rows per request
  // idempotent. The id is reserved against override: it never enters
  // ModelInput and never comes from client or session data.
  let windowId = randomUUID();
  let windowBase: string | undefined;
  let callCount = 0;
  // Review I1: consumed by the FIRST observed row — the synthetic advance a
  // replacement wrapper owes its predecessor.
  let pendingMintFrom = options.mintedFrom;
  // ω99-34 — armed by rotate(): the rotation is a NAMED cold start. The next
  // MAIN row consumes the slot and, when its miss clears the spike floor,
  // reports ONE info line naming the cause (the harness itself rotated the
  // session — self-inflicted cold starts get a name and an ℹ️ tier, never
  // ⚠️ anomaly wording). A side row never consumes it (ω99-31: one-shots
  // are main-chain-only).
  let pendingRotation = false;

  const observe = (usage: ModelUsage, serialized: string, original: ModelInput): void => {
    callCount += 1;
    // ω99-31 — chain-aware partition. querySource IS the chain identity:
    // undefined = the main conversation; any tag ("subagent" via
    // withChildQuerySource, "summarizer", "loop-reflector", "title", …) = a
    // side chain that merely RIDES this wrapper. The observation state below
    // (prevSerialized / recentMisses / windowBase / coldFirst /
    // afterExpectedBreak) belongs to the MAIN chain only — a side row used
    // to feed it and got diffed against the main chain, so the o26 campaign's
    // turn 5/8/16 mislabeled steady main rows as header breaks (the child's
    // different system line diverges at line 0) and every child first call
    // fake-advanced the window identity / polluted the eviction baseline
    // (:395/:443/:599-601). Declared property: break detection only pairs
    // SAME-chain observations — a cross-chain switch is a state RESET, never
    // a diff input; window identity, spike baseline and the cold-cache
    // checkpoint likewise recognize the main chain only. A side row stays
    // observable exactly where the cost ledger lives (stats.record + onUsage
    // with the querySource tag — ω99-8b's red line) and touches no chain
    // state: no coldFirst / pendingColdAttribution consumption (the main
    // chain's one-shot attributions survive to its first row), no window
    // mint/advance, no checkpoint feed (a child's prompt length says nothing
    // about the main window's residency), no detectCacheBreak, no
    // recentMisses, no afterExpectedBreak arming.
    if (original.querySource !== undefined) {
      stats.record(usage);
      options.onUsage?.(usage, stats, { id: windowId, call: callCount }, original.querySource);
      original.onUsage?.(usage);
      return;
    }
    // ω99-33 — park this main row's counted size for the finally seam (the
    // pairing stays exact even when a call emits several usage rows: the
    // last one wins, mirroring the loop's pendingUsage overwrite).
    pendingMainPromptTokens = usage.promptTokens;
    let u = usage;
    // ω99-24 B: the bundle-lifecycle declaration — one-shot, main calls only.
    // A parked attribution stamps THIS row cold-and-expected; an unstamped
    // row (nothing parked) passes through untouched, byte-identical.
    if (options.pendingColdAttribution !== undefined && original.querySource === undefined && usage.coldTurnExpected !== true) {
      const attribution = options.pendingColdAttribution();
      if (attribution !== undefined) {
        u = { ...usage, coldTurnExpected: true, cacheBreakAttribution: attribution };
      }
    }
    if (coldFirst !== undefined) {
      const attribution = coldFirst;
      coldFirst = undefined;
      u = u.coldTurnExpected === true
        ? u // already stamped upstream (a compaction the same turn) — keep it
        : { ...u, coldTurnExpected: true, cacheBreakAttribution: attribution };
    }
    stats.record(u);
    if (windowBase === undefined) {
      windowBase = serialized;
      // Review I1 (fix round): a wrapper built as a REPLACEMENT reports its
      // predecessor once — no divergent line exists, so `divergedAt` is
      // absent on this synthetic advance.
      if (pendingMintFrom !== undefined) {
        const from = pendingMintFrom;
        pendingMintFrom = undefined;
        options.onWindowAdvance?.({ from, to: windowId, atCall: callCount, firstCall: firstCallOf(u) });
      }
    } else {
      const line = firstDivergentLine(windowBase, serialized);
      if (line > 0) {
        const from = windowId;
        windowId = randomUUID();
        options.onWindowAdvance?.({
          from,
          to: windowId,
          atCall: callCount,
          divergedAt: divergedAtLabel(serialized, original.messages, line),
          firstCall: firstCallOf(u),
        });
      }
      windowBase = serialized;
    }
    // ω-5a I23: one checkpoint feed per observed usage row.
    if (options.coldCache !== undefined) {
      const identity = typeof options.coldCache.identity === "function" ? options.coldCache.identity() : options.coldCache.identity;
      options.coldCache.noteUsage(identity, u.promptTokens);
    }
    // ω99-34 — the rotation's first MAIN row: with the diff state cleared the
    // classifier below returns undefined on its own (no baseline, no window),
    // so the named cold start is reported HERE — one line, ℹ️ tier, cost tier
    // on the same line (ω99-28 T2's rule: the label and what it PAID belong
    // together). The slot is consumed by this row regardless of miss size: a
    // tiny fresh session paid nothing worth naming (zero output), and a later
    // big miss is judged on its own merits against the NEW session's baseline.
    if (pendingRotation) {
      pendingRotation = false;
      if (u.cacheMissTokens > MISS_SPIKE_FLOOR_TOKENS) {
        options.onBreak?.(`ℹ️ expected: session-rotation (cold start)${costTier(u.cacheMissTokens, u.promptTokens)}`);
      }
    }
    // ω99-24 C — the row's final declaration rides into the break wording
    // (a declared row reads as info, not ⚠️), and an EXPECTED break arms the
    // one-shot aftershock suppression for the next call.
    const rowAttribution = u.coldTurnExpected === true ? u.cacheBreakAttribution : undefined;
    const warning = detectCacheBreak({
      prevSerialized,
      currSerialized: serialized,
      currMessages: original.messages,
      missTokens: u.cacheMissTokens,
      promptTokens: u.promptTokens,
      ...(prevPromptTokens !== undefined ? { prevPromptTokens } : {}),
      recentMisses: [...recentMisses],
      ...(rowAttribution !== undefined ? { expectedColdAttribution: rowAttribution } : {}),
      ...(afterExpectedBreak ? { afterExpectedBreak: true } : {}),
    });
    afterExpectedBreak = rowAttribution !== undefined && warning !== undefined;
    if (warning !== undefined) options.onBreak?.(warning);
    recentMisses.push(u.cacheMissTokens);
    if (recentMisses.length > MISS_WINDOW) recentMisses.shift();
    options.onUsage?.(u, stats, { id: windowId, call: callCount }, original.querySource);
    // P0-1: the per-turn waste seam — MAIN calls only (side calls ride other
    // prefixes and would misread as waste against the main chain's baseline).
    // ω99-8b note: tagged child calls ("subagent") are side calls by the same
    // check — ZERO change here; the stamp is what excludes them.
    if (options.onTurnUsage !== undefined && original.querySource === undefined) options.onTurnUsage(u);
    // Forward to the caller's channel (the loop's usage-event callback) —
    // wrapping must never swallow the observer the loop attached.
    original.onUsage?.(u);
  };

  const stream = model.stream;
  return {
    stats,
    currentWindowId: () => windowId,
    rotate(): void {
      prevSerialized = undefined;
      prevPromptTokens = undefined;
      pendingMainPromptTokens = undefined;
      recentMisses.length = 0;
      windowBase = undefined;
      afterExpectedBreak = false;
      coldFirst = undefined;
      // ω99-34 — the successor identity: a rotation IS a structural prefix
      // change (the whole tail left), so the old window id flows to the next
      // main row as a SYNTHETIC advance (the Review I1 mintedFrom path — no
      // second mechanism), replacing the mislabeled "message:user" divergence
      // receipt the untreated diff would have fired. The id never rides the
      // request bytes.
      pendingMintFrom = windowId;
      windowId = randomUUID();
      pendingRotation = true;
    },
    async generate(input: ModelInput) {
      const serialized = serializePrompt(input);
      try {
        return await model.generate({ ...input, onUsage: (u) => observe(u, serialized, input) });
      } finally {
        // ω99-31 — the main chain's prev only: a side row's serialization is
        // never the main chain's predecessor (evicting it here made the next
        // MAIN row diff cross-chain — the campaign's turn-5 re-entry report).
        // ω99-33 — the counted size commits at the SAME seam so the pair
        // (prevSerialized, prevPromptTokens) always describes ONE call.
        if (input.querySource === undefined) {
          prevSerialized = serialized;
          prevPromptTokens = pendingMainPromptTokens;
        }
        pendingMainPromptTokens = undefined;
      }
    },
    ...(stream
      ? {
          async *stream(input: ModelInput) {
            const serialized = serializePrompt(input);
            try {
              yield* stream({ ...input, onUsage: (u) => observe(u, serialized, input) });
            } finally {
              // ω99-31 — same main-chain-only write as generate's finally.
              if (input.querySource === undefined) {
                prevSerialized = serialized;
                prevPromptTokens = pendingMainPromptTokens;
              }
              pendingMainPromptTokens = undefined;
            }
          },
        }
      : {}),
  };
}
