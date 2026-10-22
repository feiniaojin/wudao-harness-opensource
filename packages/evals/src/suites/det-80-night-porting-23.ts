// det-80-night-porting-23 — the deterministic pins for 夜移 035 (turn phase
// timing, ported from the upstream project/core/src/turn_timing.rs). wudao had
// cache forensics (M24 byte assertions) but NO latency forensics — "why did
// this run take 90s" was unanswerable. The recorder is a six-bucket phase
// state machine: beforeFirstSampling / sampling / compaction / toolBlocking /
// betweenSamplingOverhead / afterLastSampling (+ request vs retry counters).
// Pinned here through the public export: exact transition accounting, the
// nested-begin inert guard + complete-freeze, the rounding absorption
// invariant (buckets re-sum to totalMs), and retry-vs-request separation.
import type { EvalDefinition } from "../runner.js";
import { createTurnProfileRecorder } from "@wudao/core";

export interface NightPorting23Evidence {
  // ① transitions account to the CURRENT phase at exact clock steps
  readonly transitionAccounting: boolean;
  // ② a nested begin while a phase is active is inert; complete freezes
  readonly nestedInertAndFreeze: boolean;
  // ③ floor-truncation residual is absorbed so the six buckets re-sum to total
  readonly absorptionInvariant: boolean;
  // ④ sampling retries count separately from sampling requests
  readonly retryVsRequest: boolean;
}

export const det80Eval: EvalDefinition<Record<string, never>, NightPorting23Evidence> = {
  name: "det-80-night-porting-23",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① exact-transition accounting: before 10 / sampling 100 / after 40.
    let t = 0;
    const r1 = createTurnProfileRecorder(() => t);
    r1.markTurnStarted();
    t = 10;
    const s = r1.beginSampling();
    t = 110;
    s.end();
    t = 150;
    const p1 = r1.complete();
    const transitionAccounting = p1.beforeFirstSamplingMs === 10
      && p1.samplingMs === 100
      && p1.afterLastSamplingMs === 40
      && p1.totalMs === 150
      && p1.samplingRequestCount === 1;

    // ② a nested begin inside an ACTIVE phase is inert (the active phase is
    //    not swapped — its guard ends as a no-op); complete is memoized and
    //    freezes later noise.
    t = 0;
    const r2 = createTurnProfileRecorder(() => t);
    r2.markTurnStarted();
    const active = r2.beginSampling();
    t = 50;
    const nested = r2.beginCompaction();
    t = 80;
    nested.end(); // no-op: not the active phase
    t = 100;
    active.end();
    t = 120;
    const first = r2.complete();
    const late = r2.beginSampling();
    late.end();
    const second = r2.complete();
    const nestedInertAndFreeze = first.samplingMs === 100
      && first.compactionMs === 0
      && second === first
      && second.samplingRequestCount === 1; // the late begin never counted

    // ③ fractional clock: per-bucket floor truncation leaves an integer
    //    residual that complete() absorbs into the final bucket — the six
    //    buckets ALWAYS re-sum to totalMs (no unaccounted hole).
    t = 0;
    const r3 = createTurnProfileRecorder(() => t);
    r3.markTurnStarted();
    t = 10.5;
    const s3 = r3.beginSampling();
    t = 21.2;
    s3.end();
    t = 30.9;
    const p3 = r3.complete();
    const absorptionInvariant = p3.totalMs === 30
      && p3.samplingMs === 10
      && p3.afterLastSamplingMs === 10
      && p3.beforeFirstSamplingMs + p3.samplingMs + p3.compactionMs
        + p3.betweenSamplingOverheadMs + p3.toolBlockingMs + p3.afterLastSamplingMs === p3.totalMs;

    // ④ retries are their own counter (a retry is also a request — the loop's
    //    beginSampling at the retry site bumps requests; recordSamplingRetry
    //    bumps retries).
    t = 0;
    const r4 = createTurnProfileRecorder(() => t);
    r4.markTurnStarted();
    const s4 = r4.beginSampling();
    r4.recordSamplingRetry();
    r4.recordSamplingRetry();
    t = 50;
    s4.end();
    const p4 = r4.complete();
    const retryVsRequest = p4.samplingRequestCount === 1 && p4.samplingRetryCount === 2;

    return { transitionAccounting, nestedInertAndFreeze, absorptionInvariant, retryVsRequest };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.transitionAccounting, "① transitions must account elapsed time to the active phase at exact clock steps");
    need(e.nestedInertAndFreeze, "② a nested begin must be inert and complete must memoize+freeze");
    need(e.absorptionInvariant, "③ the rounding residual must be absorbed so the six buckets re-sum to totalMs");
    need(e.retryVsRequest, "④ sampling retries must count separately from sampling requests");

    return errs;
  },
};
