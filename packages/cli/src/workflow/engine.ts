// M29 §1-§3 — the JS workflow engine. Compiles a script (or an M22 adapter
// plan), injects the seven primitives, and drives every `task()` through the
// agent loop with: content-addressed journal replay (resume = zero model
// calls on a hit; key mismatch = edit-point truncation), the shared token
// budget, retry-once with the failure taxonomy, deterministic scorers and
// structured-output validation at the engine boundary. The run lands a
// terminal state.json and GCs old runs.
//
// Determinism lives here, not in the model: the script cannot read the clock
// or roll dice (vm tripwire), and every model-affecting input is part of the
// journal key.
import { runAgentLoop, type LoopEvent, type ModelClient, type PermissionDecision, type Terminal } from "@wudao-org/core";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { buildToolSet } from "../tools.js";
import { buildSystemPrompt } from "../prompt.js";
import { DEFAULT_STEP_TOOLS, parseWorkflow, substituteStepRefs } from "./schema.js";
import {
  clampLimit,
  compileScript,
  createSemaphore,
  evidenceScore,
  runParallel,
  runPipeline,
  type BudgetView,
  type ParallelResult,
  type Semaphore,
  type TaskCost,
  type TaskEvidence,
  type TaskFailure,
  type TaskOptions,
  type TaskResult,
  type VerifyReceipt,
  type VmPrimitives,
  type RunResult,
} from "./vm.js";
import { extractStructuredOutput, validateJsonSchemaSubset, type JsonSchemaSubset } from "./structured-output.js";
import { evaluateVerifySpecs, type VerifySpec } from "./scorers.js";
import { BudgetExhaustedError, createBudget, DEFAULT_BUDGET_TOKENS, type Budget } from "./budget.js";
import {
  gcWorkflowRuns,
  taskKey,
  cmdKey,
  truncateTaskJournal,
  writeWorkflowState,
  type JournalWriter,
  type TaskJournalEntry,
  type CmdJournalEntry,
  type WorkflowRunState,
} from "./journal.js";
// M11 #3：跨 run 导入缓存（第一写关闭规则）。
import { importableEntry, closesImportPool } from "./import-cache.js";
// M11 #2：脚本级命令门的派生面（execFile：无 shell，args 直传）。
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type JsflowEvent =
  | { readonly type: "run-started"; readonly runId: string; readonly workflow: string }
  | { readonly type: "task-started"; readonly seq: number; readonly label: string }
  | { readonly type: "task-finished"; readonly seq: number; readonly label: string; readonly ok: boolean; readonly replayed: boolean; readonly toolsUsed: readonly string[]; readonly cost: TaskCost; readonly failure?: TaskFailure; readonly evidence?: TaskEvidence }
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "journal-truncated"; readonly atSeq: number }
  | { readonly type: "workflow-started"; readonly name: string }
  // ω-4c §3.5: one MEA round closed (the CLI renders the gate matrix line).
  | { readonly type: "mea-round"; readonly round: number; readonly gatesPassing: number; readonly gatesTotal: number; readonly subtask?: string }
  | { readonly type: "run-finished"; readonly ok: boolean; readonly failure?: TaskFailure };

export interface JsflowOptions {
  readonly workspaceRoot: string;
  readonly model: ModelClient;
  readonly journal: JournalWriter;
  readonly workflowName: string;
  /** The script's own path — sub-workflows resolve relative to it. */
  readonly scriptPath?: string;
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
  readonly contextWindowTokens?: number;
  readonly budgetTokens?: number;
  readonly concurrencyLimit?: number;
  /** The `args` global (JSON value; time/randomness enter here). */
  readonly args?: unknown;
  /** Sorted ok-task entries from the journal being resumed. */
  readonly resumeTasks?: readonly TaskJournalEntry[];
  /** M11 #2: completed run() commands from the journal being resumed. */
  readonly resumeCmds?: readonly CmdJournalEntry[];
  /** M11 #2（a reference harness cmd 字面量钉死命令集的 wudao 形）：调用方授予的命令
   *  允许清单（--allow-cmd 旗标积聚）。缺省/不含 → run() 拒绝（fail-
   *  closed，能力≠策略——脚本声明能力，调用方在确认时授予）。 */
  readonly commandAllowlist?: ReadonlySet<string>;
  /** 133 #3（a reference harness journal 身份模型）：本次执行的运行身份（脚本+参数双
   *  哈希）——写入 run-started；与 resumeIdentity 全等时，任务键在 seq 位
   *  漂移 = 纯度违例（大声失败），否则 = 脚本/参数编辑（既有截断语义）。
   *  缺省（适配器路径/旧调用方）不武装，行为逐字节不变。 */
  readonly identity?: { readonly scriptHash: string; readonly argsHash: string; readonly allowHash?: string };
  /** 被恢复日志的原始身份（loadJournal().identity——旧日志无则 undefined，
   *  fail-open 到旧行为）。 */
  readonly resumeIdentity?: { readonly scriptHash: string; readonly argsHash: string; readonly allowHash?: string };
  readonly signal?: AbortSignal;
  /** M56 §5: admission-time route preflight, called before EVERY task spawn.
   *  Returning a reason string refuses the task fast (category
   *  "preflight-refused", ZERO model calls); the default builder lives in
   *  workflow/preflight.ts (local checks only — provider/key/model; the
   *  budget-at-spawn stays the engine's own assertCanSpend, whose exhaustion
   *  is a FATAL run failure, not a per-task refusal the script survives). */
  readonly preflight?: () => string | undefined;
  /** Sub-workflow nesting depth (internal; top-level runs stay 0). */
  readonly depth?: number;
  readonly onEvent?: (e: JsflowEvent) => void;
  readonly now?: () => Date;
  /** ω-4c §3.6: per-task model routing — a TaskOptions.model LABEL resolved
   *  here (falls back to `model` when absent or unmapped). MEA routes its
   *  auditor to the cheap matrix model this way; buildToolSet still receives
   *  the run model (its model param only feeds the filtered-out task tool). */
  readonly taskModels?: ReadonlyMap<string, ModelClient>;
  /** ω-4c §3.4: append the budget advisory line to every task's system
   *  section. Opt-in (the MEA engine sets it) — the js/json-adapter engines
   *  keep byte-identical task prompts, preserving the M22 equivalence pin
   *  against the legacy runner (a file this engine must stay byte-equal to). */
  readonly budgetAdvisory?: boolean;
}

export interface JsflowRunResult {
  readonly ok: boolean;
  /** The script's return value (present when the run succeeded). */
  readonly returnValue?: unknown;
  readonly failure?: TaskFailure;
  readonly tasksTotal: number;
  readonly tasksOk: number;
  readonly tasksReplayed: number;
  /** M56 §4: ok tasks whose success carries no evidential receipt —
   *  0.5-partials, never passes (workloop + workflow expectation rule). */
  readonly tasksPartial: number;
  /** Actual tokens spent by THIS execution (all attempts); the budget is
   *  charged for the final ok attempt only. */
  readonly cost: TaskCost;
}

/** An M22 JSON workflow compiled to task() calls (see planFromWorkflow). */
export interface CompiledPlanStep {
  readonly label: string;
  /** May contain {{step.<id>.output}} references to earlier steps. */
  readonly promptTemplate: string;
  readonly taskOpts: TaskOptions;
}

export interface CompiledPlan {
  readonly name: string;
  readonly steps: readonly CompiledPlanStep[];
}

export interface PlanSourceStep {
  readonly id: string;
  readonly prompt: string;
  readonly allowTools?: readonly string[];
  readonly maxTurns?: number;
  readonly expect?: { readonly toolUsed?: string; readonly outputContains?: string };
}

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

/** State shared by reference across sub-workflows: the call counter, the
 *  replay cursor and the run totals belong to the RUN, not to one script. */
interface SharedState {
  seq: number;
  cursor: number;
  invalidated: boolean;
  /** 133 #3：同身份 resume 的纯度武装——键漂移时大声失败而非截断重跑。 */
  readonly purityArmed: boolean;
  /** M11 #3：首笔写入（带工具的实际执行 or cmd）——关闭导入池的非纯项。 */
  firstWrite: boolean;
  /** M11 #2：task 与 cmd 条目按 seq 合并的统一重放走查（键命名空间隔离
   *  ——task 裸 hex / cmd c: 前缀——同 seq 位异类即漂移）。 */
  readonly replay: readonly (TaskJournalEntry | CmdJournalEntry)[];
  readonly totals: {
    tasksTotal: number;
    tasksOk: number;
    tasksReplayed: number;
    tasksPartial: number;
    promptTokens: number;
    completionTokens: number;
  };
}

interface EngineCtx extends JsflowOptions {
  readonly budget: Budget;
  readonly semaphore: Semaphore;
  readonly shared: SharedState;
  readonly engineName: "js" | "json-adapter" | "mea";
  /** T006 F4：纯度违例的作用域点名——顶层 run 为空串；子工作流为其名。 */
  readonly scopeLabel?: string;
}

// The subagent/task tool is NEVER available inside a workflow task: a
// deterministic script cannot let the model fan out unscoped agents.
const FORBIDDEN_TASK_TOOLS = new Set(["task"]);

const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

/** Thrown by the adapter plan when a step fails (M22 semantics: the run stops
 *  at the first failed step); execute() maps it to a run failure. ω-4c: MEA
 *  reuses it to convert its own terminal decisions into run failures. */
export class PlanStepFailure extends Error {
  constructor(readonly failure: TaskFailure) {
    super(failure.message);
    this.name = "PlanStepFailure";
  }
}

/** 133 #3（a reference harness journal 身份模型，6.1 的 inputHash 防御校验直译）：同一
 *  运行身份（脚本+参数未动）下，任务键在 seq 位漂移 = 脚本在绊线之外
 *  引入了非确定性。绝不静默偏移（重跑会掩盖一个被污染的重放前缀）——
 *  整个 run 大声失败，结构化错误点名 seq 与两个键。T006 F4/F5：子工作
 *  流的漂移点名作用域（否则用户会去查父脚本）；消息带恢复路径。 */
export class WorkflowPurityError extends Error {
  constructor(readonly seq: number, readonly expectedKey: string, readonly gotKey: string, scopeLabel?: string) {
    const scope = scopeLabel !== undefined && scopeLabel !== "" ? ` (in workflow '${scopeLabel}')` : "";
    super(
      `workflow purity violation at call #${seq + 1}${scope}: same script+args produced a different task key ` +
        `(journal ${expectedKey.slice(0, 12)}…, now ${gotKey.slice(0, 12)}…) — the script is nondeterministic past the tripwire ` +
        `(reads files/network/global state?). Fix the script to take the varying value in via args, then rerun fresh. ` +
        `恢复：修好漂移源后 --resume 即命中重放；或改脚本/参数换身份重跑；或删 .wudao/workflows/<runId>.jsonl 全新开始。`,
    );
    this.name = "WorkflowPurityError";
  }
}

const STRUCTURED_OUTPUT_INSTRUCTION = (schema: JsonSchemaSubset): string =>
  `\nCRITICAL: your final answer must be ONLY a fenced ${"```"}json code block containing one JSON ${schema.type ?? "object"} matching the requested shape — no prose before or after.`;

/** Byte-stable with the M22 runner's step section (adapter equivalence hinges
 *  on this); the responseSchema instruction is a trailing, cache-friendly line.
 *  ω-4c §3.4: the budget advisory (when provided) is the LAST trailing line —
 *  `undefined` keeps the section byte-identical to the pre-advisory bytes. */
export function taskSystemSection(
  label: string,
  workflowName: string,
  allowedNames: readonly string[],
  schema: JsonSchemaSubset | undefined,
  advisory?: string,
): string {
  return `

# Workflow step
You are executing step "${label}" of deterministic workflow "${workflowName}". Complete exactly this step's task, then finish with a short final answer.
Tools allowed in this step: ${allowedNames.join(", ")}.` +
    (schema !== undefined ? STRUCTURED_OUTPUT_INSTRUCTION(schema) : "") +
    (advisory !== undefined ? `\n${advisory}` : "");
}

// ---------------------------------------------------------------------------
// ω-4c §3.4 — the budget-aware tool advisory (BAVT broad→focus, book ch10).
// Pure: no clock, no env, no randomness — same inputs → same string. Computed
// once per task at spawn and frozen for the task's duration (byte-stable
// within a task; engine tasks never share a prefix, so no cross-task cache
// expectation is created or broken).
// ---------------------------------------------------------------------------

function formatTokensK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The BAVT phase word for a remaining fraction: broad early, focus late.
 *  Exact boundaries: > 0.60 ample · 0.25 < f ≤ 0.60 moderate · f ≤ 0.25 tight. */
export function budgetPhaseWord(remainingFraction: number): string {
  if (remainingFraction > 0.6) return "ample: broad exploration is affordable";
  if (remainingFraction > 0.25) return "moderate: begin narrowing to the promising directions";
  return "tight: focus on the most promising direction; stop exploring broadly";
}

export function formatBudgetAdvisory(budget: BudgetView, maxTurns?: number): string {
  const fraction = budget.total > 0 ? budget.remaining / budget.total : 0;
  const pct = Math.round(fraction * 100);
  const first = `Budget: ${formatTokensK(budget.spent)}/${formatTokensK(budget.total)} tokens spent · ${pct}% remaining — ${budgetPhaseWord(fraction)}.`;
  return maxTurns !== undefined ? `${first}\nTurn budget for this task: ${maxTurns}.` : first;
}

interface AttemptRun {
  readonly terminal: Terminal | undefined;
  readonly toolsUsed: readonly string[];
  readonly cost: TaskCost;
}

async function driveAgentRun(ctx: EngineCtx, prompt: string, opts: TaskOptions, label: string): Promise<AttemptRun> {
  const allowed = new Set(opts.allowTools ?? DEFAULT_STEP_TOOLS);
  const tools = buildToolSet({
    workspaceRoot: ctx.workspaceRoot,
    model: ctx.model,
    canUseTool: ctx.canUseTool ?? allowAll,
    contextWindowTokens: ctx.contextWindowTokens ?? 200000,
  }).filter((t) => allowed.has(t.name) && !FORBIDDEN_TASK_TOOLS.has(t.name));

  // ω-4c §3.4: the advisory is computed ONCE per task from the budget at
  // spawn (frozen for the task's duration) — and only when the run opted in,
  // so js/json-adapter task prompts stay byte-identical to the legacy runner.
  const advisory = ctx.budgetAdvisory === true
    ? formatBudgetAdvisory(
        { total: ctx.budget.total, spent: ctx.budget.spent, remaining: ctx.budget.remaining },
        opts.maxTurns,
      )
    : undefined;
  const systemPrompt =
    buildSystemPrompt(ctx.workspaceRoot) +
    taskSystemSection(label, ctx.workflowName, tools.map((t) => t.name), opts.responseSchema, advisory);

  const state = {
    systemPrompt,
    messages: [{ role: "user" as const, content: prompt }],
    tools,
    status: "idle" as const,
  };

  // ω-4c §3.6: resolve the optional per-task model LABEL (unmapped/absent
  // falls back to the run model). buildToolSet keeps ctx.model above — its
  // model param only feeds the task tool's child routing, which is filtered out.
  const taskModel = (opts.model !== undefined ? ctx.taskModels?.get(opts.model) : undefined) ?? ctx.model;

  const toolsUsed: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  const gen = runAgentLoop(state, taskModel, {
    maxTurns: opts.maxTurns ?? 8,
    canUseTool: ctx.canUseTool ?? allowAll,
    compaction: { contextWindowTokens: ctx.contextWindowTokens ?? 200000, reserveTokens: 16384 },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  let terminal: Terminal | undefined;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      terminal = next.value;
      break;
    }
    const event: LoopEvent = next.value;
    if (event.type === "tool_call_started" && !toolsUsed.includes(event.toolName)) {
      toolsUsed.push(event.toolName);
    } else if (event.type === "usage") {
      promptTokens += event.usage.promptTokens;
      completionTokens += event.usage.completionTokens ?? 0;
    }
  }
  return { terminal, toolsUsed, cost: { promptTokens, completionTokens } };
}

interface AttemptVerdict {
  readonly failure?: TaskFailure;
  readonly data?: unknown;
  readonly verify?: readonly VerifyReceipt[];
  /** M56 §4: the no-evidence-success rule's verdict for ok tasks. */
  readonly evidence?: TaskEvidence;
}

/** Post-run classification: terminal reason → structured output → scorers. */
async function classifyAttempt(ctx: EngineCtx, opts: TaskOptions, run: AttemptRun): Promise<AttemptVerdict> {
  if (run.terminal === undefined || run.terminal.reason !== "completed") {
    if (run.terminal?.reason === "aborted") {
      return { failure: { category: "aborted", message: "task aborted" } };
    }
    return {
      failure: {
        category: "task-threw",
        message: `task ended with terminal "${run.terminal?.reason ?? "unknown"}" (no final answer)`,
      },
    };
  }
  const text = run.terminal.finalMessage?.content ?? "";
  let data: unknown;
  if (opts.responseSchema !== undefined) {
    const extracted = extractStructuredOutput(text);
    if (!extracted.ok) {
      return { failure: { category: "no-structured-output", message: "no parsable JSON in the final text (responseSchema was requested)" } };
    }
    const errors = validateJsonSchemaSubset(extracted.value, opts.responseSchema);
    if (errors.length > 0) {
      return { failure: { category: "invalid-structured-output", message: errors.join("; ") } };
    }
    data = extracted.value;
  }
  if (opts.verify !== undefined && opts.verify.length > 0) {
    const receipts = await evaluateVerifySpecs(opts.verify, {
      workspaceRoot: ctx.workspaceRoot,
      taskText: text,
      ...(data !== undefined ? { taskData: data } : {}),
      toolsUsed: run.toolsUsed,
    });
    // M56 §4: transport/verifier receipts are not the task's fault — only
    // fail/timeout fail it (unchanged). But they are not evidence FOR it
    // either: a success whose receipts are all skip/transport/verifier (or a
    // task with no scorers) is a PARTIAL, never a pass.
    const bad = receipts.filter((r) => r.status === "fail" || r.status === "timeout");
    if (bad.length > 0) {
      return {
        failure: {
          category: "verify-failed",
          message: bad.map((r) => `${r.kind}: ${r.status}${r.detail !== undefined ? ` (${r.detail})` : ""}`).join("; "),
        },
        ...(data !== undefined ? { data } : {}),
      };
    }
    return {
      ...(data !== undefined ? { data } : {}),
      verify: receipts,
      evidence: evidenceScore(receipts) === 1 ? "verified" : "partial",
    };
  }
  // No scorers configured: the success stands, but unevidenced (0.5 partial).
  return { ...(data !== undefined ? { data } : {}), evidence: "partial" };
}

function defaultFailure(): TaskFailure {
  return { category: "task-threw", message: "unknown failure" };
}

async function runTask(ctx: EngineCtx, prompt: string, opts: TaskOptions = {}): Promise<TaskResult> {
  const shared = ctx.shared;
  const seq = shared.seq;
  shared.seq += 1;
  const label = opts.label ?? `task-${seq + 1}`;
  const key = taskKey(prompt, opts);
  shared.totals.tasksTotal += 1;
  const nowFn = ctx.now ?? (() => new Date());

  // --- M56 §5: admission-time route preflight -----------------------------
  // Checked where the task is ADMITTED, before replay, journal writes beyond
  // the failure record, and any model call. A refused route never retries —
  // a configuration failure is not transient.
  const refusal = ctx.preflight?.();
  if (refusal !== undefined) {
    const failure: TaskFailure = { category: "preflight-refused", message: refusal };
    await ctx.journal.append({
      type: "task-failed", seq, key, label, category: failure.category, message: failure.message,
      endedAt: nowFn().toISOString(),
    });
    ctx.onEvent?.({
      type: "task-finished", seq, label, ok: false, replayed: false,
      toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, failure,
    });
    return { ok: false, text: "", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, failure };
  }

  // --- Journal replay -----------------------------------------------------
  if (!shared.invalidated) {
    const entry = shared.replay[shared.cursor];
    // The replay list holds ok entries only, so a previously-FAILED task
    // leaves a hole in it: when the cursor's entry carries a LATER seq than
    // this call, no cached result exists for THIS slot — a failure gap from
    // the prior run, not an edit. Re-run the task and keep the cursor so the
    // later entry still replays at its own seq; the downstream cache must
    // survive. Only an entry whose seq matches this call but whose key
    // differs is a real edit point (truncation below).
    const failureGap = entry !== undefined && entry.seq > seq;
    if (entry !== undefined && !failureGap && entry.key === key && entry.type === "task-finished") {
      // A cached structured output must still satisfy the CURRENT schema —
      // a stale-invalid entry is a divergence, not a hit (CCB replay rule).
      const staleErrors =
        opts.responseSchema === undefined
          ? []
          : entry.data === undefined
            ? ["cached entry carries no structured data"]
            : validateJsonSchemaSubset(entry.data, opts.responseSchema);
      if (staleErrors.length === 0) {
        shared.cursor += 1;
        shared.totals.tasksOk += 1;
        shared.totals.tasksReplayed += 1;
        // M56 §4: a replayed success keeps its evidence verdict (recomputed
        // from the journaled receipts — the journal bytes never change).
        const evidence = evidenceScore(entry.verify) === 1 ? "verified" : "partial";
        if (evidence === "partial") shared.totals.tasksPartial += 1;
        await ctx.journal.append({ type: "task-replayed", seq, key, label });
        ctx.onEvent?.({
          type: "task-finished", seq, label, ok: true, replayed: true,
          toolsUsed: entry.toolsUsed, cost: entry.cost, evidence,
        });
        return {
          ok: true, text: entry.text,
          ...(entry.data !== undefined ? { data: entry.data } : {}),
          toolsUsed: entry.toolsUsed, cost: entry.cost, evidence,
          ...(entry.verify !== undefined ? { verify: entry.verify } : {}),
        };
      }
    }
    if (entry !== undefined && !failureGap) {
      // 133 #3（a reference harness inputHash 防御校验）：同身份（脚本+参数未动）下的键
      // 漂移不是编辑——是脚本在绊线之外引入了非确定性。绝静默偏移：大声
      // 失败，点名 seq 与两键（截断重跑会掩盖被污染的重放前缀）。
      // T006 F1（HIGH）：stale-schema 落穿（键相等但缓存数据不再过当前
      // schema）是缓存失效不是漂移——纯度只在**键真的漂了**时触发，否则
      // 错误文案会拿两个相同的哈希前缀宣称"different task key"。
      if (entry.key !== key && shared.purityArmed) {
        throw new WorkflowPurityError(seq, entry.key, key, ctx.scopeLabel);
      }
      // Divergence（编辑）与 stale-schema 缓存失效共用截断：保留命中的
      // 前缀、从本位起弃条目重跑——中段编辑同时保住 provider 前缀缓存与
      // 已跑步骤；坏缓存条目被丢弃后重建。
      // T008 α（高危）：invalidated 在 await 之前置真——并行分支看到即跳
      // 截断走导入路径（修前 invalidated 在 await 之后，多分支并发进入
      // cursor check 共享 .truncating tmp → ENOENT → 降级 null）。
      const keepSeqs = new Set(shared.replay.slice(0, shared.cursor).map((e) => e.seq));
      shared.invalidated = true;
      await truncateTaskJournal(ctx.journal.path, keepSeqs);
      ctx.onEvent?.({ type: "journal-truncated", atSeq: seq });
    }
  }

  // --- M11 #3: Import pool lookup (a reference harness amend-resume 第一写关闭规则) -----
  // 编辑点之后（invalidated=true），任务按键在**全量**重放清单中查找——
  // 内容寻址键天然支持随机访问。关门规则：首个带工具的实际执行关闭导入
  // 池的非纯项；纯项（toolCalls===0）永远可导入（"只依赖指令与转录前缀，
  // 旧世界的答案对新世界同样成立"）。
  if (shared.invalidated) {
    const imported = importableEntry(
      shared.replay.filter((e): e is TaskJournalEntry => e.type === "task-finished"),
      key,
      { pastEditPoint: shared.invalidated, firstWrite: shared.firstWrite },
    );
    // T006 F1 的导入路径镜像：缓存的结构化产物必须仍过**当前** schema——
    // 过期数据是缓存失效不是命中（CCB replay rule）。
    const importStaleErrors =
      imported !== undefined && opts.responseSchema !== undefined
        ? imported.data === undefined
          ? ["cached entry carries no structured data"]
          : validateJsonSchemaSubset(imported.data, opts.responseSchema)
        : [];
    if (imported !== undefined && importStaleErrors.length === 0) {
      shared.totals.tasksOk += 1;
      shared.totals.tasksReplayed += 1;
      const evidence = evidenceScore(imported.verify) === 1 ? "verified" : "partial";
      if (evidence === "partial") shared.totals.tasksPartial += 1;
      // M11 #3：导入的任务写**新 task-finished**（非仅 task-replayed）——
      // 后续 resume 需要它在光标重放清单里。
      await ctx.journal.append({
        type: "task-finished", seq, key, prompt: imported.prompt, ok: true,
        text: imported.text,
        ...(imported.data !== undefined ? { data: imported.data } : {}),
        toolsUsed: imported.toolsUsed, cost: imported.cost,
        ...(imported.verify !== undefined ? { verify: imported.verify } : {}),
        endedAt: nowFn().toISOString(),
      });
      await ctx.journal.append({ type: "task-replayed", seq, key, label });
      ctx.onEvent?.({
        type: "task-finished", seq, label, ok: true, replayed: true,
        toolsUsed: imported.toolsUsed, cost: imported.cost, evidence,
      });
      return {
        ok: true, text: imported.text,
        ...(imported.data !== undefined ? { data: imported.data } : {}),
        toolsUsed: imported.toolsUsed, cost: imported.cost, evidence,
        ...(imported.verify !== undefined ? { verify: imported.verify } : {}),
      };
    }
  }

  await ctx.journal.append({ type: "task-started", seq, key, label });
  ctx.onEvent?.({ type: "task-started", seq, label });

  const attempts = 1 + Math.max(0, opts.retry ?? 1);
  let lastFailure: TaskFailure | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (ctx.signal?.aborted) {
      lastFailure = { category: "aborted", message: "workflow aborted" };
      break; // abort is the user's intent — never retried
    }
    let run: AttemptRun | undefined;
    await ctx.semaphore.acquire();
    try {
      // Budget assert INSIDE the critical section: a waiter re-checks the
      // latest spend when its permit arrives (CCB overspend race).
      ctx.budget.assertCanSpend();
      try {
        run = await driveAgentRun(ctx, prompt, opts, label);
      } catch (err) {
        lastFailure =
          err instanceof Error && err.name === "AbortError"
            ? { category: "aborted", message: "task aborted" }
            : { category: "task-threw", message: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      ctx.semaphore.release();
    }
    if (run === undefined) {
      if (lastFailure?.category === "aborted") break;
      continue;
    }
    shared.totals.promptTokens += run.cost.promptTokens;
    shared.totals.completionTokens += run.cost.completionTokens;

    const verdict = await classifyAttempt(ctx, opts, run);
    if (verdict.failure === undefined) {
      const text = run.terminal?.reason === "completed" ? run.terminal.finalMessage?.content ?? "" : "";
      ctx.budget.charge(run.cost.promptTokens + run.cost.completionTokens);
      await ctx.journal.append({
        type: "task-finished", seq, key, prompt, ok: true, text,
        ...(verdict.data !== undefined ? { data: verdict.data } : {}),
        toolsUsed: run.toolsUsed, cost: run.cost,
        ...(verdict.verify !== undefined ? { verify: verdict.verify } : {}),
        endedAt: nowFn().toISOString(),
      });
      // M11 #3：带工具的实际执行=第一笔写入——关闭导入池的非纯项。
      if (closesImportPool(run.toolsUsed)) shared.firstWrite = true;
      shared.totals.tasksOk += 1;
      if (verdict.evidence === "partial") shared.totals.tasksPartial += 1;
      ctx.onEvent?.({
        type: "task-finished", seq, label, ok: true, replayed: false,
        toolsUsed: run.toolsUsed, cost: run.cost,
        ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
      });
      return {
        ok: true, text,
        ...(verdict.data !== undefined ? { data: verdict.data } : {}),
        toolsUsed: run.toolsUsed, cost: run.cost,
        ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
        ...(verdict.verify !== undefined ? { verify: verdict.verify } : {}),
      };
    }
    lastFailure = verdict.failure;
    if (verdict.failure.category === "aborted") break;
  }

  const failure = lastFailure ?? defaultFailure();
  await ctx.journal.append({
    type: "task-failed", seq, key, label, category: failure.category, message: failure.message,
    endedAt: nowFn().toISOString(),
  });
  ctx.onEvent?.({
    type: "task-finished", seq, label, ok: false, replayed: false,
    toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, failure,
  });
  return { ok: false, text: "", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, failure };
}

// ---------------------------------------------------------------------------
// Sub-workflows (one level)
// ---------------------------------------------------------------------------

function resolveSubScript(ctx: EngineCtx, name: string): string {
  const base = ctx.scriptPath !== undefined ? dirname(ctx.scriptPath) : ctx.workspaceRoot;
  if (name.split("/").some((s) => s === ".." || s.length === 0)) {
    throw new Error(`workflow(${JSON.stringify(name)}): invalid name (path traversal is not allowed)`);
  }
  const candidates = /\.(js|json)$/.test(name) ? [name] : [`${name}.js`, `${name}.json`];
  for (const candidate of candidates) {
    const path = resolve(base, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`workflow(${JSON.stringify(name)}): no script found next to ${base} (tried ${candidates.join(", ")})`);
}

async function runSubWorkflow(ctx: EngineCtx, name: string, childArgs?: unknown): Promise<unknown> {
  if ((ctx.depth ?? 0) >= 1) {
    throw new Error("workflow(): sub-workflows cannot nest further (one level max)");
  }
  const path = resolveSubScript(ctx, name);
  ctx.onEvent?.({ type: "workflow-started", name });
  const childCtx: EngineCtx = { ...ctx, depth: (ctx.depth ?? 0) + 1, scriptPath: path, args: childArgs, scopeLabel: name }; // T006 F4：子工作流漂移点名作用域
  if (path.endsWith(".json")) {
    const validated = parseWorkflow(readFileSync(path, "utf8"));
    if (!validated.valid) {
      throw new Error(`workflow(${JSON.stringify(name)}): invalid JSON workflow: ${validated.errors.join("; ")}`);
    }
    return runPlanSteps(planFromWorkflow(validated.workflow.name ?? basename(path), validated.workflow.steps), primitivesFor(childCtx).task);
  }
  return compileScript(readFileSync(path, "utf8"))(primitivesFor(childCtx), childCtx.args);
}

// ---------------------------------------------------------------------------
// Programs: a compiled script or an adapter plan — both just functions over
// the primitives.
// ---------------------------------------------------------------------------

type Program = (primitives: VmPrimitives) => Promise<unknown>;
export type { Program };

/** M11 #2（a reference harness world.run 形）— 脚本级确定性命令门。
 *
 * 语义：非零退出码是正常返回（门控循环的常态——检查失败是数据不是
 * 异常）；超时/spawn 失败也是返回的字段。无 shell：execFile args 直传
 * （无管道/重定向/变量展开）。命令集=调用方授予的允许清单（fail-closed，
 * 能力≠策略）。journaled：与 task() 共享 seq 空间与重放走查——重放零
 * 进程派生，同身份键漂移触发纯度违例（cmd 键=c: 前缀隔离）。
 * 输出各帽 64KB（日志膨胀控制，截断带标记）。 */
const CMD_OUTPUT_CAP = 64 * 1024;
const capOutput = (s: string): string =>
  s.length <= CMD_OUTPUT_CAP ? s : s.slice(0, CMD_OUTPUT_CAP) + "\n[输出超 64KB 截断]";

async function runCmd(ctx: EngineCtx, cmd: string, args?: readonly string[], opts?: { readonly timeoutMs?: number }): Promise<RunResult> {
  const shared = ctx.shared;
  const seq = shared.seq;
  shared.seq += 1;
  const argv = [...(args ?? [])];
  const granted = ctx.commandAllowlist !== undefined && ctx.commandAllowlist.has(cmd);
  const key = cmdKey(cmd, argv, granted);
  const nowFn = ctx.now ?? (() => new Date());
  // T007 P0：帽在 settle 一处生效——journal 落账与调用方拿到**同一份字节**
  // （修前只落账截断、调用方拿 raw，首跑 100KB / resume 64KB 重放不等）。
  const settle = async (raw: RunResult): Promise<RunResult> => {
    const result: RunResult = { ...raw, stdout: capOutput(raw.stdout), stderr: capOutput(raw.stderr) };
    await ctx.journal.append({
      type: "cmd-finished", seq, key, cmd, args: argv,
      code: result.code, stdout: result.stdout, stderr: result.stderr,
      timedOut: result.timedOut,
      ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
      endedAt: nowFn().toISOString(),
    });
    return result;
  };
  // Journal replay（与 runTask 同走查）：命中即零进程派生。
  if (!shared.invalidated) {
    const entry = shared.replay[shared.cursor];
    const failureGap = entry !== undefined && entry.seq > seq;
    if (entry !== undefined && !failureGap && entry.type === "cmd-finished" && entry.key === key) {
      shared.cursor += 1;
      await ctx.journal.append({ type: "cmd-replayed", seq, key, cmd });
      return { code: entry.code, stdout: entry.stdout, stderr: entry.stderr, timedOut: entry.timedOut, ...(entry.spawnError !== undefined ? { spawnError: entry.spawnError } : {}) };
    }
    if (entry !== undefined && !failureGap && entry.key !== key && shared.purityArmed) {
      throw new WorkflowPurityError(seq, entry.key, key, ctx.scopeLabel);
    }
    if (entry !== undefined && !failureGap) {
      const keepSeqs = new Set(shared.replay.slice(0, shared.cursor).map((e) => e.seq));
      shared.invalidated = true; // T008 α：await 前置真（与 runTask 同修）
      await truncateTaskJournal(ctx.journal.path, keepSeqs);
      ctx.onEvent?.({ type: "journal-truncated", atSeq: seq });
    }
  }
  // M11 #3：cmd 的**实际执行**永远关门（live 副作用——a reference harness 的 world.run
  // live 执行同义）。拒绝（不在允许清单）也关门——拒绝后的导入语义过于
  // 微妙，保守处置。
  shared.firstWrite = true;
  // 允许清单（fail-closed）：不在清单=确定性拒绝，照常落账（重放一致）。
  if (!granted) {
    return settle({
      code: undefined, stdout: "", stderr: "", timedOut: false,
      spawnError: `command not granted: "${cmd}" — 授予它请在调用时加 --allow-cmd <cmd>（能力≠策略：脚本声明能力，调用方授予命令集）`,
    });
  }
  // 帽 120s / 地板 1s / 缺省 30s。
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts?.timeoutMs ?? 30_000));
  return new Promise<RunResult>((resolve) => {
    execFile(cmd, argv, { cwd: ctx.workspaceRoot, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (err !== null && "killed" in err && (err as { killed?: boolean }).killed === true) {
        void settle({ code: undefined, stdout: String(stdout), stderr: String(stderr), timedOut: true }).then(resolve);
        return;
      }
      const ecode = (err as { code?: unknown } | null)?.code;
      // spawn 失败（命令不存在/不可执行等）：code 非数字——数据化返回。
      const code = typeof ecode === "number" ? ecode : err === null ? 0 : undefined;
      void settle({
        code, stdout: String(stdout), stderr: String(stderr), timedOut: false,
        ...(code === undefined && err !== null ? { spawnError: err.message } : {}),
      }).then(resolve);
    });
  });
}

function primitivesFor(ctx: EngineCtx): VmPrimitives {
  return {
    task: (prompt: string, opts?: TaskOptions) => runTask(ctx, prompt, opts),
    run: (cmd: string, args?: readonly string[], opts?: { readonly timeoutMs?: number }) => runCmd(ctx, cmd, args, opts),
    parallel: <T>(fns: readonly (() => Promise<T> | T)[], opts?: { limit?: number }): Promise<ParallelResult<T>> =>
      runParallel(fns, opts),
    pipeline: <T>(gen: AsyncIterable<() => Promise<T> | T>, opts?: { limit?: number }): Promise<ParallelResult<T>> =>
      runPipeline(gen, opts),
    log: (obj: unknown): Promise<void> => {
      const message = typeof obj === "string" ? obj : JSON.stringify(obj) ?? String(obj);
      const pending = ctx.journal.append({ type: "log", message }).catch(() => {});
      ctx.onEvent?.({ type: "log", message });
      return pending;
    },
    workflow: (name: string, args?: unknown) => runSubWorkflow(ctx, name, args),
    budget: {
      get total() { return ctx.budget.total; },
      get spent() { return ctx.budget.spent; },
      get remaining() { return ctx.budget.remaining; },
    },
  };
}

/** M22 semantics inside the new engine: sequential steps, {{ref}}
 *  substitution, stop at the first failed step (run failure). */
async function runPlanSteps(plan: CompiledPlan, task: VmPrimitives["task"]): Promise<unknown> {
  const outputs = new Map<string, string>();
  for (const step of plan.steps) {
    const prompt = substituteStepRefs(step.promptTemplate, outputs);
    outputs.set(step.label, ""); // a step never reads its own output
    const result = await task(prompt, { ...step.taskOpts, label: step.label });
    if (!result.ok) {
      throw new PlanStepFailure(result.failure);
    }
    outputs.set(step.label, result.text);
  }
  return [...outputs.values()];
}

// ---------------------------------------------------------------------------
// Run lifecycle: journal markers, events, state.json, GC
// ---------------------------------------------------------------------------

function classifyRunError(err: unknown): TaskFailure {
  if (err instanceof BudgetExhaustedError) return { category: "budget-exhausted", message: err.message };
  if (err instanceof PlanStepFailure) return err.failure;
  if (err instanceof WorkflowPurityError) return { category: "purity-violation", message: err.message };
  if (err instanceof Error && err.name === "AbortError") return { category: "aborted", message: "workflow aborted" };
  return { category: "task-threw", message: err instanceof Error ? err.message : String(err) };
}

async function execute(
  program: Program,
  opts: JsflowOptions,
  engineName: "js" | "json-adapter" | "mea",
): Promise<JsflowRunResult> {
  const ctx: EngineCtx = {
    ...opts,
    budget: createBudget(opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS),
    semaphore: createSemaphore(clampLimit(opts.concurrencyLimit)),
    shared: {
      seq: 0,
      cursor: 0,
      invalidated: false,
      firstWrite: false, // M11 #3
      // 133 #3：身份全等（脚本+参数双哈希）且有可重放任务才武装——
      // 异身份=编辑（截断语义），无身份=旧调用方/适配器（旧行为）。
      purityArmed:
        opts.identity !== undefined
        && opts.resumeIdentity !== undefined
        && opts.identity.scriptHash === opts.resumeIdentity.scriptHash
        && opts.identity.argsHash === opts.resumeIdentity.argsHash
        // T007 P1：授予面也要全等——策略变化走编辑语义（截断重跑），
        // 不触发纯度（换授予是合法操作不是非确定性）。
        && opts.identity.allowHash === opts.resumeIdentity.allowHash
        && ((opts.resumeTasks?.length ?? 0) + (opts.resumeCmds?.length ?? 0)) > 0,
      // M11 #2：task+cmd 按 seq 归并（同空间调用序，稳定排序保文件序）。
      replay: [...(opts.resumeTasks ?? []), ...(opts.resumeCmds ?? [])].sort(
        (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
      ),
      totals: { tasksTotal: 0, tasksOk: 0, tasksReplayed: 0, tasksPartial: 0, promptTokens: 0, completionTokens: 0 },
    },
    engineName,
    scopeLabel: "", // T006 F4：顶层 run 无作用域后缀
  };
  const runId = basename(opts.journal.path).replace(/\.jsonl$/, "");
  const nowFn = opts.now ?? (() => new Date());
  const startedAt = nowFn().toISOString();

  await opts.journal.append({
    type: "run-started", runId, workflow: opts.workflowName, startedAt, engine: engineName,
    // 133 #3：身份随运行起戳落账——resume 据此区分"纯度违例"与"编辑"。
    ...(opts.identity !== undefined ? { scriptHash: opts.identity.scriptHash, argsHash: opts.identity.argsHash, allowHash: opts.identity.allowHash } : {}),
  });
  ctx.onEvent?.({ type: "run-started", runId, workflow: opts.workflowName });

  let returnValue: unknown;
  let failure: TaskFailure | undefined;
  try {
    returnValue = await program(primitivesFor(ctx));
  } catch (err) {
    failure = classifyRunError(err);
  }
  const ok = failure === undefined;

  await opts.journal.append({
    type: "run-finished", ok,
    ...(failure !== undefined ? { failure: { category: failure.category, message: failure.message } } : {}),
  });
  ctx.onEvent?.({ type: "run-finished", ok, ...(failure !== undefined ? { failure } : {}) });

  const state: WorkflowRunState = {
    schemaVersion: 1,
    runId,
    workflow: opts.workflowName,
    status: failure?.category === "aborted" ? "aborted" : ok ? "completed" : "failed",
    startedAt,
    finishedAt: nowFn().toISOString(),
    tasksTotal: ctx.shared.totals.tasksTotal,
    tasksOk: ctx.shared.totals.tasksOk,
    tasksReplayed: ctx.shared.totals.tasksReplayed,
    cost: { promptTokens: ctx.shared.totals.promptTokens, completionTokens: ctx.shared.totals.completionTokens },
    ...(failure !== undefined ? { failure: { category: failure.category, message: failure.message } } : {}),
  };
  await writeWorkflowState(opts.workspaceRoot, state);
  // GC only after the new state landed — the just-finished run is the newest.
  await gcWorkflowRuns(opts.workspaceRoot);

  return {
    ok,
    ...(ok ? { returnValue } : {}),
    ...(failure !== undefined ? { failure } : {}),
    tasksTotal: ctx.shared.totals.tasksTotal,
    tasksOk: ctx.shared.totals.tasksOk,
    tasksReplayed: ctx.shared.totals.tasksReplayed,
    tasksPartial: ctx.shared.totals.tasksPartial,
    cost: state.cost,
  };
}

/** Run a `.js` workflow script (M29 path). */
export function runScriptWorkflow(source: string, opts: JsflowOptions): Promise<JsflowRunResult> {
  return execute((primitives) => compileScript(source)(primitives, opts.args), opts, "js");
}

/** Run a compiled M22-JSON plan through the same engine (adapter path). */
export function runPlanWorkflow(plan: CompiledPlan, opts: JsflowOptions): Promise<JsflowRunResult> {
  return execute((primitives) => runPlanSteps(plan, primitives.task), opts, "json-adapter");
}

/** ω-4c §3.1: run an arbitrary Program through the same lifecycle (journal
 *  markers, budget, preflight, events, state.json, GC) — the seam the MEA
 *  engine drives; a MEA loop is just another Program. */
export function runProgramWorkflow(
  program: Program,
  opts: JsflowOptions,
  engineName: "js" | "json-adapter" | "mea" = "js",
): Promise<JsflowRunResult> {
  return execute(program, opts, engineName);
}

/** Compile an M22 JSON workflow into an equivalent plan: steps → sequential
 *  task() calls; expect.toolUsed → a toolUsed scorer; expect.outputContains →
 *  an escaped regexMatch scorer (substring semantics preserved); retry 0 keeps
 *  M22's no-step-retry behavior (and byte-equal journal keys). */
export function planFromWorkflow(name: string, steps: readonly PlanSourceStep[]): CompiledPlan {
  return {
    name,
    steps: steps.map((step) => ({
      label: step.id,
      promptTemplate: step.prompt,
      taskOpts: {
        ...(step.allowTools !== undefined ? { allowTools: step.allowTools } : {}),
        ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
        ...(step.expect !== undefined && (step.expect.toolUsed !== undefined || step.expect.outputContains !== undefined)
          ? {
              verify: [
                ...(step.expect.toolUsed !== undefined ? [{ toolUsed: { tool: step.expect.toolUsed } } as VerifySpec] : []),
                ...(step.expect.outputContains !== undefined
                  ? [{ regexMatch: { pattern: escapeRegex(step.expect.outputContains) } } as VerifySpec]
                  : []),
              ],
            }
          : {}),
        retry: 0,
      },
    })),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
