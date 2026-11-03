// M41 — the kernel-policy single source. `@wudao-org/core` owns the mechanisms
// (concurrency slots, the budget fuse, grace-turn semantics); the deployment's
// OPERATING POINTS live here and are threaded into every construction site.
// Core keeps the types and the semantics, never the values — grep-audit table
// in docs/ARCHITECTURE.md ("mechanism/policy inventory") is the registry of
// what stayed and why.
//
// The values below are the pre-M41 core defaults, hoisted verbatim: this
// milestone moves policy, it does not change it. They are pinned by
// tests/kernel-policy.test.ts; changing one is a deployment-policy decision,
// not a refactor.

/** Registry operating points (M30 §B, M41 §1). */
export const KERNEL_POLICY = {
  registry: {
    /** Concurrent child slots (clamped into [1, maxConcurrentCeiling]). */
    maxConcurrent: 3,
    /** Ceiling for a caller-supplied maxConcurrent (the clamp bound). */
    maxConcurrentCeiling: 16,
    /** Upper bound on LIVE (queued+running) agents; spawn past it throws. */
    hardCap: 16,
    /** Registry-level child turn budget — spawn maxTurns > role maxTurns >
     *  this. The direct-runSubagent fuse is explicit since M41. */
    childTurns: 20,
    /** Grace-turn tool whitelist (budget-fuse escape hatch). Empty disables
     *  grace; foreground children are dispatched graceless by design. */
    graceTools: ["todo_write"],
    /** false: write-scope overlap warns on the receipt; true refuses. */
    strictOverlaps: false,
    /** 波次8 #47 (OH#6): registry-level wall-clock default for background
     *  children (spawn timeoutMs > this > unbounded). Same scale as
     *  SCHEDULE_RUN_TIMEOUT_MS (30m) — a hung child otherwise pins a
     *  concurrency slot forever. */
    backgroundTimeoutMs: 30 * 60_000,
  },
  /** Agent tool input clamps (#47): the model-facing timeoutMs range —
   *  minimum prevents a degenerate 1ms spawn, ceiling keeps one fat-fingered
   *  hour from masking a hang. */
  agentTimeout: {
    minMs: 30_000,
    maxMs: 3_600_000,
  },
} as const;

export type KernelPolicy = typeof KERNEL_POLICY;
