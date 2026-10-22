// ω99-249: #2 — the model-side GoalState: a budgeted goal object that stays
// alive across turns. The agent gets a durable awareness of WHAT it is
// working toward, HOW MUCH budget remains, and WHY the work continues —
// without the mission ledger and the goal ever becoming two truths.
//
// Design stance (240 five-repo recon ④; the upstream project goals.ts is the parity
// blueprint, our derivation discipline is the delta):
//   - The entry rides the M35 §2 GENERIC session lane ({type:"goal_state",
//     data}) — append-only like every session row: a state change APPENDS a
//     new line, the old line's bytes never move. load() filters generic
//     entries out of the model-visible history, so nothing here ever touches
//     the persisted transcript (M24 prefix-stable by construction).
//   - Six statuses (prime parity): idle (the absent-goal state — NEVER
//     written to an entry row), active, paused, budget_limited, complete,
//     error. complete/error are terminals. budget_limited has NO path back
//     to active: v1 has no budget-raise face, and honesty forbids un-limiting
//     a goal whose tokens are spent — only the mission lifecycle (complete /
//     error / a fail-retry's paused) moves it out.
//   - Tokens are a SPLIT (input/output), settled at RUN boundaries — never
//     per-call. timeUsedMs and continuationsUsed (this goal's lifetime
//     compaction count; mid-turn compaction + same-run continuation just
//     counts — prime's queue/rollback discipline does not apply to us) ride
//     the same rows.
//   - `missionTaskId` is REQUIRED on every row: the goal must be DERIVED
//     from a mission task (the CLI runtime materializes it on claim of a
//     budget-declaring task). A row without the binding is junk on load —
//     parseGoalStateData drops it (fail-safe, never throws).
// All functions here are PURE over data; the derivation wiring lives in the
// CLI (goal-runtime.ts over mission.ts). Zero dependencies beyond the store
// entry types.
import type { GenericSessionEntry, SessionEntry } from "./session/store.js";
import { truncateSafe } from "./text-truncate.js";

/** The entry type on the M35 §2 generic lane. */
export const GOAL_STATE_ENTRY_TYPE = "goal_state";
/** objective ceiling (prime parity: MAX_THREAD_GOAL_OBJECTIVE_CHARS). */
export const GOAL_OBJECTIVE_MAX_CHARS = 4000;

export type GoalStatus = "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";
/** The statuses a LIVE (non-terminal, non-absent) goal can carry. */
export type LiveGoalStatus = Exclude<GoalStatus, "idle" | "complete" | "error">;

/** Input/output token accounting — settled as a pair, never conflated. */
export interface GoalTokensSplit {
  readonly input: number;
  readonly output: number;
}

/** The `data` contract of a goal_state entry row (the writer's law). */
export interface GoalStateData {
  readonly goalId: string;
  readonly objective: string;
  /** REQUIRED: the mission task this goal derives from (anti dual-truth). */
  readonly missionTaskId: string;
  readonly status: LiveGoalStatus | "complete" | "error";
  /** Positive integer; absent = unbudgeted (remaining reads null, never a fake number). */
  readonly tokenBudget?: number;
  readonly tokensUsed: GoalTokensSplit;
  readonly timeUsedMs: number;
  readonly continuationsUsed: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastReason?: string;
  /** 121 §4（the upstream format budget death salvage）— the honest death cause. Set
   *  ONCE at the budget crossing (applyGoalSettlement) and carried into every
   *  later row of the same goal (moveTo spreads it): a goal that died by
   *  budget NEVER terminal-izes as a bare "completed" — the row names its
   *  cause. Absent = the goal never crossed its budget (a normal completion
   *  carries no deathCause, by design). Additive lane: old readers never see
   *  the field; the writer omits it when absent. */
  readonly deathCause?: "budget_exhausted";
  /** 125 项 3（the upstream project预算上卷 4761851ff3 形）— 扇出子代理的用量归账：本目标
   *  生命周期内全部子代理模型调用的 token 合计 + 去重子代理数。**计入报告、
   *  不计入触发**（ω99-8b 分区不动：子代理/evaluator 用量永不进
   *  applyGoalSettlement 的 tokensUsed——预算穿越判定只看根 loop 的行）；
   *  没有子代理的目标整个字段缺席（缺省隐藏，零噪音——additive lane：老读
   *  者永不见该字段，写入侧缺席时省略）。 */
  readonly subagentsUsed?: { readonly tokens: number; readonly count: number };
}

/**
 * The pinned transition table (who may move where). Rows append; this table
 * governs CROSS-status moves only (same-status settle rows are accumulation,
 * always legal). idle exists as the materialization source state only.
 */
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  idle: ["active"],
  active: ["paused", "budget_limited", "complete", "error"],
  paused: ["active", "complete", "error"],
  budget_limited: ["paused", "complete", "error"],
  complete: [],
  error: [],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

export function isLiveGoalStatus(status: GoalStatus): status is LiveGoalStatus {
  return status === "active" || status === "paused" || status === "budget_limited";
}

/** The canonical entry factory — one row, one full snapshot of the goal. */
export function buildGoalStateEntry(data: GoalStateData): GenericSessionEntry {
  return {
    type: GOAL_STATE_ENTRY_TYPE,
    data: {
      goalId: data.goalId,
      objective: data.objective,
      missionTaskId: data.missionTaskId,
      status: data.status,
      ...(data.tokenBudget !== undefined ? { tokenBudget: data.tokenBudget } : {}),
      tokensUsed: { input: data.tokensUsed.input, output: data.tokensUsed.output },
      timeUsedMs: data.timeUsedMs,
      continuationsUsed: data.continuationsUsed,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(data.lastReason !== undefined && data.lastReason !== "" ? { lastReason: data.lastReason } : {}),
      ...(data.deathCause !== undefined ? { deathCause: data.deathCause } : {}),
      // 125 项 3: the subagent rollup lane — omitted when absent (a goal with
      // zero subagents keeps its exact pre-125 row bytes).
      ...(data.subagentsUsed !== undefined
        ? { subagentsUsed: { tokens: Math.max(0, Math.trunc(data.subagentsUsed.tokens)), count: Math.max(0, Math.trunc(data.subagentsUsed.count)) } }
        : {}),
    } satisfies GoalStateData,
  };
}

/** Read-side fail-safe parse: any structurally wrong field drops the WHOLE
 *  row (a corrupt goal row reads as absent — it never throws, never partially
 *  loads). The missionTaskId binding is load-bearing: without it the row is
 *  not our goal. */
export function parseGoalStateData(data: unknown): GoalStateData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.goalId !== "string" || d.goalId === "") return undefined;
  if (typeof d.objective !== "string") return undefined;
  if (typeof d.missionTaskId !== "string" || d.missionTaskId === "") return undefined;
  if (d.status !== "active" && d.status !== "paused" && d.status !== "budget_limited" && d.status !== "complete" && d.status !== "error") return undefined;
  if (d.tokenBudget !== undefined && (typeof d.tokenBudget !== "number" || !Number.isInteger(d.tokenBudget) || d.tokenBudget <= 0)) return undefined;
  const used = d.tokensUsed as Record<string, unknown> | undefined;
  if (typeof used !== "object" || used === null || typeof used.input !== "number" || typeof used.output !== "number") return undefined;
  if (typeof d.timeUsedMs !== "number" || typeof d.continuationsUsed !== "number") return undefined;
  if (typeof d.createdAt !== "string" || typeof d.updatedAt !== "string") return undefined;
  if (d.lastReason !== undefined && typeof d.lastReason !== "string") return undefined;
  // 121 §4: the death-cause lane — fail-safe like every other field: an
  // unknown value drops the WHOLE row (v1 knows exactly one cause; a future
  // writer's new value must ship with its own reader in the same change).
  if (d.deathCause !== undefined && d.deathCause !== "budget_exhausted") return undefined;
  // 125 项 3: the subagent-rollup lane — same fail-safe (a structurally wrong
  // additive field drops the WHOLE row, never a partial load). Absent stays
  // absent (old rows read as zero-subagent goals).
  const sub = d.subagentsUsed as Record<string, unknown> | undefined;
  if (sub !== undefined
    && (typeof sub !== "object" || sub === null
      || typeof sub.tokens !== "number" || !Number.isFinite(sub.tokens) || sub.tokens < 0
      || typeof sub.count !== "number" || !Number.isInteger(sub.count) || sub.count < 0)) {
    return undefined;
  }
  return {
    goalId: d.goalId,
    objective: d.objective,
    missionTaskId: d.missionTaskId,
    status: d.status,
    ...(d.tokenBudget !== undefined ? { tokenBudget: d.tokenBudget } : {}),
    tokensUsed: { input: Math.max(0, Math.trunc(used.input)), output: Math.max(0, Math.trunc(used.output)) },
    timeUsedMs: Math.max(0, Math.trunc(d.timeUsedMs)),
    continuationsUsed: Math.max(0, Math.trunc(d.continuationsUsed)),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.lastReason !== undefined && d.lastReason !== "" ? { lastReason: d.lastReason } : {}),
    ...(d.deathCause !== undefined ? { deathCause: d.deathCause } : {}),
    ...(sub !== undefined ? { subagentsUsed: { tokens: Math.max(0, Math.trunc(sub.tokens as number)), count: Math.max(0, Math.trunc(sub.count as number)) } } : {}),
  };
}

/**
 * File-order replay: the latest row per goalId is that goal's state; a row
 * with a NEW goalId supersedes whatever was live (a fresh materialization
 * implicitly closes the previous goal — its rows stay as the audit trail).
 * Returns the LIVE goal, or undefined when the newest goal is terminal (or
 * no goal rows exist). Corrupt rows skip silently.
 */
export function replayGoalStates(entries: readonly SessionEntry[]): GoalStateData | undefined {
  let current: GoalStateData | undefined;
  for (const e of entries) {
    if ("role" in e) continue;
    if (e.type !== GOAL_STATE_ENTRY_TYPE) continue;
    const parsed = parseGoalStateData(e.data);
    if (parsed === undefined) continue;
    current = parsed;
  }
  return current !== undefined && isLiveGoalStatus(current.status) ? current : undefined;
}

/** One model-usage row → the split delta (prompt/completion → input/output). */
export function goalUsageDeltaOf(usage: { readonly promptTokens: number; readonly completionTokens?: number }): GoalTokensSplit {
  return { input: Math.max(0, usage.promptTokens), output: Math.max(0, usage.completionTokens ?? 0) };
}

export function goalTokensTotal(split: GoalTokensSplit): number {
  return Math.max(0, split.input) + Math.max(0, split.output);
}

/** Remaining budget; null when unbudgeted (never a fake number). */
export function goalRemainingTokens(goal: GoalStateData): number | null {
  return goal.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goalTokensTotal(goal.tokensUsed));
}

// ---------------------------------------------------------------------------
// 114 长任务纪律 ②（预算感知收尾）：the near-exhaustion wrap-up suggestion.
// The status line is the goal's per-run budget broadcast; when the remaining
// tokens fall to (or under) the fraction line, it appends ONE best-effort
// wrap-up line — a SUGGESTION in GoalState's advisory-only voice (nothing is
// paused, killed, or hidden by it; the exhausted channel remains
// goalBudgetNote's, which fires only after the crossing settles). Unbudgeted
// and freshly-materialized (zero spent) goals never warn — no noise.
// ---------------------------------------------------------------------------

/** The near-exhaustion line: remaining ≤ 20% of the budget (floor, min 1). */
export const GOAL_NEAR_BUDGET_FRACTION = 0.2;

/** The remaining-token count when the goal is NEAR its budget — else
 *  undefined (unbudgeted, nothing spent yet, or still above the line). */
export function goalNearBudgetRemaining(goal: GoalStateData): number | undefined {
  if (goal.tokenBudget === undefined) return undefined;
  const used = goalTokensTotal(goal.tokensUsed);
  if (used === 0) return undefined;
  const remaining = Math.max(0, goal.tokenBudget - used);
  return remaining <= Math.max(1, Math.floor(goal.tokenBudget * GOAL_NEAR_BUDGET_FRACTION)) ? remaining : undefined;
}

/**
 * Pure run-boundary settlement: accumulate the split + wall time, clamp at
 * zero, and cross into budget_limited exactly ONCE (from active). Settling
 * an already-limited goal keeps counting but reports no new crossing.
 * 121 §4: the crossing row stamps deathCause "budget_exhausted" — the honest
 * death cause rides every later row of the same goal (a budget-dead goal
 * never terminal-izes as a bare "completed").
 * continuationsUsed is NOT touched here (the caller folds its pending
 * compaction count into the row it persists).
 */
export function applyGoalSettlement(
  goal: GoalStateData,
  delta: { readonly tokens: GoalTokensSplit; readonly timeMs: number },
): { readonly goal: GoalStateData; readonly crossedBudget: boolean } {
  const tokensUsed = {
    input: Math.max(0, goal.tokensUsed.input + Math.max(0, delta.tokens.input)),
    output: Math.max(0, goal.tokensUsed.output + Math.max(0, delta.tokens.output)),
  };
  const timeUsedMs = Math.max(0, goal.timeUsedMs + Math.max(0, delta.timeMs));
  const over = goal.tokenBudget !== undefined && goalTokensTotal(tokensUsed) >= goal.tokenBudget;
  const crossedBudget = over && goal.status === "active";
  return {
    goal: {
      ...goal,
      tokensUsed,
      timeUsedMs,
      ...(over && goal.status === "active" ? { status: "budget_limited" as const, deathCause: "budget_exhausted" as const } : {}),
    },
    crossedBudget,
  };
}

// ---------------------------------------------------------------------------
// The safe-pause suggestion (face 2): budget exhaustion must not stop
// mid-air — name the node where pausing is SAFE per the DAG. Structural
// input only (the mission task's minimal shape); pure, so core pins the
// topology and the CLI passes live ledger tasks.
// ---------------------------------------------------------------------------

/** The minimal task shape the topology reads (mission tasks satisfy it structurally). */
export interface GoalPauseSuggestionTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly status: string;
}

/**
 * The deepest CURRENTLY-DOING node by dependency depth (longest chain from a
 * root): pausing there loses only that node's in-flight work — every dep
 * behind it is settled, and resume restarts exactly at it. Ties break to the
 * LATER ledger position (deterministic). No doing task → undefined (nothing
 * is in flight; there is nothing to pause AT).
 */
export function safePauseSuggestion(tasks: readonly GoalPauseSuggestionTask[]): { readonly taskId: string; readonly depth: number } | undefined {
  const doing = tasks.filter((t) => t.status === "doing");
  if (doing.length === 0) return undefined;
  const byId = new Map<string, GoalPauseSuggestionTask>();
  const memo = new Map<string, number>();
  const depth = (id: string, seen: ReadonlySet<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cyclic guard — the mission refuses cycles at plan time; this never fires on real ledgers
    const task = byId.get(id);
    if (task === undefined || task.dependsOn.length === 0) {
      memo.set(id, 1);
      return 1;
    }
    let best = 0;
    for (const dep of task.dependsOn) best = Math.max(best, depth(dep, new Set([...seen, id])));
    const value = best + 1;
    memo.set(id, value);
    return value;
  };
  for (const t of tasks) byId.set(t.id, t);
  let pick: { readonly taskId: string; readonly depth: number } | undefined;
  for (const t of doing) {
    const d = depth(t.id, new Set());
    if (pick === undefined || d >= pick.depth) pick = { taskId: t.id, depth: d }; // >= : ties break to the later ledger position
  }
  return pick;
}

// ---------------------------------------------------------------------------
// The model-facing renders (projection face 3): the short status line every
// run carries, and the budget note with its pause suggestion. Both ride the
// MetaNote seam (tail-side projection — 233's modeSteeringNote precedent);
// the <goal_context> wrap is prime parity. Benefit copy, and the progress is
// always the LEDGER's doing/done count — never a model self-report.
// ---------------------------------------------------------------------------

const GOAL_LINE_OBJECTIVE_MAX_CHARS = 160;

/** 125 项 3: the rollup render line — `子代理累计：N tokens（M 个子代理）`。
 *  Zero/absent → undefined（缺省隐藏，零子代理的会话逐字节与 125 前一致）。
 *  Present but zero tokens (a child that never burned a model call) still
 *  renders — the count is the honest fact worth seeing. */
export function goalSubagentLine(sub: { readonly tokens: number; readonly count: number } | undefined): string | undefined {
  if (sub === undefined || (sub.tokens <= 0 && sub.count <= 0)) return undefined;
  return `子代理累计：${Math.max(0, Math.trunc(sub.tokens))} tokens（${Math.max(0, Math.trunc(sub.count))} 个子代理）`;
}

const clampObjective = (objective: string): string =>
  objective.length > GOAL_LINE_OBJECTIVE_MAX_CHARS ? `${truncateSafe(objective, GOAL_LINE_OBJECTIVE_MAX_CHARS - 1)}…` : objective; // 113-A4

/** Derive the goal's objective from a mission task's title (+detail), clamped to the 4000 face. */
export function goalObjectiveOf(title: string, detail?: string): string {
  const joined = detail !== undefined && detail !== "" ? `${title}——${detail}` : title;
  return joined.length > GOAL_OBJECTIVE_MAX_CHARS ? truncateSafe(joined, GOAL_OBJECTIVE_MAX_CHARS) : joined; // 113-A4
}

export function goalStatusLine(goal: GoalStateData, progress: { readonly done: number; readonly total: number }): string {
  const used = goalTokensTotal(goal.tokensUsed);
  const budgetLine =
    goal.tokenBudget !== undefined
      ? `预算：已花 ${used}（输入 ${goal.tokensUsed.input} · 输出 ${goal.tokensUsed.output}）/ ${goal.tokenBudget}，剩余 ${Math.max(0, goal.tokenBudget - used)}`
      : `用量：已花 ${used}（输入 ${goal.tokensUsed.input} · 输出 ${goal.tokensUsed.output}）`;
  // 114 纪律 ②：近耗尽时追加一条最佳努力收尾建议（只建议，不执行——
  // GoalState 的一贯语义）。Remaining settles at run boundaries, so the
  // number is an approximation ("约") of what the next settle will leave.
  const nearRemaining = goalNearBudgetRemaining(goal);
  const subagentLine = goalSubagentLine(goal.subagentsUsed); // 125 项 3
  return [
    "<goal_context>",
    `当前目标（任务 ${goal.missionTaskId}）：${clampObjective(goal.objective)}`,
    budgetLine,
    // 125 项 3（the upstream project预算上卷）：扇出成本对模型可见——「根预算显示健康、
    // 子代理烧钱不可见」的盲区补上面；缺省隐藏（零子代理零噪音）。
    ...(subagentLine !== undefined ? [subagentLine] : []),
    ...(nearRemaining !== undefined
      ? [`预算还剩约 ${nearRemaining}——建议停止开启新的探索，把当前最好的成果整理、提交/落盘（收尾建议，非强制）。`]
      : []),
    `进度：${progress.done}/${progress.total} 任务完成（以任务台账为准，不是模型自报）`,
    `状态：${goal.status}`,
    "目标跨轮持续存在：单轮结束不会减少或改写目标；未完成就继续推进。",
    "</goal_context>",
  ].join("\n");
}

export function goalBudgetNote(
  goal: GoalStateData,
  pause: { readonly taskId: string; readonly title?: string } | undefined,
  progress: { readonly done: number; readonly total: number },
): string {
  const used = goalTokensTotal(goal.tokensUsed);
  const lines = [
    "<goal_context>",
    `目标预算已用尽：已花 ${used}${goal.tokenBudget !== undefined ? ` / 预算 ${goal.tokenBudget}` : ""}。`,
  ];
  if (pause !== undefined) {
    lines.push(`按任务依赖，当前可安全暂停于节点 ${pause.taskId}${pause.title !== undefined && pause.title !== "" ? `（${pause.title}）` : ""}——它的依赖均已完成，恢复时从该节点继续即可。`);
  }
  lines.push(
    `进度：${progress.done}/${progress.total} 任务完成（以任务台账为准）。`,
    // 121 §4（the upstream format budget death salvage）— the wrap-up directive: budget
    // death must not stop mid-air with the work unsummarized. Advisory-only
    // (GoalState's standing semantics — nothing is killed or forced), but
    // this IS the final advice: the driver fires ONE salvage round whose
    // first model call drains this very note.
    "预算已耗尽。请立即做以下收尾：(1) 用一至两句话总结你已完成的部分 (2) 列出还差什么没做 (3) 如果有部分成果文件，确认已保存。不要再发起新的工具调用。",
    // the honest death-cause receipt: the crossing row stamped
    // deathCause:budget_exhausted, and every later row of this goal carries
    // it — a later "完成" state never reads as a clean completion.
    ...(goal.deathCause !== undefined ? ["死因已记录：budget_exhausted（预算耗尽，非正常完成——本目标的后续状态行会一直携带此死因）。"] : []),
    "这是收尾轮：预算用尽后系统只自动触发这一次收尾回答，此后不再自动开始新的工作轮，也不会自动砍断在飞的工作；是否继续、是否调整预算由用户决定。",
    "</goal_context>",
  );
  return lines.join("\n");
}

/** The full-detail query face (the `goal` tool's reply body). */
export function goalQueryText(
  goal: GoalStateData,
  progress: { readonly done: number; readonly total: number },
  task?: { readonly id: string; readonly title: string; readonly status: string },
): string {
  const used = goalTokensTotal(goal.tokensUsed);
  const remaining = goalRemainingTokens(goal);
  return [
    `目标（${goalStatusLabel(goal.status)}）：${goal.objective}`,
    `绑定任务：${goal.missionTaskId}${task !== undefined ? ` ${task.title}（当前 ${task.status}）` : ""}`,
    `预算：已花 ${used}（输入 ${goal.tokensUsed.input} · 输出 ${goal.tokensUsed.output}）${goal.tokenBudget !== undefined ? ` / 预算 ${goal.tokenBudget}，剩余 ${remaining}` : "（未设上限）"}`,
    // 125 项 3: the rollup's full-detail face — the root budget line above
    // stays the ω99-8b partition (loop rows only); this line is the fan-out
    // truth (report-only, never a trigger input).
    ...(goalSubagentLine(goal.subagentsUsed) !== undefined ? [goalSubagentLine(goal.subagentsUsed)!] : []),
    `耗时：${Math.round(goal.timeUsedMs / 1000)} 秒 · 压缩次数：${goal.continuationsUsed}`,
    `进度：${progress.done}/${progress.total} 任务完成（以任务台账为准——任务的完成只由台账记录判定，模型不能自报完成）`,
    ...(goal.deathCause !== undefined ? [`死因：${goal.deathCause}（预算耗尽——不是正常完成）`] : []),
  ].join("\n");
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "进行中";
    case "paused":
      return "已暂停";
    case "budget_limited":
      return "预算已尽";
    case "complete":
      return "已完成";
    case "error":
      return "已出错";
    default:
      return status;
  }
}
