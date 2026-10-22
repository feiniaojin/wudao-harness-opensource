// 夜移 023 (Reasonix reasoning_warn_state.go): a missing tool-call reasoning
// finish is a compatibility INCIDENT, not a permanent provider characteristic.
// One frozen replay per incident window; a replay that ALSO comes back
// reasoning-less opens the circuit (the replay tax stops while the regression
// lasts); three consecutive healthy tool turns re-arm it. Divergence from the
// source (recorded in the ledger): only a PROVEN-useless replay opens the
// circuit — a retry that recovers keeps full protection, because wudao has no
// history-projection machinery to fall back on when reasoning is lost.
// Session-scoped: one circuit per provider leg; the cross-process persisted
// variant (fingerprint + cooldown + file lock) is milestone-level, not here.

/** Reasonix missingReasoningHealthyResolveStreak — three consecutive healthy
 *  tool turns close an open incident, so a future isolated regression gets one
 *  fresh silent retry without flapping. */
const RE_ARM_HEALTHY_TURNS = 3;

export interface MissingReasoningCircuit {
  /** Whether the one frozen replay may still be attempted for a
   *  missing-reasoning finish (the circuit is closed). */
  allowsRetry(): boolean;
  /** The frozen replay of a missing-reasoning finish ALSO came back missing —
   *  open the circuit: remediation is proven useless for this window. */
  noteFailedReplay(): void;
  /** A missing-reasoning finish settled as-is because the circuit was open —
   *  another observed regression resets the re-arm streak (an intermittent
   *  regression must not re-arm on a sparse streak). */
  noteSuppressedMissing(): void;
  /** A healthy tool-call turn under the replay contract settled — three
   *  consecutive re-arm the circuit. */
  noteHealthyToolTurn(): void;
}

export function createMissingReasoningCircuit(): MissingReasoningCircuit {
  let retriesExhausted = false;
  let healthyStreak = 0;
  return {
    allowsRetry: () => !retriesExhausted,
    noteFailedReplay() {
      retriesExhausted = true;
      healthyStreak = 0;
    },
    noteSuppressedMissing() {
      healthyStreak = 0;
    },
    noteHealthyToolTurn() {
      if (!retriesExhausted) return;
      healthyStreak += 1;
      if (healthyStreak >= RE_ARM_HEALTHY_TURNS) {
        retriesExhausted = false;
        healthyStreak = 0;
      }
    },
  };
}
