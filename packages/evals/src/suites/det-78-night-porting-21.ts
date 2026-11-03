// det-78-night-porting-21 — the deterministic pins for 夜移 033 (the
// zero-output length-stop tripwire, ported from pi's
// packages/ai/src/utils/overflow.ts Case 3). A length-stop carrying ZERO
// output tokens over a ≥99%-full window is a disguised context overflow —
// the server truncated the oversized input (Xiaomi MiMo style), leaving no
// room to generate. Nudging there stuffs a full window and deterministically
// repeats. Pinned here through the public export: the 0.99 threshold
// arithmetic (the floor boundary, one token each side) and the fail-open
// edges — a missing completion count and an unknown window both keep the
// ordinary 013 nudge path.
import type { EvalDefinition } from "../runner.js";
import { isZeroOutputOverflow } from "@wudao-org/core";

export interface NightPorting21Evidence {
  // ① at/above floor(0.99×window) with zero output → true (the disguise)
  readonly fullWindowTripwire: boolean;
  // ② the threshold boundary: exactly 8910 trips, 8909 does not
  readonly floorBoundary: boolean;
  // ③ completionTokens must be STRICTLY 0 — a real (≥1) output is 013's
  //    ordinary truncation, and an absent count fails open
  readonly strictZeroOutput: boolean;
  // ④ window 0 (no compaction options → window unknown) fails open
  readonly unknownWindowFailsOpen: boolean;
}

export const det78Eval: EvalDefinition<Record<string, never>, NightPorting21Evidence> = {
  name: "det-78-night-porting-21",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① the disguise itself: 8950 prompt tokens into a 9000 window.
    const fullWindowTripwire = isZeroOutputOverflow(0, 8_950, 9_000) === true;

    // ② floor(0.99 × 9000) = 8910 — inclusive at the floor, one short does not.
    const floorBoundary = isZeroOutputOverflow(0, 8_910, 9_000) === true
      && isZeroOutputOverflow(0, 8_909, 9_000) === false;

    // ③ strict zero: 1 output token is a REAL truncation (013's case, never
    //    a detour); undefined (provider did not report a count) fails open.
    const strictZeroOutput = isZeroOutputOverflow(1, 8_950, 9_000) === false
      && isZeroOutputOverflow(undefined, 8_950, 9_000) === false;

    // ④ no compaction options → window 0 → the predicate must decline
    //    (the nudge path owns it; compacting without a known window is a
    //    policy the run never signed up for).
    const unknownWindowFailsOpen = isZeroOutputOverflow(0, 8_950, 0) === false;

    return { fullWindowTripwire, floorBoundary, strictZeroOutput, unknownWindowFailsOpen };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.fullWindowTripwire, "① a zero-output length-stop over a ≥99%-full window must trip the overflow diagnosis");
    need(e.floorBoundary, "② the threshold is floor(0.99×window): exactly-at trips, one token short does not");
    need(e.strictZeroOutput, "③ completionTokens must be strictly 0 — real output (013's case) and missing counts fail open");
    need(e.unknownWindowFailsOpen, "④ an unknown window (0) must fail open to the nudge path");

    return errs;
  },
};
