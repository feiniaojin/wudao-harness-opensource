// 夜移 036 — 会话树级 token 预算（codex codex-rs/core/src/rollout_budget.rs
// 移植）。wudao 已有的两个限额都是局部的：maxRunMs 是 run 级墙钟（一枚
// run 的保险丝），usage 统计是只读观测。本模块给「一棵 agent 树」立一个
// 共享硬顶——根 loop 与所有子 agent 记同一本账（通过 loopOptions 里的同
// 一实例共享），子 agent 扇出无法绕开。
//
// 语义（codex 同款）：
// · 记账单位 = completion×sampling_weight + (prompt−cacheHit)×prefill_weight
//   （缓存命中的输入免费——奖励前缀缓存架构不变量）；或 provider 显式
//   单位（finite ≥ 0，否则 Fatal —— fail-closed，非法值不落账）。
// · 耗尽粘滞：used ≥ limit 即耗尽，且之后每次记账都返回 true（后续回合
//   各烧一次调用再失败——codex 无预检，行为一致）。
// · 提醒：remaining = floor(max(0, limit−used))；reminder_index = 跨越的
//   阈值个数（remaining ≤ threshold 计一次）；index 0 = 每窗口首个请求
//   的全量余量重述（codex adds_weighted_initial_and_threshold_reminders）。
//   按 {thread, window} 去重：同线程同窗口且已投递 index ≥ 当前 → 抑制。
//   标记在投递之后写（投递前取消应重试）。
// · rearm 只清标记不退款（rollback 后重述当前余量）。
// · 窗口 = 压缩边界（loop 以 state.messages 里的 SUMMARY_MARKER 计数），
//   窗口切换后 dedup miss → 摘要之后重述当前余量。
//
// 分叉（wudao 第一刀）：
// · codex 的提醒是持久 developer 消息（历史里累积）；wudao 走 MetaNote
//   投影（M32 范式——纯后缀、前缀缓存安全、永不落盘），每个请求至多
//   携带一条当前余量。预算实例本身是 driver 生命周期（codex 的
//   RolloutBudget 同为内存 OnceLock，不持久化）。
// · codex 的压缩摘要调用也记账（compact_remote_v2 记 token_usage）；
//   wudao 的 summarizeSpan 无 usage 通道，第一刀不记——stage-2。
// · thread 身份：driver 传 "root"，runSubagent 为每个子 agent 换新
//   threadId（同线程去重、跨线程互不抑制）。
// · provider 单位：wudao 的 ModelUsage 无对应字段，作为 recordUsage 的
//   显式参数保留给未来 provider。
import type { ModelUsage } from "./model-client.js";

export interface SessionBudgetConfig {
  /** 会话树共享的加权 token 硬顶；必须为正整数。 */
  readonly limitTokens: number;
  /** 剩余 ≤ 阈值时提高提醒档位；全部为正且 < limitTokens；可空（仅初始重述）。 */
  readonly reminderAtRemainingTokens: readonly number[];
  /** 每输出 token 的记账权重，默认 1；finite ≥ 0。 */
  readonly samplingTokenWeight?: number;
  /** 每非缓存输入 token 的记账权重，默认 1；finite ≥ 0。 */
  readonly prefillTokenWeight?: number;
}

export interface SessionBudgetReminder {
  readonly remainingTokens: number;
  readonly reminderIndex: number;
}

export interface SessionBudget {
  /** 记一笔用量；返回是否（仍然）耗尽。非法 providerUnits 抛错且不落账。 */
  recordUsage(usage: ModelUsage, providerUnits?: number): boolean;
  isExhausted(): boolean;
  /** 到目前为止的加权记账总量（诊断/测试面）。 */
  usedUnits(): number;
  /** 当前提醒；同线程同窗口已投递同档或更高档时返回 undefined。 */
  pendingReminder(threadId: string, windowId: string): SessionBudgetReminder | undefined;
  /** 投递成功后写标记（codex：插入历史之后才标记）。 */
  markReminderDelivered(threadId: string, windowId: string, reminder: SessionBudgetReminder): void;
  /** 清线程的投递标记（rollback 后重述当前余量）；不退款。 */
  rearmReminder(threadId: string): void;
}

interface ThreadDelivery {
  windowId: string;
  reminderIndex: number;
}

const assertFiniteNonNegative = (name: string, v: number): number => {
  if (!Number.isFinite(v) || v < 0) {
    throw new TypeError(`session budget: ${name} must be finite and non-negative (got ${v})`);
  }
  return v;
};

export function createSessionBudget(config: SessionBudgetConfig): SessionBudget {
  if (!Number.isInteger(config.limitTokens) || config.limitTokens <= 0) {
    throw new TypeError(`session budget: limitTokens must be a positive integer (got ${config.limitTokens})`);
  }
  for (const t of config.reminderAtRemainingTokens) {
    if (!Number.isInteger(t) || t <= 0 || t >= config.limitTokens) {
      throw new TypeError(
        `session budget: every reminder threshold must be a positive integer below limitTokens ${config.limitTokens} (got ${t})`,
      );
    }
  }
  const samplingTokenWeight = assertFiniteNonNegative("samplingTokenWeight", config.samplingTokenWeight ?? 1);
  const prefillTokenWeight = assertFiniteNonNegative("prefillTokenWeight", config.prefillTokenWeight ?? 1);
  const limitTokens = config.limitTokens;

  let used = 0;
  const deliveries = new Map<string, ThreadDelivery>();

  const remainingTokens = (): number => Math.max(0, Math.floor(limitTokens - used));
  const reminderIndex = (remaining: number): number => {
    let n = 0;
    for (const threshold of config.reminderAtRemainingTokens) {
      if (remaining <= threshold) n += 1;
    }
    return n;
  };

  return {
    recordUsage(usage: ModelUsage, providerUnits?: number): boolean {
      let units: number;
      if (providerUnits !== undefined) {
        if (!Number.isFinite(providerUnits) || providerUnits < 0) {
          throw new TypeError(
            "session budget: providerUnits must be finite and non-negative — the response is rejected without recording",
          );
        }
        units = providerUnits;
      } else {
        const output = Math.max(0, usage.completionTokens ?? 0);
        const nonCachedInput = Math.max(0, (usage.promptTokens ?? 0) - (usage.cacheHitTokens ?? 0));
        units = output * samplingTokenWeight + nonCachedInput * prefillTokenWeight;
      }
      used += units;
      return used >= limitTokens;
    },
    isExhausted(): boolean {
      return used >= limitTokens;
    },
    usedUnits(): number {
      return used;
    },
    pendingReminder(threadId: string, windowId: string): SessionBudgetReminder | undefined {
      const remaining = remainingTokens();
      const index = reminderIndex(remaining);
      const delivered = deliveries.get(threadId);
      if (delivered !== undefined && delivered.windowId === windowId && delivered.reminderIndex >= index) {
        return undefined;
      }
      return { remainingTokens: remaining, reminderIndex: index };
    },
    markReminderDelivered(threadId: string, windowId: string, reminder: SessionBudgetReminder): void {
      deliveries.set(threadId, { windowId, reminderIndex: reminder.reminderIndex });
    },
    rearmReminder(threadId: string): void {
      deliveries.delete(threadId);
    },
  };
}
