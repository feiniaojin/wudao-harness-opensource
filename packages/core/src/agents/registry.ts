// M30 §B — the background-agent registry. `task({background: true})` hands
// the parent a `bg-N` receipt immediately; the registry owns the child's
// lifecycle from there: concurrency slots, the hard cap, parent-abort
// linking, the budget-fuse grace iteration, and structured report receipts.
// Engine-level only — no tool surface lives here (the CLI registers
// agent_await/agent_status/agent_cancel on top of this).
//
// M41: every operating point (slots, cap, child budget, grace whitelist) is
// constructor policy — the CLI's kernel-policy.ts is the single value source.

import type { ModelClient } from "../model-client.js";
import type { Tool } from "../tool.js";
import type { LoopOptions, LoopEvent } from "../loop.js";
import type { ImageBlock } from "../attachments.js";
import type { ForkContext, SubagentRunInfo, ChildSessionOptions, ResumeSeamInfo, RunSubagentOptions } from "../subagent.js";
import { runSubagent } from "../subagent.js";
import type { AgentRoleProfile } from "./roster.js";
import { toSubagentType } from "./roster.js";
import type { WriteScopeDeclaration } from "./write-scope.js";
import { formatWriteScope, intersectWriteScopes, isWriteScopeEmpty } from "./write-scope.js";
// 121 项 1 — the AIMD concurrency gate the pump consults when present.
import type { ConcurrencyGate } from "./aimd.js";
// ω99-60: the parent→child steer half-arc — the per-child FIFO mailbox the
// registry owns and the formatted attribution composed at submit time.
import { createSteerMailbox, formatSteerText } from "./steer.js";
import type { SteerMailbox } from "./steer.js";

/** The JSON-schema subset a reportSchema may use — structurally identical to
 *  M29's JsonSchemaSubset (cli injects its validator; core stays
 *  schema-lib-free). */
export interface SubsetSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SubsetSchema>>;
  readonly items?: SubsetSchema;
  readonly enum?: readonly unknown[];
}

/** Binding spelling of the subset-schema interface (see SubsetSchema). */
export type isSubsetSchema = SubsetSchema;

/** Receipt validator injected by the CLI (M29 subset validator + JSON
 *  extraction composed). Returns violations; empty = valid. */
export type ReportValidator = (reportText: string, schema: SubsetSchema) => readonly string[];

export interface AgentRegistryOptions {
  /** M41 policy hoist: the operating points below are REQUIRED — core keeps
   *  the mechanisms (slot scheduling, the hard-cap gate, the budget fuse,
   *  grace semantics) but no default values. The CLI supplies them from its
   *  kernel-policy single source; embedders state their own. */
  /** Concurrent child slots. */
  readonly maxConcurrent: number;
  /** Upper bound on LIVE (queued+running) agents — spawn past it throws. */
  readonly hardCap: number;
  /** Registry-level child turn budget: spawn `maxTurns` > role `maxTurns` >
   *  this. */
  readonly childTurns: number;
  /** Registry-level grace-turn whitelist: spawn `graceTools` > this; an
   *  empty array disables grace for children that do not override. */
  readonly graceTools: readonly string[];
  /** 波次8 #47 (OH#6): registry-level wall-clock default — spawn
   *  `timeoutMs` > this; undefined = no registry default (children without
   *  either run unbounded, the pre-#47 behavior). A hung child otherwise
   *  pins a concurrency slot forever (the hardCap only gates NEW spawns —
   *  it never reaps what already holds a slot). */
  readonly defaultTimeoutMs?: number;
  /** Parent cancellation: one abort tears down every queued and running
   *  child (fail-together semantics). */
  readonly signal?: AbortSignal;
  /** Injected report validation (core ships none — schema-lib-free). */
  readonly validateReport?: ReportValidator;
  /** M31 §1: refuse (instead of warn) when a spawn's write scope overlaps a
   *  live agent's. Absent → warn on the receipt. */
  readonly strictOverlaps?: boolean;
  /** ω99-5b §C: corrective repair rounds for a schema'd report that fails
   *  validation — the child transcript is resumed once with the violation
   *  list and a bounded turn budget. Default 1; 0 disables. HARD CAPPED at 1
   *  regardless of the value passed: a schema fight between harness and
   *  model must never loop (death-spiral guard). */
  readonly reportRepairRounds?: number;
  /** 121 项 1 — AIMD 速率自适应并发门（a reference harness DynamicGate 形）：在场时
   *  pump 的准入读 gate.current()（而非冻结的 maxConcurrent），子代结算喂
   *  信号（ok → onSuccess；失败且 isThrottleFailure 命中 → onThrottle）。
   *  缺席 = 纯静态帽，行为与既往字节等价（既有测试与嵌入方零演进）。
   *  gate.current() 只影响新准入——已在跑的子代不被杀（收容量的
   *  是「新进入」，与 a reference harness 的 pause-new-admissions 同律）。 */
  readonly concurrencyGate?: ConcurrencyGate;
  /** 121 项 1 — 结算失败的降容判据（providers 的 isOverloadClassFailure 由
   *  部署层注入；core 对 provider 错误分类保持零依赖——与 validateReport
   *  同一条 schema-lib-free 纪律）。缺席时失败不触发 onThrottle（只有外部
   *  观察者面——如梯子的 onOverload——能降容）。 */
  readonly isThrottleFailure?: (err: unknown) => boolean;
}

export interface AgentSpawnSpec {
  readonly model: ModelClient;
  readonly allTools: readonly Tool[];
  readonly role: AgentRoleProfile;
  readonly prompt: string;
  /** M80 (direction b): image refs riding the child's first user message
   *  (threaded to runSubagent's promptImages — same contract, fail-closed
   *  combinations refuse at the runSubagent seam). */
  readonly promptImages?: readonly ImageBlock[];
  /** Budget fuse for THIS child; defaults to the role's maxTurns, else the
   *  registry's childTurns policy. */
  readonly maxTurns?: number;
  /** Grace-turn tool whitelist (registry-level graceTools policy by
   *  default). Pass [] to disable grace for this child. */
  readonly graceTools?: readonly string[];
  /** Wall-clock cap for THIS child. On expiry the child is aborted (result
   *  aborted:true, report names the timeout) — a hung model call can no
   *  longer pin a registry slot forever. */
  readonly timeoutMs?: number;
  readonly reportSchema?: SubsetSchema;
  /** Reasoning receipt: what was requested (spawn- or role-level) and what
   *  the provider normalized it to. */
  readonly reasoningEffort?: string;
  readonly effectiveReasoningEffort?: string;
  readonly loopOptions?: Omit<LoopOptions, "canUseTool">;
  readonly canUseTool?: LoopOptions["canUseTool"];
  readonly onEvent?: (event: LoopEvent) => void;
  readonly forkFrom?: ForkContext;
  /** M30 §C: run the background child as a resumable sidechain session. */
  readonly session?: ChildSessionOptions;
  readonly onBeforeResume?: (info: ResumeSeamInfo) => string | undefined;
  /** M31 §1: the effective (already task-narrowed) write scope for overlap
   *  detection and receipts. Guarding the child's tools is the SPAWNER's
   *  job (the CLI wraps its own tool set) — the registry only observes. */
  readonly writeScope?: WriteScopeDeclaration;
  /** M31 §3: stable task call id (t-N) for lineage + resume_from. */
  readonly callId?: string;
  /** M31 §3: the t-N this child resumes (resume_from lineage). */
  readonly parentCallId?: string;
  /** M31 §2: the budget this child was dispatched with (adaptive or
   *  explicit) — echoed in the result's budget receipt. */
  readonly suggestedBudget?: number;
  /** M31 §2: fires exactly once when this child settles, with the full
   *  result (the CLI records the per-role budget sample here). */
  readonly onSettle?: (result: RegistryResult) => void;
  /** M63-B: the SubagentStart/Stop hook faces, threaded to runSubagent
   *  (background children fire them too). */
  readonly subagentHooks?: RunSubagentOptions["subagentHooks"];
  /** M63-C §3: the subagent-position hooks (the role profile's own). */
  readonly runHooks?: RunSubagentOptions["runHooks"];
  /** ω99-57: wire the child→parent mail edge for this background child (the
   *  parent's lane sink — same contract as runSubagent's parentMail). */
  readonly parentMail?: RunSubagentOptions["parentMail"];
}

export type AgentRunStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface RegistryResult {
  readonly id: string;
  readonly role: string;
  /** true iff the child ran to a final answer (abort/error → false). */
  readonly ok: boolean;
  /** The child's final report text (grace-turn text when budget-limited). */
  readonly report: string;
  readonly aborted?: boolean;
  readonly error?: string;
  /** Grace iteration fired: the report is a budget-limited partial result. */
  readonly budgetLimited?: boolean;
  /** Deterministic [WORKER_REPORT] block synthesized from telemetry when the
   *  budget fuse fired — completion count / usage / budget_limited + the
   *  re-dispatch hint. Absent when the child finished within budget. */
  readonly workerReport?: string;
  readonly reasoning?: { readonly requested?: string; readonly effective?: string };
  readonly reportValid?: boolean;
  readonly reportErrors?: readonly string[];
  /** M31 §1: this child's write-scope summary (present only when scoped). */
  readonly writeScope?: string;
  /** M31 §1: live agents whose write scope overlapped THIS spawn's (the
   *  fan-in receipt keeps both candidates for the model to reconcile). */
  readonly overlapWith?: readonly string[];
  /** M31 §3: lineage ids (t-N). */
  readonly callId?: string;
  readonly parentCallId?: string;
  /** M31 §2: model turns the child consumed (telemetry). */
  readonly turns?: number;
  /** M31 §2: budget receipt — what it was dispatched with and what it used. */
  readonly budget?: { readonly suggested?: number; readonly used: number; readonly budgetLimited: boolean };
}

export interface AgentStatusInfo {
  readonly id: string;
  readonly role: string;
  readonly status: AgentRunStatus;
  /** M31 §1: write-scope summary (present only when scoped). */
  readonly writeScope?: string;
  /** M31 §3: lineage ids (t-N). */
  readonly callId?: string;
  readonly parentCallId?: string;
}

export interface AwaitSpec {
  readonly ids: readonly string[];
  readonly mode?: "all" | "allSettled" | "any" | "race";
}

function synthesizeWorkerReport(id: string, info: SubagentRunInfo): string {
  return [
    "[WORKER_REPORT]",
    `agent: ${id}`,
    "status: budget_limited",
    `turns_used: ${info.turns}`,
    `tool_calls_completed: ${info.toolCalls}`,
    `tokens_prompt: ${info.usage.promptTokens}`,
    `tokens_completion: ${info.usage.completionTokens}`,
    "hint: budget exhausted mid-task — re-dispatch this worker with a higher maxTurns to continue (its child-session transcript survives for resume)",
  ].join("\n");
}

// ω99-5b §B: the finishing tool a schema'd spawn names for runSubagent — the
// final_output tool_use in the transcript becomes the canonical-JSON report.
const REPORT_FINAL_TOOL = "final_output";

// ω99-5b §C: the corrective steering message — deterministic bytes (tests pin
// the error list and the "Output ONLY" directive). One bounded round, no more.
const reportRepairPrompt = (errors: readonly string[]): string =>
  `[report repair] Your previous report violated the schema: ${errors.join("; ")}. Output ONLY the corrected JSON now.`;

// ω99-5b §C hard bound: at most ONE repair round — the constant IS the
// death-spiral guard (a schema fight must never become a loop).
const REPAIR_ROUNDS_MAX = 1;

interface Entry {
  readonly id: string;
  readonly spec: AgentSpawnSpec;
  readonly controller: AbortController;
  status: AgentRunStatus;
  resolveDone: (result: RegistryResult) => void;
  readonly done: Promise<RegistryResult>;
  /** M31 §1: effective write scope (absent when unscoped). */
  readonly writeScope?: WriteScopeDeclaration;
  /** M31 §1: overlap partners detected at spawn time. */
  readonly overlapWith: readonly string[];
  /** ω99-60: this child's steer mailbox (FIFO). Steers accumulate here (a
   *  queued child drains on start) and the child's loopOptions steering
   *  drains them before every model call — main, grace and repair passes. */
  readonly mailbox: SteerMailbox;
}

/** M31 §1: spawn warnings computed synchronously (scope overlaps). */
export interface AgentSpawnReceipt {
  readonly id: string;
  readonly done: Promise<RegistryResult>;
  readonly warnings: readonly string[];
}

export interface AgentRegistry {
  spawn(spec: AgentSpawnSpec): AgentSpawnReceipt;
  awaitAgents(spec: AwaitSpec): Promise<readonly RegistryResult[]>;
  status(): readonly AgentStatusInfo[];
  status(id: string): AgentStatusInfo | undefined;
  cancel(id: string): boolean;
  abortAll(): void;
  /** ω99-60: submit one steer to a queued-or-running child's mailbox — the
   *  text lands on that child's next model call (the loop's steering drain),
   *  already formatted with the unforgeable parent attribution. Typed
   *  errors: unknown id; a settled child (done|failed|aborted). A QUEUED
   *  child accepts (the mailbox accumulates until the child starts). */
  steer(id: string, content: string): void;
}

export function createAgentRegistry(options: AgentRegistryOptions): AgentRegistry {
  const maxConcurrent = options.maxConcurrent;
  // 121 项 1 — the AIMD face: admission reads the gate's LIVE capacity when
  // one is wired (a shrink only bars NEW entries — running children are never
  // killed); absent = the frozen static cap, byte-equal to the pre-121 pump.
  const admissionLimit = (): number => options.concurrencyGate?.current() ?? maxConcurrent;
  const hardCap = options.hardCap;
  const strictOverlaps = options.strictOverlaps === true;
  // ω99-5b §C: resolved once (default on, 0 off, hard-capped at 1 above).
  const repairRounds = Math.min(REPAIR_ROUNDS_MAX, Math.max(0, Math.floor(options.reportRepairRounds ?? 1)));

  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  let active = 0;
  let counter = 0;

  const settle = (entry: Entry, result: RegistryResult): void => {
    // Idempotent: first write wins (a cancel can settle before the child's
    // own run completes; the child's late result must not overwrite it).
    if (entry.status !== "queued" && entry.status !== "running") return;
    entry.status = result.aborted === true ? "aborted" : result.ok ? "done" : "failed";
    const full: RegistryResult = {
      ...result,
      // M31 lineage/scope facts ride every settle path (cancel included).
      ...(entry.spec.callId !== undefined ? { callId: entry.spec.callId } : {}),
      ...(entry.spec.parentCallId !== undefined ? { parentCallId: entry.spec.parentCallId } : {}),
      ...(entry.writeScope !== undefined ? { writeScope: formatWriteScope(entry.writeScope) } : {}),
      ...(entry.overlapWith.length > 0 ? { overlapWith: [...entry.overlapWith] } : {}),
    };
    entry.resolveDone(full);
    entry.spec.onSettle?.(full);
  };

  const cancelEntry = (entry: Entry, report: string): void => {
    if (entry.status !== "queued" && entry.status !== "running") return;
    entry.controller.abort();
    if (entry.status === "queued") {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    }
    settle(entry, { id: entry.id, role: entry.spec.role.id, ok: false, aborted: true, report });
  };

  const runChild = async (entry: Entry): Promise<void> => {
    entry.status = "running";
    const spec = entry.spec;
    // Per-child wall-clock cap: fires cancelEntry → controller.abort → the
    // child's aborted terminal. Cleared on ANY settle path below. 波次8 #47:
    // spawn-level timeoutMs > registry-level defaultTimeoutMs.
    const timeoutMs = spec.timeoutMs ?? options.defaultTimeoutMs;
    const timeoutHandle = timeoutMs !== undefined
      ? setTimeout(() => cancelEntry(entry, `agent ${entry.id} timed out after ${timeoutMs}ms`), timeoutMs)
      : undefined;
    const requestedEffort = spec.reasoningEffort ?? spec.role.reasoningEffort;
    const effectiveEffort = spec.effectiveReasoningEffort ?? requestedEffort;
    const reasoning =
      requestedEffort !== undefined || effectiveEffort !== undefined
        ? { requested: requestedEffort, effective: effectiveEffort }
        : undefined;
    // ω99-60: this child's steering seam — the per-child mailbox, chained
    // BEHIND a caller-supplied steering queue (spawn spec loopOptions.steering,
    // supplied by nobody today): caller items drain FIRST, mailbox items
    // second. The order is the deterministic rule the chained-steering test
    // pins — never a hidden priority.
    const callerSteering = spec.loopOptions?.steering;
    const childSteering = {
      take: (): string | undefined =>
        (callerSteering !== undefined ? callerSteering.take() : undefined) ?? entry.mailbox.take(),
    };
    let runInfo: SubagentRunInfo | undefined;
    try {
      let report = await runSubagent({
        model: spec.model,
        allTools: spec.allTools,
        subagentType: toSubagentType(spec.role),
        prompt: spec.prompt,
        // ω99-5b §B: a schema'd spawn names the finishing tool — a captured
        // final_output tool_use becomes the canonical-JSON report.
        ...(spec.reportSchema !== undefined ? { finalTool: REPORT_FINAL_TOOL } : {}),
        // M80: the explicit image hand-off (fresh isolated children only —
        // the incompatible combinations fail closed inside runSubagent).
        ...(spec.promptImages !== undefined && spec.promptImages.length > 0 ? { promptImages: spec.promptImages } : {}),
        forkFrom: spec.forkFrom,
        canUseTool: spec.canUseTool,
        onEvent: spec.onEvent,
        session: spec.session,
        onBeforeResume: spec.onBeforeResume,
        ...(spec.subagentHooks !== undefined ? { subagentHooks: spec.subagentHooks } : {}),
        ...(spec.runHooks !== undefined ? { runHooks: spec.runHooks } : {}),
        // ω99-57: the mail edge rides background children too.
        ...(spec.parentMail !== undefined ? { parentMail: spec.parentMail } : {}),
        graceTools: spec.graceTools ?? options.graceTools,
        loopOptions: {
          ...spec.loopOptions,
          maxTurns: spec.maxTurns ?? spec.role.maxTurns ?? options.childTurns,
          // Abort linking: the registry owns the child's signal — a spawn's
          // own signal would sever the parent-abort chain, so it is ignored.
          signal: entry.controller.signal,
          // ω99-60: parent steers ride the loop's existing drain (the same
          // path as user steering — the loop's own gate/events/persistence).
          steering: childSteering,
        },
        onResult: (info) => { runInfo = info; },
      });
      let reportValid: boolean | undefined;
      let reportErrors: readonly string[] | undefined;
      if (spec.reportSchema !== undefined) {
        if (options.validateReport === undefined) {
          // Fail-closed: a constraint nobody can check must be LOUD, not a
          // silent pass.
          reportValid = false;
          reportErrors = ["reportSchema requested but no validateReport callback was injected into the registry"];
        } else {
          reportErrors = options.validateReport(report, spec.reportSchema);
          reportValid = reportErrors.length === 0;
        }
      }
      // ω99-5b §C: ONE bounded repair round for an invalid schema'd report —
      // resume the SAME child transcript with the violation list, so the fix
      // is a correction, not a re-run. Gating: needs the validator (a
      // repair nobody can re-judge is pointless) and a resumable session
      // (mode new/resume with a KNOWN id — a session-fork wrote to a fresh
      // fork-<uuid> the registry never sees; a sessionless spawn left no
      // transcript at all). A failed repair keeps the original marking and
      // report untouched (reportValid:false + reportErrors stay as-is).
      if (
        reportValid === false && repairRounds > 0
        && spec.reportSchema !== undefined && options.validateReport !== undefined
        && spec.session !== undefined && spec.session.mode !== "fork" && spec.session.id !== undefined
      ) {
        const repair = reportRepairPrompt(reportErrors ?? []);
        const repaired = await runSubagent({
          model: spec.model,
          allTools: spec.allTools,
          subagentType: toSubagentType(spec.role),
          prompt: repair,
          // The exact corrective bytes, not the "[resume] " steering default.
          onBeforeResume: () => repair,
          session: { mode: "resume", id: spec.session!.id, store: spec.session!.store },
          ...(spec.reportSchema !== undefined ? { finalTool: REPORT_FINAL_TOOL } : {}),
          // ω99-57: the corrective round keeps the child's mail edge (same
          // child, same identity — a repair-round send is legal, if unusual).
          ...(spec.parentMail !== undefined ? { parentMail: spec.parentMail } : {}),
          // The repair round is NOT budget work: no grace whitelist, and its
          // own fuse is 2 turns (emit the fix, end the turn).
          graceTools: [],
          loopOptions: {
            ...spec.loopOptions,
            maxTurns: 2,
            // Abort linking survives the corrective round (same child).
            signal: entry.controller.signal,
            // ω99-60: the mailbox survives too — a steer submitted during a
            // repair round drains there instead of being silently dropped.
            steering: childSteering,
          },
          canUseTool: spec.canUseTool,
          onEvent: spec.onEvent,
          // Lifecycle hooks stay on the FIRST run — a corrective round must
          // not re-fire SubagentStart for the same child (M63-B exactly-once).
        });
        if (options.validateReport(repaired, spec.reportSchema).length === 0) {
          report = repaired;
          reportValid = true;
          reportErrors = [];
        }
      }
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // 121 项 1 — a child that ran to completion is a capacity-healthy
      // observation (the provider served every one of its calls): additive
      // recovery pressure on the gate. Fired BEFORE settle so the slot-free
      // pump that follows already sees the raised admission.
      options.concurrencyGate?.onSuccess();
      settle(entry, {
        id: entry.id,
        role: spec.role.id,
        ok: true,
        report,
        budgetLimited: runInfo?.budgetLimited === true ? true : undefined,
        workerReport: runInfo?.budgetLimited === true ? synthesizeWorkerReport(entry.id, runInfo) : undefined,
        reasoning,
        reportValid,
        reportErrors,
        ...(runInfo !== undefined
          ? {
              turns: runInfo.turns,
              budget: {
                ...(spec.suggestedBudget !== undefined ? { suggested: spec.suggestedBudget } : {}),
                used: runInfo.turns,
                budgetLimited: runInfo.budgetLimited === true,
              },
            }
          : {}),
      });
    } catch (err) {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // 121 项 1 — a child that DIED of an overload-class failure is the
      // strongest throttle signal the registry can observe itself (the retry
      // ladder already absorbed every mid-flight 429 it could). Classification
      // is injected (isThrottleFailure) — core stays provider-classification
      // -free; absent classifier = absent signal (a foreground 400 death says
      // nothing about capacity).
      if (options.concurrencyGate !== undefined && options.isThrottleFailure?.(err) === true) {
        options.concurrencyGate.onThrottle();
      }
      settle(entry, {
        id: entry.id,
        role: spec.role.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        report: "(agent failed)",
        reasoning,
      });
    }
  };

  const pump = (): void => {
    while (active < admissionLimit() && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      active += 1;
      void runChild(next).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  const abortAll = (): void => {
    for (const entry of entries.values()) {
      cancelEntry(entry, "(aborted by parent)");
    }
  };

  if (options.signal) {
    const signal = options.signal;
    if (signal.aborted) abortAll();
    else signal.addEventListener("abort", () => abortAll(), { once: true });
  }

  const liveCount = (): number => {
    let n = 0;
    for (const e of entries.values()) if (e.status === "queued" || e.status === "running") n += 1;
    return n;
  };

  return {
    spawn(spec) {
      if (liveCount() >= hardCap) {
        throw new Error(`agent registry hard cap (${hardCap} live agents) exceeded — await or cancel before spawning more`);
      }
      // M31 §1: pairwise overlap with every LIVE scoped agent. Warning by
      // default; strictOverlaps refuses the spawn outright.
      const writeScope = spec.writeScope !== undefined && !isWriteScopeEmpty(spec.writeScope) ? spec.writeScope : undefined;
      const overlapWith: string[] = [];
      const warnings: string[] = [];
      if (writeScope !== undefined) {
        for (const live of entries.values()) {
          if (live.status !== "queued" && live.status !== "running") continue;
          const other = live.spec.writeScope;
          if (other === undefined || isWriteScopeEmpty(other)) continue;
          const shared = intersectWriteScopes(writeScope, other);
          if (shared.length === 0) continue;
          overlapWith.push(live.id);
          warnings.push(
            `write-scope overlap with ${live.id} (${formatWriteScope(other)}): shared ${shared.map((s) => `${s.kind === "root" ? "root" : "file"} ${s.path}`).join(", ")}`,
          );
        }
        if (overlapWith.length > 0 && strictOverlaps) {
          throw new Error(`spawn refused: write-scope overlap with ${overlapWith.join(", ")} (${warnings.join("; ")}) — strictOverlaps is on; await them or narrow the task write scope`);
        }
      }
      counter += 1;
      const id = `bg-${counter}`;
      let resolveDone!: (result: RegistryResult) => void;
      const done = new Promise<RegistryResult>((resolve) => { resolveDone = resolve; });
      const entry: Entry = {
        id,
        spec,
        controller: new AbortController(),
        status: "queued",
        resolveDone,
        done,
        ...(writeScope !== undefined ? { writeScope } : {}),
        overlapWith,
        mailbox: createSteerMailbox(),
      };
      entries.set(id, entry);
      queue.push(entry);
      pump();
      return { id, done, warnings };
    },

    async awaitAgents({ ids, mode = "all" }: AwaitSpec): Promise<readonly RegistryResult[]> {
      if (ids.length === 0) throw new Error("agent_await: no agent ids given (empty ids can never settle for any/race)");
      const targets = ids.map((id) => {
        const entry = entries.get(id);
        if (!entry) throw new Error(`unknown agent id: ${id}`);
        return entry;
      });
      if (mode === "race") {
        return [await Promise.race(targets.map((e) => e.done))];
      }
      if (mode === "any") {
        return new Promise<readonly RegistryResult[]>((resolve, reject) => {
          let pending = targets.length;
          const failures: RegistryResult[] = [];
          for (const entry of targets) {
            void entry.done.then((result) => {
              if (result.ok) {
                resolve([result]);
                return;
              }
              failures.push(result);
              pending -= 1;
              if (pending === 0) {
                reject(new Error(`agent_await any: every agent failed — ${failures.map((f) => `${f.id}: ${f.error ?? "failed"}`).join("; ")}`));
              }
            });
          }
        });
      }
      const results = await Promise.all(targets.map((e) => e.done));
      if (mode === "all") {
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          throw new Error(`agent_await all: ${failed.map((f) => `${f.id}: ${f.error ?? "failed"}`).join("; ")}`);
        }
      }
      return results;
    },

    status: ((id?: string) => {
      if (id !== undefined) {
        const entry = entries.get(id);
        return entry === undefined
          ? undefined
          : {
              id: entry.id,
              role: entry.spec.role.id,
              status: entry.status,
              ...(entry.writeScope !== undefined ? { writeScope: formatWriteScope(entry.writeScope) } : {}),
              ...(entry.spec.callId !== undefined ? { callId: entry.spec.callId } : {}),
              ...(entry.spec.parentCallId !== undefined ? { parentCallId: entry.spec.parentCallId } : {}),
            };
      }
      return [...entries.values()].map((e) => ({
        id: e.id,
        role: e.spec.role.id,
        status: e.status,
        ...(e.writeScope !== undefined ? { writeScope: formatWriteScope(e.writeScope) } : {}),
        ...(e.spec.callId !== undefined ? { callId: e.spec.callId } : {}),
        ...(e.spec.parentCallId !== undefined ? { parentCallId: e.spec.parentCallId } : {}),
      }));
    }) as AgentRegistry["status"],

    cancel(id: string): boolean {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.status !== "queued" && entry.status !== "running") return false;
      cancelEntry(entry, "(cancelled)");
      return true;
    },

    // ω99-60: the parent→child steer edge. State-checked against the SAME
    // live predicate settle/cancel use (queued|running): a settled child
    // (done|failed|aborted) refuses — an awaited child stays running, so a
    // steer during a pending agent_await is legal (pinned by test).
    steer(id: string, content: string): void {
      const entry = entries.get(id);
      if (entry === undefined) {
        throw new Error(`unknown agent id: ${id}`);
      }
      if (entry.status !== "queued" && entry.status !== "running") {
        throw new Error(`agent ${id} already settled (status: ${entry.status}) — steer is only possible while queued or running`);
      }
      // The attribution is composed HERE — the model never supplies it.
      entry.mailbox.submit(formatSteerText(content));
    },

    abortAll,
  };
}
