// ω-long-1 — turn-budget watermark: the model is told how many turns of its
// CURRENT slice remain, at two milestones (50% and 20% left), through the
// MetaNote projection channel (suffix-only, never persisted, prefix-cache
// safe — the same lane sessionBudget/timeReminder ride).
//
// Why (114 §4.2 item 3, P5e 截止盲视 4/7 真实超时): the harness already has
// two hard fuses (maxTurns, maxRunMs) and a token-budget reminder — but all
// of them are either silent-until-death or scoped to tokens. A run whose
// token budget is comfortable but whose TURN fuse is close dies with zero
// warning; 114 found the模型 keeps opening new experiments in the last third.
// The fix is the cheapest of the seven it lists: put the remaining turns in
// front of the model at the moments a pace change is still possible.
//
// Slicing caveat (弧 C): maxTurns is a SLICE boundary when continuation is
// armed, so the remainder is computed against the CURRENT slice (turn -
// sliceTurnBase), never the whole run — otherwise a continued run would see
// a negative remainder and go silent.
//
// Milestone semantics: each milestone fires at most ONCE per slice. A slice
// reset (new sliceTurnBase) re-arms both. No per-turn nagging: the model
// gets 2 notes, not 190.

/** The two watermarks, as a fraction of the slice REMAINING. */
export const TURN_BUDGET_MILESTONES = [0.5, 0.2] as const;

export interface TurnBudgetState {
  /** Index into TURN_BUDGET_MILESTONES of the last milestone already fired
   *  (-1 = none). */
  lastMilestone: number;
  /** The slice base the milestones were armed against — a new slice resets
   *  lastMilestone to -1. */
  sliceBase: number;
}

export function newTurnBudgetState(): TurnBudgetState {
  return { lastMilestone: -1, sliceBase: 0 };
}

/** Pure: decide whether this turn crosses a not-yet-fired milestone.
 *  Returns the milestone index to fire, or undefined. */
export function nextTurnBudgetMilestone(
  state: TurnBudgetState,
  turn: number,
  sliceBase: number,
  maxTurns: number,
): number | undefined {
  if (maxTurns <= 0 || !Number.isFinite(maxTurns)) {
    // Unlimited (Infinity) or disabled: there is no remainder to pace against.
    return undefined;
  }
  if (state.sliceBase !== sliceBase) {      // a new slice re-arms everything
    state.sliceBase = sliceBase;
    state.lastMilestone = -1;
  }
  const used = turn - sliceBase;
  const remaining = maxTurns - used;
  if (remaining <= 0) return undefined;
  const frac = remaining / maxTurns;
  for (let i = 0; i < TURN_BUDGET_MILESTONES.length; i += 1) {
    if (i <= state.lastMilestone) continue;
    if (frac <= (TURN_BUDGET_MILESTONES[i] as number)) {
      state.lastMilestone = i;
      return i;
    }
  }
  return undefined;
}

/** The note text. Milestone-aware: the 20% one is directive (stop opening
 *  new fronts, land what exists), the 50% one is informational. */
export function formatTurnBudgetNote(remaining: number, milestone: number): string {
  const base = `[turn budget: ${remaining} turn(s) left in this run's slice (the run stops when they reach 0)]`;
  return milestone === 1
    ? `${base} Wrap up NOW: stop opening new fronts, finish and verify what you already started, then report. Unfinished exploration is worth less than a verified partial result.`
    : `${base} Pace yourself: prefer finishing existing work over starting new exploration.`;
}
