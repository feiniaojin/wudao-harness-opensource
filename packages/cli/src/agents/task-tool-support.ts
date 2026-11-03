// ω99 拆分运动 弧 B：task-tool 的 spawn 支撑族外提（角色名册/子轮默认值/工具
// 组装/参数解析/选项类型/领航 nudge/用量观察包装/状态词映射/前台 child 运行
// 器——原 task-tool.ts 模块级段逐字保留；task-tool.ts re-export 门面保公共面。
// executeTask 走 type-only 互引（Parameters<typeof executeTask> 的 ctx 契约
// 单源）——类型级循环安全。
import {
  runSubagent,
  toSubagentType,
  createReadFileTool,
  createGlobTool,
  createGrepTool,
  createWriteFileTool,
  createEditTool,
  createShellTool,
  createTodoTool,
  createParentMessageTool,
  DEFAULT_MAX_IMAGES,
} from "@wudao-org/core";
import type { LoopEvent, LoopOptions, ModelClient, ModelUsage, Tool, ForkContext, ChildSessionOptions, ImageBlock } from "@wudao-org/core";
import type { AgentRoleProfile } from "./core-bind.js";
import { BUILTIN_ROLES } from "./core-bind.js";
import type { ModelOverrides } from "./contract.js";
import { KERNEL_POLICY } from "../kernel-policy.js";
import { decorateChildGate } from "../ask-evidence.js";
import { laneAsParentMail } from "./child-mail.js";
// 125 项 3：usage 行的 per-child 身份（goal 上卷的去重键）。
import { randomUUID } from "node:crypto";
import type { ChildMailLane } from "./child-mail.js";
import type { ChildApprovalFace } from "./child-approvals.js";
import type { executeTask } from "./task-tool.js";

export const BUILTIN_ROLE_NAMES: readonly string[] = [...BUILTIN_ROLES.keys()];

/** M41: the child-turn default is kernel policy (single source) — the
 *  <3-samples budget fallback and the budgets-off fuse both resolve here. */
export const DEFAULT_CHILD_TURNS = KERNEL_POLICY.registry.childTurns;

/** Default worktree-child tool set: the builtin coding tools re-rooted at the
 *  child's worktree. Frontends with session-level policy (sandbox, spill
 *  dirs) pass their own factory through AgentsTooling. ω99-57: the global
 *  mail tool joins (context-free — the sender is derived at run time). */
export function defaultChildToolsFor(root: string): readonly Tool[] {
  return [
    createReadFileTool({ workspaceRoot: root }),
    createGlobTool({ workspaceRoot: root }),
    createGrepTool({ workspaceRoot: root }),
    createWriteFileTool({ workspaceRoot: root }),
    createEditTool({ workspaceRoot: root }),
    createShellTool({ workspaceRoot: root }),
    createTodoTool({ workspaceRoot: root }),
    createParentMessageTool(),
  ];
}

/** A JSON object accepted as a string (models sometimes stringify nested
 *  params) — undefined when the text is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** M80 (direction b): the explicit image hand-off — attachment ids the
 *  PARENT names for an isolated child. Shape-checked pure and fail-closed
 *  (before any roster/session work burns effort): an array of non-empty
 *  strings, at most DEFAULT_MAX_IMAGES, no duplicates. Id→ref resolution
 *  against the parent conversation runs later, once the role is known. */
export function parseImageIdsArg(v: unknown): { ok: true; ids: readonly string[] } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(v)) return { ok: false, error: "images must be an array of attachment id strings" };
  const ids: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, error: "images must be an array of attachment id strings" };
    }
    if (ids.includes(item)) return { ok: false, error: `duplicate attachment id "${item}"` };
    ids.push(item);
  }
  if (ids.length > DEFAULT_MAX_IMAGES) {
    return { ok: false, error: `images accepts at most ${DEFAULT_MAX_IMAGES} attachment ids (got ${ids.length})` };
  }
  return { ok: true, ids };
}

export interface AgentsTaskToolOptions {
  readonly model: ModelClient;
  /** Coding tools (orchestration tools MUST NOT be in here — they are
   *  filtered defensively anyway). */
  readonly allTools: readonly Tool[];
  readonly registry: import("./core-bind.js").AgentRegistry;
  readonly workspaceRoot: string;
  /** Session id — namespaces worktree paths and the roster cache buster. */
  readonly runId: string;
  readonly loopOptions?: Omit<LoopOptions, "canUseTool">;
  readonly canUseTool?: LoopOptions["canUseTool"];
  readonly onSubagentEvent?: (event: LoopEvent) => void;
  /** ω99-8: every child model call's usage, for cost attribution. Observational
   *  — recorder failures are isolated and never affect the child's events.
   *  125 项 3: info.childId identifies WHICH child the row came from (stamped
   *  by subagentEventWithUsage's per-child wrapper — the rollup dedupes on it
   *  to count subagents, not calls). Absent only for recorders bypassing the
   *  wrapper; additive, existing consumers ignore it. */
  readonly onSubagentUsage?: (info: { childId?: string; model: string; usage: ModelUsage }) => void;
  readonly getForkContext?: () => ForkContext | undefined;
  /** True when the parent has first-hand tool results visible (pilot nudge). */
  readonly pilotProbe?: () => boolean;
  /** Resolves caller/role model overrides to a child ModelClient. Absent →
   *  caller overrides fail closed; role pins degrade with a note. */
  readonly resolveModel?: (overrides: ModelOverrides) => { ok: true; model: ModelClient; effectiveEffort: string } | { ok: false; error: string };
  /** Session-level reasoning effort — the receipt baseline. */
  readonly defaultEffort?: string;
  /** ω99-86 (53 停泊债清偿): the parent's LIVE effort getter — the box face
   *  the driver arms per run (AgentDriverOptions.effortLiveBox via
   *  buildToolSet, the ω99-79 subagentUpdateBox discipline: read LATE, at
   *  spawn time, so run-scoped arming works). The surviving value rides the
   *  child's loopOptions.effortSent (its assistant trail, ω99-53) — the
   *  parent's live level is the single source of truth, so the child's
   *  trail matches what its requests actually run at. Absent/unarmed ⇒ no
   *  key ⇒ byte-identical spawns (the pre-ω99-86 default). */
  readonly effortLive?: () => string | undefined;
  /** Builds the tool set for a worktree child rooted at its worktree.
   *  Defaults to the builtin coding tools re-rooted at the child's tree. */
  readonly childToolsFor?: (root: string) => readonly Tool[];
  /** M31 §1: the session runs shell sandboxed (--sandbox) — exempts
   *  scoped roles' shell from the write-scope guard. */
  readonly sandboxedRunCommand?: boolean;
  /** M31 §1: dim-notice channel for overlap warnings (TUI seam). */
  readonly onNotice?: (text: string) => void;
  /** M31 §2: the adaptive-budget stats file. Defaults to
   *  `<workspaceRoot>/.wudao/agents-stats.json`. */
  readonly statsPath?: string;
  /** M40 §2: the plugin agent layer — slots into the roster between the
   *  builtins and `.wudao/agents/*.json` (builtin < plugin < workspace).
   *  Built by collectPluginAgents from the loaded plugins. */
  readonly pluginAgents?: readonly import("./core-bind.js").RosterPluginAgent[];
  /** M63-B: the session's hook object — the SubagentStart/Stop faces are
   *  derived from it and threaded to EVERY child (foreground and registry
   *  background spawns alike). */
  readonly hooks?: import("@wudao-org/core").AgentHooks;
  /** M63-C R1: the fire-runtime view — the subagent-position compile gets
   *  the full contract (common fields / `if` / mcp / rewake). */
  readonly hookRuntime?: import("../hooks-config.js").NonNeverRuntime;
  /** M64-C §C: the session's team runtime (lazy — frontends hand a factory
   *  so no team machinery exists until the first teammate spawns). The
   *  `teammate: "<name>"` argument routes here: a named subagent IS a
   *  teammate (roster role reuse, mailboxes, plan flow, wake). */
  readonly teams?: { readonly getTeam: () => import("../teams/runtime.js").TeamRuntime };
  /** ω99-57: the parent-side child-mail lane. When set (and the pool carries
   *  the global message_parent tool), every isolated/worktree child of THIS
   *  task tool draws the tool and its send lands on the lane — the parent
   *  reads it at its next model call. Absent → children draw no mail tool
   *  and no guidance line rides their brief (byte-identical to pre-ω99-57). */
  readonly childMail?: import("./child-mail.js").ChildMailLane;
  /** stop-tree（openwork opencode-interruption 移植）: the session's
   *  foreground-dispatch port (the driver's StopCoordinator arm — the same
   *  box buildToolSet receives). FOREGROUND dispatches (fork / isolated /
   *  worktree) register/settle through it so the driver's interrupt can plan
   * the stop tree; background registry spawns do NOT (they return
   *  immediately — their lifecycle belongs to agent_cancel). Absent/unarmed
   *  slots → no bookkeeping, every dispatch byte-identical. */
  readonly stopTree?: import("@wudao-org/core").StopTreeDispatchPort;
}

export const PILOT_NUDGE =
  "pilot advisory: no first-hand work in this run yet — do one unit yourself before delegating more; this spawn proceeded.";

/** ω99-8: the cost-attribution observer — wraps a child's event stream so
 *  every `usage` event reaches the recorder FIRST (isolated: a recorder
 *  failure never touches the child's events or run), then forwards the
 *  stream VERBATIM to the frontend renderer. The model key is the ANSWERING
 *  model (usage.model, else the fallback chain's name, else the spawn
 *  config's id) so WUDAO_PRICE_<MODEL> keys stay priceable — the M61
 *  evaluator-label lesson, not repeated. Callers with no recorder pass
 *  their onEvent through UNWRAPPED (zero bytes moved on that path).
 *  125 项 3: the wrapper is created ONCE PER CHILD, so it stamps a stable
 *  per-child childId on every row — the goal rollup dedupes on it（「M 个
 *  子代理」是子代理数，不是模型调用行数；foreground runChild 与 background
 *  spawn 两个调用点各建一个包装器，正好一子一代）。 */
export function subagentEventWithUsage(
  onEvent: ((event: LoopEvent) => void) | undefined,
  onUsage: (info: { childId?: string; model: string; usage: ModelUsage }) => void,
  childModel: ModelClient,
): (event: LoopEvent) => void {
  const childId = `sub-${randomUUID()}`;
  return (event: LoopEvent) => {
    if (event.type === "usage") {
      try {
        onUsage({ childId, model: event.usage.model ?? event.usage.fallbackModel ?? childModel.modelId ?? "unknown", usage: event.usage });
      } catch {
        // Observational only — attribution is an account concern, never a run concern.
      }
    }
    onEvent?.(event);
  };
}

/** Registry status (queued|running|done|failed|aborted) → the tool
 *  vocabulary the agent_* tools surface (matches registry-tools.ts). */
export function stateWord(status: string | undefined): string {
  if (status === "done") return "completed";
  if (status === "aborted") return "cancelled";
  return status ?? "unknown";
}

/** Shared foreground runner: delegates to core's runSubagent with the
 *  effective child role and tool set; notes ride as appended meta lines. */
export async function runChild(
  ctx: Parameters<typeof executeTask>[1],
  o: {
    readonly childRole: AgentRoleProfile;
    readonly prompt: string;
    readonly forkFrom?: ForkContext;
    readonly session?: ChildSessionOptions;
    readonly notes: readonly string[];
    readonly model?: ModelClient;
    readonly allTools: readonly Tool[];
    /** M31 §2: the resolved dispatch budget (explicit > adaptive > role). */
    readonly budgetTurns?: number;
    /** ω99-86: the guarded live effort (see the effortToSend block) — rides
     *  the foreground child's loopOptions exactly like the background
     *  spawn's spec. Absent ⇒ no key (byte-identical literal). */
    readonly effortSent?: string;
    /** M80: image refs riding the isolated child's first user message. */
    readonly promptImages?: readonly ImageBlock[];
    /** ω99-43: the durable-approval face for a session'd foreground child
     *  (built at the dispatch site; rides the decorated gate). */
    readonly childApprovals?: ChildApprovalFace;
    /** ω99-5b §B: the finishing tool whose captured tool_use becomes the
     *  canonical-JSON report (schema'd foreground children only). */
    readonly finalTool?: string;
    /** M31 §2: telemetry receipt for budget sampling (sync children). */
    readonly onResult?: (info: { turns: number; budgetLimited: boolean }) => void;
  },
): Promise<string> {
  // M41: the fuse is always stated — budgetTurns > role maxTurns > the
  // parent loop's fuse (if the frontend passed one) > the kernel-policy
  // childTurns (the value the core `?? 20` used to supply; identical
  // semantics, single source).
  const loopOptions = {
    ...ctx.loopOptions,
    maxTurns: o.budgetTurns ?? o.childRole.maxTurns ?? ctx.loopOptions?.maxTurns ?? KERNEL_POLICY.registry.childTurns,
    // ω99-86: the guarded live effort — the foreground twin of the
    // background spawn's conditional spread (absent ⇒ no key).
    ...(o.effortSent !== undefined ? { effortSent: o.effortSent } : {}),
  };
  // ω99-8: with a recorder wired, the child's stream passes through the cost
  // observer (usage → recorder first, isolated, then forwarded VERBATIM);
  // without one onEvent stays ctx.onSubagentEvent itself (byte-identical to
  // the pre-ω99-8 spread below).
  const onEvent = ctx.onSubagentUsage !== undefined
    ? subagentEventWithUsage(ctx.onSubagentEvent, ctx.onSubagentUsage, o.model ?? ctx.model)
    : ctx.onSubagentEvent;
  const answer = await runSubagent({
    model: o.model ?? ctx.model,
    allTools: o.allTools,
    subagentType: toSubagentType(o.childRole),
    prompt: o.prompt,
    // ω99-57: the mail sink (a fork dispatch ignores it by core's ruling).
    ...(ctx.childMail !== undefined ? { parentMail: laneAsParentMail(ctx.childMail) } : {}),
    ...(o.promptImages !== undefined ? { promptImages: o.promptImages } : {}),
    // M63-B: the SubagentStart/Stop faces (foreground children).
    ...(ctx.subagentHooks !== undefined ? { subagentHooks: ctx.subagentHooks } : {}),
    // M63-C §3: the subagent position — the role profile's own hooks, armed
    // for this child's run only.
    ...(ctx.compileRoleHooks !== undefined && o.childRole.hooks !== undefined
      ? { runHooks: ctx.compileRoleHooks(o.childRole) ?? undefined }
      : {}),
    ...(o.forkFrom !== undefined ? { forkFrom: o.forkFrom } : {}),
    loopOptions,
    // ω99-5b §B: the finishing-tool report extraction (isolated children).
    ...(o.finalTool !== undefined ? { finalTool: o.finalTool } : {}),
    // ω-4e: the foreground child's gate carries its asker context (same
    // decoration as the background registry spawn above) — covers isolated,
    // worktree and fork children alike, all of which hand their asks to this
    // one shared gate. ω99-43: session'd children also carry their
    // approval-receipt face (replay + fail-closed commit).
    ...(ctx.canUseTool !== undefined
      ? { canUseTool: decorateChildGate(ctx.canUseTool, { kind: "child", role: o.childRole.id, brief: o.prompt }, () => ctx.getForkContext?.()?.messages, o.childApprovals) }
      : {}),
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(o.session !== undefined ? { session: o.session } : {}),
    ...(o.onResult !== undefined ? { onResult: o.onResult } : {}),
  });
  return o.notes.length > 0 ? `${answer}\n\n${o.notes.join("\n")}` : answer;
}

