// det-81-night-porting-24 — the deterministic pins for 夜移 036 (session-tree
// token budget, ported from the upstream project/core/src/rollout_budget.rs). wudao
// had run-level wall-clock fuses (maxRunMs) and read-only usage stats, but no
// tree-wide hard cap — a subagent fleet could burn unbounded tokens. Pinned
// here through the public export: weighted accounting with cached-input-free
// units, sticky exhaustion, threshold reminder_index counting, per-thread /
// per-window delivery dedup, and rearm-without-refund.
import type { EvalDefinition } from "../runner.js";
import { createSessionBudget } from "@wudao/core";
import type { ModelUsage } from "@wudao/core";

export interface NightPorting24Evidence {
  // ① weighted units = output×sampling + non-cached-input×prefill (the upstream project40-of-100)
  readonly weightedAccounting: boolean;
  // ② exhaustion is sticky and remaining clamps at 0 with full index
  readonly stickyExhaustion: boolean;
  // ③ reminder_index counts crossed thresholds; index 0 restates the window start
  readonly thresholdIndexing: boolean;
  // ④ dedup is per {thread, window}; rearm removes the marker without refunding
  readonly dedupAndRearm: boolean;
}

function row(output: number, promptTokens: number, cacheHitTokens: number): ModelUsage {
  return {
    promptTokens,
    cacheHitTokens,
    cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
    completionTokens: output,
  } as ModelUsage;
}

export const det81Eval: EvalDefinition<Record<string, never>, NightPorting24Evidence> = {
  name: "det-81-night-porting-24",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① the upstream project's exact test numbers: input 60 (40 cached) + output 15 with
    //    weights 2.0/0.5 → 15×2 + 20×0.5 = 40 units; remaining 60; index 1.
    const a = createSessionBudget({
      limitTokens: 100,
      reminderAtRemainingTokens: [75, 50, 25],
      samplingTokenWeight: 2.0,
      prefillTokenWeight: 0.5,
    });
    const aExhausted = a.recordUsage(row(15, 60, 40));
    const aReminder = a.pendingReminder("root", "w0");
    const weightedAccounting = aExhausted === false
      && a.usedUnits() === 40
      && aReminder?.remainingTokens === 60
      && aReminder?.reminderIndex === 1;

    // ② cross the limit → true; later usage still true; remaining 0,
    //    index = every threshold.
    const b = createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 50, 25] });
    const bCross = b.recordUsage(row(60, 0, 0));
    const bLater = b.recordUsage(row(41, 0, 0));
    const bReminder = b.pendingReminder("root", "w0");
    const stickyExhaustion = bCross === false
      && bLater === true
      && b.recordUsage(row(1, 0, 0)) === true
      && bReminder?.remainingTokens === 0
      && bReminder?.reminderIndex === 3;

    // ③ index 0 = the window's opening restatement (nothing crossed); each
    //    threshold crossing raises the index; 0 remaining crosses all.
    const c = createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 50, 25] });
    const c0 = c.pendingReminder("c", "w0");
    const idxAt = (remaining: number): number => {
      let n = 0;
      for (const t of [75, 50, 25]) if (remaining <= t) n += 1;
      return n;
    };
    const thresholdIndexing = c0?.remainingTokens === 100
      && c0?.reminderIndex === 0
      && idxAt(60) === 1 && idxAt(45) === 2 && idxAt(10) === 3 && idxAt(0) === 3;

    // ④ same thread+window+index suppressed; higher index passes; another
    //    window restates; another thread is independent; rearm restates at
    //    the same index WITHOUT refunding usage.
    const d = createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 50, 25] });
    d.recordUsage(row(40, 0, 0)); // remaining 60, index 1
    const d1 = d.pendingReminder("root", "w0");
    d.markReminderDelivered("root", "w0", d1!);
    const dSameAgain = d.pendingReminder("root", "w0");
    d.recordUsage(row(15, 0, 0)); // remaining 45 → index 2
    const dHigher = d.pendingReminder("root", "w0");
    const dNewWindow = d.pendingReminder("root", "w1");
    const dOtherThread = d.pendingReminder("child", "w0");
    d.markReminderDelivered("root", "w1", dNewWindow!);
    // w1 is now silent too (same thread, delivered index 2) — checked BEFORE
    // the rearm, which wipes the whole thread marker (thread-keyed).
    const dW1Silent = d.pendingReminder("root", "w1") === undefined;
    d.rearmReminder("root");
    const dRearmed = d.pendingReminder("root", "w0");
    const dedupAndRearm = dSameAgain === undefined
      && dHigher?.reminderIndex === 2
      && dNewWindow?.reminderIndex === 2
      && dOtherThread?.reminderIndex === 2
      && dW1Silent
      && dRearmed?.remainingTokens === 45
      && dRearmed?.reminderIndex === 2
      && d.usedUnits() === 55;

    return { weightedAccounting, stickyExhaustion, thresholdIndexing, dedupAndRearm };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.weightedAccounting, "① weighted units must be output×sampling + non-cached-input×prefill (the upstream project 40-of-100)");
    need(e.stickyExhaustion, "② exhaustion must be sticky with remaining clamped at 0 and full reminder index");
    need(e.thresholdIndexing, "③ reminder_index must count crossed thresholds with index 0 restating the window start");
    need(e.dedupAndRearm, "④ dedup must be per {thread, window} and rearm must restate without refunding");

    return errs;
  },
};
