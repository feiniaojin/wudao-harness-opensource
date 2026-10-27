// 夜移 026 — sleep 工具 (Strands vended_tools/sleep 移植 + unref 修补).
// The model needs a bounded, permission-free temporal wait (background
// process progress, rate-limit backoff) — the alternative is a shell
// `shell("sleep 30")` that rides the full permission pipeline.
// Strands contract: factory validates the cap, execute validates the
// duration BEFORE sleeping, cancellation wins. The wudao additions: the
// timer is unref'd (an aborted/abandoned sleep never holds a headless
// process open — JS has no cooperative task cancellation to clear it),
// and the description steers file-waits to monitor_read (夜移 020).
//
// ω99-101 timing discipline: every time-based verdict rides an injected
// clock (vi fake timers faking exactly setTimeout/clearTimeout/Date —
// the only time sources the tool touches), never the wall clock. A
// parallel full-suite run under machine-load jitter must produce the
// same verdicts as an idle single-file run: the elapsed figure the tool
// reports is a function of the faked clock, so "Slept 0.01s" is exact,
// not a race against scheduler delay. No real waits remain, so there is
// nothing left to sequentialize or tolerate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSleepTool, SLEEP_DEFAULT_MAX_SECONDS } from "../src/tools/sleep.js";
import { normalizeToolArguments, validateToolArguments } from "../src/tool.js";

describe("sleep tool (夜移 026)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Drive one execute() under the faked clock: the call starts, its
  // setTimeout(resolve, Math.round(seconds*1000)) registers on the fake
  // clock, we advance by exactly that duration, the timer fires, and the
  // reported elapsed is exactly `seconds`. Advancing mirrors the tool's
  // own rounding so the timer is due — never early, never late.
  async function executeAdvancing<T>(run: () => Promise<T>, seconds: number): Promise<T> {
    const pending = run();
    await vi.advanceTimersByTimeAsync(Math.round(seconds * 1000));
    return pending;
  }

  it("A: factory rejects a non-positive, non-finite, or boolean max", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, true, "60"]) {
      expect(() => createSleepTool({ maxSeconds: bad as number })).toThrow();
    }
  });

  it("B: a normal sleep resolves with the measured elapsed time", async () => {
    const tool = createSleepTool({});
    const r = await executeAdvancing(() => tool.execute({ seconds: 0.01 }), 0.01);
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/^Slept 0\.0\d+s$/);
  });

  it("C: a negative duration is rejected before any sleep", async () => {
    const tool = createSleepTool({});
    const r = await tool.execute({ seconds: -1 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("non-negative");
  });

  it("D: an over-cap duration is rejected with the cap named in the message", async () => {
    const tool = createSleepTool({});
    const r = await tool.execute({ seconds: SLEEP_DEFAULT_MAX_SECONDS + 1 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(String(SLEEP_DEFAULT_MAX_SECONDS));
  });

  it("E: zero seconds is allowed (Strands accepts non-negative)", async () => {
    const tool = createSleepTool({});
    const r = await executeAdvancing(() => tool.execute({ seconds: 0 }), 0);
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/^Slept 0\.0\d+s$/);
  });

  it("F: direct execute calls with non-number durations are refused defensively", async () => {
    const tool = createSleepTool({});
    for (const bad of ["3", true, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await tool.execute({ seconds: bad as unknown as number });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("number");
    }
  });

  it("G: the M47 normalization layer repairs string durations through the full dispatch path", async () => {
    const tool = createSleepTool({});
    const { args, normalized } = normalizeToolArguments(tool.parameters, { seconds: "0.01" });
    expect(normalized).toContain("seconds");
    const validation = validateToolArguments(tool.parameters, args, tool.name);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      const r = await executeAdvancing(() => tool.execute(validation.args), 0.01);
      expect(r.isError).toBeUndefined();
    }
  });

  it("H: risk annotations are explicit — read-only, concurrency-safe, not destructive, not open-world", () => {
    const tool = createSleepTool({});
    expect(tool.isReadOnly?.({ seconds: 5 })).toBe(true);
    expect(tool.isConcurrencySafe?.({ seconds: 5 })).toBe(true);
    expect(tool.isDestructive?.({ seconds: 5 })).toBe(false);
    expect(tool.isOpenWorld?.({ seconds: 5 })).toBe(false);
  });

  it("I: the description names the cap and steers file-waits to monitor_read", () => {
    const tool = createSleepTool({});
    expect(tool.description).toContain(String(SLEEP_DEFAULT_MAX_SECONDS));
    expect(tool.description).toContain("monitor_read");
    // No timeoutMs: the duration cap is validated pre-sleep; a second
    // deadline would be redundant.
    expect(tool.timeoutMs).toBeUndefined();
  });

  it("J: a custom cap is honored — over rejected naming it, at-cap accepted", async () => {
    const capped = createSleepTool({ maxSeconds: 5 });
    const over = await capped.execute({ seconds: 6 });
    expect(over.isError).toBe(true);
    expect(over.content).toContain("5");
    // At-cap acceptance without a wall-clock cost: a tiny custom cap,
    // resolved on the faked clock (no 50ms real sleep per run).
    const tiny = createSleepTool({ maxSeconds: 0.05 });
    const at = await executeAdvancing(() => tiny.execute({ seconds: 0.05 }), 0.05);
    expect(at.isError).toBeUndefined();
    expect(at.content).toMatch(/^Slept 0\.0\d+s$/);
  });
});
