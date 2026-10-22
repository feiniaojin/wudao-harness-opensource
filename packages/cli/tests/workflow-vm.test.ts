import { describe, it, expect, vi } from "vitest";
import {
  compileScript,
  assertScriptBody,
  createSemaphore,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_ITEMS_PER_CALL,
  type VmPrimitives,
  type TaskResult,
} from "../src/workflow/vm.js";

// ---------------------------------------------------------------------------
// FakeDriver seam (the upstream format): the VM is testable without a model — primitives
// are injected, so tests hand it deterministic fakes.
// ---------------------------------------------------------------------------

const okTask = (text: string): TaskResult => ({
  ok: true, text, toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 },
});

function primitives(over: Partial<VmPrimitives> = {}): VmPrimitives {
  return {
    task: vi.fn(async (prompt: string) => okTask(`ran:${prompt}`)),
    parallel: undefined as never, // filled by the VM's own parallel below
    pipeline: undefined as never,
    log: vi.fn(),
    workflow: vi.fn(async (name: string) => `child:${name}`),
    budget: { total: 500_000, spent: 0, remaining: 500_000 },
    ...over,
  };
}

// The real parallel/pipeline implementations, bound like the engine binds them.
import { runParallel, runPipeline } from "../src/workflow/vm.js";

function withRealConcurrency(p: Partial<VmPrimitives> = {}): VmPrimitives {
  const base = primitives(p);
  return {
    ...base,
    parallel: (fns, opts) => runParallel(fns, opts),
    pipeline: (gen, opts) => runPipeline(gen, opts),
  };
}

async function runScript(source: string, p: VmPrimitives = withRealConcurrency(), args?: unknown): Promise<unknown> {
  return compileScript(source)(p, args);
}

// ---------------------------------------------------------------------------
// Sandbox: Date / Math.random throw; the rest of Math still works.
// ---------------------------------------------------------------------------

describe("determinism sandbox", () => {
  it("new Date() (argless) throws the sandbox error", async () => {
    await expect(runScript("return new Date();")).rejects.toThrow(/Date.*determinism|determinism.*Date/i);
  });
  it("Date.now() throws", async () => {
    await expect(runScript("return Date.now();")).rejects.toThrow(/determinism/i);
  });
  it("new Date(123) throws too (Date is a stub, not a passthrough)", async () => {
    await expect(runScript("return new Date(123);")).rejects.toThrow(/determinism/i);
  });
  it("Date.parse throws with the named API in the message", async () => {
    await expect(runScript("return Date.parse('2026-01-01');")).rejects.toThrow(/Date\.parse/);
  });
  it("Math.random() throws", async () => {
    await expect(runScript("return Math.random();")).rejects.toThrow(/Math\.random/);
  });
  it("Math.floor / Math.max still work (only random is stubbed)", async () => {
    await expect(runScript("return [Math.floor(1.7), Math.max(1, 2)];")).resolves.toEqual([1, 2]);
  });
  it("timestamps passed via args reach the script", async () => {
    await expect(runScript("return args.now;", withRealConcurrency(), { now: 1726000000000 })).resolves.toBe(1726000000000);
  });
});

// ---------------------------------------------------------------------------
// Script compilation & validation
// ---------------------------------------------------------------------------

describe("assertScriptBody", () => {
  it("accepts a normal script body", () => {
    expect(() => assertScriptBody("const a = 1;\nreturn a;")).not.toThrow();
  });
  it("rejects static import", () => {
    expect(() => assertScriptBody("import fs from 'node:fs';")).toThrow(/import/);
  });
  it("rejects bare import", () => {
    expect(() => assertScriptBody("import 'x';")).toThrow(/import/);
  });
  it("rejects dynamic import()", () => {
    expect(() => assertScriptBody("const m = await import('node:fs');")).toThrow(/import\(\)/);
  });
  it("rejects export statements", () => {
    expect(() => assertScriptBody("export const meta = {};")).toThrow(/export/);
    expect(() => assertScriptBody("export default 1;")).toThrow(/export/);
  });
});

describe("compileScript", () => {
  it("awaits task and gets its result object; the script's return value propagates", async () => {
    const p = withRealConcurrency();
    const out = await runScript("const r = await task('do it');\nreturn { saw: r.text, ok: r.ok };", p);
    expect(out).toEqual({ saw: "ran:do it", ok: true });
    expect(p.task).toHaveBeenCalledWith("do it");
  });
  it("task options pass through verbatim", async () => {
    const p = withRealConcurrency();
    await runScript("await task('p', { label: 'a', allowTools: ['grep'], maxTurns: 2, retry: 0 });", p);
    expect(p.task).toHaveBeenCalledWith("p", { label: "a", allowTools: ["grep"], maxTurns: 2, retry: 0 });
  });
  it("log() and budget are reachable; workflow() resolves the child value", async () => {
    const p = withRealConcurrency();
    const out = await runScript(
      "log({ note: 'hi' }); const child = await workflow('child', { x: 1 }); return [budget.remaining, budget.total, child];",
      p,
    );
    expect(out).toEqual([500_000, 500_000, "child:child"]);
    expect(p.log).toHaveBeenCalledWith({ note: "hi" });
    expect(p.workflow).toHaveBeenCalledWith("child", { x: 1 });
  });
  it("plain JS control flow works (loop + branch + array map)", async () => {
    const p = withRealConcurrency();
    const out = await runScript(
      "const out = [];\nfor (let i = 0; i < 3; i++) { const r = await task('t' + i); if (r.ok) out.push(r.text); }\nreturn out;",
      p,
    );
    expect(out).toEqual(["ran:t0", "ran:t1", "ran:t2"]);
    expect(p.task).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// parallel: barrier, allSettled semantics, bounded concurrency
// ---------------------------------------------------------------------------

describe("runParallel", () => {
  it("awaits all thunks and returns values in slot order (barrier)", async () => {
    const out = await runParallel([
      async () => "a",
      async () => "b",
      async () => "c",
    ]);
    expect(out.results).toEqual(["a", "b", "c"]);
    expect(out.failures).toEqual([]);
  });

  it("a throwing thunk → null slot + failures entry; the call never rejects", async () => {
    const out = await runParallel([
      async () => "kept",
      async () => { throw new Error("boom"); },
    ]);
    expect(out.results).toEqual(["kept", null]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ index: 1, category: "task-threw", message: expect.stringContaining("boom") });
  });

  it("a thunk resolving to a failed task result → null + its failure category", async () => {
    const failed: TaskResult = {
      ok: false, text: "", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 },
      failure: { category: "verify-failed", message: "scorer said no" },
    };
    const out = await runParallel([async () => okTask("fine"), async () => failed]);
    expect(out.results).toEqual([{ ok: true, text: "fine", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 } }, null]);
    expect(out.failures[0]).toMatchObject({ index: 1, category: "verify-failed" });
  });

  it("bounds concurrent thunks to limit (default 3)", async () => {
    let inFlight = 0;
    let peak = 0;
    const thunk = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return "x";
    };
    const out = await runParallel(Array.from({ length: 7 }, () => thunk));
    expect(out.results).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("honors {limit} above the default and clamps to the hard cap 16", async () => {
    let inFlight = 0;
    let peak = 0;
    const mk = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    };
    await runParallel(Array.from({ length: 20 }, mk), { limit: 8 });
    expect(peak).toBeLessThanOrEqual(8);
    // limit above the cap collapses to 16
    let peak2 = 0;
    let cur2 = 0;
    await runParallel(
      Array.from({ length: 20 }, () => async () => {
        cur2 += 1;
        peak2 = Math.max(peak2, cur2);
        await new Promise((r) => setTimeout(r, 10));
        cur2 -= 1;
      }),
      { limit: 64 },
    );
    expect(peak2).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });

  it("rejects more than 4096 items (runaway script guard)", async () => {
    const many = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, () => async () => 1);
    await expect(runParallel(many)).rejects.toThrow(/4096/);
  });

  it("fatal errors (budget/abort) propagate and fail the run", async () => {
    const { BudgetExhaustedProbe } = await import("../src/workflow/vm.js");
    const fatal = new BudgetExhaustedProbe("spent");
    const out = runParallel([
      async () => 1,
      async () => { throw fatal; },
      async () => 3,
    ]);
    await expect(out).rejects.toBe(fatal);
  });
});

// ---------------------------------------------------------------------------
// pipeline: no-barrier streaming over a generator of thunks
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  it("streams: pulls the next item while earlier ones are still running (no barrier)", async () => {
    const events: string[] = [];
    async function* gen(): AsyncGenerator<() => Promise<string>> {
      for (let i = 0; i < 3; i++) {
        events.push(`yield:${i}`);
        yield async () => {
          events.push(`start:${i}`);
          await new Promise((r) => setTimeout(r, i === 0 ? 60 : 5)); // item 0 slow
          events.push(`done:${i}`);
          return `done:${i}`;
        };
      }
    }
    const out = await runPipeline(gen());
    expect(out.results).toEqual(["done:0", "done:1", "done:2"]);
    // No barrier: items 1 and 2 start BEFORE item 0 finishes.
    expect(events.indexOf("start:1")).toBeLessThan(events.indexOf("done:0"));
  });

  it("bounds in-flight thunks to the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    async function* gen(): AsyncGenerator<() => Promise<number>> {
      for (let i = 0; i < 8; i++) {
        yield async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 8));
          inFlight -= 1;
          return i;
        };
      }
    }
    const out = await runPipeline(gen(), { limit: 2 });
    expect(out.results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("a failed item → null slot + failure; later items still run", async () => {
    async function* gen(): AsyncGenerator<() => Promise<string>> {
      yield async () => "good";
      yield async () => { throw new Error("item died"); };
      yield async () => "also good";
    }
    const out = await runPipeline(gen());
    expect(out.results).toEqual(["good", null, "also good"]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ index: 1 });
  });

  it("a fatal error fails the whole pipeline", async () => {
    const { BudgetExhaustedProbe } = await import("../src/workflow/vm.js");
    const fatal = new BudgetExhaustedProbe("gone");
    async function* gen(): AsyncGenerator<() => Promise<number>> {
      yield async () => 1;
      yield async () => { throw fatal; };
    }
    await expect(runPipeline(gen())).rejects.toBe(fatal);
  });
});

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

describe("createSemaphore", () => {
  it("hands permits to waiters in FIFO order without losing count", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];
    const job = async (n: number) => {
      await sem.acquire();
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      sem.release();
    };
    await Promise.all([job(1), job(2), job(3)]);
    expect(order).toEqual([1, 2, 3]);
    // all released → one permit available again
    await sem.acquire();
    sem.release();
  });
});
