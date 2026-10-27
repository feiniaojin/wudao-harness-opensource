// ω99-249: #5 — the GoalState runtime: the model-side budgeted goal, DERIVED from
// the mission ledger (anti dual-truth). Core's goal-state.ts owns the pure
// object face (entry schema, six-state machine, split accounting, renders);
// THIS module owns the derivation wiring:
//
//   - MATERIALIZE: at a run boundary, when no goal is live, the LAST
//     ledger-order DOING task that declared budgetTokens materializes a goal
//     (objective derived from title+detail; the binding missionTaskId is
//     required on every row). Unbudgeted tasks never materialize anything —
//     sessions without them see zero injection, zero rows (R4 zero noise).
//   - 随动 (follow the ledger): the goal's STATUS is a deterministic
//     projection of its task's lifecycle — done→complete, failed/gone/
//     mission-abandoned→error, todo (fail-retry)→paused, re-claimed doing→
//     active. Nothing the model SAYS moves the projection; only the ledger
//     does (the model self-report face structurally does not exist).
//   - SETTLE: at run settle the run's token usage (input/output SPLIT) and
//     wall time accumulate onto the goal, one appended row per settle; the
//     ω99-8b partition mirrors /goal --budget's (all loop usage rows count;
//     subagent/evaluator calls never reach the loop's usage events).
//     Crossing the budget flips active→budget_limited and returns a note
//     naming the DAG's deepest doing node as the SAFE PAUSE point — a
//     suggestion only: nothing is ever auto-killed or auto-continued (that
//     discipline belongs to the 242 recovery system).
//   - continuationsUsed: the goal's lifetime compaction count (mid-turn
//     compaction + same-run continuation just counts — prime's queue/
//     rollback discipline has no equivalent here; recorded honestly).
//   - INJECT: the short <goal_context> status line rides the SAME MetaNote
//     queue 233's mode steering uses (loop drains it per turn; the projection
//     is a tail-side suffix — zero system-prompt prefix bytes, M24 intact).
//
// Entry persistence is fire-and-forget (the 217 receipt law): a failed
// append costs one stderr line and NEVER breaks the run chain. The runtime is
// driver-owned (sessionStore + sessionId + the late-bound missionBox); the
// REPL's readline lane stays unwired in v1 (honest boundary — see the arc
// report).
import { randomInt } from "node:crypto";
import { buildTool, type Tool } from "@wudao/core";
import {
  applyGoalSettlement,
  buildGoalStateEntry,
  canTransitionGoal,
  goalBudgetNote,
  goalObjectiveOf,
  goalQueryText,
  goalStatusLine,
  goalTokensTotal,
  goalUsageDeltaOf,
  isLiveGoalStatus,
  replayGoalStates,
  safePauseSuggestion,
  type GenericSessionEntry,
  type GoalStateData,
  type SessionEntry,
} from "@wudao/core";
import type { MissionState, MissionTask } from "./mission.js";

/** 121 §4（a reference harness budget death salvage）— the ONE system-authored wrap-up
 *  prompt the driver's salvage lane fires after a budget crossing settles.
 *  The directive itself rides goalBudgetNote on the MetaNote queue (drained
 *  by this run's first model call); the prompt is the persisted user-side
 *  turn that gives the model its LAST answer opportunity — advisory-only
 *  (GoalState's 只建议不强制 law), but exactly once per crossing: the
 *  salvage run's own settle reports no new crossing, so nothing re-arms. */
export const GOAL_BUDGET_SALVAGE_PROMPT =
  "（系统触发）目标预算已耗尽——请完成最后的收尾回答（总结已完成、列出未完成、确认成果已保存，见预算收尾指引），不要再发起新的工具调用。";

export interface GoalRuntimeOptions {
  /** The session-entry sink (fire-and-forget; failures never throw up). */
  readonly appendEntry: (entry: GenericSessionEntry) => Promise<void>;
  /** The live mission snapshot (the SINGLE truth the goal projects from). */
  readonly getMission: () => MissionState | undefined;
  readonly now?: () => number;
}

/** The web/status face of a live goal (DriverStatus.goal — benefit copy). */
export interface GoalWebSnapshot {
  readonly objective: string;
  readonly status: "active" | "paused" | "budget_limited";
  readonly usedTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly budgetTokens?: number;
  readonly missionTaskId: string;
  readonly progress: { readonly done: number; readonly total: number };
  /** 125 项 3: the fan-out rollup (report-only; absent = zero subagents —
   *  old consumers never see the field). */
  readonly subagentsUsed?: { readonly tokens: number; readonly count: number };
}

export interface GoalRuntime {
  /** Run START (the turn boundary): reconcile + maybe materialize; returns
   *  the short status line to inject, or undefined when no goal is live
   *  (zero noise). Purely synchronous — entries append fire-and-forget. */
  onRunStart(): string | undefined;
  /** Run SETTLE: fold the run's split usage + wall time into the goal (one
   *  appended row), then reconcile the ledger 随动. Returns the budget note
   *  when THIS settle crossed the budget (the caller injects it). */
  onRunSettle(delta: { readonly input: number; readonly output: number; readonly ms: number }): { readonly budgetNote: string } | undefined;
  /** A compaction fired during the goal's life → continuationsUsed +1
   *  (persisted on the next settle row; mid-turn semantics, no rollback). */
  onCompacted(): void;
  /** 125 项 3（codex 预算上卷 4761851ff3 形）：子代理用量归账——task 工具的
   *  onSubagentUsage 回传（每个子代理模型调用一行，childId 去重计子代理数）
   *  汇入本目标的 subagentsUsed 计数器。**计入报告、不计入触发**（ω99-8b
   *  分区不动：applyGoalSettlement 的 tokensUsed 只收根 loop 的行——预算穿
   *  越判定永不因子代理而提前）。计数器在下一个 settle 行落盘；无 live 目标
   *  时静默丢弃（goal 面缺席的会话本就没有归账处）。 */
  onSubagentUsage(info: { readonly childId?: string; readonly model: string; readonly usage: { readonly promptTokens: number; readonly completionTokens?: number } }): void;
  /** The read-only query face (the `goal` tool's body). */
  query(): { readonly text: string; readonly none?: true };
  /** The status/web face — PURE read (no transitions, no appends). */
  webSnapshot(): GoalWebSnapshot | null;
  /** Tests/introspection: the current live goal, else the last closed one. */
  snapshot(): GoalStateData | undefined;
  /** Resume: replay the session's goal_state rows; true when a live goal restored. */
  restoreFromEntries(entries: readonly SessionEntry[]): boolean;
}

const iso = (now: () => number): string => new Date(now()).toISOString();

export function createGoalRuntime(opts: GoalRuntimeOptions): GoalRuntime {
  const now = opts.now ?? Date.now;
  /** The LIVE goal; undefined when none (or terminal — closed goals leave
   *  `closed` behind for honest reporting and free the slot for the next
   *  materialization). */
  let current: GoalStateData | undefined;
  let closed: GoalStateData | undefined;
  let pendingCompactions = 0;
  // 125 项 3（codex 预算上卷）：本目标生命周期内的子代理用量累计器——
  // tokens 全加、childId 去重（无 childId 的旧行每行算一个——诚实高估好过
  // 静默低估；生产路径 task-tool-support 的包装器总盖 childId）。settle 行
  // 落盘后清零；restore 从最后一行重建起点（目标跨 resume 连续计）。展示面
  // （statusLine/query/web）读「行内值 + pending」的合并值；触发面（预算穿
  // 越）永不读它——ω99-8b 分区的 125 补面：扇出成本进报告、不进触发。
  let pendingSubagents: { tokens: number; childIds: Set<string> } = { tokens: 0, childIds: new Set() };
  let idLessRows = 0;
  const subagentsMerged = (): { tokens: number; count: number } | undefined => {
    const rowTokens = current?.subagentsUsed?.tokens ?? 0;
    const rowCount = current?.subagentsUsed?.count ?? 0;
    const tokens = rowTokens + pendingSubagents.tokens;
    const count = rowCount + pendingSubagents.childIds.size + idLessRows;
    return tokens > 0 || count > 0 ? { tokens, count } : undefined;
  };

  const persistRow = (row?: GoalStateData): void => {
    const target = row ?? current;
    if (target === undefined) return;
    void opts.appendEntry(buildGoalStateEntry(target)).catch((err) => {
      // fire-and-forget law: one stderr line, never a run-chain break
      process.stderr.write(`wudao: goal 状态落盘失败（继续运行，不重试）：${err instanceof Error ? err.message : String(err)}\n`);
    });
  };

  const mission = (): MissionState | undefined => opts.getMission();
  const progressOf = (m: MissionState | undefined): { readonly done: number; readonly total: number } => {
    const tasks = m?.tasks ?? [];
    return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length };
  };

  /** Deterministic 随动: project the bound task's lifecycle onto the goal.
   *  Transitions append rows; illegal moves (GOAL_TRANSITIONS) refuse. */
  const reconcile = (): void => {
    if (current === undefined || !isLiveGoalStatus(current.status)) return;
    const m = mission();
    if (m === undefined) return; // no mission face / unreadable ledger — hold state (cannot project)
    if (m.status !== "active") {
      // the mission flipped terminal: a completed campaign completes its
      // goals; abandoned/stale campaigns error them (honest 随动).
      if (m.status === "completed") moveTo("complete", `mission 已完成（${m.status}）`);
      else moveTo("error", `mission 已${m.status === "abandoned" ? "放弃" : "结算"}（${m.status}）`);
      return;
    }
    const task = m.tasks.find((t) => t.id === current!.missionTaskId);
    if (task === undefined) {
      moveTo("error", "任务已不在台账");
      return;
    }
    switch (task.status) {
      case "done":
        moveTo("complete", "任务已完成（台账判定）");
        return;
      case "failed":
        moveTo("error", "任务重试预算耗尽（failed）");
        return;
      case "todo":
        moveTo("paused", "任务回到 todo（失败重试）");
        return;
      default: // doing — the working state
        if (current.status === "paused") moveTo("active", "任务重新认领");
        // active stays active; budget_limited stays budget_limited (no raise face)
    }
  };

  const moveTo = (to: GoalStateData["status"], reason: string): void => {
    if (current === undefined) return;
    if (!canTransitionGoal(current.status, to)) return;
    current = { ...current, status: to, lastReason: reason, updatedAt: iso(now) };
    if (!isLiveGoalStatus(current.status)) {
      closed = current;
      current = undefined;
      persistRow(closed);
      return;
    }
    persistRow();
  };

  /** Materialize for the LAST ledger-order doing task that declared a budget
   *  (deterministic; one live goal per session — a new claim while another
   *  goal is live never spawns a second). */
  const materialize = (): void => {
    const m = mission();
    if (m === undefined || m.status !== "active") return;
    const candidates = m.tasks.filter((t) => t.status === "doing" && t.budgetTokens !== undefined);
    if (candidates.length === 0) return;
    const task = candidates[candidates.length - 1] as MissionTask;
    const at = iso(now);
    current = {
      goalId: `g${now().toString(36)}-${randomInt(0x1000000).toString(36)}`,
      objective: goalObjectiveOf(task.title, task.detail),
      missionTaskId: task.id,
      status: "active",
      ...(task.budgetTokens !== undefined ? { tokenBudget: task.budgetTokens } : {}),
      tokensUsed: { input: 0, output: 0 },
      timeUsedMs: 0,
      continuationsUsed: 0,
      createdAt: at,
      updatedAt: at,
      lastReason: "任务认领（预算目标建立）",
    };
    // 125 项 3: a fresh goal starts a fresh rollup (the previous goal's rows
    // stay as its own audit trail).
    pendingSubagents = { tokens: 0, childIds: new Set() };
    idLessRows = 0;
    persistRow();
  };

  return {
    onRunStart: () => {
      reconcile();
      if (current === undefined) materialize();
      if (current === undefined) return undefined;
      const m = mission();
      const progress = progressOf(m);
      // 125 项 3: the injected line carries the LIVE rollup (row + pending) —
      // mid-run fan-out spend is visible at the very next run boundary.
      const live = { ...current, ...(subagentsMerged() !== undefined ? { subagentsUsed: subagentsMerged() } : {}) };
      if (current.status === "budget_limited") {
        return goalBudgetNote(live, pauseSuggestionOf(m), progress);
      }
      return goalStatusLine(live, progress);
    },
    onRunSettle: (delta) => {
      let note: string | undefined;
      if (current !== undefined && (current.status === "active" || current.status === "budget_limited")) {
        // accumulate FIRST (the completing run's tokens count), then let the
        // ledger 随动 settle the final status below.
        const applied = applyGoalSettlement(current, {
          tokens: { input: Math.max(0, delta.input), output: Math.max(0, delta.output) },
          timeMs: Math.max(0, delta.ms),
        });
        // 125 项 3: the subagent rollup folds onto the row at the SAME settle
        // seam (report-only lane — applyGoalSettlement's tokensUsed/budget
        // crossing above never sees it).
        const sub = subagentsMerged();
        current = {
          ...applied.goal,
          continuationsUsed: applied.goal.continuationsUsed + pendingCompactions,
          updatedAt: iso(now),
          ...(sub !== undefined ? { subagentsUsed: sub } : {}),
        };
        pendingCompactions = 0;
        pendingSubagents = { tokens: 0, childIds: new Set() };
        idLessRows = 0;
        if (applied.crossedBudget) {
          const m = mission();
          note = goalBudgetNote(current, pauseSuggestionOf(m), progressOf(m));
        }
        persistRow();
      }
      reconcile();
      return note !== undefined ? { budgetNote: note } : undefined;
    },
    onCompacted: () => {
      if (current === undefined || !isLiveGoalStatus(current.status)) return;
      pendingCompactions += 1;
    },
    onSubagentUsage: (info) => {
      if (current === undefined || !isLiveGoalStatus(current.status)) return; // 无目标=无归账处（静默丢弃）
      const delta = goalUsageDeltaOf(info.usage);
      pendingSubagents.tokens += goalTokensTotal(delta);
      if (info.childId !== undefined) pendingSubagents.childIds.add(info.childId);
      else idLessRows += 1;
    },
    query: () => {
      reconcile();
      if (current === undefined) {
        return {
          none: true as const,
          text: "当前没有带预算的目标——目标随任务建立：mission_plan 给任务声明 budgetTokens，该任务被认领（doing）时目标自动建立并跨轮持续。",
        };
      }
      const m = mission();
      const task = m?.tasks.find((t) => t.id === current!.missionTaskId);
      const sub = subagentsMerged();
      return {
        text: goalQueryText(
          sub !== undefined ? { ...current!, subagentsUsed: sub } : current!,
          progressOf(m),
          task !== undefined ? { id: task.id, title: task.title, status: task.status } : undefined,
        ),
      };
    },
    webSnapshot: () => {
      // PURE read — no transitions, no appends (the status channel rebuilds
      // on every emit; side effects live on the run boundaries only).
      const g = current;
      if (g === undefined || !isLiveGoalStatus(g.status)) return null;
      const m = mission();
      return {
        objective: g.objective,
        status: g.status,
        usedTokens: goalTokensTotal(g.tokensUsed),
        inputTokens: g.tokensUsed.input,
        outputTokens: g.tokensUsed.output,
        ...(g.tokenBudget !== undefined ? { budgetTokens: g.tokenBudget } : {}),
        missionTaskId: g.missionTaskId,
        progress: progressOf(m),
        // 125 项 3: the live merged rollup rides the status face (absent when
        // zero — omit-when-absent, the additive-lane discipline).
        ...(subagentsMerged() !== undefined ? { subagentsUsed: subagentsMerged() } : {}),
      };
    },
    snapshot: () => current ?? closed,
    restoreFromEntries: (entries) => {
      const restored = replayGoalStates(entries);
      if (restored === undefined) return false;
      current = restored;
      // 125 项 3: resume continues the rollup FROM the last row's value (the
      // goal's lifetime accumulator spans resumes — same object, same audit).
      pendingSubagents = { tokens: 0, childIds: new Set() };
      idLessRows = 0;
      return true;
    },
  };
}

/** The safe-pause node over the live ledger (core's topology, titled). */
function pauseSuggestionOf(m: MissionState | undefined): { readonly taskId: string; readonly title?: string } | undefined {
  if (m === undefined) return undefined;
  const pick = safePauseSuggestion(m.tasks);
  if (pick === undefined) return undefined;
  const task = m.tasks.find((t) => t.id === pick.taskId);
  return { taskId: pick.taskId, ...(task !== undefined && task.title !== "" ? { title: task.title } : {}) };
}

// ---------------------------------------------------------------------------
// The model tool face — `goal`, read-only query (mission_know's mount
// precedent). The recon verdict on "how to hang a builtin skill": our skills
// are filesystem-discovered SKILL.md packs (a synthesized one would fake a
// filePath); the honest read-only query face in this harness IS a shared tool
// — progressive disclosure is the per-run status line (short) + this tool
// (full detail on demand).
// ---------------------------------------------------------------------------

export function createGoalTools(getRuntime: () => GoalRuntime | undefined): Tool[] {
  const refused = { content: "goal 工具拒绝：当前会话没有目标面（运行时尚未就绪或该前端未接线）", isError: true };
  return [
    buildTool({
      name: "goal",
      description:
        "查询当前目标（只读）：目标是什么、绑定哪个任务、token 预算已花多少还剩多少、任务进度与状态。进度与完成判定以任务台账为准（mission_next/mission_complete 记录的那个台账），不是模型自报——回答「目标完成了吗」时以本工具返回的进度为准。目标跨轮持续存在：单轮结束不会减少或改写目标。无参数调用即可。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute() {
        const runtime = getRuntime();
        if (runtime === undefined) return refused;
        const r = runtime.query();
        return { content: r.text };
      },
    }),
  ];
}
