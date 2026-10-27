// ω-1b — the repetition circuit breaker (goose crates/goose/src/tool_monitor.rs
// :34-82, digest 98a). A model wedged in a loop — re-reading the same file,
// re-running the same failing command — is the most common pure token waste;
// goose interrupts once the SAME call repeats past a threshold. This module is
// the pure inspector: the loop feeds it every call that reaches the execution
// seam, and a `repeated` verdict means "do not execute — answer with the
// breaker error result instead".
//
// Semantics (deliberately narrower than the M48 loop-safety net, which sees
// whole turns at boundaries): CONSECUTIVE identical calls, key = tool name +
// JSON.stringify(arguments). Any different call — different tool, different
// args — resets the streak. The trip itself ALSO resets the counter: the
// breaker shorts the call, never the tool, so the next identical call starts
// accumulating again and no subsequent turn can deadlock on a latched state.
//
// Per-turn counting (M48's windowCalls doctrine, adopted verbatim): a turn
// contributes at most 1 to a call's streak. Identical calls inside ONE
// assistant batch are one DECISION — a parallel fan-out, a legitimate shape
// the M48 net already refuses to punish — so they execute normally and never
// advance the streak; the loop signals turn boundaries via the optional
// `turn` argument. The streak therefore counts the model RE-CHOOSING the
// same call across turns: a genuinely wedged model trips on its 3rd
// consecutive identical TURN. When a turn's re-choice does trip, every
// identical copy in that same turn shares the verdict (the whole re-choice
// is refused, not 2 of 8 fan-out calls).
//
// Known limitation (pinned by test): JSON.stringify is key-order-SENSITIVE, so
// the same call re-emitted with reordered argument keys counts as different.
// The M48 net fingerprints arguments canonically (sorted keys) and catches
// that shape at the turn boundary — the second line, not this one.
//
// Lifecycle: the loop holds one inspector per RUN (a closure variable — the
// same scope discipline as the M48 turn records), so the streak persists
// across turns within one runAgentLoop call and starts from zero on resume
// (each resume is a fresh generator). Acceptable by design: a resumed run has
// no live memory of the pre-interrupt streak, and 2-3 calls to re-arm is
// cheap next to a wedged loop.
import type { ToolCall } from "../types.js";

/** Consecutive identical turns before the breaker trips. */
export const REPETITION_DEFAULT_THRESHOLD = 3;

export interface RepetitionInspectorOptions {
  /** Default REPETITION_DEFAULT_THRESHOLD (3). Values < 2 are meaningless
   *  (every call would "repeat") and are used as given — callers configure
   *  sensible thresholds; the loop passes nothing. */
  readonly threshold?: number;
}

/** One verdict: `count` is the consecutive-identical streak INCLUDING this
 *  call; `repeated` means the streak reached the threshold (trip → the loop
 *  skips execution and answers with the breaker result). */
export interface RepetitionVerdict {
  readonly repeated: boolean;
  readonly count: number;
}

export interface RepetitionInspector {
  /** `turn` (when provided) enables per-turn dedup: same-key calls within one
   *  turn share the turn's first verdict for that key and never advance the
   *  streak on their own. Omit it for literal call-by-call streaks. */
  inspect(call: ToolCall, turn?: number): RepetitionVerdict;
}

/** The identity of a call for breaker purposes: name + stringified args. */
function callKey(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
}

export function createRepetitionInspector(options: RepetitionInspectorOptions = {}): RepetitionInspector {
  const threshold = options.threshold ?? REPETITION_DEFAULT_THRESHOLD;
  let lastKey: string | undefined;
  let streak = 0;
  let dedupTurn: number | undefined;
  let turnVerdicts: Map<string, RepetitionVerdict> | undefined;
  // The streak algebra both lanes share: count, trip at the threshold, and
  // RESET on the trip (never latch).
  const advance = (key: string): RepetitionVerdict => {
    streak = key === lastKey ? streak + 1 : 1;
    lastKey = key;
    if (streak >= threshold) {
      const count = streak;
      lastKey = undefined;
      streak = 0;
      return { repeated: true, count };
    }
    return { repeated: false, count: streak };
  };
  return {
    inspect(call: ToolCall, turn?: number): RepetitionVerdict {
      const key = callKey(call);
      // Per-turn dedup lane: one decision per (turn, key) — see the header.
      // A same-turn duplicate replays the first verdict for its key and
      // leaves the streak untouched (a fan-out neither trips nor counts).
      if (turn !== undefined) {
        if (turn !== dedupTurn) {
          dedupTurn = turn;
          turnVerdicts = new Map();
        }
        const memo = turnVerdicts?.get(key);
        if (memo !== undefined) return memo;
        const verdict = advance(key);
        turnVerdicts?.set(key, verdict);
        return verdict;
      }
      return advance(key);
    },
  };
}

/** The breaker's model-facing result text (the error-tool-result channel —
 *  model-facing like TRUNCATED_TOOL_CALL_RESULT, never an exception). The
 *  count and the directive ride the text so the model can see exactly what
 *  tripped and what to do about it. */
export function repetitionBreakerMessage(call: { readonly name: string }, count: number): string {
  return `[重复熔断] 连续第 ${count} 次完全相同的调用已熔断——本次调用未执行;换一种做法或停止(修改参数、改用其他工具,或直接给出结论;工具 ${call.name} 本身未被禁用)`;
}
