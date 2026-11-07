// ω-long-1 — the turn-budget watermark: milestone arithmetic + the note copy.
// The integration (the note actually landing on a model request) is covered
// by loop-level tests; this file pins the pure seam so the milestone math
// cannot drift silently.
import { describe, expect, it } from "vitest";
import {
  TURN_BUDGET_MILESTONES,
  newTurnBudgetState,
  nextTurnBudgetMilestone,
  formatTurnBudgetNote,
} from "../src/turn-budget.js";

describe("turn budget milestones", () => {
  it("fires the 50% milestone when half the slice remains", () => {
    const st = newTurnBudgetState();
    // maxTurns 200: remaining 100 → exactly 50%
    expect(nextTurnBudgetMilestone(st, 100, 0, 200)).toBe(0);
  });

  it("does NOT fire above 50% remaining", () => {
    const st = newTurnBudgetState();
    for (let turn = 0; turn < 100; turn += 1) {
      expect(nextTurnBudgetMilestone(st, turn, 0, 200)).toBeUndefined();
    }
  });

  it("fires the 20% milestone later, and each milestone only once", () => {
    const st = newTurnBudgetState();
    expect(nextTurnBudgetMilestone(st, 100, 0, 200)).toBe(0); // 50% left
    // 50 → 20% milestone (remaining 40 = 20%)
    expect(nextTurnBudgetMilestone(st, 160, 0, 200)).toBe(1);
    // no repeat on later turns
    expect(nextTurnBudgetMilestone(st, 161, 0, 200)).toBeUndefined();
    expect(nextTurnBudgetMilestone(st, 199, 0, 200)).toBeUndefined();
  });

  it("does not re-fire the 50% milestone on every later turn", () => {
    const st = newTurnBudgetState();
    nextTurnBudgetMilestone(st, 100, 0, 200);
    expect(nextTurnBudgetMilestone(st, 101, 0, 200)).toBeUndefined();
    expect(nextTurnBudgetMilestone(st, 120, 0, 200)).toBeUndefined();
  });

  it("re-arms on a new slice (continuation resets the budget window)", () => {
    const st = newTurnBudgetState();
    nextTurnBudgetMilestone(st, 100, 0, 200);   // fires 50% in slice 0
    nextTurnBudgetMilestone(st, 160, 0, 200);   // fires 20% in slice 0
    // slice 1 starts at turn 200 with a fresh 200-turn budget
    expect(nextTurnBudgetMilestone(st, 300, 200, 200)).toBe(0);
  });

  it("goes silent at zero remaining and beyond", () => {
    const st = newTurnBudgetState();
    expect(nextTurnBudgetMilestone(st, 200, 0, 200)).toBeUndefined();
    expect(nextTurnBudgetMilestone(st, 250, 0, 200)).toBeUndefined();
  });

  it("is a no-op for an unlimited budget", () => {
    const st = newTurnBudgetState();
    expect(nextTurnBudgetMilestone(st, 0, 0, 0)).toBeUndefined();
    expect(nextTurnBudgetMilestone(st, 999, 0, 0)).toBeUndefined();
  });

  it("is a no-op for Infinity (WUDAO_MAX_TURNS=0) — never emits 'Infinity turns left'", () => {
    const st = newTurnBudgetState();
    for (const turn of [0, 1, 100, 10_000]) {
      expect(nextTurnBudgetMilestone(st, turn, 0, Number.POSITIVE_INFINITY)).toBeUndefined();
    }
  });
});

describe("turn budget note copy", () => {
  it("the 50% note is informational", () => {
    const n = formatTurnBudgetNote(100, 0);
    expect(n).toContain("100 turn(s) left");
    expect(n).toContain("Pace yourself");
    expect(n).not.toContain("Wrap up NOW");
  });

  it("the 20% note is directive — no new fronts, land what exists", () => {
    const n = formatTurnBudgetNote(40, 1);
    expect(n).toContain("40 turn(s) left");
    expect(n).toContain("Wrap up NOW");
    expect(n).toContain("stop opening new fronts");
    expect(n).toContain("verified partial result");
  });

  it("states the fuse is real (the model must know 0 means the run stops)", () => {
    expect(formatTurnBudgetNote(10, 1)).toContain("the run stops when they reach 0");
  });
});

describe("TURN_BUDGET_MILESTONES", () => {
  it("is ordered most-remaining first (the loop relies on ascending index)", () => {
    expect(TURN_BUDGET_MILESTONES).toEqual([0.5, 0.2]);
  });
});
