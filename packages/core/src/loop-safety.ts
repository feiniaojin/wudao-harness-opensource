// M48 §1 — the loop-safety net: pure detectors consumed by the loop at turn
// boundaries. Three independent failure shapes (langroid's frequency-dominance
// loop detection fused with HarnessX's failure/edit-streak guards):
//
//   identical_calls — inside a sliding W=6-turn window, the fingerprint
//     (tool name + canonical argument hash) of some call reaches frequency
//     ≥ W/2 AND dominates the runner-up by F=1.5×. The same call, over and
//     over, starves everything else in the window.
//   failure_streak  — ≥4 consecutive failures of the SAME tool with VARYING
//     args (the all-identical case belongs to identical_calls).
//   edit_repeat     — ≥3 consecutive failed edits with the same file AND the
//     same old_string: the classic "edit cannot find the text" death spiral.
//   no_answer       — 3 consecutive SHORT no-tool answers that paraphrase
//     each other (bag-of-words Jaccard ≥ 0.6): the model believes it has
//     answered; a stop gate (or hook) keeps bouncing it back.
//
// Everything here is pure: `detectLoop(turns)` maps a run's turn records to
// at most one verdict. The loop turns a verdict into (1) ONE MetaNote
// injection — "change approach or ask the user" — that does not consume turn
// quota, and (2) on a SECOND verdict in the same run, a forced
// Terminal{reason:"aborted"} carrying the evidence.

import { truncateSafe } from "./text-truncate.js";

export type LoopKind = "identical_calls" | "failure_streak" | "edit_repeat" | "no_answer";

/** One executed (or denied) tool call as the detectors see it. */
export interface LoopSafetyCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean;
  /** ω99-30 (C): stamped by the loop when the tool's loopExempt(args)
   *  returned true for this NON-ERROR call (polling-cadence semantics).
   *  Consumed ONLY by the identical_calls lane's window filter;
   *  failure_streak / edit_repeat / no_answer never consult it — the
   *  exemption is for designed polling rhythm, not failure immunity. */
  readonly exempt?: boolean;
  /** 133 #6（codex 63475131ce 形）：stamped by the loop when this call was
   *  GATE-DENIED（permission/hook/task 拒——从未执行）。truncated/persist-
   *  failed 的合成失败不带此旗（那是生成/落盘问题，不是权限墙）。 */
  readonly denied?: true;
}

/** One model turn: its tool calls, or (when it made none) its answer text. */
export interface LoopSafetyTurn {
  readonly calls: readonly LoopSafetyCall[];
  /** Assistant content when the turn made NO tool calls — the NO_ANSWER lane. */
  readonly answer?: string;
}

export interface LoopVerdict {
  readonly kind: LoopKind;
  /** Human-readable fingerprint summary — rides the note, the event, and the
   *  aborted terminal's evidence field. */
  readonly evidence: string;
  /** 133 #6（codex 63475131ce 形）— true when the offending streak was
   *  ENTIRELY gate denials（权限/钩子/任务拒——从未执行的调用）。The
   *  loop's forced abort then carries Terminal.denialCircuit，父链按终因
   *  选行为契约通知（"用户确认前禁止恢复"）。 */
  readonly denialCircuit?: true;
}

// Tuning constants (langroid: F=1.5 dominance; our spec: W=6).
export const LOOP_WINDOW = 6;
export const LOOP_DOMINANCE = 1.5;
/** Frequency floor: ≥ W/2 (3 of the last 6 turns). */
export const LOOP_MIN_FREQUENCY = Math.ceil(LOOP_WINDOW / 2);
/** Consecutive same-tool failures (args varying) that mean "stuck". */
export const FAILURE_STREAK_LIMIT = 4;
/** Consecutive same-file same-old_string edit failures that mean "stuck". */
export const EDIT_STREAK_LIMIT = 3;
/** Consecutive paraphrased no-tool answers that mean "not answering". */
export const NO_ANSWER_RUNS = 3;
/** Answers longer than this are expository, not the pathological shape. */
export const NO_ANSWER_MAX_CHARS = 280;
/** Bag-of-words Jaccard threshold for "paraphrase of the previous answer". */
export const NO_ANSWER_SIMILARITY = 0.6;

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys (arrays keep their order) — the
 *  same canonical shape the provider serializer pins, so argument ORDER never
 *  changes a fingerprint (the model re-emitting the same call with reordered
 *  keys is still the same call).
 *  ω99-43: exported — the ONE canonical serializer (durable child approval
 *  receipts key on it via callFingerprint); consumers must never hand-roll a
 *  second key-ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 32-bit → base36 (deterministic, dependency-free). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The identity of a call for loop purposes: tool name + canonical args hash. */
export function callFingerprint(call: { name: string; args: Record<string, unknown> }): string {
  return `${call.name}#${hash(canonicalJson(call.args))}`;
}

/** A short, stable preview of the arguments for evidence strings. */
function argPreview(args: Record<string, unknown>): string {
  const s = canonicalJson(args);
  return s.length > 60 ? `${truncateSafe(s, 57)}…` : s; // 113-A4 代理对安全帽
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** The last LOOP_WINDOW turns' calls, ONE per fingerprint per turn. A turn
 *  contributes at most 1 to a fingerprint's count — parallel batches of the
 *  same call in a single turn do not inflate the count. */
function windowCalls(turns: readonly LoopSafetyTurn[]): LoopSafetyCall[] {
  const result: LoopSafetyCall[] = [];
  for (const t of turns.slice(-LOOP_WINDOW)) {
    const seen = new Set<string>();
    for (const c of t.calls) {
      const fp = callFingerprint(c);
      if (!seen.has(fp)) {
        seen.add(fp);
        result.push(c);
      }
    }
  }
  return result;
}

/** The most frequent fingerprint with its count and the runner-up count. */
function topFingerprints(calls: readonly LoopSafetyCall[]): { top: string; topCount: number; runnerUp: number } {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const fp = callFingerprint(c);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  let top = "";
  let topCount = 0;
  let runnerUp = 0;
  for (const n of counts.values()) {
    if (n > topCount) {
      runnerUp = topCount;
      topCount = n;
    } else if (n > runnerUp) {
      runnerUp = n;
    }
  }
  // Recover the top fingerprint (first to reach topCount — deterministic).
  for (const [fp, n] of counts) {
    if (n === topCount) {
      top = fp;
      break;
    }
  }
  return { top, topCount, runnerUp };
}

function detectIdenticalCalls(turns: readonly LoopSafetyTurn[]): LoopVerdict | undefined {
  // ω99-30 (C): exempt NON-ERROR calls leave the identical-calls window — a
  // tool that self-describes its repeats as polling (loopExempt) does not
  // trip the cadence lane. Error calls are never filtered (isError exempts
  // nothing); every other lane keeps its unfiltered windowCalls view.
  const calls = windowCalls(turns).filter((c) => !(c.exempt === true && !c.isError));
  if (calls.length < LOOP_MIN_FREQUENCY) return undefined;
  const { top, topCount, runnerUp } = topFingerprints(calls);
  if (topCount < LOOP_MIN_FREQUENCY) return undefined;
  if (runnerUp > 0 && topCount < LOOP_DOMINANCE * runnerUp) return undefined;
  const example = calls.find((c) => callFingerprint(c) === top);
  const name = example?.name ?? top;
  // 133 #6：同指纹调用全是权限拒 → 否决墙（denial circuit）。
  // T005 F2（边界钉）：allDenied 要求同指纹的**每一条**都是 denied——模型
  // 在同指纹序列里插入一次成功调用（如重新拼写参数后放行）即破墙——严格
  // 执行「全是权限拒」的字面语义（成功=该调用未被拒）。
  const streak = calls.filter((c) => callFingerprint(c) === top);
  const allDenied = streak.length > 0 && streak.every((c) => c.denied === true);
  // T005 F7（注入卫生，与 failure_streak 的 "(args vary)" 同款姿态）：evidence
  // 不再插值 argPreview——它经 loopEvidence 流向父链的否决通知，被拒参数
  // 原文（路径/查询词/密钥）不得跨代理传播。工具名+次数足以自识别。
  return {
    kind: "identical_calls",
    evidence: `identical ${name} ×${topCount} in last ${LOOP_WINDOW} turns (args hidden)`,
    ...(allDenied ? { denialCircuit: true as const } : {}),
  };
}

function detectFailureStreak(turns: readonly LoopSafetyTurn[]): LoopVerdict | undefined {
  const calls = windowCalls(turns);
  let name = "";
  let streak: LoopSafetyCall[] = [];
  for (const c of calls) {
    if (c.isError && c.name === name) {
      streak.push(c);
    } else if (c.isError) {
      name = c.name;
      streak = [c];
    } else {
      name = "";
      streak = [];
    }
  }
  // T005 F1（语义钉）：「consecutive」指窗口内**扁平调用序列**的连续
  // （windowCalls 拉平所有 turn 的 calls），不是 turn 级连续——模型「思考
  // 一轮再试」（无工具轮）不打断 streak（该轮没有调用可断它）。
  if (streak.length < FAILURE_STREAK_LIMIT) return undefined;
  // All-identical failing args is the identical_calls lane's case.
  const fingerprints = new Set(streak.map((c) => callFingerprint(c)));
  if (fingerprints.size === 1) return undefined;
  // 133 #6：连续失败全是权限拒 → 否决墙（denial circuit）。
  const allDenied = streak.every((c) => c.denied === true);
  return {
    kind: "failure_streak",
    evidence: `${name} failed ×${streak.length} consecutively (args vary)`,
    ...(allDenied ? { denialCircuit: true as const } : {}),
  };
}

/** The edit-shape key of a failed call: (tool, file, old_string), or undefined
 *  when the call is not an edit-shaped failure. */
function editKey(c: LoopSafetyCall): { name: string; file: string; oldString: string } | undefined {
  if (!c.isError) return undefined;
  const old = c.args["old_string"];
  if (typeof old !== "string") return undefined;
  const file = c.args["path"] ?? c.args["file_path"];
  if (typeof file !== "string") return undefined;
  return { name: c.name, file, oldString: old };
}

function detectEditRepeat(turns: readonly LoopSafetyTurn[]): LoopVerdict | undefined {
  const calls = windowCalls(turns);
  let key: { name: string; file: string; oldString: string } | undefined;
  let streakLen = 0;
  for (const c of calls) {
    const k = editKey(c);
    if (k !== undefined && key !== undefined && k.name === key.name && k.file === key.file && k.oldString === key.oldString) {
      streakLen += 1;
    } else if (k !== undefined) {
      key = k;
      streakLen = 1;
    } else {
      key = undefined;
      streakLen = 0;
    }
  }
  if (key === undefined || streakLen < EDIT_STREAK_LIMIT) return undefined;
  const oldPreview = key.oldString.length > 30 ? `${truncateSafe(key.oldString, 27)}…` : key.oldString; // 113-A4
  return {
    kind: "edit_repeat",
    evidence: `edit ${key.file} old_string="${oldPreview}" failed ×${streakLen}`,
  };
}

/** Lowercased word tokens, punctuation stripped. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((t) => t.length > 0),
  );
}

/** Bag-of-words Jaccard similarity. Two empty strings are treated as
 *  identical (similarity = 1) for the no-answer detector's alternation
 *  counter. */
export function answerSimilarity(a: string, b: string): number {
  // Special case: two empty strings are identical.
  if (a === "" && b === "") return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

function detectNoAnswer(turns: readonly LoopSafetyTurn[]): LoopVerdict | undefined {
  const tail = turns.slice(-NO_ANSWER_RUNS);
  if (tail.length < NO_ANSWER_RUNS) return undefined;
  const answers: string[] = [];
  for (const t of tail) {
    if (t.calls.length > 0 || t.answer === undefined || t.answer.length > NO_ANSWER_MAX_CHARS) return undefined;
    answers.push(t.answer);
  }
  for (let i = 1; i < answers.length; i += 1) {
    if (answerSimilarity(answers[i - 1] ?? "", answers[i] ?? "") < NO_ANSWER_SIMILARITY) return undefined;
  }
  const first = answers[0] ?? "";
  const preview = first.length > 50 ? `${truncateSafe(first, 47)}…` : first; // 113-A4
  return {
    kind: "no_answer",
    evidence: `no-tool answers ×${NO_ANSWER_RUNS} (paraphrased): "${preview}"`,
  };
}

/**
 * Pure loop verdict over a run's turns (most recent last). At most one
 * verdict, most-specific first: edit_repeat → failure_streak →
 * identical_calls → no_answer. `undefined` = no loop.
 */
export function detectLoop(turns: readonly LoopSafetyTurn[]): LoopVerdict | undefined {
  return (
    detectEditRepeat(turns)
    ?? detectFailureStreak(turns)
    ?? detectIdenticalCalls(turns)
    ?? detectNoAnswer(turns)
  );
}

// ---------------------------------------------------------------------------
// 121 #5 — the no-progress guard (advisory-only). a reference harness f088466d3 形的保
// 守版：四条 verdict 车道全部不看工具「结果」——不同调用返回相同结果
// （换着花样问同一件事）四处漏检：调用不同（identical_calls 的指纹按
// name+args 算，不命中）、无报错（failure_streak/edit_repeat 只看
// isError）、有工具轮（no_answer 只看无工具轮）。本车道补跨轮无变化检
// 测：连续 N 轮（缺省 5）的工具结果集 fingerprint 全部相同 → 注入一条
// MetaNote。只建议不阻断（沿 GoalState 语义——与 verdict 车道的升级/终
// 止机制完全独立，绝不 abort）。
//
// 车道正交性（既有车道 owning 的形状本车道一律复位不抢）：
//   字节相同的调用复现      → identical_calls（其窗口+支配度+升级机制 own）
//   报错轮                  → failure_streak / edit_repeat
//   连续无工具的 paraphrase → no_answer
//   全豁免轮（polling 等待）→ ω99-30 (C) 的 loopExempt 纪律同款：跳过
// ---------------------------------------------------------------------------

/** Consecutive identical-result turns that mean "no progress". */
export const NO_PROGRESS_TURNS = 5;

// 129-3（DeepCode 1bb0c93a 引进）— 对级无进展台账：A,B,A,B 同果交错对轮级
// streak 全漏（streak 永远 1——指纹在 R_A/R_B 间乒乓）。本台账数
// （调用集,结果指纹）PAIR 在整个 run 内的出现次数：同一对第 N 次（不必连续）
// 即交错停滞。与 streak 车道并存：连续同果走快路径（5 轮），交错走台账
// （3 次）。
/** Same (call-set, result) pair occurrences that mean an ALTERNATING stall. */
export const NO_PROGRESS_PAIR_REPEATS = 3;
/** Distinct pairs the ledger tracks (bounded memory; new keys beyond the cap
 * are ignored — existing keys keep counting). */
export const NO_PROGRESS_PAIR_LEDGER_CAP = 64;

/** One finished tool turn as this lane sees it: its calls (loopExempt stamps
 * included — the loop stamps them before feeding) and its tool results in
 * the assistant's call order (deterministic — completion order never changes
 * a fingerprint). */
export interface NoProgressTurn {
  readonly calls: readonly { readonly name: string; readonly args: Record<string, unknown>; readonly exempt?: boolean }[];
  readonly results: readonly { readonly content: string; readonly isError: boolean }[];
}

/** The lane's run-local state (重启/换 run 重计——刻意不持久化，保持简单；
 * 任何一轮结果变化即归零由 reducer 保证)。 */
export interface NoProgressState {
  /** Consecutive turns sharing `fingerprint` (the arming turn included). */
  readonly streak: number;
  /** The fingerprint the streak is counting (undefined = disarmed). */
  readonly fingerprint: string | undefined;
  /** The previous TOOL turn's canonical call-set key (the identical-calls
   * orthogonality gate). */
  readonly prevCallKey: string | undefined;
  /** 129-3 — the pair ledger: pairKey → occurrences this run (bounded by
   * NO_PROGRESS_PAIR_LEDGER_CAP distinct keys). */
  readonly pairCounts: Readonly<Record<string, number>>;
}

export const NO_PROGRESS_CLEAN: NoProgressState = { streak: 0, fingerprint: undefined, prevCallKey: undefined, pairCounts: {} };

/** The advisory note (byte-pinned family format of the loop-safety notes). */
export function noProgressNote(turns: number = NO_PROGRESS_TURNS): string {
  return `[system note: 你最近 ${turns} 轮的工具调用产生了完全相同的结果——你可能陷入了无进展的循环。请重新审视任务目标、换一个方法，或向用户说明你遇到的困难。]`;
}

/** 129-3 — the alternating-stall advisory (pair ledger's note). */
export function noProgressPairNote(repeats: number = NO_PROGRESS_PAIR_REPEATS): string {
  return `[system note: 同样的调用与结果的组合在本任务中已第 ${repeats} 次出现（并非每轮连续——你在交错重复相同的动作而没有任何变化）。请改变方法，或向用户说明你遇到的困难。]`;
}

/** Head/tail fragment length for one result's identity (121 §5 的「长度+首
 * 尾片段」简单 hash 处方). */
const NO_PROGRESS_FRAGMENT = 64;

/** One result's identity: length + head + tail fragments. A middle-only
 * change collides by design (documented trade-off): real progress almost
 * always moves the length or the edges (headers, counters, footers), and a
 * conservative advisory guard prefers a rare miss over fingerprint churn. */
function resultKey(content: string): string {
  const head = content.slice(0, NO_PROGRESS_FRAGMENT);
  const tail = content.length > NO_PROGRESS_FRAGMENT * 2 ? content.slice(-NO_PROGRESS_FRAGMENT) : "";
  return `${content.length}:${head}:${tail}`;
}

/** The turn's tool-result-set fingerprint: one key per result, call order,
 * FNV-hashed (deterministic — same results, same fingerprint, every time). NUL-joined so list boundaries stay structural
 * (["a b","c"] and ["a","b c"] never collide). */
export function resultFingerprint(results: readonly { readonly content: string }[]): string {
  return hash(results.map((r) => resultKey(r.content)).join("\u0000"));
}

/** One reducer step's outcome: the next state, plus the advisory note when
 * the streak reached the limit (fired exactly at the crossing turn — the
 * streak re-arms from zero, so a further N fresh identical turns re-note). */
export interface NoProgressStep {
  readonly state: NoProgressState;
  readonly note: string | undefined;
}

/** Advance the no-progress state over one FINISHED turn (pure). */
export function advanceNoProgress(state: NoProgressState, turn: NoProgressTurn): NoProgressStep {
  // A no-tool turn is the model ANSWERING — a structural behavior change.
  // Reset (the no_answer lane owns repeated-answer spins; this counter
  // counts consecutive TOOL-turn stasis only — 无工具轮不计数且断链).
  if (turn.calls.length === 0) return { state: NO_PROGRESS_CLEAN, note: undefined };
  const callKey = [...new Set(turn.calls.map((c) => callFingerprint(c)))].sort().join("|");
  // Any error result: the failure lanes own error shapes (a failing turn is
  // neither progress evidence nor honest stasis evidence) — reset the streak.
  // 129-3：台账照带（错误轮不添对——错误不是这对的「结果」）。
  if (turn.results.some((r) => r.isError)) {
    return { state: { streak: 0, fingerprint: undefined, prevCallKey: callKey, pairCounts: state.pairCounts }, note: undefined };
  }
  // An all-exempt turn (every call polling-stamped): designed waiting —
  // neither advances nor breaks the chain (ω99-30 (C) discipline, applied at
  // turn granularity).
  if (turn.calls.every((c) => c.exempt === true)) {
    return { state: { ...state, prevCallKey: callKey }, note: undefined };
  }
  const fp = resultFingerprint(turn.results);
  // Byte-identical call repeats are the identical_calls lane's case — reset
  // the streak AND skip the pair ledger (129-3 orthogonality：连续同调同果
  // 的形状归 identical_calls 所有并有自己的升级机制；本台账只数「交错回
  // 归」——callKey≠prev 时的同对重现，A,B,A,B 的盲区）。
  if (state.prevCallKey !== undefined && callKey === state.prevCallKey) {
    return { state: { streak: 0, fingerprint: undefined, prevCallKey: callKey, pairCounts: state.pairCounts }, note: undefined };
  }
  // 129-3 — the pair ledger: count this ALTERNATING return of the
  // (call-set, result) pair; the Nth occurrence (NOT consecutive — the A,B,
  // A,B gap the streak lane can never see) fires the alternating-stall note
  // and clears THAT key (re-arm: N further occurrences re-note). Bounded:
  // new keys beyond the cap are ignored; existing keys keep counting.
  const pairKey = `${callKey}\u0000${fp}`;
  const seen = state.pairCounts[pairKey] ?? 0;
  const ledgerFull = seen === 0 && Object.keys(state.pairCounts).length >= NO_PROGRESS_PAIR_LEDGER_CAP;
  const nextPairCounts = ledgerFull
    ? state.pairCounts
    : { ...state.pairCounts, [pairKey]: seen + 1 };
  if (seen + 1 >= NO_PROGRESS_PAIR_REPEATS) {
    const cleared = { ...nextPairCounts };
    delete cleared[pairKey];
    return { state: { streak: 0, fingerprint: undefined, prevCallKey: callKey, pairCounts: cleared }, note: noProgressPairNote(seen + 1) };
  }
  if (state.streak > 0 && state.fingerprint === fp) {
    const streak = state.streak + 1;
    if (streak >= NO_PROGRESS_TURNS) {
      return { state: { streak: 0, fingerprint: undefined, prevCallKey: callKey, pairCounts: nextPairCounts }, note: noProgressNote(streak) };
    }
    return { state: { streak, fingerprint: fp, prevCallKey: callKey, pairCounts: nextPairCounts }, note: undefined };
  }
  // A changed fingerprint (or a disarmed counter) re-arms: 结果变化即归零.
  return { state: { streak: 1, fingerprint: fp, prevCallKey: callKey, pairCounts: nextPairCounts }, note: undefined };
}
