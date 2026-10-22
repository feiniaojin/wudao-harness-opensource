// 133 #4（the upstream format collection-planner 引进，轻量形）— todo 板生成器治理：
// 无界任务集的动态扩板四闸。the upstream format 的 collection-planner 是图执行器里
// 的独立 LLM 规划轮（94 文件的大工程）；wudao 的裁决（123"不建图"维持）
// 是把它的**治理原语**搬到 todo 板上——比图轻得多，语义全保留。
//
// 问题定义：无界任务集（"审计全部 94 个文件"这类活）没有静态工作项表
// 能一次列全；模型把板做完就停，除非有人往板上加活。深挖报告的原话：
// "无界任务集 = LLM 生成器（planner 每轮扩工作集）+ 预算化执行器"。
//
// 机制（the upstream format 反压四闸的直译 + wudao 超越点）：
//   (a) frontier 帽——在飞项（pending+in_progress）≥ frontierTarget 不扩
//       （在飞不足才补活）；
//   (b) 新完成门槛——上一轮扩板后没有新的 done 不再扩（没有新证据不
//       重规划）；**首扩豁免**：板是模型自己播的种，第一次扩不需要
//       "新完成"证据；
//   (c) 轮数帽——plannerRuns ≥ maxPlannerRuns 显式封盘
//       （exhausted: max_planner_runs）；
//   (d) 无增长熔断——连续 maxNoGrowthRounds 轮扩板指令没有换来板增长
//       （模型忽略了指令）→ 显式封盘（exhausted: error_threshold——
//       the upstream format 用连续失败计数，我们的"失败"形态是模型不响应）。
//
// 超越点（引进不许照搬，三条声明）：
// 1. **planner 轮 = 主模型同会话有界注入**，不是独立 LLM 调用——the upstream format 的
//    plannerRunner 是独立 agent 会话（每轮一次完整模型调用+落盘产物）；
//    wudao 复用 goal 续跑的 block-reason 车道（轮界 append-only 的下一轮
//    指导，M24 零前缀代价，STOP_BLOCK_CAP 停滞守卫天然兜底）。
// 2. **熔断信号 = 无增长轮**——the upstream format 的 planner 会结构化失败（errorCount）；
//    我们的主模型没有"失败回执"形态，忽略指令不扩板就是唯一可见的
//    "规划失败"，用它当熔断计数。
// 3. **封盘是通知+停扩，不写板字节**——the upstream format 在图上标 exhausted(reason)；
//    wudao 的板是模型所有权（todo_write 契约不动），封盘走 notice 车道，
//    板字节永不因 harness 而变。
import type { ParsedTodoBoard } from "./tools/todo.js";

/** 治理策略（the upstream format 缺省直译：frontierTarget 3 / maxPlannerRuns 10 /
 * 连续失败帽 3——wudao 的第三项换义为"无增长轮帽"）。 */
export interface TodoGeneratorPolicy {
  /** 在飞项（pending+in_progress）低于此数才允许扩板。 */
  readonly frontierTarget: number;
  /** 扩板轮总数帽（到帽=显式封盘 max_planner_runs）。 */
  readonly maxPlannerRuns: number;
  /** 连续"扩了板没增长"的轮数帽（到帽=显式封盘 error_threshold）。 */
  readonly maxNoGrowthRounds: number;
}

export const TODO_GENERATOR_DEFAULT_POLICY: TodoGeneratorPolicy = {
  frontierTarget: 3,
  maxPlannerRuns: 10,
  maxNoGrowthRounds: 3,
};

/** 板面普查（从最近一块板读出）。 */
export interface TodoBoardCensus {
  readonly done: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly total: number;
  /** 在飞 = pending + in_progress（frontier 的定义）。 */
  readonly incomplete: number;
}

/** 从解析后的板读普查；无板 → undefined（没有可治理的面）。 */
export function censusFromBoard(board: ParsedTodoBoard | undefined): TodoBoardCensus | undefined {
  if (board === undefined) return undefined;
  // ParsedTodoBoard 的 done/total 是头行权威计数；行级 marks 只补
  // pending/in_progress 的分布（行被裁过时以头行为准，行数只多不少）。
  const pending = board.lines.filter((l) => l.startsWith("☐ ")).length;
  const inProgress = board.lines.filter((l) => l.startsWith("◐ ")).length;
  const done = board.done;
  return { done, pending, inProgress, total: board.total, incomplete: board.total - done };
}

/** 生成器状态（跨轮记忆；goal 重置时一并重置）。armed=true 表示上一钩子
 * 发出过扩板指令、本钩子要先结算其成果（板长了吗）再走闸。 */
export interface TodoGeneratorState {
  /** 已发出的扩板指令轮数。 */
  readonly plannerRuns: number;
  /** 连续"扩了板没增长"的轮数。 */
  readonly noGrowthRounds: number;
  /** 上一轮看到的 done 数（新完成门槛的比较基线）。 */
  readonly lastDoneCount: number;
  /** 上一轮看到的板总项数（增长判定基线）。 */
  readonly lastTotal: number;
  /** 上一钩子发出了指令、待结算。 */
  readonly armed: boolean;
}

export const INITIAL_TODO_GENERATOR_STATE: TodoGeneratorState = {
  plannerRuns: 0,
  noGrowthRounds: 0,
  lastDoneCount: 0,
  lastTotal: 0,
  armed: false,
};

/** 封盘终因（一等终态——显式、带理由、可归因）。 */
export type TodoExhaustionReason = "max_planner_runs" | "error_threshold";

/** 四闸裁决。 */
export type TodoExpansionGate =
  | { readonly expand: true }
  | {
      readonly expand: false;
      readonly suppressed: "no-board" | "frontier-busy" | "no-new-completions" | "max-planner-runs" | "error-threshold";
      /** 两类封盘终因带 exhausted（the upstream format 的 exhaust 语义）。 */
      readonly exhausted?: TodoExhaustionReason;
    };

/** 四闸判定（纯）。判定序：无板 → 封盘帽（先于一切资源闸——到帽就是
 * 终态）→ frontier 帽 → 新完成门槛（首扩豁免）。 */
export function checkTodoExpansion(
  census: TodoBoardCensus | undefined,
  state: TodoGeneratorState,
  policy: TodoGeneratorPolicy = TODO_GENERATOR_DEFAULT_POLICY,
): TodoExpansionGate {
  if (census === undefined) return { expand: false, suppressed: "no-board" };
  if (state.plannerRuns >= policy.maxPlannerRuns) {
    return { expand: false, suppressed: "max-planner-runs", exhausted: "max_planner_runs" };
  }
  if (state.noGrowthRounds >= policy.maxNoGrowthRounds) {
    return { expand: false, suppressed: "error-threshold", exhausted: "error_threshold" };
  }
  if (census.incomplete >= policy.frontierTarget) return { expand: false, suppressed: "frontier-busy" };
  // 首扩豁免：plannerRuns===0 时板是模型自己播的种，不需要新完成证据。
  if (state.plannerRuns > 0 && census.done <= state.lastDoneCount) {
    return { expand: false, suppressed: "no-new-completions" };
  }
  return { expand: true };
}

/** 结算上一轮指令（纯）：grew=指令发出后板总项数较基线有增长。无增长
 * 累加熔断计数；增长清零。未武装（armed=false）时恒等返回。 */
export function settleExpansionRound(state: TodoGeneratorState, grew: boolean): TodoGeneratorState {
  if (!state.armed) return state;
  return { ...state, armed: false, noGrowthRounds: grew ? 0 : state.noGrowthRounds + 1 };
}

/** 武装新一轮指令（纯）：plannerRuns+1、基线更新为当前普查。仅在闸放行
 * 后调用。 */
export function armExpansionRound(state: TodoGeneratorState, census: TodoBoardCensus): TodoGeneratorState {
  return {
    ...state,
    plannerRuns: state.plannerRuns + 1,
    lastDoneCount: census.done,
    lastTotal: census.total,
    armed: true,
  };
}

/** 扩板指令文本（注入为下一轮指导；有界，一次一批，禁在板空后才扩）。 */
export function todoExpansionDirective(census: TodoBoardCensus): string {
  return `[工作集生成] todo 板只剩 ${census.incomplete} 项在飞（done ${census.done}/${census.total}）。若任务集合还有未覆盖的工作，请立即用 todo_write 从中派生下一批工作项（一次一批，别等板清空再扩）；若集合已穷尽，把剩余项做完即可，不要为扩而扩。`;
}

/** 封盘通知（显式终态带理由——the upstream format 的 exhaust(reason) 直译，走 notice
 * 车道不写板字节）。 */
export function todoExhaustionNote(reason: TodoExhaustionReason): string {
  if (reason === "max_planner_runs") {
    return `[工作集生成] 已达扩板轮数帽——本目标的生成器封盘（max_planner_runs）。板上的剩余项继续做完；如需继续扩，用户可重新设定目标。`;
  }
  return `[工作集生成] 连续多轮扩板指令未换来板增长——生成器封盘（error_threshold）。板上剩余项继续做完；如任务集合确未穷尽，请检查模型是否在响应工作集指令。`;
}
