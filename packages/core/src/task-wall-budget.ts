// 任务墙钟预算（task wall-clock budget）——「原则进系统提示词，数字进
// 上下文」分层的运行期半边。系统提示词只教通用的配速启发（Task
// discipline 的 deadline 一等约束条）；具体的秒数、起跑时刻、剩余量全
// 部走本模块 + 消息层注入，冻结前缀零字节变动。
//
// 三个部件各占一个通道（见 loop 的接线）：
//   · 启动注入  —— CLI 在任务消息前放一条持久化 user 消息
//     `<task_context budget_seconds=… started_at=…>`（消息层事实，与
//     bench 模板注入同层；系统前缀不动，跨会话缓存只共用前缀，与现状
//     一致）。
//   · clock 工具 —— 拉模式：模型在任何相位边界主动查剩余（条件常驻：
//     有预算才进工具面；预算在会话内恒定 → 工具面会话内冻结）。
//   · 阈值提醒  —— 推模式：跨过 50% / 80% 时各提醒一次，文案是系统
//     提示词配速原则的引用（不发明新政策）。走 MetaNote 投影通道
//     （sessionBudget 同款：纯后缀、append 进最后 tool_result 尾、
//     前缀稳定、不落盘）。0 号档 = 每窗口首个请求重述全量余量。
//
// 与既有三顶预算的边界：maxRunMs 是保险丝（超了就杀）；sessionBudget
// 记 token 账（树共享硬顶）；turnBudget 数轮次。本模块记墙钟但**不杀**
// ——它是给模型的约束提示，硬截止留给外层 orchestrator（bench 的
// agent.py deadline / 产品的调度方）。

export interface TaskWallBudgetReminder {
  /** 0 = 全量重述；1 = 过半档；2 = 八成档。 */
  readonly index: 0 | 1 | 2;
  readonly remainingMs: number;
}

export interface TaskWallBudget {
  readonly budgetMs: number;
  readonly startedAtMs: number;
  elapsedMs(nowMs?: number): number;
  remainingMs(nowMs?: number): number;
  /** 当前应投递的提醒；同档已投递则 undefined（窗口内去重）。 */
  pendingReminder(windowId: string, nowMs?: number): TaskWallBudgetReminder | undefined;
  /** 投递成功后写标记（投影同步构建：push 后即 mark，无取消窗口）。 */
  markReminderDelivered(windowId: string, reminder: TaskWallBudgetReminder): void;
}

/** 档位边界：已耗时比例 ≥ 阈值即进档。 */
const HALF = 0.5;
const EIGHTY = 0.8;

export function createTaskWallBudget(budgetMs: number, startedAtMs: number, nowMs: () => number = Date.now): TaskWallBudget {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error(`task wall budget must be a positive number of ms, got ${budgetMs}`);
  }
  const delivered = new Map<string, number>(); // windowId -> 最高已投递档
  const elapsed = (nowMs?: number) => Math.max(0, (nowMs ?? nowMs2()) - startedAtMs);
  const nowMs2 = nowMs;
  return {
    budgetMs,
    startedAtMs,
    elapsedMs: elapsed,
    remainingMs: (n?: number) => Math.max(0, budgetMs - elapsed(n)),
    pendingReminder(windowId: string, n?: number): TaskWallBudgetReminder | undefined {
      const fraction = elapsed(n) / budgetMs;
      const index: 0 | 1 | 2 = fraction >= EIGHTY ? 2 : fraction >= HALF ? 1 : 0;
      // 0 号档每窗口重述一次（压缩重写前缀 → 窗口切换 → 重述当前余量，
      // 与 sessionBudget 的窗口语义一致）；1/2 号档全局一次即可——墙钟
      // 不会因压缩回退，跨窗口重复只会刷屏。
      const key = index === 0 ? `w:${windowId}:0` : `g:${index}`;
      if ((delivered.get(key) ?? -1) >= index && index === 0) return undefined;
      if (delivered.has(key)) return undefined;
      return { index, remainingMs: Math.max(0, budgetMs - elapsed(n)) };
    },
    markReminderDelivered(windowId: string, reminder: TaskWallBudgetReminder): void {
      const key = reminder.index === 0 ? `w:${windowId}:0` : `g:${reminder.index}`;
      delivered.set(key, reminder.index);
    },
  };
}

/** 提醒文案——系统提示词配速原则（Task discipline）的引用，不新增政策。 */
export function formatTaskWallBudgetNote(reminder: TaskWallBudgetReminder): string {
  const sec = Math.round(reminder.remainingMs / 1000);
  if (reminder.index === 2) {
    return `Task budget: ${sec}s left (~20%). If no deliverable is in sight, collapse to the shortest verifiable path now.`;
  }
  if (reminder.index === 1) {
    return `Task budget: half gone, ${sec}s left. Check your plan against the remaining time.`;
  }
  return `Task budget: ${sec}s left for this task (wall clock, from session start). The clock tool reports elapsed/remaining.`;
}

/** 启动注入块的正文（持久化 user 消息；消息层事实，非系统提示词）。 */
export function formatTaskContextMessage(budgetMs: number, startedAtMs: number, source: string): string {
  const sec = Math.round(budgetMs / 1000);
  return `<task_context budget_seconds="${sec}" started_at="${new Date(startedAtMs).toISOString()}" source="${source}">
Task budget: ${sec}s total from session start (wall clock). The clock tool reports elapsed/remaining; at each phase boundary check it and pace the work accordingly.
</task_context>`;
}
