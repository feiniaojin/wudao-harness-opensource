import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage, Terminal } from "./types.js";
import type { Tool, OutputDelta, IdentifiedToolUpdateFn } from "./tool.js";
import { validateToolArguments, normalizeToolArguments, formatArgsNormalizedLine, validateToolOutputResult, didYouMean } from "./tool.js";
import type { ModelClient, ModelUsage, TerminalRepairKind } from "./model-client.js";
import { isContextLengthError, isMaxTokensThinkingBudgetConflict, hasConfigCapConflict, isQuotaParkError } from "./model-client.js";
import type { AgentState } from "./state.js";
import type { MicrocompactOptions, SkillReadMap, Tier2Result } from "./compaction.js";
import { tier2Compact, dualTier2Compact, messageEntryId } from "./compaction.js";
import { alignedCutoff, emergencyDrop, clearTier, microcompact } from "./compaction-tiers.js";
import { SUMMARY_MARKER, CompactionThrashError } from "./compaction-markers.js";
import { compactableSpan, staticTier2Compact, countSummaryMarkers } from "./compaction-tier2-static.js";
import { VERIFIED_WORK_CAP, verifiedRunHead } from "./compaction-riders.js";
import { worldStateDiff, type WorldState } from "./window-chain.js";
import { boundaryContinuationNote, deferReasonDetail, estimateCompactableTokens, CompactionEconomicsReport, CompactionEconomicsTracker, economicsReport, latestBoardIncomplete, type CachePricing, type CompactionEconomicsDecision } from "./compaction-economics.js";
import { estimateTokens } from "./compaction-estimation.js";
import { isAbortError } from "./compaction-summarizer.js";
import { parseTodoBoard } from "./tools/todo.js";
import { consultTaskHook, lastBoardItems, parseTodoItems, todoTransitionDelta, type TaskHookDecision } from "./todo-transition.js";
export type { TaskHookDecision, TaskTransitionItems } from "./todo-transition.js";
import { createDeferController } from "./defer.js";
// PB-1 探针基础设施：loop 两挂载点（transition 转发 + 工具装饰）；关=原样透传。
import { probeAgentLoop, probeTools } from "./probe.js";
// 借鉴弧 δ（penguin 367ab084 思想）— 运行中工具调用转后台的端口族。
import { BACKGROUNDED_TOOL_RESULT, type DetachedCall, type ToolDetachPort } from "./detach.js";
// 拆分运动（借鉴弧 δ 顺带件）：纯合成层/赛跑机器外提至 loop-synthetics.ts
// （逐字节搬家；re-export 维持既有公共面——index.ts 与 tests 的导入路径不动）。
import {
  classifyTurnRetryError, DEFAULT_MAX_TURNS, STOP_BLOCK_CAP,
  TRUNCATED_TOOL_CALL_RESULT, ABORTED_UNKNOWN_TOOL_RESULT, ABORTED_NOT_STARTED_TOOL_RESULT,
  PERSIST_FAILED_TOOL_RESULT, OUTPUT_LIMIT_NUDGE, DEFAULT_OUTPUT_LIMIT_NUDGES,
  isZeroOutputOverflow, EMPTY_FINAL_NUDGE, DEFAULT_EMPTY_FINAL_NUDGES,
  TURN_RECOVERY_NOTE, MAX_TURN_RECOVERY_ATTEMPTS,
  isBackgroundOverloadError, createAbortRace, formatTimeReminderNote,
  ToolTimeoutError, raceToolTimeout, ContextOverflowHardError,
  type TurnRetryClass,
  CONTENT_FILTER_GUIDANCE,
} from "./loop-synthetics.js";
export {
  classifyTurnRetryError, DEFAULT_MAX_TURNS, STOP_BLOCK_CAP,
  TRUNCATED_TOOL_CALL_RESULT, ABORTED_UNKNOWN_TOOL_RESULT, ABORTED_NOT_STARTED_TOOL_RESULT,
  PERSIST_FAILED_TOOL_RESULT, OUTPUT_LIMIT_NUDGE, DEFAULT_OUTPUT_LIMIT_NUDGES,
  isZeroOutputOverflow, EMPTY_FINAL_NUDGE, DEFAULT_EMPTY_FINAL_NUDGES,
  TURN_RECOVERY_NOTE, MAX_TURN_RECOVERY_ATTEMPTS, ContextOverflowHardError,
} from "./loop-synthetics.js";
export type { TurnRetryClass } from "./loop-synthetics.js";
import { detectLoop, advanceNoProgress, NO_PROGRESS_CLEAN } from "./loop-safety.js";
import type { LoopSafetyCall, LoopSafetyTurn, NoProgressState } from "./loop-safety.js";
// ω-1b — the loop's two tool-result guards (goose digest 98a): the repetition
// circuit breaker and the generic large-result shaping backstop. Both ride
// ONE run-scoped seam around executeToolCall (see executeGuardedToolCall).
import { createRepetitionInspector, repetitionBreakerMessage } from "./tools/repetition.js";
import { shapeGenericToolResult, UNSHAPED_TOOLS, type GenericResultShaping } from "./tools/generic-result.js";
// 125 项 1 — the model-side context-rotation port (new_context 工具的运行期接线).
import { AGENT_ROTATION_CAP } from "./tools/new-context.js";
import type { AgentRotationRequest, AgentRotationOutcome, NewContextPortBox } from "./tools/new-context.js";
// ω-4b — the reflection fork at the second loop verdict (one direct
// challenger call, prefix-shared; see loop-reflection.ts for the contract).
import { runReflectionFork, windowDigest, REFLECTION_KINDS, REFLECTION_DEFAULT_TIMEOUT_MS } from "./loop-reflection.js";
import type { ReflectionOptions } from "./loop-reflection.js";
import type { TurnProfileRecorder } from "./turn-profile.js";
import type { SessionBudget } from "./session-budget.js";
// 124b 项 1（codex instant_interrupt）——流抢占通道：steering 提交即时中断
// 在飞模型流（详见 stream-preempt.ts 的契约注释）。
import type { StreamPreemptChannel } from "./stream-preempt.js";
// 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线 —— effectiveThreshold
// 与 CLI 的 context_remaining 工具共享的单一真值点。
import { resolveCompactionThresholdTokens, DEFAULT_COMPACTION_THRESHOLD_RATIO, DEFAULT_COMPACTION_HEADROOM_TOKENS } from "./compaction-threshold.js";
export type { StreamPreemptChannel } from "./stream-preempt.js";

export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; reason?: string };

/** M63-A: a SessionStart hook's firing reason — the session-boundary sources.
 *  Fired by the DRIVER (or a frontend that drives the loop directly), never
 *  by the loop itself: startup (fresh session), resume (history adopted —
 *  boot --resume or a runtime /resume), clear (/clear), compact (the session
 *  continues across a compaction boundary), fork (--fork-session). */
export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | "fork";

/** M63-A: the Notification hook's kind — what the surface is asking the
 *  user's attention FOR. "permission" = a permission ask is waiting for the
 *  human; "idle" = a run settled and the interface is idle again. Driver-
 *  fired; the loop never calls it. */
export type NotificationKind = "permission" | "idle";

/** M63-A: one executed call of a turn's tool batch, as the PostToolBatch
 *  hook sees it. Denied/hook-blocked/truncated calls never executed and are
 *  absent (the same "actually executed" doctrine as onPostToolUse). */
export interface PostToolBatchCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly isError: boolean;
  readonly result: string;
  /** ω-5b (I21): the per-call wall time mirrored from the finished event —
   *  gate + execution, performance.now(), omit-never-null on executed calls
   *  (the same discipline as the provenance annotation). */
  readonly durationMs?: number;
}

/** M63-A: the PostToolBatch decision. "allow" (or void) = the loop continues
 *  to the next model call; {continue:false} = the run ENDS at this batch
 *  boundary (Terminal.postToolBatchStop — the batch-level gate: "do not
 *  continue past this batch"). The Stop-hook spelling on purpose. */
export type PostToolBatchDecision = "allow" | { continue: false; reason?: string };

/** M63-B: SubagentStart/Stop sources — the child agent's type name (the
 *  roster role: general-purpose/coder/fork/plugin roles). */
export type SubagentStopDecision = StopHookDecision;

/** M64-C §C — the TeammateIdle hook's continuation verdict. */
export type TeammateIdleDecision =
  | { readonly continue: false }
  | { readonly continue: true; readonly feedback?: string };

/** M63-B: ConfigChange positions — which config surface changed. user =
 *  ~/.wudao/settings.json, project = .wudao/settings.json, local =
 *  .wudao/settings.local.json, skills = the skills root. */
export type ConfigChangePosition = "user" | "project" | "local" | "skills";

/** M63-B: the ConfigChange decision — block VETOES the change (the hot-reload
 *  consumer keeps the previously accepted snapshot; batch B: the permission
 *  rules watcher). void/"allow" = the change applies. */
export type ConfigChangeDecision = void | "allow" | { block: true; reason?: string };

/** M63-B: InstructionsLoaded sources. session_start = the session's prompt/
 *  context load at creation; path_glob_match = a gated context rule injected
 *  after a matching read (M62 §1); compact = the standing compact
 *  instructions woven into a compaction. nested_traversal is an accepted
 *  matcher value with NO firing seam yet (we do not traverse nested dirs for
 *  instructions — documented inert until one exists). */
export type InstructionsLoadedSource = "session_start" | "nested_traversal" | "path_glob_match" | "compact";

/** M63-B: SessionEnd sources — clear (/clear), resume (a session adoption
 *  ended the previous one), exit (frontend shutdown), other (fallback for
 *  future teardown paths). */
export type SessionEndSource = "clear" | "resume" | "exit" | "other";

/** M63-B: StopFailure kinds — the error class of a failed run: "context" for
 *  the ContextLengthError family (overflow), "error" for everything else. */
export type StopFailureKind = "context" | "error";

// Lifecycle hooks. Observer hooks (onRunStart/onPreCompact/onPostCompact/
// onPostToolUse) must never crash the loop; gate hooks (onRunStop/
// onPromptSubmit) degrade to "allow"/the original prompt when they throw, and
// a throwing onPreToolUse degrades to allow-with-warning posture (same
// precedent: the run continues, the interceptor's block is not honored).
// M63-A adds: the failure/batch tool faces (loop-fired), the compact trigger
// word + PreCompact deferral (loop-fired), and three session-surface events
// (SessionStart/Notification: driver-fired; PermissionRequest: permission-
// pipeline-fired — the loop itself never calls those three; they live on this
// one interface so every frontend threads ONE hook object).
export interface AgentHooks {
  onRunStart?(state: AgentState): void | Promise<void>;
  /** M61 §3: the stop hook is BLOCKING. Three shapes: "allow" (stop),
   *  {block:true,reason} (run one more turn with the reason injected as
   *  `[stop blocked] …`), and the prompt-hook spelling {continue:false} —
   *  equivalent to block (the CC Stop-hook contract). Block cap: three
   *  CONSECUTIVE continuations without any tool use end the run instead
   *  (the stall guard's official semantics — the caller learns via
   *  Terminal.stopBlockCapped). */
  onRunStop?(state: AgentState): StopHookDecision | Promise<StopHookDecision>;
  onPromptSubmit?(prompt: string): string | { block: true; reason: string } | Promise<string | { block: true; reason: string }>;
  /** M63-A: the trigger word joins the payload — "manual" (driver /compact)
   *  vs "auto" (every loop-internal compaction: threshold/boundary/immediate
   *  — the loop never says "manual"). Now BLOCKING in the DEFER direction:
   *  returning {defer:true,reason} skips THIS compaction (it re-arms on the
   *  next occupancy check; the reactive tier is exempt — deferring the
   *  post-413 emergency compact would guarantee a hard failure). A throw or
   *  timeout degrades to "compact anyway" (memory safety beats the hook). */
  onPreCompact?(messages: readonly AgentMessage[], trigger: "manual" | "auto"): PreCompactDecision | Promise<PreCompactDecision>;
  /** M63-A: same trigger word, pure observer (a compact that ran — manual or
   *  auto — just landed). */
  onPostCompact?(messages: readonly AgentMessage[], trigger: "manual" | "auto"): void | Promise<void>;
  /** M33 §2: before EVERY tool call, BEFORE canUseTool. Interceptor: returning
   *  {block:true,reason} skips execution — the model receives an error tool
   *  result `blocked by hook: <reason>`. M63-C §2 adds the EXPLICIT rewrite
   *  contract: returning {updatedInput} replaces the call's arguments — the
   *  rewritten input is what validation and the tool see (the CC
   *  updatedInput semantics, made explicit for our rewrite class). A throw
   *  degrades to allow (fail-open, same posture as the other gate hooks) —
   *  never a crashed run. */
  onPreToolUse?(toolName: string, input: Record<string, unknown>): PreToolUseDecision | Promise<PreToolUseDecision>;
  /** M33 §2: after a tool call that actually EXECUTED (denied/hook-blocked
   *  calls never fire it). Observer: sees (name, input, result-content);
   *  throws are isolated and can never break the run.
   *  M62 §5 — the additionalContext channel: a hook may RETURN a string;
   *  it is projected at the NEXT model call of the run as a suffix note
   *  (same <system_note> projection as the MetaNote channel — appended
   *  into the last tool_result tail, projection-only, cache-safe). void =
   *  pure observer, exactly the pre-M62 contract. */
  onPostToolUse?(toolName: string, input: Record<string, unknown>, result: string): void | string | Promise<void | string>;
  /** M63-A: the failure face — after an EXECUTED call that ERRORED (denied/
   *  hook-blocked calls never fire it; onPostToolUse already saw every
   *  executed call — this is the dedicated failure surface). Observer;
   *  throws are isolated. */
  onPostToolUseFailure?(toolName: string, input: Record<string, unknown>, result: string): void | Promise<void>;
  /** M63-A: the batch face — after a turn's whole tool batch landed (all
   *  executed calls + outcomes; ≥1 executed call required), before the next
   *  model call. BLOCKING in the CONTINUE direction: {continue:false} ends
   *  the run at this batch boundary (Terminal.postToolBatchStop) — the stop
   *  gates/onRunStop are skipped, the hook already decided. Throws degrade
   *  to allow. */
  onPostToolBatch?(batch: readonly PostToolBatchCall[]): PostToolBatchDecision | Promise<PostToolBatchDecision>;
  /** M63-A (driver-fired): a session boundary was crossed. Observer; the
   *  driver isolates failures. cc-plugins E4: a layer may RETURN a string —
   *  the CC SessionStart context contract (hookSpecificOutput.
   *  additionalContext); the driver parks it on the MetaNote projection so
   *  it reaches the first model call without touching persisted history. */
  onSessionStart?(source: SessionStartSource, info: { readonly sessionId?: string }): void | string | Promise<void | string>;
  /** M63-A (driver-fired): the interface wants the user's attention — a
   *  permission ask is waiting, or a run settled. Observer. */
  onNotification?(kind: NotificationKind, info: { readonly sessionId?: string }): void | Promise<void>;
  /** M63-A (permission-pipeline-fired): the deterministic policy engine —
   *  consulted AFTER the static deny rules and BEFORE the sidecar/human ask
   *  (the CLI's withPermissionRequestHook layer owns that order). Returning
   *  a DECISION (allow or deny) answers the request outright; undefined =
   *  no opinion, the pipeline continues untouched. The loop never calls
   *  this — it rides AgentHooks so all frontends thread one object. */
  onPermissionRequest?(toolName: string, input: Record<string, unknown>): PermissionDecision | undefined | Promise<PermissionDecision | undefined>;
  /** M63-B (loop-fired): a todo_write call carries NEW board items. Fired in
   *  the per-call gate BEFORE canUseTool; {block:true} refuses the write
   *  (error tool result naming the reason). void = allow. */
  onTaskCreated?(items: readonly string[], board: { readonly total: number; readonly done: number }): TaskHookDecision | Promise<TaskHookDecision>;
  /** M63-B (loop-fired): a todo_write call moves items to done. Same gate,
   *  same block semantics as onTaskCreated (created consults first). */
  onTaskCompleted?(items: readonly string[], board: { readonly total: number; readonly done: number }): TaskHookDecision | Promise<TaskHookDecision>;
  /** M63-B (child-loop-fired, via runSubagent's subagentHooks): a child agent
   *  run started. Observer. */
  onSubagentStart?(agentType: string, info: { readonly sessionId?: string }): void | Promise<void>;
  /** M63-B (child-loop-fired): a child agent run is about to stop. BLOCKING
   *  keeps the child working one more turn (the Stop-hook mechanics and cap,
   *  reused verbatim by the child loop). */
  onSubagentStop?(agentType: string, state: AgentState): SubagentStopDecision | Promise<SubagentStopDecision>;
  /** M64-C §C: a teammate went idle (its work run settled). The hook may
   *  CONTINUE the teammate (exit 2 / {"continue":true,"feedback}) — the
   *  teammate works one more round carrying the feedback (反馈续跑). No
   *  opinion / plain exit 0 → the teammate stays idle. */
  onTeammateIdle?(agent: string, info: { readonly error?: string }): TeammateIdleDecision | Promise<TeammateIdleDecision> | void;
  /** M63-B (watcher-fired): a watched file changed (literal filename
   *  matcher; the CLI watcher also delivers the change to the model through
   *  the steering channel). Observer. */
  onFileChanged?(path: string): void | Promise<void>;
  /** M63-B (watcher-fired): a config surface changed. {block} VETOES the
   *  change at the hot-reload consumer (batch B: the permission rules
   *  watcher keeps the previously accepted rules; the skills position is
   *  advisory-only — no reload consumer yet). */
  onConfigChange?(position: ConfigChangePosition, info: { readonly path?: string }): ConfigChangeDecision | Promise<ConfigChangeDecision>;
  /** M63-B (loop/driver-fired): instructions entered the context — a gated
   *  rule after a matching read (path_glob_match), the standing compact
   *  rider woven into a compaction (compact), or the session's startup
   *  context load (session_start, driver-fired). Observer. */
  onInstructionsLoaded?(source: InstructionsLoadedSource, info: { readonly detail?: string }): void | Promise<void>;
  /** M63-B (driver-fired): a session boundary ENDED a session. ALL SessionEnd
   *  hook commands share a 1.5s budget at the bridge (over-budget kill);
   *  the driver fires this VOIDED so teardown never waits on hooks.
   *  R1 fix: the FIRING site passes budgetEndsAt (epoch ms) so every composed
   *  layer — config, plugins, extensions — shares ONE deadline; a layer
   *  without it falls back to its own window (direct callers). */
  onSessionEnd?(source: SessionEndSource, info: { readonly sessionId?: string; readonly budgetEndsAt?: number }): void | Promise<void>;
  /** M63-B (driver-fired): a run settled in error — the error class is the
   *  matcher value. Observer. */
  onStopFailure?(kind: StopFailureKind, info: { readonly message?: string; readonly sessionId?: string }): void | Promise<void>;
  /** ω-5b (R9): assert the per-call hook faces are concurrency-safe (pure
   *  observers — no writes, no shared mutable state). DEFAULT ABSENT → any
   *  configured per-call hook face (onPreToolUse / onTaskCreated /
   *  onTaskCompleted) takes the SEQUENTIAL batch path: production hooks are
   *  arbitrary external commands, and two concurrent hook invocations
   *  appending to one log or read-modify-writing shared state race
   *  (Reasonix 56f72ef80). Fail-closed: the CLI bridge does NOT assert this
   *  in v1; embedders with observe-only hooks may. canUseTool is NOT a hook
   *  face — the M45 read-gate parallelism survives regardless. */
  readonly toolHooksConcurrencySafe?: boolean;
}

/** M63-A: the PreCompact decision. void/"compact" = proceed;
 *  {defer:true,reason} = skip THIS compaction (re-arms next turn). */
export type PreCompactDecision = void | "compact" | { defer: true; reason?: string };

/** M63-C §2: the PreToolUse decision — block skips execution (error tool
 *  result naming the reason); {updatedInput} rewrites the call's arguments
 *  (validation and execution see the REWRITTEN input); void = observe-only. */
export type PreToolUseDecision =
  | void
  | { block: true; reason: string }
  | { updatedInput: Record<string, unknown> };

/** M61 §3 — the blocking Stop-hook decision (prompt-based stop hook). */
export type StopHookDecision = "allow" | { block: true; reason: string } | { continue: false; reason?: string };

/** ω99-48 (dsh 候选 7 v2, attempt log-only settlement): the session entry a
 *  FAILED streaming attempt settles through — the log-only record of what the
 *  UI already rendered when the stream died mid-flight (network cut, gateway
 *  5xx, stream error) and the run is about to rethrow. Rides the M35 §2
 *  generic-entry channel (appendEntry), is NEVER a message, and NEVER enters
 *  the model-visible history: context projection is untouched, so the prefix
 *  cache pays nothing (dsh needed an entire format v2 for this settlement —
 *  the entry model needs no migration). The `type` string is the contract,
 *  byte-for-byte. */
export interface AssistantAttemptEntry {
  readonly type: "assistant_attempt";
  readonly data: {
    /** The delivered text prefix ("" when only reasoning streamed). */
    readonly content: string;
    /** The delivered reasoning prefix ("" when none streamed). */
    readonly reasoning: string;
    /** The failed attempt's usage row EXACTLY as the provider reported it —
     *  the input/cache-hit bytes make the failure side of M24's compensation
     *  diagnostics observable for the first time. Absent when the stream died
     *  before any usage arrived (most mid-stream failures — usage rides the
     *  final chunk). */
    readonly usage?: ModelUsage;
    /** ISO timestamp of the settlement. */
    readonly at: string;
    /** The failing error's text — diagnosis, not a rethrow vehicle. */
    readonly error: string;
  };
}

export interface LoopOptions {
  readonly maxTurns?: number;
  // run-budget (2026-08-24): the run-level cooperative wall-clock budget —
  // the controllable upper bound evals/schedules/server deployments need.
  // When set, each turn TOP (before the model call — compaction, probes, the
  // steering drain, the call itself) checks `now() - runStart > maxRunMs`
  // and exits through the typed terminal {reason:"run_budget_exhausted"}.
  // COOPERATIVE by design: a model call or tool batch that already started
  // always finishes — the fuse never preempts mid-flight (the preemptive
  // mechanism is `signal`/abort, a separate concern). Two consequences of
  // the top-of-turn placement: queued steering is NOT consumed on the exited
  // turn (the drain runs later in the iteration), and nothing is appended to
  // history or projected into the request — the exit is invisible to the
  // provider prefix cache. undefined = no budget = zero behavioral change
  // (not even the clock is read).
  readonly maxRunMs?: number;
  // The clock the budget reads. Injectable for deterministic tests (the
  // package's existing injection shape — scheduler's/monitor's
  // `deps.now ?? Date.now`); absent = Date.now. Never called when maxRunMs
  // is undefined.
  readonly now?: () => number;
  // 夜移 013 — 输出上限恢复梯 (真 CC tiered max_output_tokens recovery 的
  // nudge-only 适配): a stop_reason:"length" TEXT truncation (no tool calls
  // — M70's guard owns that case) is followed by ONE resume-mid-thought
  // user note (OUTPUT_LIMIT_NUDGE) and a fresh model call, up to maxNudges
  // consecutive times; exhaustion ends the run through TerminalReason
  // "output_limit". Pure append (the truncated assistant stays in history),
  // so the prefix cache is untouched. escalateTo, when set, raises the
  // CONTINUATION call's completion cap (maxTokens) — supply it from the
  // provider profile, never a magic 64k (DeepSeek hard-caps at 8k and 400s
  // above); it is skipped on turns whose request already carries a cap
  // (admission clips own those). Absent object = ladder ON, maxNudges 3,
  // no escalation; {maxNudges: 0} = opt-out.
  readonly outputLimitRecovery?: {
    readonly escalateTo?: number;
    readonly maxNudges?: number;
  };
  // 夜移 024 — the empty-final guard: a final-answer turn with NO visible
  // content (no tool calls, content trims to empty) gets one synthetic user
  // nudge before the run may complete blank. Absent object = guard ON,
  // maxNudges 1; {maxNudges: 0} = opt-out. The budget counts CONSECUTIVE
  // blank finals — any tool round resets it. Length-cut blanks are 013's,
  // never this guard's.
  readonly emptyFinalRecovery?: {
    readonly maxNudges?: number;
  };
  readonly hooks?: AgentHooks;
  // ω99-49 — the run's streaming-output subscription: handed to every tool
  // execution as `execute(args, onUpdate)`'s optional second parameter (the
  // consumer subscribes per-call by swapping the function between runs or
  // calls — the loop only threads it). Deltas are OBSERVER traffic: they
  // never enter history, transcript, or any model-visible face, so the
  // append-only/prefix-cache discipline (M24) is untouched. Absent → every
  // tool's execute receives undefined and behavior is byte-identical to
  // today (single-parameter call shape).
  // ω99-63: the consumer is IDENTIFIED — the loop's single executeToolCall
  // point enriches every delta with toolCallId/toolName before delivery (a
  // per-call-site closure capture is not required), while tools still only
  // ever see the base ToolUpdateFn face.
  readonly onToolUpdate?: IdentifiedToolUpdateFn;
  // Before each tool call. Deny → the tool is NOT executed; the model receives
  // an error tool result "permission denied[: reason]". Async so callers can prompt a human.
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>) => PermissionDecision | Promise<PermissionDecision>;
  // Microcompaction: before each model call, when the context occupancy
  // (M24: max(estimate, last reported prompt tokens)) crosses 0.8 ×
  // contextWindowTokens, old large tool results are replaced with a
  // deterministic stub (tier-2 LLM summary when that isn't enough). A
  // `compacted` event is emitted only when the estimate actually shrank
  // (after < before), so we don't re-log every turn once the context is
  // exhausted (Tier-2 gap).
  // `reserveTokens` is DEPRECATED (M24): the trigger threshold is now
  // 0.8 × contextWindowTokens regardless; the field is accepted so older
  // callers keep compiling but no longer shifts the trigger.
  readonly compaction?: {
    readonly contextWindowTokens?: number;
    /** @deprecated M24 — the trigger is 0.8 × contextWindowTokens. */
    readonly reserveTokens?: number;
    /** M48 §3: classify a successful tool call as a skill read (the ghost-skill
     *  marker seam). Called for every EXECUTED call; a match records the skill
     *  identity by toolCallId, and every compaction tier degrades that result
     *  to the canonical [SKILL_PRUNED: …] marker instead of losing it. (The
     *  compaction tiers' own `skillReads` option is the resulting MAP.) */
    readonly classifySkillRead?: (toolName: string, args: Record<string, unknown>) => { name: string; path: string } | undefined;
    /** M58 §C#2: STANDING compact instructions (the WUDAO.md/AGENTS.md
     *  `## Compact Instructions` section, parsed at session start by the CLI)
     *  woven into every tier-2 summary instruction this run — auto, boundary
     *  and reactive compactions alike. Absent = the status-quo instruction
     *  (byte-stable). Per-command focus is the manual /compact path's rider,
     *  not this one. */
    readonly compactInstructions?: string;
    /** M58 §C#12: the session's reasoning_effort riding every tier-2 summary
     *  request (ModelInput.reasoningEffort — the per-request override of the
     *  provider config's own effort field), so the summarizer reasons at the
     *  session's level. Absent = the provider config's (byte-identical
     *  options, nothing added). */
    readonly reasoningEffort?: string;
    /** ω-2b (I1-c): how the endpoint counts the context window — "shared"
     *  (prompt + completion draw on one window, DeepSeek), "independent", or
     *  "unknown" (default). Gates ONLY the proactive admission clip; the
     *  reactive ladder is trusted-parse-gated, never profile-gated. Threaded
     *  from the provider profile by the CLI wiring.
     *  125 项 1: also feeds the reserve-aware threshold via the CLI's
     *  resolveOutputReserveTokens (unknown ⇒ no reserve ⇒ flat ratio). */
    readonly windowMode?: "shared" | "independent" | "unknown";
    /** 125 项 1（dsh resolveCompactSpec 形）：平比帽的比例。缺省 0.8（M24
     *  以来的触发线，行为锚点）。触发线永远 ≤ ratio×window —— 预留感知
     *  只收紧、永不放宽。misc-config 家族 compaction.thresholdRatio。 */
    readonly thresholdRatio?: number;
    /** 125 项 1：触发线之下的固定安全余量（token）。缺省 2048。misc-config
     *  家族 compaction.headroomTokens。 */
    readonly headroomTokens?: number;
    /** 125 项 1：请求侧完成预留 —— 本会话请求实际携带的 maxTokens（CLI 从
     *  config.maxTokens / profile defaultMaxTokens 解析；windowMode 未画像
     *  或请求帽未知时缺省 undefined）。在场时触发线变为
     *  min(ratio×window, window − outputReserve − headroom)（长输出场景提前
     *  触发，prompt+maxTokens 撑爆窗口之前压缩；dsh 三次 1M 窗真实死亡的
     *  尸检背书）；缺席 = 平比，行为与 M24 逐字节一致。 */
    readonly outputReserveTokens?: number;
    /** 波次 7 #38 (OH C2): skip the tier-2 LLM summary when the span passes
     *  the digest sufficiency gate. Default TRUE (the gate is the safety);
     *  false restores the always-LLM path. Threaded straight into
     *  tier2Compact. */
    readonly zeroLlmDigest?: boolean;
    /** 借鉴弧 B1（SoL-Pi C1）：压缩经济学定价（cacheWriteReadRatio 由调用
     *  方从 providers 价目推导后传入，不暴露为用户配置；缺省=保守缺省，
     *  ratioSource:"default" 类型化）。 */
    readonly cachePricing?: CachePricing;
    /** 125 项 1（codex 窗口链）：窗口身份链。sessionKey = session id 短前缀；
     *  baseWindowCount = run 开始时 session entries 里已落的 compact_boundary
     *  条目数（driver 从 entries 数出——resume 后链继续而不是从 #1 重来）。
     *  每个 tier-2 边界把 summary message 头部带上
     *  `[context window #N | chain: … | first/prev]`（N = base + 本 run 已落
     *  边界数 + 1），事件携带 windowIndex，条目落 additive 字段。缺省 = 无
     *  身份行（status-quo 字节，pre-125 行为不变）。缓存声明（M24）：身份行
     *  骑在本来就要重写前缀的压缩边界上——零额外缓存代价。 */
    readonly windowIdentity?: {
      readonly sessionKey: string;
      readonly baseWindowCount: number;
    };
    /** 125 项 2（codex WorldState 差分）：轮转时注入「当前世界 vs 上一窗口
     *  末尾」的差分（goal 状态 + 文件变更 + 活跃工具），替代对事实的摘要
     *  转述。previous = 上一边界快照（driver 从最后一条 compact_boundary 的
     *  additive 字段读出；缺省=首次压缩→无差分注入，行为不变）；snapshot =
     *  压缩时的当前快照提取器（driver 侧：GoalState + 文件台账 + 工具面）。
     *  同 run 多次压缩时 previous 自动链到本 run 上一次快照。 */
    readonly worldState?: {
      readonly previous?: WorldState;
      readonly snapshot: () => WorldState;
    };
  } & MicrocompactOptions;
  /** 125 项 1（codex new_context 形）— the model-side context-rotation seam.
   *  Present → the loop installs its rotation port into `port` for THIS run's
   *  lifetime (the new_context tool's execute reaches it through the same box
   *  the host threaded into the tool factory) and honors the per-session
   *  budget: `rotationsUsed` is the count the host replayed from the session's
   *  context_rotation entries BEFORE this run; the loop adds its own fires on
   *  top and refuses past AGENT_ROTATION_CAP. Requires `compaction` (a
   *  rotation IS a tier-2 boundary); absent either → no port installed and
   *  the tool answers fail-closed. The rotation fires INSIDE the tool's
   *  execute (the receipt is an honest "already rotated, window N", never a
   *  promise), through the normal tier-2 path (M24: the boundary rewrites
   *  the prefix anyway — zero extra declared cache cost). */
  readonly contextRotation?: {
    /** The box shared with the tool factory (single-slot, host-created). */
    readonly port: NewContextPortBox;
    /** Model-side rotations THIS SESSION already spent before this run
     *  (replayed from the session lane; the host increments on the events). */
    readonly rotationsUsed: number;
  };
  // Cooperative cancellation for the whole run. Aborts surface as a
  // `{reason:"aborted"}` terminal — never as a thrown error out of the loop.
  readonly signal?: AbortSignal;
  // 借鉴弧 δ（v7 第三梯队，penguin-harness 367ab084 思想）— mid-flight
  // tool-call detach: the per-run request port. When present, every non-block
  // tool execution races a detach leg alongside the abort race; a request for
  // an in-flight callId wins that call's race WITHOUT cancelling it (detach
  // is "stop waiting", never "interrupt" — penguin's detachSignal/stop-signal
  // split): the call is answered in-history with BACKGROUNDED_TOOL_RESULT,
  // the still-running promise is handed to onDetachedCall, the batch's other
  // calls settle normally, and the run CLOSES at the turn boundary with
  // Terminal.backgrounded (the model is not called again — the user asked
  // for the conversation back; the landed result merges later through the
  // consumer's background lane, the ω-4a monitor seam's sibling).
  // Requests for block tools / unknown / finished calls are ignored here —
  // the surface typed-rejects them (defense in depth: block tools never arm
  // a race). Absent = zero behavior change (no controllers, no signal into
  // execute, byte-identical races).
  readonly toolDetach?: ToolDetachPort;
  /** 弧 δ: the collector for a detached execution. Fires ONCE, at detach
   *  time, synchronously from the race resolution; the consumer owns the
   *  promise from then on (it never rejects — executeToolCall normalizes
   *  every failure into an error result) and the controller (the ONLY
   *  sanctioned stop path: aborting it is how an explicit user stop kills a
   *  background task — 用户意图优先). Absent = the detached execution still
   *  runs out and its result is simply not collected (honest discard, no
   *  unhandled rejection — the loop attaches its own catch). */
  readonly onDetachedCall?: (detached: DetachedCall) => void;
  // 夜移 035 (codex turn_timing.rs): opt-in latency forensics for THIS run —
  // a six-bucket phase recorder owned by the CONSUMER (driver/CLI), created
  // before the run and completed+surfaced at its settle seam (the loop has
  // ~10 scattered terminal returns; the driver settle is the single choke
  // point). Absent = zero instrumentation overhead on the hot path.
  readonly turnProfile?: TurnProfileRecorder;
  // 波次 8 #45 (dsh session-checkpoint-policy): the pre-dispatch durability
  // barrier. Called ONCE per tool-carrying turn, after the assistant message
  // lands in state.messages and BEFORE any gate/execution runs — the seam
  // where the consumer makes the session record durable (the assistant's
  // tool_use batch, i.e. the trace that a side-effecting call was ABOUT to
  // run). Rejection fails the batch CLOSED: no tool body executes, every
  // call gets PERSIST_FAILED_TOOL_RESULT, and the run itself survives (the
  // model sees the failure and decides). A length-truncated turn crosses
  // the barrier too (its assistant record is worth persisting) but keeps
  // the M70 TRUNCATED synthetic regardless — the guard branch outranks the
  // persistence failure (nothing executes either way; truncation is the
  // more actionable fact). Absent = zero behavior change.
  readonly onBeforeToolDispatch?: (messages: readonly AgentMessage[]) => Promise<void> | void;
  // ω99-48 (dsh attempt log-only settlement): the sink for a FAILED streaming
  // attempt's log-only session entry. When a model attempt dies mid-stream
  // with a delivered prefix and the error is about to rethrow (non-abort —
  // the 夜移 001 interrupt path keeps its bytes), the loop builds the
  // assistant_attempt entry (prefix + usage + error + at; never a message,
  // never model-visible) and hands it HERE — the consumer's channel to the
  // session JSONL (appendEntry, the M35 §2 generic lane; coexists with
  // ω99-47's first-write marker, which writeEntry stamps as line 1). The
  // call is AWAITED before the rethrow so the trace lands before the error
  // surfaces, but isolated (safeCall): a seam rejection is swallowed —
  // settlement must never change the failure semantics. Recovery-resend and
  // abort paths never fire it. Absent = no settlement at all (zero behavior
  // change).
  readonly appendAttemptEntry?: (entry: AssistantAttemptEntry) => void | Promise<void>;
  // ω99-53 — the reasoning effort this run's requests carry (the driver
  // threads the provider config's CURRENT level in, read at run start — the
  // same rule as compaction.reasoningEffort). The loop does not guess and
  // never derives it: absent means the caller has no effort to report, and
  // every request byte is exactly today's (the stamp below is skipped
  // entirely). When present, each pushed assistant message — the normal
  // final AND the interrupted partial — carries it as persistence-only
  // metadata (AssistantMessage.effort) so cache-report can attribute an
  // effort-switch cold turn later. It never reaches the wire (M47).
  readonly effortSent?: string;
  // 夜移 036 (codex rollout_budget.rs): the session-tree token budget. ONE
  // instance shared by the root loop and every subagent (loopOptions spread
  // carries it; runSubagent rebinds threadId per child so reminders dedup
  // per thread while the accounting stays tree-wide). The loop CHARGES each
  // model response (onUsage fires → recordUsage; cached input is free) and,
  // on exhaustion, ends the run through {reason:"session_budget_exhausted"}
  // — no retry, and later runs keep failing (sticky). Reminders ride the
  // MetaNote projection below (at most one current-remainder note per
  // request; window = compaction boundary count in state.messages). Absent
  // = zero behavior change.
  readonly sessionBudget?: { readonly budget: SessionBudget; readonly threadId: string };
  // Mid-run steering: the queue is drained (take() until it returns
  // undefined) before EVERY model call, after the abort check. Each drained
  // text runs through the SAME onPromptSubmit gate as the run-start prompt
  // (M63-A fix: a busy-run submission must not bypass the UserPromptSubmit
  // hook — a secrets blocker holds mid-run too). A block DROPS the text (it
  // never enters history; the `steered` event carries blockedReason as the
  // notice); a rewrite pushes the rewritten text. What lands is appended as
  // a user message — a pure append, so the KV-cache prefix stays byte-stable
  // — and surfaced as a `steered` event. Absent, or a queue that stays
  // empty, changes nothing.
  readonly steering?: { take(): string | undefined };
  // 124b 项 1（codex instant_interrupt）：流抢占通道。当用户在模型流式期
  // 间提交新消息（steering 队列非空 + 驱动调用 channel.request()）时，
  // 当前在飞模型流被中断——只中断这一次调用，绝不结束运行：
  //   - 每次 attempt 前 next() 拿全新 signal，与 options.signal 合成后
  //     作为该次调用的 input.signal（provider 的流循环随 signal 中断）；
  //   - AbortError 冒出后以「运行 signal 未触发 && fired()」归类抢占：
  //     被弃 partial 不进 state.messages、不进 JSONL、不进模型所见
  //     （M24：下一次请求的前缀 = 原 append-only 历史 + steering user
  //     消息，前缀字节稳定且暖缓存命中），量与时刻走 stream_preempted
  //     事件的旁路审计；
  //   - 抢占后立即开始下一轮：顶部 steering drain 把用户的新指令作为下
  //     一 user 消息注入（同一条既有通道——抢占只是不再让新指令排队
  //     等流结束）。
  // 工具调用与压缩摘要不接合成 signal：抢占永不打断工具执行或压缩。
  // 缺席 = 零行为变化（流照常完成，steering 照旧在调用边界落地）。
  readonly streamPreempt?: StreamPreemptChannel;
  // M32 §2: runs once before EVERY model call, after the compaction check —
  // the seam the external-change prober rides (it may push into metaNotes).
  // Observer-only: failures are isolated and can never break the run.
  readonly beforeModelCall?: (turn: number) => void | Promise<void>;
  // M32 §3 — MetaNote channel (steering's sibling seam): system-class notes
  // (file_changed diffs, gate-style notices) drained after steering, just
  // before the model input is built. Each drained text is appended into the
  // LAST tool_result tail as \n<system_note>…</system_note> — a projection-
  // ONLY change: the model sees the note, the persisted history and the
  // JSONL stay clean (the ORIGINAL tool_result is what persists). With no
  // tool_result the notes degrade to an appended user message (projection-
  // only as well). Notes are ephemeral per call — nothing carries across
  // turns. Absent, or a queue that stays empty, changes nothing.
  readonly metaNotes?: { take(): string | undefined };
  // 夜移 003 (codex time_reminder, drift-thresholded): periodically ground
  // the model in the current wall-clock time. Injected on the FIRST model
  // call of the run, then again only when now() - lastInjection >= intervalMs
  // — long tool turns and human pauses re-ground, fast turns don't. Rides
  // the MetaNote channel (projection-only tail append, prefix-cache safe,
  // never persisted); the timestamp string is hand-formatted so it is
  // deterministic (no locale dependency). Absent = zero behavior change.
  readonly timeReminder?: { intervalMs: number };
  // M23 stop gates: checked where the model produces a no-tool-call final
  // answer, BEFORE onRunStop. A firing gate injects one [system note: …] user
  // message and continues the loop WITHOUT consuming turn quota. Each gate
  // insists at most maxInsists times, then lets the model through (deadlock
  // escape). Defaults: { todo: true, verify: true, maxInsists: 3 }.
  // M37 §1: gates.plan flips the todo lane's meaning for plan runs — the plan
  // IS the board, so a stop is legitimate as soon as a board EXISTS (all-
  // pending boards are the expected shape), while a board-less stop is nudged.
  readonly gates?: LoopGates;
  // M53 §5 — `--no-loop-safety` ablation seam: false disables the M48
  // loop-safety detectors entirely (no turn records, no loop_detected events,
  // no forced aborts). Absent = enabled. Evals use this for ablation
  // comparisons; production callers never set it.
  readonly loopSafety?: boolean;
  // ω-4b — the loop-safety reflection fork: when set, the run's SECOND loop
  // verdict (armed kinds only — identical_calls / failure_streak /
  // edit_repeat) first goes to ONE direct challenger model call that shares
  // this run's exact request prefix. "recoverable" stays the abort once (the
  // directive note replaces the generic one, resets the window, spends the
  // fork); "stuck" aborts enriched; every failure aborts exactly as today
  // (fail-closed). Absent = disabled = byte-identical behavior — the CLI
  // wiring layer enables it; `--no-loop-reflection` ablates it.
  readonly reflection?: ReflectionOptions;
  // ω-1b (goose tool_monitor.rs, digest 98a) — the repetition circuit
  // breaker: N consecutive IDENTICAL tool calls (same name + same arguments,
  // JSON-stringified) that reach the execution seam trip an error tool
  // result instead of executing — the model re-reads the same file / re-runs
  // the same failing command and burns tokens for nothing. The trip resets
  // the streak (one call shorted, the tool never banned); any different call
  // resets it too. Default threshold 3 (REPETITION_DEFAULT_THRESHOLD).
  // Always on — the breaker only answers calls the model actually repeats.
  readonly repetitionThreshold?: number;
  // ω-1b: false disables the repetition breaker entirely (the M53 §5
  // loopSafety-ablation pattern verbatim — tests/evals that script
  // genuinely identical call streams isolate what they measure from the
  // breaker's refusals; production callers never set it).
  readonly repetitionBreaker?: boolean;
  // ω-1b (goose large_response_handler.rs, digest 98a) — the generic
  // large-result backstop at the loop seam: EVERY tool's string result (not
  // just shell's M46 lane) is shaped head/tail + spill over loose
  // generic thresholds (1000 lines / 50KB) before it enters history.
  // read_file is exempt (M24: it IS the paging primitive). Absent — or no
  // spillDir inside — = OFF, byte-identical to pre-ω-1b (the M46
  // config-absent kill-switch pattern); the CLI injects the per-session
  // spill directory.
  readonly genericResultShaping?: GenericResultShaping;
  // M62 §1 — path-gated context rules. `match` runs after every SUCCESSFUL
  // tool execution (the CLI-side matcher filters read_file/edit and glob-
  // matches the path; zero rules → constant [] — no cost). Returned notes
  // land AFTER the turn's tool batch as user-role system-adjacent messages —
  // a pure append into the PERSISTED history (not a projection): compaction
  // summarizes them away naturally, and the next matching read re-loads the
  // rule (the loop re-checks presence by scanning for the note prefix, so a
  // rule already in history never double-injects). Each injection surfaces
  // as a `context_rule_loaded` event (the frontends' one-line notice).
  readonly contextRules?: {
    readonly match: (toolName: string, args: Record<string, unknown>) => readonly ContextRuleNote[];
  };
}

export interface LoopGates {
  readonly todo?: boolean;
  readonly verify?: boolean;
  readonly maxInsists?: number;
  /** M37 §1: plan mode — the todo gate demands a board EXISTS (not that it is
   *  complete). Execution-phase completeness is the post-approval run's job. */
  readonly plan?: boolean;
}

/** M62 §1: one gated context rule the loop may append into the message
 *  history. `source` is the display path (`.wudao/rules/x.md`) — the dedupe
 *  marker and the TUI notice both key on it. */
export interface ContextRuleNote {
  readonly source: string;
  readonly body: string;
}

/** ω99-11: which of the turn's model call sites a turn_retried recovery
 *  revived. The overflow ladder's three inner retry legs used to call
 *  callModel directly — a mid-stream drop there escaped the ω99-9 main arm
 *  and killed the run — so all four sites now share one recovery helper and
 *  stamp which one dropped. */
export type RecoveryLeg = "main" | "clip" | "compact" | "emergency";

/** ω99-315: the failure class that triggered a turn_retried recovery — the
 *  structured twin of the event's raw `reason` message. "idle" = the
 *  providers' dual-tier stream watchdog aborted a hung connection (the class
 *  the run-stats 断流重连 counter counts); "429"/"5xx" = the providers'
 *  ProviderHttpError message shape; "network" = transport-shaped everything
 *  else; "other" = statuses outside the retry vocabulary. */
export type LoopEvent =
  | { type: "turn_started"; turn: number }
  | { type: "model_call_started"; turn: number }
  | { type: "reasoning_delta"; turn: number; text: string }
  | { type: "assistant_delta"; turn: number; text: string }
  | { type: "model_call_finished"; turn: number; hasToolCalls: boolean; toolCallCount: number }
  | { type: "tool_call_started"; turn: number; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_call_finished"; turn: number; toolCallId: string; isError: boolean; result: string; provenance?: string; /** ω-5b (I21): wall time from this call's gate start to result settle (gate + execution, performance.now()). Omitted on the truncated-guard path (never executed) and absent on pre-I21 events (additive-only). */ durationMs?: number; /** 弧 δ (additive-only): present when the call was moved to the background mid-flight — the result field is the BACKGROUNDED synthetic (the execution is still running; its real result merges later through the consumer's background lane). The started+finished pairing doctrine holds. */ backgrounded?: true }
  | { type: "turn_finished"; turn: number; toolCallCount: number }
  | { type: "compacted"; turn: number; summaryMessage?: AgentMessage; beforeTokens: number; afterTokens: number; tier: 0 | 1 | 2 | 3; trigger: "threshold" | "boundary" | "immediate" | "reactive" | "static-fallback" | "manual" | "emergency" | "agent-rotation"; /** M52 §1: WHY it fired — manual (/compact), threshold (the 0.8×window trigger, any timing), overflow (post-413 reactive). */ reason: "manual" | "threshold" | "overflow" | "economic"; /** 借鉴弧 B1（SoL-Pi C1）：economic = 边界经济学门放行（盈亏平衡 ≤ 期距）。 */ /** M52 §1: tier-2 only — the fingerprint of the first kept ORIGINAL message; persisted as the compact_boundary session entry so a resumed session's next compaction continues the chain. */ firstKeptEntryId?: string; /** M70 §2 (pi): the messages the compact kept VERBATIM after the boundary (tier 0/1: the keep-recent window; tier 2: the post-span tail). Carried on compaction entries so future compactions can rebuild from it. */ retainedTail?: readonly AgentMessage[]; /** 借鉴弧 B1（SoL-Pi C1）：边界经济学的决策回执——只在轮边界审议武装的压缩上携带（压力/溢出/手动路径不带）。面板与测试的消费面。 */ economics?: CompactionEconomicsReport; /** 125 项 1：tier-2 only — 该边界开启的窗口序号（base + 本 run 已落边界数 + 1）；驱动层把它落进 compact_boundary 条目的 additive 字段 windowIndex。缺省 = 无窗口概念（pre-125 行为）。 */ windowIndex?: number; /** 125 项 2：tier-2 only — 轮转时刻的世界快照（driver 侧提取），作为 additive 字段落进 compact_boundary，供下一窗口做差分基线。 */ worldState?: WorldState; /** 125 项 1（codex new_context 形）：模型侧轮转的回执字段——trigger 为 agent-rotation 时携带。 */ agentRotation?: { window: number; rationale: string } }
  // M24: prompt usage for the model call that just finished, forwarded from
  // ModelInput.onUsage (the provider's only usage channel). Emitted after
  // model_call_finished, before any tool events of the same turn.
  | { type: "usage"; turn: number; usage: ModelUsage }
  // M63-A fix: blockedReason is set when the onPromptSubmit gate DROPPED a
  // steered text (it never entered history) — the event is the notice channel
  // (front-ends render why the steer did not land); text is the dropped text.
  | { type: "steered"; turn: number; text: string; blockedReason?: string }
  // M32 §3: a MetaNote was projected for this model call — text is the
  // joined <system_note>… payload, channel is where it landed (the last
  // tool_result tail, or a degraded user message when none exists).
  | { type: "meta_note"; turn: number; text: string; channel: "tool_result" | "user" }
  // 夜移 036: the shared session-tree token budget went dry — emitted right
  // after the `usage` event that crossed the line; the run then ends through
  // {reason:"session_budget_exhausted"}. usedUnits is the weighted total.
  | { type: "session_budget_exhausted"; turn: number; usedUnits: number }
  // M23: a stop gate fired at the final-answer seam — text is the injected
  // [system note: …] user message (front-ends render it as a notice).
  | { type: "gate_injected"; turn: number; text: string }
  // M35 §1: the run's one load_tools call applied — the named deferred tools'
  // definitions are part of every request from the next turn on. Fired once
  // per run (the defer window closes with it).
  | { type: "defer_loaded"; turn: number; names: string[] }
  // M48 §1: a loop-safety verdict fired at a turn boundary. attempt 1 rides
  // with a MetaNote injection (no turn consumed); attempt 2 — always the run's
  // second verdict — forces Terminal{reason:"aborted"} with the same evidence
  // (ω-4b: unless the reflection fork adjudicates it recoverable, in which
  // case attempt 3 — only possible after such an adjudication — aborts
  // unconditionally).
  | { type: "loop_detected"; turn: number; kind: "identical_calls" | "failure_streak" | "edit_repeat" | "no_answer"; evidence: string; attempt: 1 | 2 | 3 }
  // ω-4b: the loop-safety reflection fork settled at a second verdict — the
  // challenger's adjudication (recoverable | stuck | unavailable) with the
  // directive/rationale it produced. Emitted at most once per run, after the
  // fork's own usage event. Additive to the union: front-ends that don't
  // know it ignore it.
  | { type: "reflection_fork"; turn: number; kind: "identical_calls" | "failure_streak" | "edit_repeat" | "no_answer"; evidence: string; outcome: "recoverable" | "stuck" | "unavailable"; rationale?: string; directive?: string }
  // M48 §2: the provider repaired a degenerate finish by resending the frozen
  // request once (see ModelInput.onTerminalRepair). Emitted after the call
  // settles, before the turn's tool events.
  | { type: "terminal_repair"; turn: number; kind: TerminalRepairKind }
  // ω-2b (I1): the context-overflow ladder recovered a would-be 400 without
  // rewriting the prefix — "clip" = the identical request retried once with a
  // completion cap that fits the (learned) window (maxTokens carries the cap);
  // "compacted" = the reactive compaction path recovered (its compacted event
  // carries the history rewrite). Consumed like terminal_repair: after the
  // call settles, before the turn's tool events. NO history moved for "clip".
  // 87 item 1: "retried" = the reactive compact freed NOTHING (no compacted
  // event — nothing compactable, history reference-identical) and the bare
  // identical resend recovered (the 400 was transient); the label must not
  // claim a compaction that never ran.
  // 89 item 2: "cleared" = the in-between corner — the tier-0 clear DID shrink
  // history (old huge tool results became markers) but no compacted event
  // fired (still over threshold after the clear, and both summary tiers bailed
  // partition-null), so the resend rode a cleared, NOT byte-identical, prefix.
  // Neither "compacted" (no event) nor "retried" (bytes moved) is honest there.
  // 87 item 3: "emergency" = the emergency truncate tier recovered the turn
  // (its tier-3 compacted event carries the drop; no cap is carried).
  | { type: "context_recovery"; turn: number; kind: "clip" | "compacted" | "retried" | "cleared" | "emergency"; /** clip: the completion cap the retry carried. */ maxTokens?: number }
  // 夜移 013: the output-limit recovery ladder's moves (context_recovery's
  // output-side twin). "nudge" = a truncated text answer was sent a
  // resume-mid-thought user note (maxTokens present when the continuation
  // call carries a raised completion cap); "exhausted" = the nudge budget is
  // spent, the run ends through TerminalReason "output_limit".
  // 夜移 033: "overflow-detour" = a zero-output length-stop was re-diagnosed
  // as a disguised context overflow (pi Case 3) and diverted to the reactive
  // compaction instead of the nudge — the compacted events (if any) precede
  // it in the stream.
  | { type: "output_limit_recovery"; turn: number; kind: "nudge" | "exhausted" | "overflow-detour"; maxTokens?: number }
  | { type: "content_filter_guided"; turn: number }
  // 夜移 024: the empty-final guard's moves. "nudge" = a blank final answer
  // (no tool calls, content trims to empty — not a length cut, which 013
  // owns) was sent a synthetic user note demanding a visible answer;
  // "exhausted" = the nudge budget is spent and the blank final settles as
  // a completed run (the event is the incompleteness marker for frontends).
  | { type: "empty_final_recovery"; turn: number; kind: "nudge" | "exhausted" }
  // M62 §1: a gated context rule's body entered the message history after a
  // matching read_file/edit — source is the display path (the frontends'
  // one-line "Loaded <source>" notice).
  | { type: "context_rule_loaded"; turn: number; source: string }
  // M63-A: a PreCompact hook DEFERRED this compaction ({defer:true,reason}).
  // No history moved — the occupancy check re-arms next turn. reason is the
  // hook's (or a generic) — front-ends render it as a notice.
  // 借鉴弧 B1：经济学推迟（reason 前缀 "economics:"）带决策回执——每笔
  // 「不压」决策的类型化理由与当时的存量缓存债（面板消费面）。
  | { type: "compact_deferred"; turn: number; reason: string; economics?: CompactionEconomicsReport }
  // M63-B: the onPromptSubmit gate BLOCKED a prompt — the user-facing notice
  // (the model sees the [prompt blocked] replacement in history; this event
  // tells the HUMAN, on both channels: the run-start submit and the steering
  // drain's steered event carries its own blockedReason).
  | { type: "prompt_blocked"; turn: number; reason: string }
  // 夜移 001 (dsh interrupted-stream finalization): the user aborted the
  // model call mid-stream AND a delivered prefix existed — the loop has just
  // committed it as an `interrupted` assistant message (state.messages tail).
  // text is the full committed text (for delta-less frontends); hasReasoning
  // says whether a thinking prefix rode along. Additive-only: unknown-event
  // consumers ignore it.
  | { type: "assistant_interrupted"; turn: number; text: string; hasReasoning: boolean }
  // 124b 项 1（codex instant_interrupt）：一个在飞模型流被用户的新提交
  // 抢占（streamPreempt.request()，运行级 signal 未触发）。被弃的
  // streamed 前缀【没有】进入转录/JSONL/模型所见（与 assistant_interrupted
  // 的提交语义相对——那是运行中止时转录保真）；dropped*Chars 是被弃
  // 字节量的旁路审计载荷（前端据此提示「已中断当前生成（N 字被弃）」
  // 并可落旁路日志），preemptedAt 是 ISO 时刻。抢占后循环立即进入下一
  // 轮——steering drain 把用户的新指令作为下一条 user 消息注入。前置
  // 字节为零（首 delta 前）时计数诚实为 0，事件照发（中断这个事实本身
  // 对用户可见）。Additive-only：未知事件的消费者忽略它。
  | { type: "stream_preempted"; turn: number; droppedTextChars: number; droppedReasoningChars: number; preemptedAt: string }
  // ω99-9 (penguin #571 engine-level recovery + wudao 转录语义): a transport
  // failure landed mid-stream AFTER this turn had already delivered deltas —
  // the loop committed the delivered prefix (the assistant_interrupted event
  // immediately precedes this one), appended the frozen TURN_RECOVERY_NOTE
  // user message, and re-sent the model call through the full existing
  // ladder (clip/compact/context-overflow apply unchanged). attempt is
  // 1-based, monotonic within the turn, and bounded by
  // MAX_TURN_RECOVERY_ATTEMPTS — a budget PRIVATE to this arm, never the
  // provider's pre-delta retry ladder. reason is the failure's message
  // (diagnostics for frontends; the model sees only the note). Additive-only:
  // unknown-event consumers ignore it.
  // ω99-11: leg names WHICH call site dropped — "main" is the primary call;
  // "clip"/"compact"/"emergency" are the overflow ladder's three inner retry
  // legs (the recovery used to wrap only the main call, so a leg drop killed
  // the run; the shared helper now covers all four). Additive field: evals
  // and frontends can tell WHERE the transport failed. penguin #571 has no
  // equivalent dimension.
  | { type: "turn_retried"; turn: number; attempt: number; reason: string; /** ω99-315: the failure class (idle/429/5xx/network/other) — additive to the raw reason message; downstream counters (run-stats 断流重连) key on it. */ reasonClass: TurnRetryClass; leg: RecoveryLeg };


// Tools whose successful execution counts as "code changed" for the verify gate.
const VERIFY_WRITE_TOOLS = new Set(["write_file", "edit"]);

// 124b 项 1 Phase B（中断告知）：抢占后的第一次模型调用携带的 MetaNote。
// 被弃 partial 不在上下文（M24：前缀稳定 + 旁路审计），模型看到的只是
// 「上一答未送达 + 用户新指令」的事实——不编造内容，只解释不完整感。
const PREEMPTED_PREV_TURN_NOTE =
  "[system note: your previous reply was interrupted by the user before it finished — its partial output was discarded and never entered the conversation. The user has now submitted a new instruction; answer it from the current context.]";

// The agent loop: a non-recursive async generator carrying mutable state.
// Loop-exit signal = an assistant message with NO tool_use blocks.
export function runAgentLoop(
  state: AgentState, model: ModelClient, options: LoopOptions = {},
): AsyncGenerator<LoopEvent, Terminal> {
  // PB-1 探针缝：transition 经 probeAgentLoop 转发为 agent.*（关=原样透传）。
  return probeAgentLoop(runAgentLoopBody(state, model, options));
}

async function* runAgentLoopBody(
  state: AgentState, model: ModelClient, options: LoopOptions = {},
): AsyncGenerator<LoopEvent, Terminal> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  // run-budget (2026-08-24): the run's wall-clock origin — snapped
  // SYNCHRONOUSLY at run entry, before the first hook await, NOT after the
  // first model call (the R1 discipline: what must be settled settles before
  // the window opens). The clock is only read when a budget exists; absent
  // maxRunMs stays on the zero-change path (no snapshot, no now() calls).
  const now = options.now ?? Date.now;
  const maxRunMs = options.maxRunMs;
  const runStart = maxRunMs !== undefined ? now() : undefined;
  // 波次 7 #40: the 80% soft-landing note fires at most once per run.
  let runBudgetNudged = false;
  // 124b 项 1 Phase B：上一轮模型流被用户抢占——抢占后第一轮的 MetaNote
  // 告知模型（投影通道，永不落盘）：上下文里没有它被弃的部分回答，模型
  // 需要知道这份「不完整感」从何而来。消费即清零（只随抢占后的第一次模
  // 型调用走一次）。
  let preemptedPrevTurn = false;

  // M35 §1: deferred tool loading. Partition is computed once per run from
  // Tool.shouldDefer; requests carry base defs + the load_tools meta-tool
  // (plus the chosen defs appended after the run's one successful load). The
  // controller is a passthrough when no tool defers.
  const defer = createDeferController(state.tools);
  // PB-1 探针缝（工具面）：executeToolCall 查找表装饰（关=原数组原引用）。
  const execTools = probeTools(defer.effectiveTools());

  // ω-1b — the run's two tool-result guards, one seam around executeToolCall
  // shared by BOTH execution paths (fan-out and sequential):
  //   (A) repetition breaker — the inspector is a run-scoped closure (the
  //       M48 turn-records discipline): the streak persists across turns
  //       within THIS runAgentLoop call and starts at zero on resume (each
  //       resume is a fresh generator; re-arming costs 2-3 calls — cheap
  //       next to a wedged loop). A trip answers with an error tool result
  //       through the SAME channel executeToolCall's early errors (unknown
  //       tool / invalid arguments) use — never an exception — so the result
  //       pairs in history, feeds the M48 records, and fires the observer
  //       hooks exactly like a dispatched-but-refused call.
  //   (B) generic result shaping — applies to the string content AFTER
  //       execution, BEFORE the message enters history (and the finished
  //       event / hooks see the shaped text — the M46 precedent: the shaped
  //       result IS the result). read_file is exempt (M24 clause, see
  //       UNSHAPED_TOOLS); a failed spill write leaves the raw untouched
  //       (fail-open); structured (non-string) content never shapes.
  // Denied calls bypass this seam entirely (gateCall answered them), so a
  // permission denial — not the breaker — is what the model reads when a
  // call is refused before execution.
  const repetition = options.repetitionBreaker === false
    ? undefined
    : createRepetitionInspector({ threshold: options.repetitionThreshold });
  const genericShaping = options.genericResultShaping;
  const executeGuardedToolCall = async (call: ToolCall, signal?: AbortSignal): Promise<{ message: ToolResultMessage; provenance?: string }> => {
    // `turn` (the generator-scope counter, declared further down) rides the
    // inspect call so the streak counts per M48's doctrine: one decision per
    // (turn, call) — same-batch fan-out copies neither trip nor accumulate.
    const trip = repetition?.inspect(call, turn);
    if (trip?.repeated === true) {
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: repetitionBreakerMessage(call, trip.count),
          isError: true,
        },
      };
    }
    // 弧 δ: the per-call signal threads through to execute's optional third
    // parameter. Armed ONLY when a detach port exists, aborted ONLY by the
    // detached lane's stop path — an ordinary run (and an ordinary abort,
    // which abandons the promise) never fires it.
    const outcome = await executeToolCall(execTools, call, options.onToolUpdate, signal);
    if (
      genericShaping !== undefined
      && !UNSHAPED_TOOLS.includes(call.name)
      && typeof outcome.message.content === "string"
    ) {
      const shaped = shapeGenericToolResult(outcome.message.content, genericShaping);
      if (shaped !== undefined) {
        return { ...outcome, message: { ...outcome.message, content: shaped.shaped } };
      }
    }
    return outcome;
  };

  // M24 compaction economics. Threshold = 0.8 × context window. Occupancy is
  // measured with max(estimate, lastPromptTokens) — the provider's REAL
  // number once the run has seen usage (scripted/test models fall back to
  // the estimate). Timing is two-tier:
  //   approaching  (threshold ≤ occupancy < threshold + 8k): defer — set
  //                pendingCompaction; the current model call goes out with
  //                its full (warm) suffix; the compaction executes at the
  //                turn boundary, before the NEXT model call.
  //   immediate    (occupancy ≥ threshold + 8k): compact right now, before
  //                the model call (headroom gone; a 413 is one turn away).
  const COMPACT_DEFER_BAND_TOKENS = 8192;
  // ω-2b (I1): the output budget held back when computing a completion cap
  // against the (learned) window — the same 8k band the defer timing uses.
  const OUTPUT_BUDGET_RESERVE_TOKENS = 8192;
  // ω-2b (I1): the smallest completion cap the ladder will ever send — below
  // this the answer cannot be useful, so the ladder moves on to compaction.
  const MIN_CLIP_TOKENS = 1024;
  // 87 item 2: the floor on a window LEARNED from a trusted context-limit
  // parse. No real endpoint offers a window this small (the classic 4k floor);
  // a parse below it is poison (truncated body, unit mismatch) — clamping it
  // keeps a bogus tiny value from collapsing effectiveWindow (and with it
  // the 0.8× threshold and every downstream cap) while honest small windows
  // (≥ 4096, e.g. a 9k endpoint behind a 64k config) still shrink as parsed.
  // effectiveWindow's min(learned, base) still guarantees we never GROW the
  // configured window.
  const MIN_LEARNED_WINDOW_TOKENS = 4096;
  const baseWindow = options.compaction ? (options.compaction.contextWindowTokens ?? 200000) : 0;
  let pendingCompaction = false;
  // ω-2b (I1-d): this turn's admission-clip cap (set by the occupancy check
  // above buildModelInput, consumed by it; reset every turn).
  let admissionClip: number | undefined;

  // 借鉴弧 B1/B2（SoL-Pi C1/C2）— run 级经济学追踪器 + 边界信号面。
  // pendingTodoBoundaries 由 gateTodoTransition 登记（callId → 新 board 未完
  // 成数），结果落地且非 error 时兑现（被钩子拦下/出错的写不算边界——SoL-Pi
  // turn_end 同款卫生）；boundarySignalThisTurn 为本轮兑现的边界（轮顶清零）。
  const economics = new CompactionEconomicsTracker(options.compaction?.cachePricing);
  let boundarySignalThisTurn: number | null = null;
  const pendingTodoBoundaries = new Map<string, number>();

  // M70 §2 (pi) — the usage-anchored occupancy estimate, behind the three
  // anti-spurious-compaction guards. The anchor is the last REAL provider
  // usage row (its promptTokens + the answering model identity + the message
  // count at report time); occupancy = max(char estimate, anchor + trailing
  // messages' char estimate). The guards:
  //   (a) model switch — an anchor whose answering model differs from the
  //       client's modelId is dropped (its tokenizer/window no longer
  //       describes the prompt; both sides must be KNOWN to compare);
  //   (b) stale usage — every compaction invalidates the anchor (the number
  //       predates the new boundary and must never re-trigger);
  //   (c) zero usage — an absent/zero anchor degrades to the pure char
  //       estimate, which still drives the trigger.
  let usageAnchor:
    | { promptTokens: number; model: string | undefined; messageCount: number }
    | undefined;
  const currentModelId = model.modelId;

  // ω-2b (I1-c) — estimator calibration + window learning (Reasonix output
  // budget, minus the LimitMode matrix). ONE multiplicative ratio over the ω-1
  // script-aware estimate, learned from real usage rows and trusted 400
  // bodies, clamped [0.5, 2.5], model-scoped, in-memory only — exactly the
  // anchor's guards and lifetime (design §5):
  //   · applied ONLY in the occupancy-vs-threshold comparison and the
  //     admission clip — estimateTokens and every display consumer stay pure;
  //   · survives compaction (it describes the tokenizer, not the transcript);
  //   · dies on model switch (read-time guard, the anchor's shape).
  // learnedWindow shrinks the EFFECTIVE window to what a trusted parse said
  // the endpoint really has (min of config + learned — never grows it).
  let calibRatio: number | undefined;
  let calibModel: string | undefined;
  let learnedWindow: number | undefined;
  let learnedModel: string | undefined;
  const modelMismatch = (m: string | undefined): boolean =>
    m !== undefined && currentModelId !== undefined && m !== currentModelId;
  const effectiveWindow = (): number => {
    const w = learnedWindow !== undefined && !modelMismatch(learnedModel)
      ? Math.min(learnedWindow, baseWindow)
      : baseWindow;
    return w > 0 ? w : baseWindow;
  };
  // 125 项 1（dsh resolveCompactSpec 形）：触发线从平比 0.8×window 升格为
  // 预留感知 —— min(ratio×window, window − outputReserve − headroom)。
  // outputReserveTokens 缺席（未画像端点/未解析请求帽/一切既有测试夹具）时
  // resolver 返回 floor(ratio×window) = 平比，字节不变；只在请求帽相对窗口
  // 足够大（长输出场景）时收紧。单一真值点在 compaction-threshold.ts，CLI
  // 的 context_remaining 工具读同一条线。
  const effectiveThreshold = (): number =>
    resolveCompactionThresholdTokens({
      windowTokens: effectiveWindow(),
      thresholdRatio: options.compaction?.thresholdRatio ?? DEFAULT_COMPACTION_THRESHOLD_RATIO,
      headroomTokens: options.compaction?.headroomTokens ?? DEFAULT_COMPACTION_HEADROOM_TOKENS,
      outputReserveTokens: options.compaction?.outputReserveTokens,
    });
  const calibrate = (promptTokens: number, sent: readonly AgentMessage[], answeringModel: string | undefined): void => {
    const est = estimateTokens(state.systemPrompt, defer.requestDefs(), sent);
    if (est <= 0 || promptTokens <= 0) return;
    const r = promptTokens / est;
    if (r >= 0.5 && r <= 2.5) {
      calibRatio = r;
      calibModel = answeringModel;
    }
  };
  // The one occupancy measure (trigger, clip, reactive ladder all read it):
  // max(ratio-calibrated char estimate, anchor + trailing char estimate).
  const occupancyNow = (): number => {
    const charEstimate = estimateTokens(state.systemPrompt, defer.requestDefs(), state.messages);
    const scaled = (calibRatio !== undefined && !modelMismatch(calibModel) ? calibRatio : 1) * charEstimate;
    const anchorUsable =
      usageAnchor !== undefined
      && usageAnchor.promptTokens > 0
      && !modelMismatch(usageAnchor.model);
    return anchorUsable && usageAnchor !== undefined
      ? Math.max(scaled, usageAnchor.promptTokens + estimateTokens("", [], state.messages.slice(usageAnchor.messageCount)))
      : scaled;
  };

  // M58 §A: cold-turn compensation (M24 doctrine). When a compaction fires,
  // the NEXT model call rides a rewritten prefix — its cache hit is expected
  // to be 0. The trigger word is parked here and consumed by the next model
  // input's onUsage wrapper, which stamps the turn_usage receipt with
  // coldTurnExpected + cacheBreakAttribution.
  let coldAttribution: string | undefined;
  // 125 项 1/项 2（codex 窗口链/WorldState 差分）— the run's rotation
  // bookkeeping. tier2Boundaries counts THIS run's landed tier-2 boundaries
  // (each is one window rotation; the cheap tiers never are); the window
  // index of the next boundary = baseWindowCount + tier2Boundaries + 1.
  // lastWorldSnapshot chains the diff baseline in-run: seeded from the
  // driver's previous-window snapshot (the last compact_boundary entry's
  // additive field), advanced to each boundary's own snapshot so the SECOND
  // compaction of a run diffs against the first — never against a stale
  // pre-run world.
  const windowIdentityCfg = options.compaction?.windowIdentity;
  const worldStateCfg = options.compaction?.worldState;
  let tier2Boundaries = 0;
  let lastWorldSnapshot: WorldState | undefined = worldStateCfg?.previous;
  // ω99-28 T2 (turn-34 定界): the MetaNote projection is TRANSIENT — a drained
  // note rides the last tool_result tail (or a degraded user message) for
  // exactly ONE model call, then the next call's input reverts that message
  // to the original bytes. That one-call footprint reads as a history
  // rewrite to the byte-diffing cache detector (the campaign's undeclared
  // `cache break at edit result (turn 34)`). The M24 law applies: the by-
  // design rewrite DECLARES its cost — the first call after a projected
  // note is stamped cold-and-expected with the revert attribution. A
  // compaction parked on the same boundary wins (it is the stronger cause).
  let lastInputHadProjectedNote = false;

  // M52 §1: the event's WHY (trigger stays the timing word). Post-413
  // reactive compaction is an overflow; everything the 0.8×window trigger
  // fires (any timing) is a threshold compact; "manual" only comes from the
  // driver-level /compact path.
  const compactionReason = (trigger: "threshold" | "boundary" | "immediate" | "reactive"): "threshold" | "overflow" =>
    trigger === "reactive" ? "overflow" : "threshold";

  // M48 §3: skill reads recorded as tool calls EXECUTE successfully — the
  // ghost-skill map every compaction tier consults.
  const skillReads: Map<string, { name: string; path: string }> = new Map();
  const skillReadMap: SkillReadMap = skillReads;
  const noteSkillRead = (toolCallId: string, toolName: string, args: Record<string, unknown>): void => {
    const read = options.compaction?.classifySkillRead?.(toolName, args);
    if (read !== undefined) skillReads.set(toolCallId, read);
  };

  // M58 §C#3: the thrash guard shared by every AUTO compaction (threshold,
  // boundary, immediate, and the §A reactive path — the spec's single guard
  // against the compaction death spiral). A compaction that re-fires within
  // ≤2 turns of the previous one counts as rapid; two consecutive rapid
  // re-fires trip the breaker — auto-compaction stops with the typed
  // CompactionThrashError instead of looping forever.
  let lastAutoCompactTurn: number | undefined;
  let rapidCompactStreak = 0;

  // The shared compaction routine (tier-0 clear → microcompact → tier-2
  // fallback). Returns the events to emit plus the M63-A defer outcome;
  // mutates state.messages only when it actually shrank. 借鉴弧 B1：
  // econDecision 仅由轮边界审议传入（回执盖在 compacted 事件上）；所有自动
  // 压缩都在事件点入账缓存债——每次前缀断裂都有账。
  const runCompact = async (turn: number, trigger: "threshold" | "boundary" | "immediate" | "reactive", econDecision?: CompactionEconomicsDecision): Promise<{ events: LoopEvent[]; deferred?: string }> => {
    // The request's real tools segment (defer-aware) — occupancy must be
    // measured against what the provider actually sees.
    const toolDefsNow = defer.requestDefs();
    const events: LoopEvent[] = [];
    // M63-A: the PreCompact gate. Loop-internal triggers are all "auto". A
    // defer skips THIS compaction (re-arms next occupancy check); the
    // REACTIVE tier is exempt — it runs post-413 where skipping means a
    // guaranteed hard failure. A throwing/timeout hook = "compact anyway".
    // A defer does NOT touch the thrash counters below (it is not a
    // compaction — counting it would make a deferring hook look like a
    // death spiral).
    const preCompactHook = options.hooks?.onPreCompact;
    let preDecision: PreCompactDecision = "compact";
    if (preCompactHook !== undefined) {
      try {
        preDecision = (await preCompactHook(state.messages, "auto")) ?? "compact";
      } catch {
        preDecision = "compact";
      }
    }
    if (typeof preDecision === "object" && preDecision.defer && trigger !== "reactive") {
      return { events: [], deferred: preDecision.reason ?? "deferred by preCompact hook" };
    }
    // M58 §C#3: the thrash breaker runs BEFORE any tier — when the context
    // refills this fast twice in a row, another compaction cannot help.
    if (lastAutoCompactTurn !== undefined && turn - lastAutoCompactTurn <= 2) rapidCompactStreak += 1;
    else rapidCompactStreak = 0;
    lastAutoCompactTurn = turn;
    if (rapidCompactStreak >= 2) throw new CompactionThrashError(rapidCompactStreak);
    // M63-B: the standing compact instructions ride this compaction's tier-2
    // summary — the instructions-observability face (fired only when a
    // compaction actually proceeds past the defer/thrash gates).
    if (options.compaction?.compactInstructions !== undefined && options.compaction.compactInstructions !== "") {
      void (async () => {
        try {
          await options.hooks?.onInstructionsLoaded?.("compact", {});
        } catch {
          /* observer isolation */
        }
      })();
    }
    const before = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
    // M34 §3 — tier 0 first, the FREE clear: the oldest huge (>30k chars)
    // tool results past keepRecent become the deterministic cleared marker.
    // When that alone fits the occupancy back under the threshold, the dearer
    // tiers never fire. Clearing that cannot fit still helps — the messages
    // carry over into the microcompact pass below.
    const clear = clearTier(state.messages, {
      keepRecent: options.compaction?.keepRecent,
      fitsTokens: effectiveThreshold(),
      systemPrompt: state.systemPrompt,
      tools: toolDefsNow,
      skillReads: skillReadMap,
      // ω-2b (I2-a): per-tool retention rides the cheap tier.
      ...(options.compaction?.retention !== undefined ? { retention: options.compaction.retention } : {}),
    });
    if (clear.cleared > 0) {
      state.messages = clear.messages;
      const afterClear = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
      if (afterClear <= effectiveThreshold()) {
        await safeCall(() => options.hooks?.onPostCompact?.(state.messages, "auto"));
        coldAttribution = trigger;
        // M70 §2 guard (b): the anchor predates this boundary — stale, dropped.
        usageAnchor = undefined;
        // M70 §2: the kept-verbatim recent window rides the event.
        economics.recordCompaction(afterClear, before - afterClear);
        events.push({
          type: "compacted",
          turn,
          beforeTokens: before,
          afterTokens: afterClear,
          tier: 0,
          trigger,
          reason: econDecision?.reason === "economic" ? "economic" : compactionReason(trigger),
          retainedTail: state.messages.slice(alignedCutoff(state.messages, options.compaction?.keepRecent ?? 6)),
          ...(econDecision !== undefined ? { economics: economicsReport(econDecision, economics.carriedDebtTokens) } : {}),
        });
        return { events };
      }
    }
    // Tier 1 measures against the POST-CLEAR occupancy: a shrink logged here
    // is microcompact's own work, never the clear's (attribution the tier
    // label promises — and the trigger for falling through to tier 2).
    const beforeMicro = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
    const compacted = microcompact(state.messages, {
      keepRecent: options.compaction?.keepRecent,
      minChars: options.compaction?.minChars,
      skillReads: skillReadMap,
      // ω-2b (I2-a): per-tool retention rides the cheap tier.
      ...(options.compaction?.retention !== undefined ? { retention: options.compaction.retention } : {}),
    });
    const after = estimateTokens(state.systemPrompt, toolDefsNow, compacted);
    // Only apply + log when microcompact actually shrank the context. If it
    // can't (no large old tool results left), fall through to tier-2: an LLM
    // summary replaces the compactable span (warm-replayed, see compaction.ts).
    if (after < beforeMicro) {
      state.messages = compacted;
      await safeCall(() => options.hooks?.onPostCompact?.(state.messages, "auto"));
      coldAttribution = trigger;
      // M70 §2 guard (b): the anchor predates this boundary — stale, dropped.
      usageAnchor = undefined;
      economics.recordCompaction(after, beforeMicro - after);
      events.push({
        type: "compacted",
        turn,
        beforeTokens: beforeMicro,
        afterTokens: after,
        tier: 1,
        trigger,
        reason: econDecision?.reason === "economic" ? "economic" : compactionReason(trigger),
        // M70 §2: the kept-verbatim recent window rides the event.
        retainedTail: state.messages.slice(alignedCutoff(state.messages, options.compaction?.keepRecent ?? 6)),
        ...(econDecision !== undefined ? { economics: economicsReport(econDecision, economics.carriedDebtTokens) } : {}),
      });
    } else {
      // M47 §5: the LLM summary is the only fallible step — a provider
      // failure here used to kill the run mid-compaction. Degrade to the
      // deterministic static summary instead; the event's trigger names the
      // fallback so observability can tell the two apart.
      //
      // 125 项 1/项 2 — the rotation seam, computed BEFORE the boundary
      // lands so the world snapshot describes the window being CLOSED (the
      // pre-compaction state; state.messages is replaced below). The index
      // counts boundaries, not attempts: whichever arm below lands (LLM,
      // static fallback, dual) is the SAME rotation — ONE identity, ONE
      // snapshot, ONE diff, computed once here. Absent config keeps every
      // option undefined → byte-identical summaries (pre-125 behavior).
      const windowIdentity =
        windowIdentityCfg !== undefined
          ? { index: windowIdentityCfg.baseWindowCount + tier2Boundaries + 1, sessionKey: windowIdentityCfg.sessionKey }
          : undefined;
      let worldSnapshot: WorldState | undefined;
      let worldDiff: string | undefined;
      if (worldStateCfg !== undefined) {
        worldSnapshot = worldStateCfg.snapshot();
        // First compaction of a chain (no previous snapshot) → no diff
        // section — the behavior escape the spec pins.
        if (lastWorldSnapshot !== undefined) {
          const diff = worldStateDiff(lastWorldSnapshot, worldSnapshot);
          if (diff !== "") worldDiff = diff;
        }
      }
      let t2: Tier2Result | null;
      let staticFallback = false;
      try {
        t2 = await tier2Compact(state.messages, model, {
          keepRecent: options.compaction?.keepRecent ?? 6,
          systemPrompt: state.systemPrompt,
          tools: toolDefsNow,
          skillReads: skillReadMap,
          ...(windowIdentity !== undefined ? { windowIdentity } : {}),
          ...(worldDiff !== undefined ? { worldDiff } : {}),
          ...(options.compaction?.zeroLlmDigest !== undefined ? { zeroLlmDigest: options.compaction.zeroLlmDigest } : {}),
          // 波次 7 #39 (OH B1): both carryover buckets ride the tier-2 call —
          // the run's verified entries, and plan mode when gates.plan is on.
          ...(verifiedEntries.length > 0 ? { verifiedWork: [...verifiedEntries] } : {}),
          ...(gatePlan ? { planMode: true } : {}),
          ...(options.compaction?.compactInstructions !== undefined && options.compaction.compactInstructions !== ""
            ? { compactInstructions: options.compaction.compactInstructions }
            : {}),
          ...(options.compaction?.reasoningEffort !== undefined && options.compaction.reasoningEffort !== ""
            ? { reasoningEffort: options.compaction.reasoningEffort }
            : {}),
        // ω99-45: the run's own signal rides the summarizer — an Esc/interrupt
        // cancels the in-flight summary fetch (it always reached the run's
        // model calls; before this it missed the compaction's).
        }, options.signal);
      } catch (err) {
        // ω99-45: an aborted summarizer propagates — the loop's own abort
        // handling owns it from here (the loop-level catch maps AbortError to
        // the aborted terminal; a generator-boundary throw lands in the
        // driver's abort bookkeeping). The static fallback below stays the
        // M47 down-provider degrade, never a post-cancel one.
        if (options.signal?.aborted || isAbortError(err)) throw err;
        t2 = staticTier2Compact(state.messages, {
          keepRecent: options.compaction?.keepRecent ?? 6,
          systemPrompt: state.systemPrompt,
          tools: toolDefsNow,
          skillReads: skillReadMap,
          // 125 项 1/项 2: the fallback boundary is the same rotation —
          // identity + diff ride it identically.
          ...(windowIdentity !== undefined ? { windowIdentity } : {}),
          ...(worldDiff !== undefined ? { worldDiff } : {}),
        });
        staticFallback = t2 !== null;
      }
      if (t2 === null) {
        // M52 §1: single turn over budget — the recent window itself blows the
        // window and standard tier-2 has no span. Dual compact: history
        // summary + turn-prefix summary merged; the turn's tail survives
        // verbatim instead of the whole turn being dropped (per-part static
        // fallback inside, so this can never throw). ω99-45: except an abort —
        // the signal rides both halves and abort-shaped throws propagate.
        t2 = await dualTier2Compact(state.messages, model, {
          keepRecent: options.compaction?.keepRecent ?? 6,
          systemPrompt: state.systemPrompt,
          tools: toolDefsNow,
          skillReads: skillReadMap,
          ...(windowIdentity !== undefined ? { windowIdentity } : {}),
          ...(worldDiff !== undefined ? { worldDiff } : {}),
          ...(options.compaction?.compactInstructions !== undefined && options.compaction.compactInstructions !== ""
            ? { compactInstructions: options.compaction.compactInstructions }
            : {}),
          ...(options.compaction?.reasoningEffort !== undefined && options.compaction.reasoningEffort !== ""
            ? { reasoningEffort: options.compaction.reasoningEffort }
            : {}),
        }, options.signal);
      }
      if (t2) {
        const after2 = estimateTokens(state.systemPrompt, toolDefsNow, t2.messages);
        state.messages = t2.messages;
        await safeCall(() => options.hooks?.onPostCompact?.(state.messages, "auto"));
        // M52 §1: the boundary fingerprint — the first kept ORIGINAL message,
        // or the summary itself when the window was one entire pair-chain
        // (kept empty; the conversation continues after the summary).
        const firstKept = t2.messages.find((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER))) ?? t2.summaryMessage;
        coldAttribution = trigger;
        // M70 §2 guard (b): the anchor predates this boundary — stale, dropped.
        usageAnchor = undefined;
        economics.recordCompaction(after2, beforeMicro - after2);
        // 125 项 1/项 2: the boundary LANDED — this run's rotation count
        // advances (the next in-run boundary gets index+1) and the diff
        // baseline becomes THIS boundary's snapshot.
        tier2Boundaries += 1;
        if (worldSnapshot !== undefined) lastWorldSnapshot = worldSnapshot;
        events.push({
          type: "compacted",
          turn,
          summaryMessage: t2.summaryMessage,
          beforeTokens: beforeMicro,
          afterTokens: after2,
          tier: 2,
          trigger: staticFallback ? "static-fallback" : trigger,
          reason: econDecision?.reason === "economic" ? "economic" : compactionReason(trigger),
          firstKeptEntryId: messageEntryId(firstKept),
          // M70 §2 (pi): what the compact kept VERBATIM after the boundary —
          // carried so future compactions can rebuild from it.
          retainedTail: t2.retainedTail,
          ...(econDecision !== undefined ? { economics: economicsReport(econDecision, economics.carriedDebtTokens) } : {}),
          // 125 项 1/项 2: the rotation's identity + world snapshot ride the
          // event — the driver persists both as the compact_boundary entry's
          // additive fields (windowIndex / worldState).
          ...(windowIdentity !== undefined ? { windowIndex: windowIdentity.index } : {}),
          ...(worldSnapshot !== undefined ? { worldState: worldSnapshot } : {}),
        });
      }
    }
    return { events };
  };

  // 夜移 035 (codex turn_timing.rs): compaction is its OWN latency bucket
  // (its internal tier-2 summary LLM time rides with it). A thin wrapper so
  // every trigger arm — threshold, boundary, immediate, reactive, and the
  // 033 overflow detour — gets the guard without touching runCompact's body.
  const doCompact = async (
    turn: number,
    trigger: "threshold" | "boundary" | "immediate" | "reactive",
    econDecision?: CompactionEconomicsDecision,
  ): Promise<{ events: LoopEvent[]; deferred?: string }> => {
    const guard = options.turnProfile?.beginCompaction();
    try {
      return await runCompact(turn, trigger, econDecision);
    } finally {
      guard?.end();
    }
  };

  // 125 项 1（codex new_context 形）— the MODEL-side rotation lane. The
  // new_context tool's execute reaches this port through the host-shared box;
  // the port validates (budget / one-per-turn / a PreCompact defer) and fires
  // a tier-2 rotation boundary RIGHT THERE (inside the sequential tool
  // execution — the tool is non-concurrency-safe and block-interruptible, so
  // the swap can never race a sibling result append or an abort/detach). The
  // receipt the model reads is therefore an honest "rotated, window N", not a
  // promise about the turn boundary.
  //
  //   · 轮转 = tier-2 专用（manualCompact 的档序）：模型要的是「摘要边界 +
  //     新窗口身份」，不是 cheapest 剃须——tier-0/1 不产边界，直接跳过。
  //     全部 riders（skillReads/verifiedWork/planMode/compactInstructions/
  //     reasoningEffort/signal）与阈值压缩同源，轮转摘要不降级。
  //   · 不占 AUTO 守卫名额：thrash breaker 管的是 harness 自动压缩的死亡
  //     螺旋；模型侧轮转的滥用帽是 AGENT_ROTATION_CAP（GoalState budget
  //     同族，session lane 持久计数），两本账不混。
  //   · 事件停泊：execute 内无法 yield；compacted 事件（trigger
  //     "agent-rotation"）进 parked 队列，两条工具执行路径在结果落地后
  //     立即 drain（tool_call_finished 之后、下一事件之前——观测序=事实序）。
  //   · 独立窗口计数：window = 压缩后 marker 数 + 1（countSummaryMarkers）。
  //     125b 窗口身份链落地后，编号源切到链上（本缝即 125b 的接线点）。
  let agentRotationsFiredThisRun = 0;
  let agentRotationFiredThisTurn = false;
  const parkedRotationEvents: LoopEvent[] = [];
  if (options.compaction !== undefined && options.contextRotation !== undefined) {
    const keepRecentForRotation = options.compaction.keepRecent ?? 6;
    const fireAgentRotation = async (req: AgentRotationRequest): Promise<AgentRotationOutcome> => {
      const guard = options.turnProfile?.beginCompaction();
      try {
        // Budget: the host's replayed session count + this run's fires. A
        // refusal never consumes anything (the cap counts FIRES, not asks).
        const spent = options.contextRotation!.rotationsUsed + agentRotationsFiredThisRun;
        if (spent >= AGENT_ROTATION_CAP) {
          return { ok: false, code: "cap", error: `已用 ${spent}/${AGENT_ROTATION_CAP}` };
        }
        if (agentRotationFiredThisTurn) {
          return { ok: false, code: "already-rotated-this-turn", error: "one rotation per turn" };
        }
        // Pre-flight compactability (honest fail-closed BEFORE the summarizer
        // call): a window with nothing a boundary could replace must not burn
        // the budget on a no-op. Mirrors tier2Compact's own span logic — the
        // DUAL partition deliberately does NOT count here (it exists for a
        // single oversized turn; a short window passing it would rotate three
        // messages into a summary for nothing). Nothing appends between this
        // check and the fire below (same execute), so the span holds.
        if (compactableSpan(state.messages, keepRecentForRotation) === null) {
          return { ok: false, code: "nothing-to-rotate", error: "上下文在保留窗内，没有可替换的历史跨度" };
        }
        // The PreCompact gate gets its say — but a defer is an honest REFUSAL
        // here (the receipt must never promise a boundary that did not land),
        // never a silent skip.
        const preCompactHook = options.hooks?.onPreCompact;
        if (preCompactHook !== undefined) {
          let decision: PreCompactDecision = "compact";
          try {
            decision = (await preCompactHook(state.messages, "auto")) ?? "compact";
          } catch {
            decision = "compact";
          }
          if (typeof decision === "object" && decision.defer) {
            return { ok: false, code: "deferred", error: decision.reason ?? "preCompact hook" };
          }
        }
        // Fire: tier-2 with the rotation riders (header + preserve). The
        // normal M47 degrade applies — a down provider lands the static
        // fallback boundary (identity preserved); an abort propagates to the
        // tool's own error path (nothing landed, nothing counted).
        const toolDefsNow = defer.requestDefs();
        const before = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
        const rotOpts = {
          keepRecent: keepRecentForRotation,
          systemPrompt: state.systemPrompt,
          tools: toolDefsNow,
          skillReads: skillReadMap,
          agentRotation: { rationale: req.rationale, ...(req.preserve !== undefined ? { preserve: req.preserve } : {}) },
          ...(options.compaction?.compactInstructions !== undefined && options.compaction.compactInstructions !== ""
            ? { compactInstructions: options.compaction.compactInstructions }
            : {}),
          ...(options.compaction?.reasoningEffort !== undefined && options.compaction.reasoningEffort !== ""
            ? { reasoningEffort: options.compaction.reasoningEffort }
            : {}),
          ...(verifiedEntries.length > 0 ? { verifiedWork: [...verifiedEntries] } : {}),
          ...(gatePlan ? { planMode: true } : {}),
        };
        let t2: Tier2Result | null;
        let staticFallback = false;
        try {
          t2 = await tier2Compact(state.messages, model, rotOpts, options.signal);
        } catch (err) {
          if (options.signal?.aborted || isAbortError(err)) throw err;
          t2 = staticTier2Compact(state.messages, rotOpts);
          staticFallback = t2 !== null;
        }
        if (t2 === null) {
          t2 = await dualTier2Compact(state.messages, model, rotOpts, options.signal);
        }
        if (t2 === null) {
          // Both partitions bailed between the pre-check and here — honest
          // refusal, budget untouched (nothing landed, nothing counted).
          return { ok: false, code: "nothing-to-rotate", error: "无可替换的历史跨度" };
        }
        state.messages = t2.messages;
        agentRotationsFiredThisRun += 1;
        agentRotationFiredThisTurn = true;
        // The M70 §2 guard (b) + the M58 §A cold-turn attribution + the
        // economics ledger — the same bookkeeping every other boundary does.
        usageAnchor = undefined;
        coldAttribution = "agent-rotation";
        // A pending "approaching" threshold compaction is SUBSUMED by this
        // boundary (the same reset every other fire site applies) — otherwise
        // the turn boundary below would re-deliberate a second compaction
        // right after the rotation, the exact rapid-refill shape the thrash
        // breaker exists to stop.
        pendingCompaction = false;
        const after2 = estimateTokens(state.systemPrompt, toolDefsNow, t2.messages);
        economics.recordCompaction(after2, before - after2);
        await safeCall(() => options.hooks?.onPostCompact?.(state.messages, "auto"));
        const firstKept = t2.messages.find((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER))) ?? t2.summaryMessage;
        const window = countSummaryMarkers(t2.messages) + 1;
        parkedRotationEvents.push({
          type: "compacted",
          turn,
          summaryMessage: t2.summaryMessage,
          beforeTokens: before,
          afterTokens: after2,
          tier: 2,
          trigger: staticFallback ? "static-fallback" : "agent-rotation",
          reason: "manual",
          firstKeptEntryId: messageEntryId(firstKept),
          retainedTail: t2.retainedTail,
          agentRotation: { window, rationale: req.rationale },
        });
        return { ok: true, window, remaining: AGENT_ROTATION_CAP - (spent + 1) };
      } finally {
        guard?.end();
      }
    };
    options.contextRotation.port.current = { rotate: fireAgentRotation };
  }


  // onRunStart — fires once at the very start, observer-only.
  await safeCall(() => options.hooks?.onRunStart?.(state));

  // Prompt gate: rewrite or block the current prompt (the trailing user message).
  // Runs ONCE before the first iteration, so it does NOT re-fire on stop-block
  // continuations (which inject their own [stop blocked] user message).
  const submitPromptBlocked: string[] = [];
  {
    const last = state.messages.at(-1);
    if (last?.role === "user") {
      let decision: string | { block: true; reason: string } = last.content;
      try { decision = (await options.hooks?.onPromptSubmit?.(last.content)) ?? last.content; } catch { decision = last.content; }
      if (typeof decision === "string" && decision !== last.content) {
        state.messages[state.messages.length - 1] = { role: "user", content: decision };
      } else if (typeof decision === "object" && decision.block) {
        state.messages[state.messages.length - 1] = { role: "user", content: `[prompt blocked] ${decision.reason}` };
        // M63-B: the user-channel notice — the model sees the replacement,
        // this queue feeds the prompt_blocked event below (the generator
        // cannot yield from here — same parking pattern as usage events).
        submitPromptBlocked.push(decision.reason);
      }
    }
  }

  // M63-B: surface the submit-time block to the user channel (the steered
  // path carries its own blockedReason on the steered event).
  for (const reason of submitPromptBlocked.splice(0)) {
    yield { type: "prompt_blocked", turn: 0, reason };
  }

  // M23 gate state: insist counters (per gate, independently capped) and the
  // run's code-change trail for the verify gate.
  const gateTodo = options.gates?.todo ?? true;
  const gateVerify = options.gates?.verify ?? true;
  const gatePlan = options.gates?.plan === true;
  const gateMaxInsists = options.gates?.maxInsists ?? 3;
  let todoInsists = 0;
  let verifyInsists = 0;
  let planInsists = 0;
  let wroteThisRun = false;
  let ranSinceWrite = true;
  // 波次 7 #39 (OH B1): the run's verified-work entries — a successful
  // shell AFTER writes clears the verify trail, and that flip is a
  // verified fact worth carrying across the next tier-2 boundary (capped;
  // the compaction re-merges with the prior boundary's block).
  let verifyWriteCount = 0;
  const verifiedEntries: string[] = [];
  // M61 §3: the stop-block cap's counters — consecutive no-tool continuations
  // and whether any tool ran since the last block.
  let stopBlockStreak = 0;
  let toolsSinceStopBlock = false;
  // 夜移 013: the output-limit ladder's episode counter — CONSECUTIVE
  // truncations (any clean non-length turn resets it, so a long run gets a
  // fresh budget per episode, bounded by maxTurns regardless) — and the
  // one-shot escalation flag the nudge arms for the next model call.
  let outputLimitNudges = 0;
  let emptyFinalNudges = 0;
  // 133 #5 — content_filter 指导的 run 级一次性旗标。
  let contentFilterGuided = false; // 夜移 024: consecutive blank finals this streak has spent
  let escalateNextCall = false;
  // 夜移 033: one-shot flag — the disguised-overflow detour (below) has
  // already run its reactive compaction this RUN. A second zero-output
  // length-stop after it settles straight to the typed output_limit
  // terminal: compacting again into a server that keeps truncating the
  // input is the death spiral the flag exists to break.
  let zeroOutputOverflowDetoured = false;

  // M48 §1 loop-safety state: the run's turn records feed the pure detectors
  // at every turn boundary. First verdict → one MetaNote queued for the NEXT
  // model call (no turn consumed); a second verdict in the same run → forced
  // aborted terminal with the evidence.
  // M53 §5: `--no-loop-safety` turns the whole net off (ablation seam).
  const safetyOn = options.loopSafety !== false;
  const safetyTurns: LoopSafetyTurn[] = [];
  // 121 #5: the no-progress lane's run-local state (advisory-only — never
  // feeds the verdict/abort machinery below). 重启/换 run 重计：刻意不持久
  // 化（保持简单；M24：无 durable 面变化）。
  let noProgressState: NoProgressState = NO_PROGRESS_CLEAN;
  let loopVerdicts = 0;
  // ω-4b: ONE fork per run — latched by the recoverable adjudication (the
  // only path where the loop continues past a fork), so a re-formed pattern
  // reaches a third verdict with the fork spent and aborts unconditionally.
  let reflectionSpent = false;
  const pendingSafetyNotes: string[] = [];
  // 夜移 003: wall-clock anchor of the last time-reminder injection (null =
  // never injected this run → the next boundary always injects).
  let lastTimeNoteAt: number | null = null;

  // The final-answer seam: returns the [system note: …] text to inject, or
  // undefined when the stop is legitimate (board complete or absent, changes
  // verified or none, or insists exhausted). M37 §1: under gates.plan the todo
  // lane becomes an existence check — the plan IS the board, so any board
  // (even all-pending) legitimizes the stop and NO board is nudged.
  const stopGateInjection = (): string | undefined => {
    const parts: string[] = [];
    let board: string | undefined;
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const m = state.messages[i];
      if (m && parseTodoBoard(m.content) !== undefined) {
        board = m.content;
        break;
      }
    }
    const parsed = board === undefined ? undefined : parseTodoBoard(board);
    if (gatePlan) {
      if (planInsists < gateMaxInsists && parsed === undefined) {
        parts.push("[system note: plan mode — no plan board yet: present the plan as a todo board via todo_write (every step one item, items pending — execution happens after approval), then answer with a short plan summary (goal/steps/risks/verification)]");
        planInsists += 1;
      }
    } else if (gateTodo && todoInsists < gateMaxInsists) {
      if (parsed && parsed.incomplete > 0) {
        parts.push(`[system note: todo board has ${parsed.incomplete} incomplete item(s) — continue working through them, or explicitly update the board marking skipped items with a reason, then answer]`);
        todoInsists += 1;
      }
    }
    if (gateVerify && verifyInsists < gateMaxInsists && wroteThisRun && !ranSinceWrite) {
      parts.push("[system note: code changes were made but nothing was run since — verify with shell (tests/build/the program) before finishing]");
      verifyInsists += 1;
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  };

  // Successful (non-denied) tool outcomes feed the verify gate's trail.
  const noteToolOutcome = (name: string, message: ToolResultMessage, args: unknown): void => {
    if (name === "shell") {
      // 波次 7 #39: a successful run that clears a pending write trail is a
      // verified fact — record it BEFORE the trail clears.
      if (message.isError !== true && wroteThisRun && !ranSinceWrite) {
        const head = verifiedRunHead(args);
        if (head !== undefined) {
          verifiedEntries.push(`'${head}' ok after ${verifyWriteCount} write${verifyWriteCount === 1 ? "" : "s"}`);
          if (verifiedEntries.length > VERIFIED_WORK_CAP) verifiedEntries.shift();
        }
      }
      ranSinceWrite = true;
    } else if (VERIFY_WRITE_TOOLS.has(name) && message.isError !== true) {
      wroteThisRun = true;
      verifyWriteCount += 1;
      ranSinceWrite = false;
    }
  };

  // M62 §1 — gated context-rule injection. Notes queue during the tool
  // phase (the CLI matcher already filtered read_file/edit + glob match)
  // and flush AFTER the batch: user-role messages appended at the turn tail
  // (append-only → prefix-cache safe, persisted → compaction summarizes
  // them away, and the presence scan re-loads a rule after its note was
  // compacted). A rule already in history never re-injects.
  const pendingRuleNotes: ContextRuleNote[] = [];
  const ruleNoteSourceOf = (content: string): string | undefined => {
    if (!content.startsWith("[context rule ")) return undefined;
    const rest = content.slice("[context rule ".length);
    const close = rest.indexOf("]");
    return close === -1 ? undefined : rest.slice(0, close);
  };
  const ruleSourcesInHistory = (): Set<string> => {
    const present = new Set<string>();
    for (const m of state.messages) {
      if (m.role !== "user") continue;
      const src = ruleNoteSourceOf(m.content);
      if (src !== undefined) present.add(src);
    }
    return present;
  };
  const noteRuleRead = (toolName: string, args: Record<string, unknown>): void => {
    const notes = options.contextRules?.match(toolName, args);
    if (notes === undefined) return;
    for (const n of notes) pendingRuleNotes.push(n);
  };
  const flushRuleNotes = (): LoopEvent[] => {
    if (pendingRuleNotes.length === 0 || options.contextRules === undefined) return [];
    const present = ruleSourcesInHistory();
    const events: LoopEvent[] = [];
    for (const n of pendingRuleNotes.splice(0)) {
      if (present.has(n.source)) continue;
      present.add(n.source);
      state.messages.push({ role: "user", content: `[context rule ${n.source}]\n${n.body}` });
      events.push({ type: "context_rule_loaded", turn, source: n.source });
      // M63-B: the instructions-observability face for gated rules.
      void (async () => {
        try {
          await options.hooks?.onInstructionsLoaded?.("path_glob_match", { detail: n.source });
        } catch {
          /* observer isolation */
        }
      })();
    }
    return events;
  };

  // M62 §5: the additionalContext queue. A post-tool hook's returned string
  // parks here and drains into the NEXT model call's note projection (same
  // channel as the MetaNotes — suffix after the last tool_result,
  // projection-only, so the persisted history stays clean). Cap-free here:
  // the CLI bridge caps at 8k before returning.
  const pendingHookContext: string[] = [];
  const captureHookContext = async (invoke: () => Promise<void | string> | void | string | undefined): Promise<void> => {
    try {
      const out = await invoke();
      if (typeof out === "string" && out !== "") pendingHookContext.push(out);
    } catch {
      /* observer isolation — a throwing context hook is dropped (the same
       * posture the pre-M62 safeCall had: the run continues) */
    }
  };

  // Manual turn accounting: gate injections re-enter the loop WITHOUT
  // consuming turn quota (a nudge for still-working is not a model turn).
  let turn = 0;
  // 夜移 035: the run's wall clock starts here (queueing/projection/first-
  // prompt overhead lands in beforeFirstSamplingMs until the first model
  // call begins). Guarded by markTurnStarted's own started-at gate.
  options.turnProfile?.markTurnStarted();
  for (;;) {
    if (turn >= maxTurns) return { reason: "max_turns" };
    if (options.signal?.aborted) return { reason: "aborted" };
    // run-budget (2026-08-24): the cooperative wall-clock fuse, top of turn,
    // BEFORE any model-call work runs. Checked after the abort and max-turn
    // fuses so existing precedence is untouched. Strictly `>`: a budget
    // exactly equal to the elapsed time still admits the turn. On exit the
    // turn emits no events (max_turns' shape), queued steering stays queued
    // (the drain runs later in the iteration), and no message is injected —
    // the exit never touches the prefix cache. An in-flight call cannot be
    // cut by this check; preemption is `signal`'s job, not the budget's.
    if (maxRunMs !== undefined && runStart !== undefined) {
      const elapsedMs = now() - runStart;
      // 波次 7 #40 (hive #6) soft landing: at 80% of the wall, inject ONE
      // answer-now note at the turn boundary — the same append-only-tail
      // shape as the maxTurns last-chance nudge below. Without it a model
      // still exploring sails into the wall and the run ends with no answer
      // at all. The hard exit itself stays injection-free.
      if (!runBudgetNudged && elapsedMs >= 0.8 * maxRunMs) {
        runBudgetNudged = true;
        state.messages.push({
          role: "user",
          content: "[system note: run budget nearly exhausted — answer the user NOW with the information you already have; do not call any more tools]",
        });
      }
      if (elapsedMs > maxRunMs) {
        return { reason: "run_budget_exhausted" };
      }
    }

    // Last-chance nudge: on the FINAL allowed turn, tell the model to stop
    // exploring and answer. Without this, a model that keeps reading files
    // burns every turn and the run ends with no answer at all (max_turns).
    // Guarded so a gate injection landing on the fuse turn can't stack a
    // second copy.
    if (turn === maxTurns - 1) {
      const last = state.messages.at(-1);
      if (!(last?.role === "user" && last.content.startsWith("[system note: turn limit reached"))) {
        state.messages.push({
          role: "user",
          content: "[system note: turn limit reached — answer the user NOW with the information you already have; do not call any more tools]",
        });
      }
    }

    yield { type: "turn_started", turn };

    // M35 §1: the defer-aware tools segment (identical to the full map when
    // nothing defers).
    const toolDefs = defer.requestDefs();

    if (options.compaction) {
      // B2：边界信号轮顶清零（候选窗口=本轮；统计已入账、候选自然过期）。
      boundarySignalThisTurn = null;
      // 125 项 1：轮转「每轮一次」的轮顶复位（同一轮里第二个 new_context
      // 调用拿到的是诚实的 already-rotated 拒绝，不是第二个边界）。
      agentRotationFiredThisTurn = false;
      const occupancy = occupancyNow();
      if (occupancy >= effectiveThreshold() + COMPACT_DEFER_BAND_TOKENS) {
        const out = await doCompact(turn, "immediate");
        if (out.deferred !== undefined) yield { type: "compact_deferred", turn, reason: out.deferred };
        for (const ev of out.events) yield ev;
        pendingCompaction = false;
      } else if (occupancy >= effectiveThreshold()) {
        // Approaching: let THIS call go out on the warm full suffix; compact
        // at the turn boundary (below) instead of rewriting the prefix now.
        pendingCompaction = true;
      }
      // ω-2b (I1-d) proactive admission clip — SHARED-window profiles only
      // (the profile gate is the only thing windowMode decides). Measured on
      // the POST-immediate-compact occupancy: when the prompt alone already
      // crowds the effective window, cap this request's completion budget so
      // prompt + completion fit — the would-be first 400 becomes a slightly
      // shorter answer instead. max_tokens is a sampling parameter; the
      // prompt bytes (and the cached prefix) are untouched (M24).
      admissionClip = undefined;
      if (options.compaction.windowMode === "shared") {
        const postCompactOccupancy = occupancyNow();
        if (postCompactOccupancy >= effectiveThreshold()) {
          // 复测 0.3 反馈（P1）：occupancy 是「校准比×字符估算」的浮点值，
          // 直接 window−occupancy−reserve 会把小数 max_tokens 发给端点
          // （deepseek 422: invalid type: floating point …, expected u32）。
          // 先 floor 成整数再夹 MIN_CLIP_TOKENS。
          admissionClip = Math.max(MIN_CLIP_TOKENS, Math.floor(effectiveWindow() - postCompactOccupancy - OUTPUT_BUDGET_RESERVE_TOKENS));
        }
      }
      // B1：本请求入账（请求数=期距分母、占用增量、债偿还；POST-compact 占
      // 用为准——immediate 臂刚压完时下一请求真的要发出的字数）。
      economics.recordRequest(occupancyNow());
    }

    // M32 §2: the external-change probe seam — after the compaction check,
    // before the notes it pushes are drained into the model input below.
    await safeCall(() => options.beforeModelCall?.(turn));

    yield { type: "model_call_started", turn };

    if (options.signal?.aborted) return { reason: "aborted" };

    // Mid-run steering: drain the queue just before the model input is built,
    // so the model sees the injected texts on THIS call. Append-only.
    // M63-A fix: the drain runs the SAME prompt gate as the run start — block
    // drops the text (never enters history, the steered event is the notice),
    // rewrite pushes the rewritten text. A throwing hook degrades to the
    // original text (the run-start gate's posture).
    if (options.steering) {
      for (;;) {
        const steered = options.steering.take();
        if (steered === undefined) break;
        let steerDecision: string | { block: true; reason: string } = steered;
        try { steerDecision = (await options.hooks?.onPromptSubmit?.(steered)) ?? steered; } catch { steerDecision = steered; }
        if (typeof steerDecision === "object" && steerDecision.block) {
          yield { type: "steered", turn, text: steered, blockedReason: steerDecision.reason };
          continue;
        }
        const text = typeof steerDecision === "string" ? steerDecision : steered;
        state.messages.push({ role: "user", content: text });
        yield { type: "steered", turn, text };
      }
    }

    // M32 §3: MetaNote drain. The projected messages are a COPY only when a
    // note actually landed — state.messages (and therefore the persisted
    // transcript) keeps the ORIGINAL tool_result bytes. When the last
    // tool_result is the trailing message (the common tool-turn shape) the
    // projection is a pure suffix append: the KV-cache prefix stays stable.
    // M58 review fix: the DRAIN (queues are consumed once per turn) is split
    // from the PROJECTION (pure) — the reactive §A retry re-projects the SAME
    // drained notes onto the post-compaction messages instead of silently
    // dropping them (the original projection rode the failed call's input).
    // M48 §1: loop-safety notes ride the SAME channel — drained with the
    // queue notes below, projected identically (never persisted).
    const notes: string[] = [];
    if (options.metaNotes) {
      for (;;) {
        const note = options.metaNotes.take();
        if (note === undefined) break;
        notes.push(note);
      }
    }
    for (const n of pendingSafetyNotes.splice(0)) notes.push(n);
    // M62 §5: the post-tool hooks' additionalContext strings ride the same
    // projection (drained once, after the queued notes — a pure suffix).
    for (const n of pendingHookContext.splice(0)) notes.push(n);
    // 124b 项 1 Phase B（中断告知）：上一轮被抢占后的第一次模型调用携带
    // 一条 MetaNote——被弃 partial 不在上下文里，模型需要这份解释来理解
    // 为什么对话可能有不完整感（用户已给新指令）。投影通道（永不落盘，
    // M24 前缀零接触），消费即清零：只随抢占后的第一次调用走一次。
    if (preemptedPrevTurn) {
      preemptedPrevTurn = false;
      notes.push(PREEMPTED_PREV_TURN_NOTE);
    }
    // 夜移 003 (codex time_reminder, drift-thresholded): ground the model in
    // the current time — first boundary of the run, then only when the wall
    // clock has drifted ≥ intervalMs since the last injection. Rides the same
    // notes projection below (pure suffix, never persisted).
    if (options.timeReminder !== undefined) {
      const t = now();
      if (lastTimeNoteAt === null || t - lastTimeNoteAt >= options.timeReminder.intervalMs) {
        lastTimeNoteAt = t;
        notes.push(formatTimeReminderNote(new Date(t)));
      }
    }
    // 夜移 036 (codex rollout_budget): the budget reminder — the model is
    // told its remaining shared budget so it can pace itself (wrap up, skip
    // exploratory reads). Rides the same projection channel (never
    // persisted). Window = the count of compaction boundaries in the active
    // message chain: a compaction rewrites the prefix → new window → the
    // dedup misses → the current remainder is restated on the first request
    // AFTER the summary (codex's window-change restatement). Index 0 (the
    // first request of every window) restates the full remaining — codex's
    // initial reminder. Marked delivered AFTER the note is pushed onto this
    // request's payload (the projection is built synchronously — there is no
    // cancellation window between push and request).
    if (options.sessionBudget !== undefined) {
      let windowSeq = 0;
      for (const m of state.messages) {
        if (m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) windowSeq += 1;
      }
      const sb = options.sessionBudget;
      const reminder = sb.budget.pendingReminder(sb.threadId, `w${windowSeq}`);
      if (reminder !== undefined) {
        notes.push(`You have ${reminder.remainingTokens} weighted tokens left in the shared session token budget.`);
        sb.budget.markReminderDelivered(sb.threadId, `w${windowSeq}`, reminder);
      }
    }
    const notesPayload = notes.length > 0 ? notes.map((t) => `<system_note>\n${t}\n</system_note>`).join("\n") : undefined;
    /** Pure: land the drained notes onto a message list — appended into the
     *  LAST tool_result tail (suffix append, KV-cache prefix stable), or a
     *  degraded trailing user message when no tool_result exists. Undefined
     *  when there are no notes (nothing changes, no copy). */
    const projectNotes = (
      messages: readonly AgentMessage[],
    ): { messages: AgentMessage[]; channel: "tool_result" | "user"; payload: string } | undefined => {
      if (notesPayload === undefined) return undefined;
      let lastTool = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "tool") {
          lastTool = i;
          break;
        }
      }
      if (lastTool >= 0) {
        const original = messages[lastTool] as ToolResultMessage;
        return {
          messages: [
            ...messages.slice(0, lastTool),
            { ...original, content: `${original.content}\n${notesPayload}` },
            ...messages.slice(lastTool + 1),
          ],
          channel: "tool_result" as const,
          payload: notesPayload,
        };
      }
      return { messages: [...messages, { role: "user", content: notesPayload }], channel: "user" as const, payload: notesPayload };
    };
    let projected: AgentMessage[] = state.messages;
    {
      const p = projectNotes(state.messages);
      if (p !== undefined) {
        projected = p.messages;
        yield { type: "meta_note", turn, text: p.payload, channel: p.channel };
      }
      // ω99-28 T2 — the revert declaration: the PREVIOUS call carried a
      // projected note and THIS one does not → this input reverts that
      // message's serialized line to the original bytes (a one-line
      // divergence at an old message). Declared, not anomaly-worded. A
      // parked compaction attribution (this same turn's rewrite) wins.
      if (lastInputHadProjectedNote && p === undefined && coldAttribution === undefined) {
        coldAttribution = "meta-note projection revert (tail-only)";
      }
      lastInputHadProjectedNote = p !== undefined;
    }

    // M24 usage channel: the loop attaches the observer; the provider calls it
    // once its final usage is known (last SSE chunk / response body). The loop
    // cannot yield from inside a synchronous callback, so the value is parked
    // and emitted as a `usage` event right after the call settles. The prompt
    // size also feeds the compaction trigger (B4: real usage beats estimate).
    let pendingUsage: ModelUsage | undefined;
    // ω99-48: the usage row of the CURRENT model attempt only — pendingUsage
    // is turn-scoped, so the settlement of a ω99-9 recovery-resend failure
    // would otherwise read the PREVIOUS attempt's row and misattribute it
    // (each resend overwrites the same turn-scoped variable). Reset per
    // attempt in callModelInner, written raw (exactly as the provider
    // reported) by onUsage, read by settleFailedAttempt. Undefined = the
    // stream died before any usage arrived (most mid-stream failures —
    // usage rides the final chunk).
    let attemptUsage: ModelUsage | undefined;
    // 夜移 036: the budget charge happens INSIDE onUsage — every response
    // that reports usage draws from the shared budget (a retried-then-
    // overwritten pendingUsage still charged at its own callback). The
    // exhaustion flag parks here and surfaces at the settle seam below
    // (codex: the turn fails right after RawResponseCompleted).
    let sessionBudgetExhausted = false;
    // M48 §2: same parking pattern for the terminal-shape repair audit — the
    // provider fired it from inside the call, the loop surfaces the event.
    let pendingRepair: TerminalRepairKind | undefined;
    // M58 §A: inputs are built through one seam so the reactive retry picks up
    // the same observers. The builder CONSUMES the parked cold attribution (if
    // any) so exactly the first call on a rewritten prefix carries the
    // cold-turn-expected receipt annotation.
    const buildModelInput = (messages: readonly AgentMessage[]) => {
      const attribution = coldAttribution;
      coldAttribution = undefined;
      return {
        systemPrompt: state.systemPrompt,
        messages,
        tools: toolDefs,
        signal: options.signal,
        // ω-2b (I1-d): the admission clip rides the per-request override —
        // present only on the turns the occupancy check armed it (requests
        // stay byte-identical otherwise).
        ...(admissionClip !== undefined ? { maxTokens: admissionClip } : {}),
        onUsage: (u: ModelUsage) => {
          pendingUsage = attribution !== undefined
            ? { ...u, coldTurnExpected: true, cacheBreakAttribution: attribution }
            : u;
          // ω99-48: the raw provider row for the attempt settlement — the
          // attribution stamps above are the loop's own annotations, the
          // attempt entry embeds what the provider reported, verbatim.
          attemptUsage = u;
          // 夜移 036: charge the shared budget as usage lands (cached input
          // is free — the reward side of the cache invariant).
          if (options.sessionBudget !== undefined) {
            sessionBudgetExhausted = options.sessionBudget.budget.recordUsage(u) || sessionBudgetExhausted;
          }
          // M70 §2: record the usage anchor — the answering model identity
          // rides the row (the provider stamps it; a fallback answers under
          // its own name), and the message count fixes where the trailing
          // estimate starts (append-only growth until the next compaction).
          usageAnchor = {
            promptTokens: u.promptTokens,
            model: u.model ?? u.fallbackModel,
            messageCount: state.messages.length,
          };
          // ω-2b (I1-c): every real usage row is a calibration sample — the
          // answering model identity rides the ratio with the anchor's guard
          // shape (a fallback's row describes a different tokenizer).
          calibrate(u.promptTokens, messages, u.model ?? u.fallbackModel);
        },
        onTerminalRepair: (kind: TerminalRepairKind) => {
          pendingRepair = kind;
        },
      };
    };
    const modelInput = buildModelInput(projected);
    // 夜移 013: when a nudge armed the escalation, the CONTINUATION call
    // carries the raised completion cap — but only onto a cap-free request
    // (admission clips set maxTokens and own those turns; raising their cap
    // would fight the window fitting). The flag is consumed here, once.
    const escalateTo = options.outputLimitRecovery?.escalateTo;
    const callInput: typeof modelInput = escalateNextCall && escalateTo !== undefined && modelInput.maxTokens === undefined
      ? { ...modelInput, maxTokens: escalateTo }
      : modelInput;
    escalateNextCall = false;
    // Prefer streaming when the model supports it; emit text deltas live as
    // assistant_delta. Otherwise fall back to a blocking generate() call.
    // Abort during the call → aborted terminal, no partial assistant appended.
    // Only AbortError-name errors map to the aborted terminal; everything else
    // rethrows (existing error semantics unchanged).
    // M58 §A: the call is factored into a delegable inner generator so the
    // reactive-overflow path can run it a second time after compacting.
    // `streamedDelta` guards the reactive retry: an overflow thrown AFTER
    // deltas were yielded cannot be replayed (the output would duplicate) —
    // our providers only classify overflow at the HTTP boundary (before any
    // byte streams), so this is defense-in-depth for third-party clients.
    let streamedDelta = false;
    // 夜移 001: the delivered prefixes of the CURRENT callModel attempt —
    // committed by finalizeInterruptedStream when an abort lands mid-stream
    // (reset per attempt; the overflow ladder only retries pre-stream, so
    // third-party clients that stream-then-overflow commit their last
    // attempt's prefix, matching what the UI last rendered).
    let streamedText = "";
    let streamedReasoning = "";
    const callModelInner = async function* (input: typeof modelInput): AsyncGenerator<LoopEvent, AssistantMessage> {
      streamedDelta = false;
      streamedText = "";
      streamedReasoning = "";
      attemptUsage = undefined; // ω99-48: per-attempt, not per-turn (see its declaration)
      // 124b 项 1：本 attempt 的抢占武装——next() 换新 signal，与运行级
      // options.signal 合成后替换本调用的 signal。provider 侧随 signal 中
      // 断流（fetch abort + 流读循环的显式 abort 面）；运行中止与流抢占
      // 都以 AbortError 冒出，由 catch 位的归类面区分。attempt 之间的
      // request() 打在陈旧控制器上——下一次 next() 整体替换，无污染。
      // 无通道（缺席）时 input 原样传入，字节不变。
      const preemptSignal = options.streamPreempt?.next();
      const callInput: typeof modelInput = preemptSignal === undefined
        ? input
        : {
          ...input,
          signal: options.signal !== undefined
            ? AbortSignal.any([options.signal, preemptSignal])
            : preemptSignal,
        };
      if (model.stream) {
        let got: AssistantMessage | undefined;
        for await (const ev of model.stream(callInput)) {
          if (ev.type === "reasoning_delta") {
            streamedDelta = true;
            streamedReasoning += ev.text;
            yield { type: "reasoning_delta", turn, text: ev.text };
          } else if (ev.type === "text_delta") {
            streamedDelta = true;
            streamedText += ev.text;
            yield { type: "assistant_delta", turn, text: ev.text };
          } else {
            got = ev.message;
          }
        }
        if (!got) throw new Error("model stream ended without a done event");
        return got;
      }
      return model.generate(callInput);
    };
    // 夜移 035 (codex turn_timing.rs): the sampling bucket rides INSIDE
    // callModel so every call site — the happy path AND the three reactive-
    // ladder retries (clip / compact-resend / emergency) — is instrumented
    // exactly once per request. The finally covers stream aborts mid-delta.
    const callModel = async function* (input: typeof modelInput): AsyncGenerator<LoopEvent, AssistantMessage> {
      const guard = options.turnProfile?.beginSampling();
      try {
        return yield* callModelInner(input);
      } finally {
        guard?.end();
      }
    };
    // 夜移 001 (dsh interrupted-stream finalization): an abort mid-stream
    // COMMITS the delivered text/reasoning prefix as an `interrupted`
    // assistant message — the human transcript keeps exactly what streamed
    // (UI 与转录一致), resume/replay stay valid, and the next request sees
    // it as an append-only suffix (M24: the prefix bytes are never rewritten;
    // `interrupted` is persistence-only and never serialized). Called at
    // every abort-return that can follow streamed deltas. No deltas → null
    // (legacy behavior: nothing appended).
    const finalizeInterruptedStream = (): LoopEvent | null => {
      if (!streamedDelta) return null;
      if (streamedText.length === 0 && streamedReasoning.length === 0) return null;
      const partial: AssistantMessage = {
        role: "assistant",
        content: streamedText,
        ...(streamedReasoning.length > 0 ? { reasoning: streamedReasoning } : {}),
        interrupted: true,
        // ω99-53: same turn, same request — the partial carries the effort
        // trail exactly like the normal push below (persistence-only).
        ...(options.effortSent !== undefined ? { effort: options.effortSent } : {}),
      };
      state.messages.push(partial);
      return {
        type: "assistant_interrupted",
        turn,
        text: streamedText,
        hasReasoning: streamedReasoning.length > 0,
      };
    };
    // 124b 项 1（codex instant_interrupt）：finalizeInterruptedStream 的
    // 抢占孪生——语义相反。运行中止把已交付前缀提交进转录（UI 与转录一
    // 致，resume 保真）；流抢占则把被弃前缀【完全丢弃】：不 push 进
    // state.messages、不落 JSONL、不进模型所见（M24 声明：下一次请求的
    // 前缀 = 原 append-only 历史 + steering user 消息，被弃 partial 不在
    // 其中——模型不知道自己被打断过，除非 Phase B 的 MetaNote 告诉它）。
    // 审计走旁路：量（text/reasoning 字符数）与时刻（ISO）由事件载荷携带，
    // 前端据此提示用户并可落旁路日志——事件即审计通道，转录面零接触。
    // 首字节前的抢占计数诚实为 0，事件照发（中断事实本身对用户可见）。
    const settlePreemptedStream = (): LoopEvent => {
      preemptedPrevTurn = true; // Phase B：下一轮的 MetaNote 告知模型
      return {
        type: "stream_preempted",
        turn,
        droppedTextChars: streamedText.length,
        droppedReasoningChars: streamedReasoning.length,
        preemptedAt: new Date(now()).toISOString(),
      };
    };
    // ω99-48 (dsh attempt log-only settlement): finalizeInterruptedStream's
    // FAILURE twin. A mid-stream failure (non-abort — the abort path above
    // keeps its bytes) that is about to rethrow settles the delivered prefix
    // as a log-only assistant_attempt session entry through the
    // appendAttemptEntry seam: the transcript keeps what the UI rendered, the
    // failed attempt's usage row (input/cache-hit bytes — the diagnostic half
    // of M24's compensation semantics, observable on the failure side for the
    // first time), and the error text. Pure leave-a-trace: it never swallows,
    // wraps, or reorders the error — the rethrow right after the call site is
    // byte-identical, and a seam rejection is isolated (safeCall) so the
    // settlement can never change the failure semantics. Guards mirror the
    // abort twin: no deltas / empty prefix → nothing was rendered → no entry
    // (pre-delta failures have no transcript-UI gap to close). The entry is
    // NOT pushed into state.messages — it is not a message; model visibility
    // is zero by construction.
    const settleFailedAttempt = async (err: unknown): Promise<void> => {
      if (!streamedDelta) return;
      if (streamedText.length === 0 && streamedReasoning.length === 0) return;
      const seam = options.appendAttemptEntry;
      if (seam === undefined) return;
      await safeCall(() =>
        seam({
          type: "assistant_attempt",
          data: {
            content: streamedText,
            reasoning: streamedReasoning,
            ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
            at: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    };
    // ω99-11: the per-turn recovery budget, SHARED by all four call sites —
    // main plus the ladder's three legs — so the worst case stays bounded
    // (recovery resends ≤ MAX_TURN_RECOVERY_ATTEMPTS per turn no matter
    // which leg dropped; penguin #571 counts per call site, which multiplies
    // the budget across a multi-leg chain). Still deliberately NOT the
    // provider ladder's own counter (混计的教训).
    let turnRecoveryAttempts = 0;
    // ω99-12: the request that ACTUALLY overflowed this turn, recorded by the
    // helper right before it rethrows the overflow family. The clip leg
    // anchors its byte-identity resend HERE — the failure site — instead of
    // the turn-start `modelInput`: after a mid-stream recovery the RESENT
    // request (original + partial + NOTE, note re-projected) is the one that
    // can sit at the window edge, and a clip resend off the stale turn-start
    // anchor makes the model rewrite from scratch (duplicate transcript
    // text). Undefined = nothing overflowed out of the helper this turn →
    // the clip leg falls back to `modelInput`, the no-recovery case whose
    // bytes the old anchor already pinned. Per-turn scope (same block as the
    // counter above), so no anchor can leak across turns.
    let overflowAttemptInput: typeof modelInput | undefined;
    // ω99-11 (ω99-9 边界收口): the shared mid-stream recovery helper. ω99-9
    // wrapped ONLY the main call in a recovery for(;;), so a transport
    // failure inside a ladder leg — after that leg had already delivered
    // deltas — pierced the leg's catch and killed the run: whether recovery
    // happened at all depended on WHICH call site dropped. One helper now
    // wraps every callModel site with identical ω99-9 semantics (the
    // provider's pre-delta `produced` guard stays untouched — replaying a
    // streamed call would duplicate output): commit the delivered prefix
    // (the abort path's finalizeInterruptedStream — UI 与转录一致, M24
    // append-only, `interrupted` persistence-only), append the frozen
    // TURN_RECOVERY_NOTE, and re-send append-only off a rebuilt input.
    // Excluded, exactly as ω99-9's main arm: abort (rethrown — the leg/main
    // catches finalize; the helper NEVER finalizes, so the single finalize
    // points are unchanged), the ContextLengthError family incl.
    // ContextOverflowHardError (a mid-stream window problem belongs to the
    // overflow arms — ω99-9 ④), BackgroundOverloadError (M70 §3: background
    // calls back off, never revived), and the exhausted shared budget.
    // One-cap rule (§2): the rebuilt input is cap-free off state, so a leg
    // input that carried maxTokens (main's 013 escalation cap, the clip leg's
    // physical) keeps it on the resend — the resend is still completing that
    // same capped output; compact/emergency legs send cap-free and stay so.
    // A recovery resend that overflows pre-delta rethrows out of the helper
    // into the surrounding catch — the ladder's next tier takes it (recovery
    // and the ladder are orthogonal by construction).
    const callModelWithTurnRecovery = async function* (
      leg: RecoveryLeg,
      input: typeof callInput,
    ): AsyncGenerator<LoopEvent, AssistantMessage> {
      let resend: typeof input | undefined; // first attempt = input; after recovery = rebuilt
      for (;;) {
        try {
          return yield* callModel(resend ?? input);
        } catch (err) {
          if (isAbortError(err)) throw err;
          // 113-B3: a quota-park error is excluded from the midstream recovery
          // exactly like BackgroundOverloadError — replaying against an account
          // the provider just said is capped for hours is the retry storm the
          // park posture exists to prevent (the HOST parks + wakes at reset).
          if (
            streamedDelta && !isContextLengthError(err) && !isBackgroundOverloadError(err) && !isQuotaParkError(err) &&
            turnRecoveryAttempts < MAX_TURN_RECOVERY_ATTEMPTS
          ) {
            // The ω99-9 five steps, verbatim for every leg:
            const interrupted = finalizeInterruptedStream();
            if (interrupted) yield interrupted;
            turnRecoveryAttempts += 1;
            yield {
              type: "turn_retried",
              turn,
              attempt: turnRecoveryAttempts,
              reason: err instanceof Error ? err.message : String(err),
              // ω99-315: the structured class rides alongside the raw message —
              // the run-stats 断流重连 counter counts exactly reasonClass==="idle".
              reasonClass: classifyTurnRetryError(err),
              leg,
            };
            state.messages.push({ role: "user", content: TURN_RECOVERY_NOTE });
            streamedDelta = false;
            streamedText = "";
            streamedReasoning = "";
            const base = buildModelInput(projectNotes(state.messages)?.messages ?? state.messages);
            resend = input.maxTokens !== undefined && base.maxTokens === undefined
              ? { ...base, maxTokens: input.maxTokens }
              : base;
            continue;
          }
          // ω99-12: record the overflowing request BEFORE the rethrow — the
          // clip leg re-sends byte-identical off the failure site. Covers
          // both shapes: a FIRST-attempt overflow (`resend` unset → `input`,
          // the leg's original request — for the main leg that is the turn-
          // first request, the anchor the old call site assumed) and a
          // RECOVERY resend that overflowed (`resend` set → the rebuilt
          // original+partial+NOTE request). The ContextOverflowHardError
          // duck-type (same `name`) matches the recognizer too — it never
          // reaches the clip leg, so recording it is harmless, and the
          // recognizer is deliberately NOT widened for this.
          if (isContextLengthError(err)) overflowAttemptInput = resend ?? input;
          // ω99-48: the attempt that finally failed settles HERE — every model
          // attempt (main + the three ladder legs) funnels its final failure
          // through this one rethrow, so the log-only entry is written exactly
          // once per failed attempt, and the rethrow's own semantics are
          // untouched. Aborts left at the isAbortError guard far above (never
          // settled); earlier ω99-9 recoveries already committed their partials
          // as interrupted messages; and a leg whose failure the ladder later
          // recovers from still settles here — its delivered prefix was
          // unreplayable, the loss is real (previously untraced).
          await settleFailedAttempt(err);
          throw err; // overflow family / BackgroundOverload / exhausted budget → the surrounding semantics
        }
      }
    };
    let assistant: AssistantMessage | undefined;
    try {
      assistant = yield* callModelWithTurnRecovery("main", callInput);
    } catch (err) {
        if (isAbortError(err)) {
          // 124b 项 1：中止归类——运行 signal 未触发而本 attempt 的抢占
          // 通道已触发 = 流抢占（用户提交了新指令）：被弃前缀旁路审计
          // （stream_preempted 事件），不进转录；轮次 +1 立即续跑，顶部
          // steering drain 把新指令作为下一条 user 消息注入。运行 signal
          // 触发（或无通道）= 原有中止语义，逐字节不变。
          if (options.signal?.aborted !== true && options.streamPreempt?.fired() === true) {
            yield settlePreemptedStream();
            turn += 1;
            continue;
          }
          const interrupted = finalizeInterruptedStream();
          if (interrupted) yield interrupted;
          return { reason: "aborted" };
        }
        // M58 §A + ω-2b (I1-d): the context-overflow ladder — graded, each step
        // at most once per turn. A provider-classified overflow (see the port
        // contract on isContextLengthError) reacts in order:
        //   1. calibrate off the trusted parse (when the body carried numbers)
        //      and learn the REAL window;
        //   2. CLIP-RETRY: when the (learned) window still leaves a usable
        //      completion budget (≥ MIN_CLIP_TOKENS), resend the IDENTICAL
        //      input with maxTokens capped to fit — the prompt bytes never
        //      change, so the prefix cache keeps hitting (cache-neutral);
        //   3. COMPACT: the M58 reactive path — the full M52 ladder, trigger
        //      "reactive" — and retry once on the shortened prefix;
        //   4. terminal ContextOverflowHardError — the task does not fit.
        // F1 (clip-conflict): a computed-cap/thinking-budget conflict on OUR
        // arithmetic — the admission clip armed this turn, the only explicit
        // maxTokens core ever puts on the original request — is recoverable by
        // compaction (a shorter prompt raises the computed cap above the
        // budget), so it rides the SAME reactive ladder below instead of the
        // old hard rethrow. A conflict with no armed clip is a caller-chosen
        // cap (config.maxTokens): deterministic, un-compactable, and it keeps
        // the wire-r2 ① fail-closed propagation.
        const conflictOnComputedCap =
          isMaxTokensThinkingBudgetConflict(err) && !streamedDelta && admissionClip !== undefined;
        // conflict-origin: the provider stamped that the PERSISTENT config cap
        // (config.maxTokens) also sits at/below the thinking budget. Compaction
        // cannot rescue that — the post-compact resend's cap resolves back to
        // the config cap and re-conflicts before the wire — so the ladder
        // below (clip-retry AND compact, a full summarizer call) is pre-doomed.
        // Keep the typed fail-closed propagation directly, the same `throw err`
        // the no-ladder branch below takes for un-routable conflicts. An
        // unmarked conflict (field absent or false) routes exactly as before.
        if (isMaxTokensThinkingBudgetConflict(err) && hasConfigCapConflict(err)) throw err;
        if (conflictOnComputedCap) {
          // The rejected cap must not ride this turn's retries (buildModelInput
          // reads admissionClip at call time): drop it — the post-compact
          // requests go out on the provider's own cap, the "natural rise" the
          // recovery relies on. maxTokens is a sampling parameter, so this
          // never touches the prefix bytes (M24).
          admissionClip = undefined;
        }
        if ((isContextLengthError(err) || conflictOnComputedCap) && !streamedDelta) {
          const observed = isContextLengthError(err) ? err.observed : undefined;
          if (observed !== undefined) {
            calibrate(observed.promptTokens, projected, currentModelId);
            if (observed.windowTokens > 0) {
              // 87 item 2: floored — a poisoned tiny parse must not collapse
              // the effective window (see MIN_LEARNED_WINDOW_TOKENS).
              learnedWindow = Math.max(MIN_LEARNED_WINDOW_TOKENS, observed.windowTokens);
              learnedModel = currentModelId;
            }
          }
          const physical = effectiveWindow() - (observed?.promptTokens ?? occupancyNow()) - OUTPUT_BUDGET_RESERVE_TOKENS;
          let recovered = false;
          // F1: on a routed conflict the clip-retry arm is provably dead —
          // `physical` comes from the SAME occupancy that produced the
          // conflicting cap (a conflict carries no trusted-parse observed), so
          // the retry would deterministically re-conflict before the wire.
          // Skip straight to the compact arm.
          if (!conflictOnComputedCap && physical >= MIN_CLIP_TOKENS) {
            try {
              options.turnProfile?.recordSamplingRetry();
              // ω99-11: the clip leg rides the shared recovery helper — a
              // mid-stream drop here recovers like the main call (leg "clip").
              // ω99-12: the byte-identity anchor is the request that ACTUALLY
              // overflowed (recorded by the helper's rethrow), not the
              // turn-start `modelInput` snapshot. Invariant SHARPENED: the
              // clip resend is byte-identical to the OVERFLOWING request —
              // "identical to the turn-first request" was only its no-recovery
              // special case, so the prefix-cache semantics no longer depend
              // on where in the turn the overflow landed. The spread override
              // puts `maxTokens: physical` over any source cap (013 escalation
              // cap, admission clip, or none) — on the no-recovery path this
              // stays byte-equivalent to the old `{...modelInput, maxTokens:
              // physical}`.
              const clipBase = overflowAttemptInput ?? modelInput;
              assistant = yield* callModelWithTurnRecovery("clip", { ...clipBase, maxTokens: physical });
              yield { type: "context_recovery", turn, kind: "clip", maxTokens: physical };
              recovered = true;
            } catch (clipErr) {
              if (isAbortError(clipErr)) {
                // 124b 项 1：梯子腿上的抢占同款归类（见 main catch 位注释）。
                if (options.signal?.aborted !== true && options.streamPreempt?.fired() === true) {
                  yield settlePreemptedStream();
                  turn += 1;
                  continue;
                }
                const interrupted = finalizeInterruptedStream();
                if (interrupted) yield interrupted;
                return { reason: "aborted" };
              }
              // conflict-origin: the clipped retry's conflict carries the
              // config-cap marker (config.maxTokens itself ≤ budget). The
              // "pre-doomed" MECHANISM holds on this catch's main path — the
              // original err was a genuine overflow with NOTHING armed (a
              // routed conflict never reaches this catch: :1309 skips the
              // clip-retry arm entirely), so the compact resend would carry
              // no input cap, resolve back to config.maxTokens ≤ budget, and
              // re-conflict before the wire. It does
              // NOT hold on the compound corner (original err a genuine
              // overflow, armed clip > budget still live, physical landed in
              // [MIN_CLIP_TOKENS, budget]): there the compact resend would
              // carry the still-armed clip and could physically serve. The
              // skip is correct there BY POLICY, not mechanism — the recovery
              // would mask a deterministic config conflict with core
              // arithmetic (maxtokens-narrow ruling: fail-closed beats
              // speculative recovery), and the old path was itself 2-4 model
              // calls ending in the same typed conflict. Keep the typed
              // fail-closed propagation.
              if (isMaxTokensThinkingBudgetConflict(clipErr) && hasConfigCapConflict(clipErr)) throw clipErr;
              // Only an overflow — or, F1 (clip-conflict), a conflict on the
              // clipped retry's OWN computed cap (physical ≤ budget; that
              // request was core's arithmetic by construction) — falls through
              // to compaction; every other error keeps its normal propagation.
              if (!isContextLengthError(clipErr) && !isMaxTokensThinkingBudgetConflict(clipErr)) throw clipErr;
            }
          }
          if (!recovered) {
            if (options.compaction) {
              // 89 item 2: reference identity across doCompact — the tier-0
              // clear can swap state.messages to the cleared copy with NO
              // compacted event (cleared>0 yet still over threshold, both
              // summary tiers bailed partition-null), and that resend is NOT
              // byte-identical. "retried" must promise the identical resend, so
              // it is earned only by an untouched array reference.
              const messagesBeforeCompact = state.messages;
              const out = await doCompact(turn, "reactive");
              // 89 item 3 (report-87 review M2): NO deferred handling here —
              // provably dead at this site. doCompact's ONLY deferred-producing
              // return is the PreCompact gate (above), which requires
              // `trigger !== "reactive"`; this call passes the literal
              // "reactive" (the exemption is the design: skipping a compaction
              // post-413 means a guaranteed hard failure), so out.deferred is
              // structurally undefined. If that exemption is ever lifted, this
              // site must grow a compact_deferred yield again.
              for (const ev of out.events) yield ev;
              pendingCompaction = false;
              // 87 item 1: the recovery kind must tell the truth about WHAT
              // recovered the turn. A compacted event means history actually
              // moved; without one the reactive compact freed nothing and any
              // recovery came from the bare resend itself (a transient 400) —
              // labeling that "compacted" claims a compaction that never ran.
              // 89 item 2: without an event there are still TWO honest cases —
              // untouched history = the bare identical resend ("retried");
              // history swapped by the eventless clear = "cleared" (the resend
              // rode the cleared prefix — not identical, not a summary tier).
              const compactedFired = out.events.some((ev) => ev.type === "compacted");
              const resentIdentical = state.messages === messagesBeforeCompact;
              try {
                // Review fix: re-project the drained notes onto the post-compaction
                // messages — the notes consumed for the failed call must reach the
                // retry too (the drain is once-per-turn, the projection is pure).
                const retryProjected = projectNotes(state.messages)?.messages ?? state.messages;
                options.turnProfile?.recordSamplingRetry();
                // ω99-11: the compact-resend leg rides the shared recovery
                // helper too (leg "compact"; cap-free leg → cap-free resend).
                assistant = yield* callModelWithTurnRecovery("compact", buildModelInput(retryProjected));
                yield { type: "context_recovery", turn, kind: compactedFired ? "compacted" : resentIdentical ? "retried" : "cleared" };
                recovered = true;
              } catch (retryErr) {
                if (isAbortError(retryErr)) {
                  // 124b 项 1：梯子腿上的抢占同款归类（见 main catch 位注释）。
                  if (options.signal?.aborted !== true && options.streamPreempt?.fired() === true) {
                    yield settlePreemptedStream();
                    turn += 1;
                    continue;
                  }
                  const interrupted = finalizeInterruptedStream();
                  if (interrupted) yield interrupted;
                  return { reason: "aborted" };
                }
                if (isContextLengthError(retryErr)) {
                  // ω-2b (I2-b) — the emergency truncate tier: the compact-retry
                  // ALSO overflowed. Shed the oldest 20% of the droppable head
                  // (pairing-safe, head+summary-pinned, ONE frozen count-marker)
                  // and retry ONCE more — the 4th and FINAL model attempt this
                  // turn (original + clip + compact + emergency); a further
                  // overflow below is the terminal hard error by rule 5.
                  const toolDefsNow = defer.requestDefs();
                  const drop = emergencyDrop(state.messages, {
                    fitsTokens: Math.max(1, effectiveWindow() - OUTPUT_BUDGET_RESERVE_TOKENS),
                    systemPrompt: state.systemPrompt,
                    tools: toolDefsNow,
                    ...(options.compaction?.keepRecent !== undefined ? { keepRecent: options.compaction.keepRecent } : {}),
                  });
                  if (drop === null) throw new ContextOverflowHardError(String(retryErr.message), true);
                  const beforeDrop = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
                  state.messages = drop.messages;
                  const afterDrop = estimateTokens(state.systemPrompt, toolDefsNow, state.messages);
                  // The prefix was rewritten (oldest messages gone) — one cold
                  // turn, attributed to the emergency tier (M24 compensation).
                  coldAttribution = "emergency";
                  // M70 §2 guard (b): the anchor predates this boundary.
                  usageAnchor = undefined;
                  await safeCall(() => options.hooks?.onPostCompact?.(state.messages, "auto"));
                  yield {
                    type: "compacted",
                    turn,
                    beforeTokens: beforeDrop,
                    afterTokens: afterDrop,
                    tier: 3,
                    trigger: "emergency",
                    reason: "overflow",
                    retainedTail: state.messages.slice(alignedCutoff(state.messages, options.compaction?.keepRecent ?? 6)),
                  };
                  try {
                    const emergencyProjected = projectNotes(state.messages)?.messages ?? state.messages;
                    options.turnProfile?.recordSamplingRetry();
                    // ω99-11: the emergency leg rides the shared recovery
                    // helper too (leg "emergency").
                    assistant = yield* callModelWithTurnRecovery("emergency", buildModelInput(emergencyProjected));
                    // 87 item 3: the emergency recovery is observable like its
                    // siblings — the tier-3 compacted event above carries the
                    // drop; this event says the TURN was recovered, by which
                    // tier of the ladder (kind "emergency", no cap carried).
                    yield { type: "context_recovery", turn, kind: "emergency" };
                    recovered = true;
                  } catch (emErr) {
                    if (isAbortError(emErr)) {
                      // 124b 项 1：梯子腿上的抢占同款归类（见 main catch 位注释）。
                      if (options.signal?.aborted !== true && options.streamPreempt?.fired() === true) {
                        yield settlePreemptedStream();
                        turn += 1;
                        continue;
                      }
                      const interrupted = finalizeInterruptedStream();
                      if (interrupted) yield interrupted;
                      return { reason: "aborted" };
                    }
                    if (isContextLengthError(emErr)) throw new ContextOverflowHardError(String(emErr.message), true);
                    throw emErr;
                  }
                } else {
                  // A non-overflow compact-retry failure keeps its propagation.
                  throw retryErr;
                }
              }
            } else {
              // F1: with no ladder to route into, the conflict keeps its own
              // typed terminal — the overflow's "does not fit" hard error would
              // mislabel a cap/budget conflict.
              // Provably dead TODAY (89-item-3 style note): conflictOnComputedCap
              // requires an armed admission clip, and the ONLY arming site
              // (~:1069) is nested inside `if (options.compaction)` — with the
              // ladder absent the clip is never armed, so this sub-branch cannot
              // fire. Kept as the guard for the contract "admission clips arm
              // only under a compaction config": if arming ever decouples, the
              // fall-through below would mislabel a typed conflict as a context
              // overflow. Delete only together with that contract.
              if (conflictOnComputedCap) throw err;
              throw new ContextOverflowHardError(String((err as Error).message), false);
            }
          }
        } else if (isContextLengthError(err)) {
          // Post-delta overflow: the delivered prefix cannot be replayed (the
          // ladder above arms only pre-delta), and ω99-9's arm deliberately
          // leaves this to the overflow family — a mid-stream ContextLength
          // is a window problem, not a transport one.
          throw new ContextOverflowHardError(String(err.message), false);
        } else {
          // ω99-9's recovery arm lives inside callModelWithTurnRecovery now
          // (ω99-11) — a post-delta transport failure never reaches this
          // catch; the helper either recovered inside itself or rethrew one
          // of the excluded classes (abort returned above; the overflow
          // family took the branches above; BackgroundOverloadError and the
          // exhausted-budget drop land HERE and keep their propagation).
          throw err;
        }
      }
    // Every path through the try/catch either assigned `assistant`, returned,
    // or threw (the ladder's clip/compact arms each end in assign-or-exit;
    // the ω99-11 recovery helper resolves inside itself or rethrows) — the
    // assertion is that invariant, not a runtime hope.
    // ω99-53: stamp the run's reasoning effort onto the pushed message when
    // the caller reported one. The stamp is a NEW object only when needed —
    // effortSent absent keeps today's exact reference and shape (zero
    // behavior change). Persistence-only (AssistantMessage.effort): the
    // terminal's finalMessage and the JSONL tail carry it; the wire never
    // does (M47 — serializers map fields explicitly).
    const finalAssistant: AssistantMessage = options.effortSent === undefined
      ? assistant!
      : { ...assistant!, effort: options.effortSent };
    state.messages.push(finalAssistant);
    const toolCalls = finalAssistant.toolCalls ?? [];
    // 夜移 013: any NON-length assistant turn (a clean final answer OR a
    // tool-call turn) breaks the truncation streak — the model made progress
    // by other means, so the next truncation starts a fresh nudge episode
    // (STOP_BLOCK_CAP's consecutive-episode philosophy). A length turn —
    // including M70's truncated tool call — does not reset.
    if (finalAssistant.stopReason !== "length") {
      outputLimitNudges = 0;
    }
    // 夜移 024 (Reasonix handleToolRound's reset): a tool round proves
    // progress — a LATER blank-final streak deserves a fresh nudge budget,
    // so the counter guards against consecutive blanks only.
    if (toolCalls.length > 0) {
      emptyFinalNudges = 0;
    }
    yield {
      type: "model_call_finished",
      turn,
      hasToolCalls: toolCalls.length > 0,
      toolCallCount: toolCalls.length,
    };
    if (pendingUsage !== undefined) {
      yield { type: "usage", turn, usage: pendingUsage };
    }
    // 夜移 036: budget exhausted → the run ends HERE, before the tool batch
    // (codex: break Err(SessionBudgetExceeded) right after the response
    // completes — the response's tool calls never execute). No retry, and
    // the flag is sticky across later runs (each subsequent run burns one
    // call, records, fails — same as codex's later-turns behavior).
    if (sessionBudgetExhausted) {
      yield { type: "session_budget_exhausted", turn, usedUnits: options.sessionBudget?.budget.usedUnits() ?? 0 };
      return { reason: "session_budget_exhausted" };
    }
    if (pendingRepair !== undefined) {
      yield { type: "terminal_repair", turn, kind: pendingRepair };
    }

    // Permission gates + hooks run per call, AFTER that call's
    // tool_call_started has been emitted (M45 §1.6's display-first iron rule:
    // the UI shows tool progress — "⏺ shell(…)" — while the safety
    // check, e.g. the auto-mode sidecar, runs behind it; the display channel
    // never waits on the gate). M33 §2: onPreToolUse runs BEFORE canUseTool
    // per call — a hook block skips both the gate and the execution; a
    // throwing hook degrades to allow (the run continues, the block is not
    // honored). Each call comes out either denied (with its error message
    // already built) or allowed (message still to be produced).
    // M63-B: the todo-board transition gate — the OLD board is the last board
    // message in history; the NEW board is the call's todos. Only actual
    // deltas fire (no transition, no hook). A throwing hook degrades to
    // allow; a block refuses the write with the reason in the tool result.
    // 拆分外提（借鉴弧 B2 收口）：匹配/咨询的纯 halves 走 todo-transition.ts。
    const gateTodoTransition = async (call: ToolCall): Promise<ToolResultMessage | undefined> => {
      if (call.name !== "todo_write") return undefined;
      const rawTodos = call.arguments["todos"];
      if (!Array.isArray(rawTodos)) return undefined; // schema validation owns junk
      const newItems = parseTodoItems(rawTodos);
      const { created, completed } = todoTransitionDelta(lastBoardItems(state.messages), newItems);
      if (created.length === 0 && completed.length === 0) return undefined;
      // B2（SoL-Pi C2）：完成 transition = 子任务边界候选。这里登记（新 board
      // 的未完成数为期距的「剩余边界数」），结果落地且非 error 时在下方两个
      // 落点兑现——被钩子拦下/出错的写不算边界。
      if (completed.length > 0) {
        pendingTodoBoundaries.set(call.id, newItems.filter((it) => it.status !== "done").length);
      }
      const board = { total: newItems.length, done: newItems.filter((it) => it.status === "done").length };
      const createdBlock = await consultTaskHook(options.hooks?.onTaskCreated, created, board);
      if (createdBlock !== undefined) {
        return { role: "tool", toolCallId: call.id, name: call.name, content: `todo_write blocked by hook: ${createdBlock}`, isError: true };
      }
      const completedBlock = await consultTaskHook(options.hooks?.onTaskCompleted, completed, board);
      if (completedBlock !== undefined) {
        return { role: "tool", toolCallId: call.id, name: call.name, content: `todo_write blocked by hook: ${completedBlock}`, isError: true };
      }
      return undefined;
    };

    const gateCall = async (call: ToolCall): Promise<{ call: ToolCall; denied?: ToolResultMessage }> => {
      let hookBlocked: ToolResultMessage | undefined;
      let rewritten: ToolCall = call;
      try {
        const pre = await options.hooks?.onPreToolUse?.(call.name, call.arguments);
        if (pre && typeof pre === "object") {
          if ("block" in pre && pre.block) {
            hookBlocked = { role: "tool", toolCallId: call.id, name: call.name, content: `blocked by hook: ${pre.reason}`, isError: true };
          } else if ("updatedInput" in pre && pre.updatedInput !== undefined && typeof pre.updatedInput === "object") {
            // M63-C §2: the explicit rewrite contract — validation and the
            // tool see the REWRITTEN arguments (the loop's normalized-line
            // audit rides the execution path as usual).
            rewritten = { ...call, arguments: pre.updatedInput as Record<string, unknown> };
          }
        }
      } catch {
        hookBlocked = undefined; // throwing interceptor → allow
      }
      if (hookBlocked !== undefined) return { call, denied: hookBlocked };
      call = rewritten;
      // M63-B: todo board transitions gate between the interceptor and the
      // permission pipeline (a task block skips canUseTool entirely).
      const taskBlocked = await gateTodoTransition(call);
      if (taskBlocked !== undefined) return { call, denied: taskBlocked };
      let decision: PermissionDecision;
      try {
        decision = options.canUseTool ? await options.canUseTool(call.name, call.arguments) : { behavior: "allow" as const };
      } catch {
        decision = { behavior: "deny" as const, reason: "permission check failed" };
      }
      return decision.behavior === "deny"
        ? { call, denied: { role: "tool", toolCallId: call.id, name: call.name, content: `permission denied${decision.reason ? ": " + decision.reason : ""}`, isError: true } }
        : { call };
    };

    // Concurrency: a multi-call batch where EVERY tool reports isConcurrencySafe
    // runs via Promise.all; anything else (or a single call) stays sequential.
    // (M35: load_tools lives in execTools and is NOT concurrency-safe, so a
    // batch containing it runs sequentially by the same rule.)
    // M45 §1: a concurrency-safe batch's GATES also run via Promise.all —
    // their sidecar checks classify in parallel (spec §1). Today only read
    // tools are concurrency-safe (they gate to allow without prompting), so
    // the "gates may prompt a human — never concurrently" invariant still
    // holds wherever prompting is possible.
    // ω-5b (R9): the hook-config fact Reasonix names — when ANY per-call hook
    // face is configured and safety is not asserted, the batch takes the
    // sequential path (gates, hooks and execution strictly ordered per call).
    // Three synchronous property reads, evaluated once per turn: cheap and
    // deterministic. canUseTool is deliberately NOT in the predicate (the
    // sanctioned prompt-free read-gate parallelism survives).
    const perCallHooksConfigured = options.hooks?.onPreToolUse !== undefined
      || options.hooks?.onTaskCreated !== undefined
      || options.hooks?.onTaskCompleted !== undefined;
    const allSafe = toolCalls.length > 1
      && toolCalls.every((call) => execTools.find((t) => t.name === call.name)?.isConcurrencySafe?.(call.arguments) === true)
      && !(perCallHooksConfigured && options.hooks?.toolHooksConcurrencySafe !== true);

    // Tool-batch abort: one shared promise rejecting on signal abort, raced
    // against each execution so a hung tool cannot outlive an abort. The
    // listener is removed after the batch; when aborting mid-batch we return
    // the aborted terminal WITHOUT appending tool results. Created unconditionally
    // when a signal exists (even if already aborted) and checked below.
    // M51 §3: `interruptBehavior: "block"` tools are EXEMPT from the race —
    // cancelling them mid-flight is the hazard the annotation exists for;
    // the run waits for them to settle.
    const signal = options.signal;
    const abortRace = signal ? createAbortRace(signal) : undefined;
    const blocksInterrupt = (name: string): boolean =>
      execTools.find((t) => t.name === name)?.interruptBehavior === "block";

    // 弧 δ (penguin 367ab084): the batch's detach machinery — the SAME
    // lifetime as abortRace (created per tool phase, torn down in the same
    // finally). Requests are PER-CALL: the listener resolves the one armed
    // race whose callId matches, anything else parks in `detachPending` (a
    // request that landed during the call's GATE arms-and-wins the moment
    // its race is built — penguin's already-detached check, same posture as
    // createAbortRace's signal.aborted fast path). Block tools never arm a
    // leg (their settle contract outranks backgrounding — the same exemption
    // the abort race gives them).
    const DETACHED = { detached: true } as const;
    type RaceOutcome = { message: ToolResultMessage; provenance?: string } | { aborted: true } | { message: ToolResultMessage; provenance?: string; detached: true };
    const detachArmed = new Map<string, () => void>();
    const detachPending = new Set<string>();
    const offDetach = options.toolDetach?.onRequest((callId) => {
      const resolve = detachArmed.get(callId);
      if (resolve !== undefined) {
        resolve();
      } else {
        detachPending.add(callId);
      }
    });
    /** The race leg for callId, or undefined when detaching is off / the
     *  tool is uninterruptible. `release` disarms the leg when the race
     *  settles without a detach (execution/abort won) so a later request
     *  can never resolve a dead promise. */
    const detachRaceFor = (callId: string): { promise: Promise<typeof DETACHED>; release: () => void } | undefined => {
      if (options.toolDetach === undefined) return undefined;
      if (detachPending.delete(callId)) {
        return { promise: Promise.resolve(DETACHED), release: () => {} };
      }
      let resolveLeg!: (v: typeof DETACHED) => void;
      const promise = new Promise<typeof DETACHED>((r) => { resolveLeg = r; });
      detachArmed.set(callId, () => {
        detachArmed.delete(callId);
        resolveLeg(DETACHED);
      });
      return { promise, release: () => { detachArmed.delete(callId); } };
    };
    /** The shared handoff: collector to the consumer + the paired synthetic
     *  (the call is STILL RUNNING — not an error, not an abort). Provenance
     *  rides the real result later, on the consumer's lane. */
    let detachedThisBatch = false;
    const settleDetached = (call: ToolCall, controller: AbortController, exec: Promise<{ message: ToolResultMessage; provenance?: string }>): { message: ToolResultMessage; provenance?: string; detached: true } => {
      void exec.catch(() => {}); // never rejects in practice — the catch keeps an absent consumer leak-free
      detachedThisBatch = true;
      options.onDetachedCall?.({ call, controller, result: exec });
      return {
        message: { role: "tool", toolCallId: call.id, name: call.name, content: BACKGROUNDED_TOOL_RESULT, isError: false },
        provenance: undefined,
        detached: true,
      };
    };

    // If already aborted, return terminal immediately without starting tools
    if (signal?.aborted) return { reason: "aborted" };

    // M48 §1: this turn's executed calls (denied/blocked included — they are
    // model-visible failures too) feed the loop-safety detectors below.
    const turnSafetyCalls: LoopSafetyCall[] = [];
    // M63-A: the executed calls of THIS batch, as the PostToolBatch hook sees
    // them (the "actually executed" doctrine — denied/blocked/truncated calls
    // are absent). Fires once after the whole batch settles.
    const turnBatch: PostToolBatchCall[] = [];

    // 夜移 035: the tool phase = permission gates + execution + result
    // normalization, ended in the batch's existing finally (which also cleans
    // the abort race — same termination point).
    const toolGuard = options.turnProfile?.beginToolBlocking();
    try {
      // 波次 8 #45 (dsh session-checkpoint-policy): the pre-dispatch
      // durability barrier. One await per tool-carrying turn, before the
      // truncation guard and both execution paths — the consumer lands the
      // assistant's tool_use batch on the session store HERE, so a crash
      // mid-tool leaves a durable unmatched call for resume (which then
      // answers it with the UNKNOWN-outcome repair instead of losing the
      // side-effect trace entirely). Rejection fails the batch closed below.
      let persistFailed = false;
      if (toolCalls.length > 0 && options.onBeforeToolDispatch !== undefined) {
        try {
          await options.onBeforeToolDispatch(state.messages);
        } catch {
          persistFailed = true;
        }
      }
      // M70 §1 (pi) — truncated tool-call guard: a length-cut generation
      // never executes. Every call in the message fails with the explanatory
      // error result (the model re-issues complete calls next turn); gates,
      // hooks, and execution are all skipped. The calls still feed the
      // loop-safety detectors — a model repeatedly truncating is stuck.
      if (finalAssistant.stopReason === "length" && toolCalls.length > 0) {
        for (const call of toolCalls) {
          yield { type: "tool_call_started", turn, toolCallId: call.id, toolName: call.name, input: call.arguments };
          state.messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: TRUNCATED_TOOL_CALL_RESULT,
            isError: true,
          });
          turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: true });
          yield { type: "tool_call_finished", turn, toolCallId: call.id, isError: true, result: TRUNCATED_TOOL_CALL_RESULT };
        }
      } else if (persistFailed) {
        // 波次 8 #45: the durability barrier rejected — fail the batch
        // CLOSED (nothing runs: a side-effecting body with no durable record
        // of its dispatch is how a crash becomes an untraceable mutation).
        // Same synthetic shape as M70's guard; the run survives so the MODEL
        // sees the failure and decides (retry, warn, or stop).
        for (const call of toolCalls) {
          yield { type: "tool_call_started", turn, toolCallId: call.id, toolName: call.name, input: call.arguments };
          state.messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: PERSIST_FAILED_TOOL_RESULT,
            isError: true,
          });
          turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: true });
          yield { type: "tool_call_finished", turn, toolCallId: call.id, isError: true, result: PERSIST_FAILED_TOOL_RESULT };
        }
      } else if (allSafe) {
        for (const call of toolCalls) {
          yield { type: "tool_call_started", turn, toolCallId: call.id, toolName: call.name, input: call.arguments };
        }
        // ω-5b (I21): each call runs as ONE pipelined promise carrying its
        // OWN clock — gate start → result settle (gate + execution) — so a
        // fan-out reports per-call durations, not batch wall time. The gate
        // layer still runs concurrently per call (the M45 §1.6 fan-out this
        // branch exists for); messages + finished events stay in the
        // ORIGINAL call order below.
        const runGatedCall = async (call: ToolCall): Promise<{ entry: { call: ToolCall; denied?: ToolResultMessage }; outcome: { message: ToolResultMessage; provenance?: string } | { aborted: true } | { message: ToolResultMessage; provenance?: string; detached: true }; durationMs: number }> => {
          const startedAt = performance.now();
          const gated = await gateCall(call);
          // Execute tools, racing non-block tools against abort. When a
          // non-block tool loses the race, the abortRace promise rejects
          // with AbortError; convert to the sentinel "aborted" outcome so
          // Promise.all doesn't fail and block-tool results survive.
          // R1: execute the GATED call — gateCall returns the M63-C rewrite
          // {updatedInput} on the entry's call; running the closure's
          // original `call` makes execution disagree with the batch audit
          // trail (turnBatch.input / turnSafetyCalls / skill/rule reads).
          const target = gated.call;
          if (gated.denied !== undefined) {
            return { entry: gated, outcome: { message: gated.denied, provenance: undefined as string | undefined }, durationMs: performance.now() - startedAt };
          }
          // 弧 δ: with a detach port, every non-block execution carries its
          // own controller (the ONLY stop path for the backgrounded task)
          // and races a detach leg alongside the abort race — penguin's
          // union collect window (collectUntil(signal, detachSignal)):
          // execution / abort / detach, whichever settles first wins, and
          // only a DETACH win leaves the execution promise alive past the
          // race (handed to the lane, never cancelled, never abandoned).
          const detachable = options.toolDetach !== undefined && !blocksInterrupt(target.name);
          const controller = detachable ? new AbortController() : undefined;
          const exec = executeGuardedToolCall(target, controller?.signal);
          const detachLeg = detachable ? detachRaceFor(target.id) : undefined;
          try {
            const legs: Promise<RaceOutcome | typeof DETACHED>[] = [exec];
            if (abortRace && !blocksInterrupt(target.name)) legs.push(abortRace.promise);
            if (detachLeg !== undefined) legs.push(detachLeg.promise);
            const raced: RaceOutcome | typeof DETACHED = legs.length > 1
              ? await Promise.race(legs).catch(
                  (err) => err?.name === "AbortError" ? { aborted: true as const } : Promise.reject(err),
                )
              : await exec;
            // A DETACHED leg only ever enters the race when a controller was
            // created for this call (detachable ⇒ both) — the cast is the
            // invariant, not an escape hatch.
            const outcome: RaceOutcome = raced === DETACHED
              ? settleDetached(target, controller as AbortController, exec)
              : (raced as RaceOutcome);
            return { entry: gated, outcome, durationMs: performance.now() - startedAt };
          } finally {
            detachLeg?.release();
          }
        };
        const results = await Promise.all(toolCalls.map((call) => runGatedCall(call)));
        // M51 §3: a block tool's result lands even when the signal aborted
        // while it ran (an external abort/detach) — its whole point is that
        // cancellation must not discard it. Results are processed below, and
        // the abort return only applies to non-block tools.
        const aborted = signal?.aborted ?? false;
        // Messages + finished events stay in the ORIGINAL call order.
        for (let i = 0; i < results.length; i += 1) {
          const result = results[i];
          if (!result) continue;
          const { entry, outcome, durationMs } = result;
          // Skip tools that lost the race (got the "aborted" sentinel)
          if ("aborted" in outcome && outcome.aborted === true) {
            continue;
          }
          if (!("message" in outcome)) continue;
          // 弧 δ: a detached call settles as the backgrounded synthetic —
          // paired in history (started+finished events keep the doctrine),
          // feeds the safety detectors (the call happened), but skips the
          // executed-only faces (hooks/turnBatch: it has not SETTLED; the
          // real result rides the consumer's lane later).
          if ("detached" in outcome && outcome.detached === true) {
            state.messages.push(outcome.message);
            turnSafetyCalls.push({ name: entry.call.name, args: entry.call.arguments, isError: false });
            yield {
              type: "tool_call_finished",
              turn,
              toolCallId: entry.call.id,
              isError: false,
              result: outcome.message.content,
              backgrounded: true,
              durationMs,
            };
            continue;
          }
          // 波次 8 #41 (dsh #13): a non-block call that COMPLETED even as the
          // abort landed keeps its real result + finished event — the side
          // effect happened; discarding its output burns it. Hook/batch side
          // channels stay skipped (the run is ending; the abort return must
          // stay prompt and PostToolBatch keeps the executed-only doctrine).
          if (aborted && !blocksInterrupt(entry.call.name)) {
            state.messages.push(outcome.message);
            turnSafetyCalls.push({ name: entry.call.name, args: entry.call.arguments, isError: outcome.message.isError === true, ...(entry.denied !== undefined ? { denied: true as const } : {}) });
            yield {
              type: "tool_call_finished",
              turn,
              toolCallId: entry.call.id,
              isError: outcome.message.isError === true,
              result: outcome.message.content,
              ...(outcome.provenance !== undefined ? { provenance: outcome.provenance } : {}),
              durationMs,
            };
            continue;
          }
          const message = outcome.message;
          state.messages.push(message);
          // 133 #6：gate 拒（permission/hook/task）盖 denied 旗——loop-safety
          // 的 failure_streak/identical_calls 据此判"否决墙"。
          turnSafetyCalls.push({ name: entry.call.name, args: entry.call.arguments, isError: message.isError === true, ...(entry.denied !== undefined ? { denied: true as const } : {}) });
          if (message.isError !== true && !entry.denied) noteSkillRead(entry.call.id, entry.call.name, entry.call.arguments);
          if (message.isError !== true && !entry.denied) noteRuleRead(entry.call.name, entry.call.arguments);
          // B2：成功的 todo_write 完成 transition 兑现为边界（删除式消费）。
          const fanoutBoundary = pendingTodoBoundaries.get(entry.call.id);
          if (fanoutBoundary !== undefined && message.isError !== true && !entry.denied) {
            pendingTodoBoundaries.delete(entry.call.id);
            economics.recordBoundary(fanoutBoundary);
            boundarySignalThisTurn = fanoutBoundary;
          }
          if (!entry.denied) {
            noteToolOutcome(entry.call.name, message, entry.call.arguments);
            // M33 §2: observer fires only for calls that actually executed.
            // M62 §5: a returned string parks as additionalContext.
            await captureHookContext(() => options.hooks?.onPostToolUse?.(entry.call.name, entry.call.arguments, message.content));
            // M63-A: the failure face rides the same executed-call seam.
            if (message.isError === true) {
              await safeCall(() => options.hooks?.onPostToolUseFailure?.(entry.call.name, entry.call.arguments, message.content));
            }
            turnBatch.push({ name: entry.call.name, input: entry.call.arguments, isError: message.isError === true, result: message.content, durationMs });
          }
          yield {
            type: "tool_call_finished",
            turn,
            toolCallId: entry.call.id,
            isError: message.isError === true,
            result: message.content,
            // M49 §4: result provenance (runtime-only annotation).
            ...(outcome.provenance !== undefined ? { provenance: outcome.provenance } : {}),
            // ω-5b (I21): the per-call clock (gate + execution).
            durationMs,
          };
          // 125 项 1：轮转事件排水（fan-out 位——new_context 非并发安全，正常
          // 永远走顺序路径；此位是双路径对称的保险）。
          while (parkedRotationEvents.length > 0) yield parkedRotationEvents.shift()!;
        }
        // 波次 8 #41 (dsh #18): every in-flight call that lost the abort race
        // (the sentinel) gets the UNKNOWN synthetic — paired history, honest
        // about the unverifiable outcome. Same started+finished event pairing
        // as the truncated-call guard above.
        if (aborted) {
          for (const result of results) {
            if (!result || !("aborted" in result.outcome) || result.outcome.aborted !== true) continue;
            if (blocksInterrupt(result.entry.call.name)) continue; // block tools settle for real
            const call = result.entry.call;
            state.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: ABORTED_UNKNOWN_TOOL_RESULT, isError: true });
            turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: true });
            yield { type: "tool_call_finished", turn, toolCallId: call.id, isError: true, result: ABORTED_UNKNOWN_TOOL_RESULT };
          }
          return { reason: "aborted" };
        }
      } else {
        // 波次 8 #41 (dsh #13+#18): the sequential path's three abort-return
        // sites below each leave the batch's tail un-answered. Every one now
        // synthesizes PAIRED results before returning — UNKNOWN for a call
        // that was in flight, NOT-STARTED for the never-dispatched tail — so
        // the committed interrupted assistant replays paired (resume never
        // hits repairOrphanedToolCalls' blind backfill). Started+finished
        // event pairing follows the truncated-call guard's precedent.
        for (const [si, originalCall] of toolCalls.entries()) {
          if (signal?.aborted) {
            for (const rest of toolCalls.slice(si)) {
              state.messages.push({ role: "tool", toolCallId: rest.id, name: rest.name, content: ABORTED_NOT_STARTED_TOOL_RESULT, isError: true });
              turnSafetyCalls.push({ name: rest.name, args: rest.arguments, isError: true });
              yield { type: "tool_call_started", turn, toolCallId: rest.id, toolName: rest.name, input: rest.arguments };
              yield { type: "tool_call_finished", turn, toolCallId: rest.id, isError: true, result: ABORTED_NOT_STARTED_TOOL_RESULT };
            }
            return { reason: "aborted" };
          }
          yield { type: "tool_call_started", turn, toolCallId: originalCall.id, toolName: originalCall.name, input: originalCall.arguments };
          // ω-5b (I21): the per-call clock — the natural started→finished
          // span (gate + execution) of the sequential path.
          const startedAt = performance.now();
          // M63-C: the gated call carries the REWRITE (updatedInput) — the
          // sequential path must execute the returned call, not the original.
          const { call, denied } = await gateCall(originalCall);
          // 弧 δ: the sequential twin of the fan-out's union window —
          // execution / abort / detach three-way race, per-call controller,
          // a detach win hands the promise to the lane and answers the call
          // with the backgrounded synthetic (the loop then CONTINUES the
          // batch; the run closes at the batch end, not here).
          const detachableSeq = options.toolDetach !== undefined && !blocksInterrupt(call.name);
          const controllerSeq = detachableSeq ? new AbortController() : undefined;
          const execSeq = denied === undefined ? executeGuardedToolCall(call, controllerSeq?.signal) : undefined;
          const detachLegSeq = detachableSeq && denied === undefined ? detachRaceFor(call.id) : undefined;
          let outcome: RaceOutcome;
          if (denied !== undefined || execSeq === undefined) {
            outcome = { message: denied as ToolResultMessage };
          } else {
            try {
              // #41: the same AbortError→sentinel conversion as the fan-out —
              // an abort mid-execution lands in the sentinel branch below
              // instead of throwing out to the loop's error path (where the
              // committed batch would dangle).
              const legs: Promise<RaceOutcome | typeof DETACHED>[] = [execSeq];
              if (abortRace && !blocksInterrupt(call.name)) legs.push(abortRace.promise);
              if (detachLegSeq !== undefined) legs.push(detachLegSeq.promise);
              const raced: RaceOutcome | typeof DETACHED = legs.length > 1
                ? await Promise.race(legs).catch(
                    (err) => isAbortError(err) ? { aborted: true as const } : Promise.reject(err),
                  )
                : await execSeq;
              // Same invariant as the fan-out twin: a DETACHED leg in the
              // race implies the call's controller exists.
              outcome = raced === DETACHED
                ? settleDetached(call, controllerSeq as AbortController, execSeq)
                : (raced as RaceOutcome);
            } finally {
              detachLegSeq?.release();
            }
          }
          const durationMs = performance.now() - startedAt;
          // #41: in-flight abort → the UNKNOWN synthetic answers this call,
          // NOT-STARTED synthetics answer the tail, then the run ends.
          if (!("message" in outcome)) {
            state.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: ABORTED_UNKNOWN_TOOL_RESULT, isError: true });
            turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: true });
            yield { type: "tool_call_finished", turn, toolCallId: call.id, isError: true, result: ABORTED_UNKNOWN_TOOL_RESULT };
            for (const rest of toolCalls.slice(si + 1)) {
              state.messages.push({ role: "tool", toolCallId: rest.id, name: rest.name, content: ABORTED_NOT_STARTED_TOOL_RESULT, isError: true });
              turnSafetyCalls.push({ name: rest.name, args: rest.arguments, isError: true });
              yield { type: "tool_call_started", turn, toolCallId: rest.id, toolName: rest.name, input: rest.arguments };
              yield { type: "tool_call_finished", turn, toolCallId: rest.id, isError: true, result: ABORTED_NOT_STARTED_TOOL_RESULT };
            }
            return { reason: "aborted" };
          }
          const message = outcome.message;
          // 弧 δ: the detached synthetic settles this call — the batch
          // CONTINUES to the model's remaining calls (each still detachable
          // on its own); the run itself closes at the batch end.
          if ("detached" in outcome && outcome.detached === true) {
            state.messages.push(outcome.message);
            turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: false });
            yield {
              type: "tool_call_finished",
              turn,
              toolCallId: call.id,
              isError: false,
              result: outcome.message.content,
              backgrounded: true,
              durationMs,
            };
            continue;
          }
          // M51 §3: a block tool's result lands even when the signal aborted
          // while it ran (an external abort/detach) — its whole point is that
          // cancellation must not discard it. The next iteration's top abort
          // check still ends the run.
          // #41: a non-block call that COMPLETED as the abort landed keeps
          // its real result (dsh #13 — don't burn a finished side effect's
          // output), then the tail synthesizes NOT-STARTED and the run ends.
          if (signal?.aborted && !blocksInterrupt(call.name)) {
            state.messages.push(message);
            // 133 #6（T005 F5）：与 fan-out 孪生位（:2989）对齐——denied 调用
            // 在 abort 落地时已完成结算的旁支同样盖旗（漏盖会让否决墙漏判）。
            turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: message.isError === true, ...(denied !== undefined ? { denied: true as const } : {}) });
            yield {
              type: "tool_call_finished",
              turn,
              toolCallId: call.id,
              isError: message.isError === true,
              result: message.content,
              ...(outcome.provenance !== undefined ? { provenance: outcome.provenance } : {}),
              durationMs,
            };
            for (const rest of toolCalls.slice(si + 1)) {
              state.messages.push({ role: "tool", toolCallId: rest.id, name: rest.name, content: ABORTED_NOT_STARTED_TOOL_RESULT, isError: true });
              turnSafetyCalls.push({ name: rest.name, args: rest.arguments, isError: true });
              yield { type: "tool_call_started", turn, toolCallId: rest.id, toolName: rest.name, input: rest.arguments };
              yield { type: "tool_call_finished", turn, toolCallId: rest.id, isError: true, result: ABORTED_NOT_STARTED_TOOL_RESULT };
            }
            return { reason: "aborted" };
          }
          state.messages.push(message);
          // 133 #6：顺序路径孪生位——gate 拒盖 denied 旗（fan-out 位 :3003 同款）。
          turnSafetyCalls.push({ name: call.name, args: call.arguments, isError: message.isError === true, ...(denied !== undefined ? { denied: true as const } : {}) });
          if (message.isError !== true && !denied) noteSkillRead(call.id, call.name, call.arguments);
          if (message.isError !== true && !denied) noteRuleRead(call.name, call.arguments);
          // B2：顺序路径的同款边界兑现（fan-out 路径的孪生）。
          const seqBoundary = pendingTodoBoundaries.get(call.id);
          if (seqBoundary !== undefined && message.isError !== true && !denied) {
            pendingTodoBoundaries.delete(call.id);
            economics.recordBoundary(seqBoundary);
            boundarySignalThisTurn = seqBoundary;
          }
          if (!denied) {
            noteToolOutcome(call.name, message, call.arguments);
            // M33 §2: observer fires only for calls that actually executed.
            // M62 §5: a returned string parks as additionalContext.
            await captureHookContext(() => options.hooks?.onPostToolUse?.(call.name, call.arguments, message.content));
            // M63-A: the failure face rides the same executed-call seam.
            if (message.isError === true) {
              await safeCall(() => options.hooks?.onPostToolUseFailure?.(call.name, call.arguments, message.content));
            }
            turnBatch.push({ name: call.name, input: call.arguments, isError: message.isError === true, result: message.content, durationMs });
          }
          yield {
            type: "tool_call_finished",
            turn,
            toolCallId: call.id,
            isError: message.isError === true,
            result: message.content,
            // M49 §4: result provenance (runtime-only annotation).
            ...(outcome.provenance !== undefined ? { provenance: outcome.provenance } : {}),
            // ω-5b (I21): the per-call clock (gate + execution).
            durationMs,
          };
          // 125 项 1：轮转事件排水（主位——顺序路径每结果落地后立即 yield；
          // execute 内无法 yield，停泊的 compacted 事件在这里跟上，观测序=
          // 事实序：回执先落历史，边界事件紧随）。
          while (parkedRotationEvents.length > 0) yield parkedRotationEvents.shift()!;
          // M35 §1: the run's one applied load_tools surfaced as an event
          // (denied/blocked calls never execute, so never apply).
          const appliedDefer = defer.consumeApplied();
          if (appliedDefer !== undefined) {
            yield { type: "defer_loaded", turn, names: appliedDefer.names };
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) return { reason: "aborted" };
      throw err;
    } finally {
      toolGuard?.end();
      abortRace?.cleanup();
      // 弧 δ: the detach machinery dies with the batch (the abortRace
      // doctrine) — parked requests for block/finished/unknown calls are
      // dropped, and no resolver outlives the race it belonged to.
      offDetach?.();
      detachArmed.clear();
      detachPending.clear();
    }

    // M63-A: the batch face — one hook per TURN's tool batch, after every
    // executed call settled (results in history, events emitted), before the
    // rule notes/turn boundary. {continue:false} ends the run HERE: the
    // batch's results stand, the model is not called again, and the stop
    // gates/onRunStop never run (the hook already decided). Throws/timeouts
    // degrade to allow.
    if (turnBatch.length > 0) {
      let batchDecision: PostToolBatchDecision = "allow";
      try {
        batchDecision = (await options.hooks?.onPostToolBatch?.(turnBatch)) ?? "allow";
      } catch {
        batchDecision = "allow";
      }
      if (typeof batchDecision === "object" && batchDecision.continue === false) {
        return { reason: "completed", finalMessage: finalAssistant, postToolBatchStop: true };
      }
    }

    // 弧 δ: a batch that detached a call closes the run HERE — the same
    // shape as PostToolBatch's {continue:false}: the batch's results stand
    // (the backgrounded synthetic pairs its tool_use in history; the other
    // calls' real results landed), the model is NOT called again, and the
    // stop gates/onRunStop stay skipped (the user already decided — the
    // conversation comes back now; the background result merges on its own
    // lane when it lands).
    if (detachedThisBatch) {
      return { reason: "completed", finalMessage: finalAssistant, backgrounded: true };
    }

    // M62 §1: the turn's queued gated-rule notes land here — after the tool
    // batch, before the next model call (a pure suffix append).
    for (const ev of flushRuleNotes()) yield ev;

    yield { type: "turn_finished", turn, toolCallCount: toolCalls.length };
    // M61 §3: a turn that used tools resets the stop-block cap's input.
    if (toolCalls.length > 0) toolsSinceStopBlock = true;

    // M48 §1: the loop-safety net, at the turn boundary. One verdict → one
    // MetaNote (queued for the NEXT model call, no turn consumed); a second
    // verdict in the same run → forced abort carrying the evidence.
    // M53 §5: skipped entirely under the --no-loop-safety ablation.
    // ω-4b: the second verdict first goes to the reflection fork when every
    // arm condition holds — one direct challenger call sharing this run's
    // request prefix (loop-reflection.ts); fail-closed everywhere else.
    if (safetyOn) {
    // ω99-30 (C): stamp the loopExempt annotation onto this turn's calls
    // before they feed the detectors — name lookup against execTools, the
    // SAME table execution used (:2982's lookup source). Only NON-ERROR
    // calls are stamped: a polling tool failing the same way repeatedly is
    // itself a stuck signal (isError never exempts). Hoisted (121 #5): BOTH
    // consumers — the verdict window below and the no-progress lane — see
    // the same stamped view.
    const stampedCalls: LoopSafetyCall[] = toolCalls.length > 0
      ? turnSafetyCalls.map((c) =>
          !c.isError && execTools.find((t) => t.name === c.name)?.loopExempt?.(c.args) === true
            ? { ...c, exempt: true }
            : c,
        )
      : [];
    safetyTurns.push(
      toolCalls.length > 0
        ? { calls: stampedCalls }
        : { calls: [], answer: finalAssistant.content },
    );
    // 121 #5 — the no-progress guard (advisory-only): fingerprint this turn's
    // tool-result set (by toolCallId — steering/user interleaves cannot
    // misattribute a result), advance the streak, and on the Nth consecutive
    // identical turn queue ONE MetaNote for the NEXT model call. 只建议不
    // 阻断：this lane never yields a verdict, never aborts, never touches the
    // escalation machinery below. M24: tail-side MetaNote projection (never
    // persisted) — zero stable-prefix bytes; the ω99-28 T2 revert declaration
    // already covers the next call's one-line divergence.
    {
      const results: { content: string; isError: boolean }[] = [];
      if (toolCalls.length > 0) {
        const wanted = new Set(toolCalls.map((c) => c.id));
        const byId = new Map<string, { content: string; isError: boolean }>();
        for (let i = state.messages.length - 1; i >= 0 && wanted.size > 0; i -= 1) {
          const m = state.messages[i];
          if (m?.role !== "tool") continue; // skip interleaves (steers land elsewhere)
          const t = m as ToolResultMessage;
          if (!wanted.has(t.toolCallId)) continue;
          wanted.delete(t.toolCallId);
          byId.set(t.toolCallId, { content: String(t.content), isError: t.isError === true });
        }
        for (const c of toolCalls) {
          const r = byId.get(c.id);
          if (r !== undefined) results.push(r);
        }
      }
      const step = advanceNoProgress(noProgressState, { calls: stampedCalls, results });
      noProgressState = step.state;
      if (step.note !== undefined) pendingSafetyNotes.push(step.note);
    }
    {
      const verdict = detectLoop(safetyTurns);
      if (verdict !== undefined) {
        loopVerdicts += 1;
        const attempt: 1 | 2 | 3 = loopVerdicts === 1 ? 1 : loopVerdicts === 2 ? 2 : 3;
        yield {
          type: "loop_detected",
          turn,
          kind: verdict.kind,
          evidence: verdict.evidence,
          attempt,
        };
        if (attempt !== 1) {
          // ω-4b §3.1 arm check — ALL must hold (the allowlist IS the
          // fail-closed default): enabled + fork unspent + exactly the 2nd
          // verdict + an armed kind + the user is not already killing the
          // run. Anything else takes today's unconditional abort below.
          const armed = options.reflection !== undefined
            && !reflectionSpent
            && loopVerdicts === 2
            && REFLECTION_KINDS.has(verdict.kind)
            && options.signal?.aborted !== true;
          let recovered = false;
          if (armed) {
            const digest = windowDigest(safetyTurns);
            let forkUsage: ModelUsage | undefined;
            const reflection = await runReflectionFork(model, {
              systemPrompt: state.systemPrompt,
              messages: state.messages,
              tools: toolDefs,
              evidence: verdict.evidence,
              digest,
              signal: options.signal,
              timeoutMs: options.reflection.timeoutMs ?? REFLECTION_DEFAULT_TIMEOUT_MS,
              onUsage: (u) => { forkUsage = u; },
            });
            if (forkUsage !== undefined) {
              // 夜移 036: the reflection fork is a real model call — it
              // draws from the shared budget like any other response.
              if (options.sessionBudget !== undefined) {
                sessionBudgetExhausted = options.sessionBudget.budget.recordUsage(forkUsage) || sessionBudgetExhausted;
              }
              yield { type: "usage", turn, usage: forkUsage };
            }
            if (sessionBudgetExhausted) {
              yield { type: "session_budget_exhausted", turn, usedUnits: options.sessionBudget?.budget.usedUnits() ?? 0 };
              return { reason: "session_budget_exhausted" };
            }
            yield {
              type: "reflection_fork",
              turn,
              kind: verdict.kind,
              evidence: verdict.evidence,
              outcome: reflection.outcome,
              ...(reflection.rationale !== undefined ? { rationale: reflection.rationale } : {}),
              ...(reflection.directive !== undefined ? { directive: reflection.directive } : {}),
            };
            if (reflection.outcome === "recoverable" && reflection.directive !== undefined) {
              // Abort stayed ONCE. The generic note is REPLACED by the
              // directive note (same MetaNote projection channel, never
              // persisted) and the window resets — verdict-1 semantics;
              // the fork is spent, so a third verdict aborts outright.
              reflectionSpent = true;
              pendingSafetyNotes.push(`[system note: the loop-safety challenger adjudicated this run RECOVERABLE (${verdict.evidence}) — directive: ${reflection.directive}. Final warning: one more loop verdict ends the run.]`);
              safetyTurns.length = 0;
              recovered = true;
            } else if (reflection.outcome === "stuck") {
              // Enriched abort: the DETECTOR's evidence stays authoritative
              // (the deterministic signal names the failure); the challenger
              // only confirms and explains.
              return {
                reason: "aborted",
                loopEvidence: verdict.evidence,
                ...(verdict.denialCircuit === true ? { denialCircuit: true as const } : {}),
                loopReflection: {
                  outcome: "challenger-confirmed",
                  ...(reflection.rationale !== undefined ? { rationale: reflection.rationale } : {}),
                },
              };
            } else {
              // unavailable — the original verdict wins, byte-for-byte
              // today's abort plus the receipt.
              return {
                reason: "aborted",
                loopEvidence: verdict.evidence,
                ...(verdict.denialCircuit === true ? { denialCircuit: true as const } : {}),
                loopReflection: { outcome: "challenger-unavailable" },
              };
            }
          }
          if (!recovered) return { reason: "aborted", loopEvidence: verdict.evidence, ...(verdict.denialCircuit === true ? { denialCircuit: true as const } : {}) };
        } else {
          pendingSafetyNotes.push(`[system note: you appear stuck in a loop (${verdict.evidence}) — change approach or ask the user]`);
          // The note resets the game: the repeats that produced THIS verdict are
          // consumed, and a second verdict must be a pattern that re-formed
          // AFTER the model saw the note (i.e. it ignored the warning).
          safetyTurns.length = 0;
        }
      }
    }
    } // safetyOn

    if (toolCalls.length === 0) {
      // 夜移 013 — the output-limit recovery ladder, BEFORE the stop gates:
      // a mechanical cut (stop_reason:"length" with no tool calls — M70's
      // guard owns the tool-call case) is not a stop INTENT, so recovery
      // runs first and stop gates/hooks only ever judge a message the model
      // actually chose to end. Nudge = append the resume-mid-thought user
      // note (pure append → prefix-stable) and take one more turn; the
      // escalation flag gives the continuation call a raised cap when the
      // request is cap-free. Exhausted (budget spent or turn budget reached)
      // → the typed terminal, WITHOUT consulting the stop hooks (same
      // discipline as real CC's "skip stop hooks after an API error" — a
      // policy hook must not re-drive a mechanical failure into a spiral).
      // The exhausted event fires only when nudges were actually attempted —
      // maxNudges:0 is the opt-out (feature off: zero events, the typed
      // terminal alone carries the failure). An abort racing this branch
      // skips the ladder entirely (never mislabels an abort as
      // output_limit) and falls through to the pre-013 exit path, whose
      // next-iteration abort check owns the terminal.
      if (finalAssistant.stopReason === "length" && !options.signal?.aborted) {
        // 夜移 033 (pi overflow.ts Case 3) — re-diagnose BEFORE the nudge
        // budget: a zero-output length-stop over a ≥99%-full window is a
        // disguised context overflow (the server truncated the oversized
        // input), and nudging would append MORE tokens into that same full
        // window — a deterministic repeat that burns the budget en route to
        // the wrong terminal. Divert to the reactive compaction instead
        // (doCompact is exempt from the PreCompact defer gate; structurally
        // no deferred at this trigger — same proof as the 413 arm) and let
        // the next iteration re-project and re-call over the compacted
        // state. One-shot per run: a second disguise after the detour means
        // the server keeps truncating regardless — settle to the typed
        // output_limit terminal without hooks (the 013 exhausted discipline:
        // a mechanical failure is not a stop intent for policy to re-drive).
        if (
          isZeroOutputOverflow(
            pendingUsage?.completionTokens,
            pendingUsage?.promptTokens ?? 0,
            effectiveWindow(),
          )
        ) {
          if (zeroOutputOverflowDetoured || turn + 1 >= maxTurns) {
            return { reason: "output_limit", finalMessage: finalAssistant };
          }
          zeroOutputOverflowDetoured = true;
          const out = await doCompact(turn, "reactive");
          for (const ev of out.events) yield ev;
          pendingCompaction = false;
          yield { type: "output_limit_recovery", turn, kind: "overflow-detour" };
          turn += 1;
          continue;
        }
        const maxNudges = options.outputLimitRecovery?.maxNudges ?? DEFAULT_OUTPUT_LIMIT_NUDGES;
        if (outputLimitNudges < maxNudges && turn + 1 < maxTurns) {
          outputLimitNudges += 1;
          const esc = options.outputLimitRecovery?.escalateTo;
          const applyEsc: boolean = esc !== undefined && callInput.maxTokens === undefined;
          escalateNextCall = applyEsc;
          state.messages.push({ role: "user", content: OUTPUT_LIMIT_NUDGE });
          yield {
            type: "output_limit_recovery",
            turn,
            kind: "nudge",
            ...(applyEsc && esc !== undefined ? { maxTokens: esc } : {}),
          };
          turn += 1;
          continue;
        }
        if (outputLimitNudges > 0) {
          yield { type: "output_limit_recovery", turn, kind: "exhausted" };
        }
        return { reason: "output_limit", finalMessage: finalAssistant };
      }
      // 133 #5（codex 8bd5a136ff）— content_filter 终因的恢复指导：被
      // 内容安全过滤拦截不是网络故障（重试同内容只会再撞墙）。一次性
      // MetaNote 注入（同 run 不重复——模型已被告知，重复是噪音），注入
      // 后走 completed 终态（内容问题不是机械截断——013 的 output_limit
      // 专属 "length"）。注入卫生：指导文本不引用被拦内容原文。
      if (finalAssistant.stopReason === "content_filter" && !contentFilterGuided && !options.signal?.aborted) {
        contentFilterGuided = true;
        state.messages.push({ role: "user", content: CONTENT_FILTER_GUIDANCE });
        yield { type: "content_filter_guided", turn };
        turn += 1;
        continue;
      }

      // 夜移 024 — the empty-final guard (Reasonix run_loop.go:571-596): a
      // final-answer turn with no visible content is not an answer to judge.
      // Precedence: AFTER the length ladder (a mechanical cut is 013's), BEFORE
      // the stop gates/hooks (content visibility precedes stop legitimacy —
      // same discipline as 013's "mechanical failure before policy hooks").
      // A reasoning-present blank still nudges: the provider layer already
      // spent its frozen byte-identical replay on that shape (M48 §2), so this
      // different-instruction request is the last chance before the blank
      // settles. Pure user-message append → prefix-stable. An abort racing
      // this decision skips the guard (never nudge after an abort; the
      // pre-existing exit path owns the terminal).
      if (finalAssistant.content.trim() === "" && !options.signal?.aborted) {
        const maxNudges = options.emptyFinalRecovery?.maxNudges ?? DEFAULT_EMPTY_FINAL_NUDGES;
        if (emptyFinalNudges < maxNudges && turn + 1 < maxTurns) {
          emptyFinalNudges += 1;
          state.messages.push({ role: "user", content: EMPTY_FINAL_NUDGE });
          yield { type: "empty_final_recovery", turn, kind: "nudge" };
          turn += 1;
          continue;
        }
        // Exhausted: the event fires only when nudges were actually attempted
        // (maxNudges:0 = feature off, zero events). The blank settles through
        // the normal completed terminal WITHOUT consulting the gates/hooks —
        // a blank is not an answer those policies could judge (013's
        // exhausted-path discipline).
        if (emptyFinalNudges > 0) {
          yield { type: "empty_final_recovery", turn, kind: "exhausted" };
        }
        return { reason: "completed", finalMessage: finalAssistant };
      }
      // M23 stop gates run BEFORE onRunStop: an illegitimate stop is nudged
      // back to work without consuming turn quota.
      const gateText = stopGateInjection();
      if (gateText !== undefined) {
        state.messages.push({ role: "user", content: gateText });
        yield { type: "gate_injected", turn, text: gateText };
        continue;
      }
      let stopDecision: StopHookDecision = "allow";
      try { stopDecision = (await options.hooks?.onRunStop?.(state)) ?? "allow"; } catch { stopDecision = "allow"; }
      // M61 §3: normalize the prompt-hook spelling ({continue:false} ≡ block).
      const blocked: { block: true; reason: string } | undefined = typeof stopDecision === "object"
        ? "block" in stopDecision
          ? stopDecision
          : { block: true, reason: stopDecision.reason ?? "the stop hook requested one more turn" }
        : undefined;
      if (blocked !== undefined && turn + 1 < maxTurns) {
        // M61 §3 block cap: three consecutive continuations with NO tool use
        // end the run (stopBlockCapped) — a stop hook can never wedge the
        // loop into an answer-restate spiral. Any tool use resets the count.
        if (stopBlockStreak >= STOP_BLOCK_CAP) {
          return { reason: "completed", finalMessage: finalAssistant, stopBlockCapped: true };
        }
        stopBlockStreak = toolsSinceStopBlock ? 0 : stopBlockStreak + 1;
        toolsSinceStopBlock = false;
        state.messages.push({ role: "user", content: `[stop blocked] ${blocked.reason}` });
        turn += 1;
        continue;
      }
      return { reason: "completed", finalMessage: finalAssistant };
    }

    // Turn boundary (M24 B5 → 借鉴弧 B1/B2, SoL-Pi C1/C2): the deferred
    // "approaching" compaction AND the boundary-signal candidate are decided
    // HERE. B1（经济学门）：盈亏平衡对期距裁决、债连本带息、窗口保护覆盖一
    // 切、压力无边界证据 fail-open（ω-2b 语义不动，债照记）。B2（边界优先）：
    // todo 完成是压缩候选（压力带以下也是——最便宜的遗忘时刻）；压完同 run
    // 继续（轮边界原生操作，无 barrier hack）。
    if (options.compaction && (pendingCompaction || boundarySignalThisTurn !== null)) {
      const occupancy = occupancyNow();
      if (pendingCompaction || (boundarySignalThisTurn !== null && occupancy >= economics.boundaryCandidateFloor(effectiveThreshold()))) {
        const decision = economics.decide({
          occupancy,
          windowTokens: effectiveWindow(),
          pressure: pendingCompaction,
          spanTokens: estimateCompactableTokens(state.messages, state.systemPrompt, defer.requestDefs(), options.compaction.keepRecent ?? 6),
        });
        if (decision.compact) {
          const out = await doCompact(turn, "boundary", decision);
          if (out.deferred !== undefined) {
            yield { type: "compact_deferred", turn, reason: out.deferred };
          } else {
            for (const ev of out.events) yield ev;
            // B2：同 run 续跑的重锚定注记（board 空尽/无 board 不打扰）。
            const incomplete = out.events.some((ev) => ev.type === "compacted") ? latestBoardIncomplete(state.messages) : undefined;
            if (incomplete !== undefined && incomplete > 0) state.messages.push(boundaryContinuationNote(incomplete));
          }
        } else {
          // 每笔「不压」决策的类型化理由（可审计、可进面板）+ 决策回执。
          yield {
            type: "compact_deferred",
            turn,
            reason: `economics:${decision.reason}${deferReasonDetail(decision)}`,
            economics: economicsReport(decision, decision.carriedDebtTokens),
          };
        }
      }
      pendingCompaction = false;
    }

    turn += 1;
  }
}

// Observer hooks must never crash the loop.
async function safeCall(fn: () => unknown): Promise<void> {
  try { await fn(); } catch { /* ignore */ }
}

async function executeToolCall(
  tools: readonly Tool[],
  call: ToolCall,
  onUpdate?: IdentifiedToolUpdateFn, // ω99-49: threaded to execute's optional second parameter
  signal?: AbortSignal, // 弧 δ: threaded to execute's optional third parameter (the detached lane's stop path)
): Promise<{ message: ToolResultMessage; provenance?: string }> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return {
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: `unknown tool: ${call.name}${didYouMean(call.name, tools.map((t) => t.name))}`,
        isError: true,
      },
    };
  }

  // M47 §6: schema-driven normalization BETWEEN schema fetch and validation —
  // "true"→bool, numeric strings→number, path trim/quote-strip, unique enum
  // case-fold. Everything it fixes rides on; everything it can't stays for the
  // did-you-mean validation error below.
  const { args, normalized } = normalizeToolArguments(tool.parameters, call.arguments);
  const auditLine = normalized.length > 0 ? formatArgsNormalizedLine(normalized) : undefined;
  const withAudit = (content: string): string =>
    auditLine !== undefined ? `${auditLine}\n${content}` : content;

  const validation = validateToolArguments(tool.parameters, args, tool.name);
  if (!validation.valid) {
    return {
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: withAudit(`invalid arguments: ${validation.error}`),
        isError: true,
      },
    };
  }

  try {
    // ω99-63: identity is a loop-level invariant — the ONE execution point
    // where call.id/call.name are authoritative enriches every delta before
    // the consumer sees it. The adapter is built ONLY when a consumer exists;
    // absent → undefined threads through and the call below is byte-identical
    // to the pre-ω99-63 shape (single-parameter face, zero closure cost).
    const identified = onUpdate === undefined
      ? undefined
      : (delta: OutputDelta): void => { onUpdate({ ...delta, toolCallId: call.id, toolName: call.name }); };
    // 夜移 002: arm the declared deadline (block tools are exempt — their
    // settle contract is stronger than the deadline).
    const deadline = tool.interruptBehavior === "block" ? undefined : tool.timeoutMs;
    const result = await (deadline === undefined
      ? tool.execute(validation.args, identified, signal)
      : raceToolTimeout(tool.execute(validation.args, identified, signal), deadline));
    // M51 §3: outputSchema — a declared tool owes JSON results on success; a
    // violation (parse or subset) is isError with the violations appended.
    // Already-error results skip the check (their error IS the contract).
    let content = result.content;
    let isError = result.isError;
    if (tool.outputSchema !== undefined && isError !== true) {
      const check = validateToolOutputResult(tool.outputSchema, content);
      if (!check.ok) {
        content = `${content}\n[output schema violation: ${check.errors.join("; ")}]`;
        isError = true;
      }
    }
    return {
      // M49 §4: the provenance mark rides the RESULT (runtime annotation) —
      // the message itself stays clean (no wire / persistence pollution).
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: withAudit(content),
        isError,
        // ω99-138: tool-produced images ride the message as durable refs
        // (the M79 ToolResultMessage contract); absent on every text-only
        // result, byte-identical to the pre-138 shape.
        ...(Array.isArray(result.images) && result.images.length > 0 ? { images: result.images } : {}),
      },
      provenance: result.provenance,
    };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: withAudit(
            `${err.message} tool ${call.name} exceeded its timeoutMs — the result was abandoned (the call may still be running detached); retry with a narrower call or a larger timeoutMs`,
          ),
          isError: true,
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: withAudit(`tool ${call.name} threw: ${message}`),
        isError: true,
      },
    };
  }
}

// Re-export so consumers can build messages without reaching into types.ts directly.
export type { AgentMessage, Terminal };
