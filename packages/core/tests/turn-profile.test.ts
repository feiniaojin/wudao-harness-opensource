// 夜移 035 — 回合相位计时（the upstream project/core/src/turn_timing.rs 移植）。
// wudao 有缓存取证（M24 hit/miss 字节断言）无延迟取证——「这回合为何
// 90s」不可答。六桶相位状态机：首采前（排队/投影） / 采样（模型流） /
// 压缩 / 工具阻塞（gate+执行） / 采间开销（恢复梯/注记/批次钩子） /
// 尾闲（末采后收尾）。语义钉：转换点归账当前相（advance）；嵌套 begin
// 惰性（活动相不换）；complete 幂等且冻结；舍入残差吸入终相（the upstream project尾相
// 吸收取整）；时钟回退饱和为零；重试计数独立于请求计数。
import { describe, it, expect } from "vitest";
import { createTurnProfileRecorder } from "../src/turn-profile.js";

/** Manual clock: the test moves time explicitly; durations are exact. */
function manualClock(): { now(): number; recorder: ReturnType<typeof createTurnProfileRecorder>; set(t: number): void } {
  let t = 0;
  const r = createTurnProfileRecorder(() => t);
  return { now: () => t, recorder: r, set: (v: number) => { t = v; } };
}

describe("夜移 035 — turn profile: six-bucket phase accounting (the upstream project turn_timing.rs)", () => {
  it("single sampling round: before / sampling / after split at exact transitions", () => {
    const c = manualClock();
    c.set(0);
    c.recorder.markTurnStarted();
    c.set(10);
    const s = c.recorder.beginSampling();
    c.set(110);
    s.end();
    c.set(150);
    const p = c.recorder.complete();
    expect(p.beforeFirstSamplingMs).toBe(10);
    expect(p.samplingMs).toBe(100);
    expect(p.afterLastSamplingMs).toBe(40);
    expect(p.compactionMs).toBe(0);
    expect(p.toolBlockingMs).toBe(0);
    expect(p.betweenSamplingOverheadMs).toBe(0);
    expect(p.totalMs).toBe(150);
    expect(p.samplingRequestCount).toBe(1);
    expect(p.samplingRetryCount).toBe(0);
  });

  it("sampling → tools → sampling: tool time its own bucket, nothing in between-overhead", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    c.set(10);
    const s1 = c.recorder.beginSampling();
    c.set(110);
    s1.end();
    const tool = c.recorder.beginToolBlocking();
    c.set(160);
    tool.end();
    const s2 = c.recorder.beginSampling();
    c.set(200);
    s2.end();
    c.set(250);
    const p = c.recorder.complete();
    expect(p.beforeFirstSamplingMs).toBe(10);
    expect(p.samplingMs).toBe(140); // 100 + 40
    expect(p.toolBlockingMs).toBe(50);
    expect(p.betweenSamplingOverheadMs).toBe(0);
    expect(p.afterLastSamplingMs).toBe(50);
    expect(p.samplingRequestCount).toBe(2);
    expect(p.totalMs).toBe(250);
  });

  it("idle BETWEEN two sampling rounds lands in between-overhead, the tail in after", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s1 = c.recorder.beginSampling(); // t=0
    c.set(100);
    s1.end();
    c.set(150); // idle 50 — becomes between-overhead when sampling #2 begins
    const s2 = c.recorder.beginSampling();
    c.set(200);
    s2.end();
    c.set(220);
    const p = c.recorder.complete();
    expect(p.betweenSamplingOverheadMs).toBe(50);
    expect(p.afterLastSamplingMs).toBe(20);
    expect(p.beforeFirstSamplingMs).toBe(0);
  });

  it("compaction is its own bucket (its internal LLM time rides with it)", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s1 = c.recorder.beginSampling();
    c.set(100);
    s1.end();
    const comp = c.recorder.beginCompaction();
    c.set(200);
    comp.end();
    const s2 = c.recorder.beginSampling();
    c.set(260);
    s2.end();
    c.set(300);
    const p = c.recorder.complete();
    expect(p.compactionMs).toBe(100);
    expect(p.samplingMs).toBe(160);
    expect(p.afterLastSamplingMs).toBe(40);
  });

  it("a NESTED begin while a phase is active is inert — accounting untouched", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s = c.recorder.beginSampling();
    c.set(50);
    const nested = c.recorder.beginCompaction(); // active sampling → inert guard
    c.set(80);
    nested.end(); // no-op: not the active phase
    c.set(100);
    s.end();
    c.set(120);
    const p = c.recorder.complete();
    expect(p.samplingMs).toBe(100); // 0→100 uninterrupted
    expect(p.compactionMs).toBe(0);
    expect(p.totalMs).toBe(120);
  });

  it("complete is idempotent and FREEZES the machine: later guards are inert", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s = c.recorder.beginSampling();
    c.set(100);
    s.end();
    c.set(150);
    const first = c.recorder.complete();
    // post-complete noise must not move anything
    const late = c.recorder.beginSampling();
    late.end();
    const second = c.recorder.complete();
    expect(second).toEqual(first);
    expect(second.samplingMs).toBe(100);
    expect(second.afterLastSamplingMs).toBe(50);
  });

  it("rounding residual (floor truncation) is absorbed into the FINAL phase bucket", () => {
    // fractional clock: floor-per-bucket truncation leaves a residual that
    // the upstream project's complete() adds back into the final active bucket
    let t = 0;
    const r = createTurnProfileRecorder(() => t);
    r.markTurnStarted();
    t = 10.5;
    const s = r.beginSampling();
    t = 21.2;
    s.end();
    t = 30.9;
    const p = r.complete();
    // total = floor(30.9) = 30; sampling = floor(10.7)=10; after=floor(9.7)=9;
    // residual 1 → absorbed into the final bucket (idle after sampling)
    expect(p.totalMs).toBe(30);
    expect(p.samplingMs).toBe(10);
    expect(p.afterLastSamplingMs).toBe(10);
    // and the six buckets always re-sum to the total (the absorption invariant)
    expect(
      p.beforeFirstSamplingMs + p.samplingMs + p.compactionMs
      + p.betweenSamplingOverheadMs + p.toolBlockingMs + p.afterLastSamplingMs,
    ).toBe(p.totalMs);
  });

  it("a clock that steps BACKWARDS saturates to zero elapsed — no negative buckets", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s = c.recorder.beginSampling();
    c.set(100);
    c.set(40); // clock steps back mid-phase
    s.end();
    const p = c.recorder.complete();
    expect(p.samplingMs).toBeGreaterThanOrEqual(0);
    expect(p.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("sampling retries count separately from requests", () => {
    const c = manualClock();
    c.recorder.markTurnStarted();
    const s = c.recorder.beginSampling();
    c.recorder.recordSamplingRetry();
    c.recorder.recordSamplingRetry();
    c.set(50);
    s.end();
    const p = c.recorder.complete();
    expect(p.samplingRequestCount).toBe(1);
    expect(p.samplingRetryCount).toBe(2);
  });

  it("before markTurnStarted every begin is inert (the upstream project started_at gate)", () => {
    const r = createTurnProfileRecorder();
    const s = r.beginSampling();
    s.end();
    const p = r.complete();
    expect(p.totalMs).toBe(0);
    expect(p.samplingRequestCount).toBe(0);
  });
});
