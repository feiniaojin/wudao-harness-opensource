// M29 §3 — the per-workflow token budget. One pool shared by reference across
// sub-workflows (a child spending is the run spending); the script reads
// `budget.remaining` to drive loop-until-budget patterns; `assertCanSpend()`
// throws BudgetExhaustedError — a run failure, never a silent truncation.
// Budget is charged only for a task's FINAL ok attempt (retries don't
// double-bill), while actual spend is still recorded per attempt in journals.
import { RunFatalError, type BudgetView } from "./vm.js";

export class BudgetExhaustedError extends RunFatalError {
  constructor(total: number, spent: number) {
    super(`workflow budget exhausted: ${spent} / ${total} tokens spent — failing the run (no silent truncation)`);
    this.name = "BudgetExhaustedError";
  }
}

export const DEFAULT_BUDGET_TOKENS = 500_000;

export interface Budget extends BudgetView {
  /** Charge tokens to the pool (a task's final ok attempt). */
  charge(tokens: number): void;
  /** Throws BudgetExhaustedError when the pool is spent. Call INSIDE the
   *  concurrency critical section so queued waiters re-check on wake. */
  assertCanSpend(): void;
}

export function createBudget(total: number = DEFAULT_BUDGET_TOKENS): Budget {
  let spent = 0;
  return {
    total,
    get spent(): number {
      return spent;
    },
    get remaining(): number {
      return Math.max(0, total - spent);
    },
    charge(tokens: number): void {
      if (tokens > 0) spent += tokens;
    },
    assertCanSpend(): void {
      if (spent >= total) throw new BudgetExhaustedError(total, spent);
    },
  };
}
