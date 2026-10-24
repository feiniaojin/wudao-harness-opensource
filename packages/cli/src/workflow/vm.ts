// M29 §1 — the JS workflow script VM.
//
// A workflow is a plain JavaScript program (the file's text is the BODY of an
// async function), not a DSL: loops, conditionals, matrices and dynamic work
// lists come free from the language. The engine injects seven primitives as
// function parameters — task / parallel / pipeline / log / workflow / args /
// budget (the CCB workflow-engine `script.ts` paradigm) — and prepends a
// determinism tripwire prologue that shadows `Date` and `Math.random` with
// throwing stubs. The tripwire CATCHES nondeterminism (a script that reads
// the clock or rolls dice fails loudly instead of forking replay); it is NOT
// isolation — the script still runs with full JS capability in-process.
// Scripts must take time and randomness in via `args`; that discipline is
// what makes journal replay sound (CodeWhale enforces the same).
import type { JsonSchemaSubset } from "./structured-output.js";
import type { VerifySpec } from "./scorers.js";

// ---------------------------------------------------------------------------
// Contracts shared by the VM surface and the engine that implements it.
// ---------------------------------------------------------------------------

/** Tokens consumed by one task (prompt + completion), from the provider usage channel. */
export interface TaskCost {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** The M29 failure taxonomy (CCB dead.reason + budget/verify/abort). M56 §5
 *  adds `preflight-refused`: the route was refused AT ADMISSION (provider /
 *  key / model / budget) with no model call spent. 133 #3 adds
 *  `purity-violation`: same-identity replay saw a task key drift at a seq
 *  position — the script is nondeterministic past the tripwire (ZCode
 *  inputHash 防御校验的 wudao 形：绝不静默偏移). */
export type FailureCategory =
  | "no-structured-output"
  | "invalid-structured-output"
  | "task-threw"
  | "budget-exhausted"
  | "verify-failed"
  | "preflight-refused"
  | "purity-violation"
  | "aborted";

export interface TaskFailure {
  readonly category: FailureCategory;
  readonly message: string;
}

/** Deterministic scorer receipts (CodeWhale §3.3). M56 §4 adds the two
 *  evidence-fault classes: `transport` (the worker transport reported no
 *  process result — not the task's fault) and `verifier` (the SCORER itself
 *  is broken, e.g. a regex that does not compile). Neither fails the task
 *  and neither counts as evidence for it. `partial` is reserved for future
 *  manual/verifier-prompt scorers — the built-ins never emit it. */
export type VerifyStatus = "pass" | "fail" | "skip" | "timeout" | "partial" | "transport" | "verifier";

/** M56 §4 (CodeWhale task_spec): success without evidence is a 0.5 PARTIAL,
 *  never a pass. A receipt set counts as evidence only when at least one
 *  receipt speaks to the work (pass/fail/timeout); skip/transport/verifier
 *  receipts and absent scorers leave the success unevidenced. */
export const PARTIAL_EVIDENCE_SCORE = 0.5;
export type TaskEvidence = "verified" | "partial";

/** The evidence score of a successful task: 1 when at least one receipt is
 *  evidential, 0.5 (partial) when none is — or when no scorers ran at all. */
export function evidenceScore(receipts: readonly VerifyReceipt[] | undefined): 0.5 | 1 {
  if (receipts === undefined || receipts.length === 0) return PARTIAL_EVIDENCE_SCORE;
  const evidential = receipts.some((r) => r.status === "pass" || r.status === "fail" || r.status === "timeout");
  return evidential ? 1 : PARTIAL_EVIDENCE_SCORE;
}

export interface VerifyReceipt {
  readonly kind: string;
  readonly status: VerifyStatus;
  readonly detail?: string;
}

export interface TaskOptions {
  /** Display-only label; EXCLUDED from the journal key (like CCB label/phase). */
  readonly label?: string;
  /** Tool whitelist for this task (default: the read-only set). */
  readonly allowTools?: readonly string[];
  readonly maxTurns?: number;
  /** Structured-output contract: validated at the engine boundary. */
  readonly responseSchema?: JsonSchemaSubset;
  /** Deterministic scorers evaluated after the run; any fail/timeout fails the task. */
  readonly verify?: readonly VerifySpec[];
  /** Retries after a failed attempt (default 1 = one retry, two attempts). */
  readonly retry?: number;
  /** ω-4c §3.6: model ROUTING LABEL (not a client) — resolved via
   *  JsflowOptions.taskModels at spawn; absent/unmapped falls back to the run
   *  model. Part of the canonical task key: a task's identity includes which
   *  model ran it, so switching the auditor model forks old entries correctly. */
  readonly model?: string;
}

export type TaskResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** Parsed + validated structured output (present when responseSchema was set). */
      readonly data?: unknown;
      readonly toolsUsed: readonly string[];
      readonly cost: TaskCost;
      readonly verify?: readonly VerifyReceipt[];
      /** M56 §4: "verified" when at least one evidential receipt backs the
       *  success, "partial" when none does (no scorers, or only skip/
       *  transport/verifier receipts) — a no-evidence success is a 0.5
       *  partial, never a pass. */
      readonly evidence?: TaskEvidence;
    }
  | {
      readonly ok: false;
      readonly text: string;
      readonly toolsUsed: readonly string[];
      readonly cost: TaskCost;
      readonly failure: TaskFailure;
    };

export interface ParallelFailure {
  readonly index: number;
  readonly category: FailureCategory;
  readonly message: string;
}

export interface ParallelResult<T> {
  /** Slot values in call/yield order; a failed slot is null. */
  readonly results: readonly (T | null)[];
  readonly failures: readonly ParallelFailure[];
}

export interface BudgetView {
  readonly total: number;
  readonly spent: number;
  readonly remaining: number;
}

export interface VmPrimitives {
  readonly task: (prompt: string, opts?: TaskOptions) => Promise<TaskResult>;
  readonly parallel: <T>(fns: readonly (() => Promise<T> | T)[], opts?: { limit?: number }) => Promise<ParallelResult<T>>;
  readonly pipeline: <T>(gen: AsyncIterable<() => Promise<T> | T>, opts?: { limit?: number }) => Promise<ParallelResult<T>>;
  /** M11 #2（ZCode world.run 形）：脚本级确定性命令门。非零退出码是正常
   *  返回（门控循环的常态——检查失败是数据不是异常）；超时/spawn 失败也
   *  是正常返回的字段（门控循环需要看到这些事实）。无 shell：args 数组
   *  直传（无管道/重定向/变量展开）。命令必须在调用方授予的允许清单内
   *  （能力≠策略——脚本声明能力，调用方在确认时授予命令集）。journaled
   *  效应：重放零进程派生。 */
  readonly run: (cmd: string, args?: readonly string[], opts?: RunOpts) => Promise<RunResult>;
  /** ω-4c: returns the journal-append promise (fire-and-forget for scripts —
   *  the pre-ω-4c `void` behavior; MEA awaits it so its state records land
   *  before the run's terminal records). */
  readonly log: (obj: unknown) => Promise<void>;
  readonly workflow: (name: string, args?: unknown) => Promise<unknown>;
  readonly budget: BudgetView;
}

/** M11 #2 — run() 的可选面。timeoutMs 上限 120s（缺省 30s）。 */
export interface RunOpts {
  readonly timeoutMs?: number;
}

/** M11 #2 — run() 的返回形。一切结局都是数据：退出码/超时/spawn 失败
 *  原因——门控循环用纯脚本逻辑分支，失败交给 task() 的 agent 修。 */
export interface RunResult {
  /** 进程退出码（超时/spawn 失败时 undefined）。 */
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** spawn 失败的原因（命令不在允许清单时为拒绝原因串）。 */
  readonly spawnError?: string;
}

// ---------------------------------------------------------------------------
// Fatal errors — budget exhaustion and user abort fail the RUN, not a slot.
// parallel/pipeline rethrow these instead of degrading them to null.
// ---------------------------------------------------------------------------

export class RunFatalError extends Error {}

/** Exported under its probe name for tests; the real budget lives in budget.ts. */
export class BudgetExhaustedProbe extends RunFatalError {}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 16;
export const MAX_ITEMS_PER_CALL = 4096;

/** A FIFO semaphore with permit handoff: `release()` transfers the permit
 *  directly to the first waiter (the available count never rises past the
 *  waiters), so permits cannot be lost or double-counted (CCB concurrency.ts). */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (available > 0) {
        available -= 1;
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next(); // handoff: the permit moves without passing through `available`
      } else {
        available += 1;
      }
    },
  };
}

export function clampLimit(limit: number | undefined): number {
  const requested = limit ?? DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, requested));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A task-shaped result that failed — parallel/pipeline degrade it to null +
 *  a failures entry so one bad task cannot take down the fan-out. */
function failedTaskFailure(value: unknown): TaskFailure | undefined {
  if (typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false) {
    const failure = (value as { failure?: TaskFailure }).failure;
    if (failure !== undefined) return failure;
  }
  return undefined;
}

async function settleSlot<T>(
  sem: Semaphore,
  fn: () => Promise<T> | T,
  index: number,
  results: (T | null)[],
  failures: ParallelFailure[],
): Promise<RunFatalError | undefined> {
  await sem.acquire();
  try {
    const value = await fn();
    const failed = failedTaskFailure(value);
    if (failed !== undefined) {
      results[index] = null;
      failures.push({ index, category: failed.category, message: failed.message });
    } else {
      results[index] = value;
    }
  } catch (err) {
    if (err instanceof RunFatalError) return err;
    results[index] = null;
    failures.push({ index, category: "task-threw", message: messageOf(err) });
  } finally {
    sem.release();
  }
  return undefined;
}

/** parallel([...fns], {limit}) — barrier fan-out with allSettled semantics:
 *  every thunk runs (bounded by `limit`); a thunk that throws or resolves to a
 *  failed task result becomes null for its slot plus a `failures` entry, and
 *  the call itself NEVER rejects — except for run-fatal budget/abort errors. */
export async function runParallel<T>(
  fns: readonly (() => Promise<T> | T)[],
  opts?: { limit?: number },
): Promise<ParallelResult<T>> {
  if (fns.length > MAX_ITEMS_PER_CALL) {
    throw new Error(`parallel: ${fns.length} items exceeds the cap of ${MAX_ITEMS_PER_CALL}`);
  }
  const limit = clampLimit(opts?.limit);
  const sem = createSemaphore(limit);
  const results: (T | null)[] = new Array<T | null>(fns.length).fill(null);
  const failures: ParallelFailure[] = [];
  const settled = await Promise.all(
    fns.map((fn, index) => settleSlot(sem, fn, index, results, failures)),
  );
  const fatal = settled.find((err): err is RunFatalError => err !== undefined);
  if (fatal !== undefined) throw fatal;
  return { results, failures };
}

/** pipeline(gen) — no-barrier streaming. `gen` yields thunks lazily; each is
 *  started as soon as a slot (≤ limit) is free, so PRODUCTION of work overlaps
 *  EXECUTION of earlier items — a generator can itself await tasks to decide
 *  what to yield next while earlier items are still in flight. Slot semantics
 *  match parallel (failure → null + failures entry; fatal errors reject). */
export async function runPipeline<T>(
  gen: AsyncIterable<() => Promise<T> | T>,
  opts?: { limit?: number },
): Promise<ParallelResult<T>> {
  const limit = clampLimit(opts?.limit);
  const sem = createSemaphore(limit);
  const results: (T | null)[] = [];
  const failures: ParallelFailure[] = [];
  const pending = new Set<Promise<RunFatalError | undefined>>();
  const iterator = gen[Symbol.asyncIterator]();
  let index = 0;
  let exhausted = false;

  const startNext = async (thunk: () => Promise<T> | T): Promise<void> => {
    const i = index;
    index += 1;
    results.push(null); // reserve the slot in yield order
    const p = settleSlot(sem, thunk, i, results, failures).finally(() => {
      pending.delete(p);
    });
    pending.add(p);
  };

  while (!exhausted) {
    while (!exhausted && pending.size < limit) {
      const next = await iterator.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      await startNext(next.value);
    }
    if (!exhausted && pending.size >= limit) {
      await Promise.race(pending);
    }
  }
  const settled = await Promise.all([...pending]);
  const fatal = settled.find((err): err is RunFatalError => err !== undefined);
  if (fatal !== undefined) throw fatal;
  return { results, failures };
}

// ---------------------------------------------------------------------------
// Script compilation: AsyncFunction body + determinism tripwire prologue.
// ---------------------------------------------------------------------------

// Shadowed bindings for the script body. `const` at function-body top shadows
// the globals for the whole body; the original Math is captured BEFORE the
// shadowing const's initializer would hit its own temporal dead zone.
const SANDBOX_PROLOGUE = `
const __wudaoSandboxThrow = (name) => {
  throw new Error("workflow script used " + name + " — determinism sandbox: pass time/randomness in via args");
};
const Date = Object.assign(function Date() { __wudaoSandboxThrow("Date"); }, {
  now: () => __wudaoSandboxThrow("Date.now"),
  parse: () => __wudaoSandboxThrow("Date.parse"),
  UTC: () => __wudaoSandboxThrow("Date.UTC"),
});
const __wudaoMath = globalThis.Math;
const Math = Object.create(__wudaoMath, { random: { value: () => __wudaoSandboxThrow("Math.random") } });
`;

/** Static checks with model-facing error text (the #1 script-error causes are
 *  named up front, CCB assertScriptBody). Simple lexical checks — a string
 *  containing `import (` will false-positive, which is the documented cost. */
export function assertScriptBody(source: string): void {
  if (/\bimport\s*\(/.test(source)) {
    throw new Error("workflow script cannot use dynamic import() — workflows are single-file programs");
  }
  if (/^\s*import\b/m.test(source)) {
    throw new Error("workflow script cannot use import statements — everything it needs is injected (task, parallel, pipeline, log, workflow, args, budget)");
  }
  if (/\bexport\s+(const|let|var|function|async|class|default|type|interface|\{|\*)/.test(source)) {
    throw new Error("workflow script cannot use export statements — use `return` to produce the run result");
  }
}

/** A compiled workflow script: call it with the engine primitives and `args`. */
export type CompiledScript = (primitives: VmPrimitives, args: unknown) => Promise<unknown>;

// AsyncFunction is not a global TS type; reach the constructor through the
// prototype of an async function literal (the only reliable way in ESM).
const AsyncFunctionConstructor: new (...args: string[]) => (...args: unknown[]) => Promise<unknown> =
  Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

export function compileScript(source: string): CompiledScript {
  assertScriptBody(source);
  const fn = new AsyncFunctionConstructor(
    "task",
    "parallel",
    "pipeline",
    // M11 #2: the script-level command gate primitive (ZCode world.run 形).
    "run",
    "log",
    "workflow",
    "args",
    "budget",
    SANDBOX_PROLOGUE + source,
  );
  return async (primitives: VmPrimitives, args: unknown): Promise<unknown> =>
    fn(
      primitives.task,
      primitives.parallel,
      primitives.pipeline,
      primitives.run,
      primitives.log,
      primitives.workflow,
      args,
      primitives.budget,
    );
}
