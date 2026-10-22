// 113-B3（the upstream project #2375 形 + 超越点）— CLI 驱动侧的配额停泊策略件：
// 常量、归因行（M35 §2 泛型车道 receipt）、唤醒注入的编码/解码、用户提示
// 文案。纯函数模块（零 driver 依赖），行为接线在 agent-driver.ts 的错误收尾
// 缝与 cron 注入缝。
//
// M24 纪律：park 归因行只进 session JSONL 的泛型车道（load() 滤泛型，永不进
// state.messages / system prompt / 模型上下文——前缀缓存零影响）；resume 走
// 既有 continueSession 断口续跑（暖前缀重放，普通 resume 语义，无需特化）。
// 停泊时 state.messages 的尾形一字不动（user/tool 尾本来就是 isUnfinishedTail
// 的继续形），不注合成 assistant——唤醒续跑的模型输入尾即停泊点前驱，字节
// 原样。
import type { GenericSessionEntry, SessionEntry } from "@wudao/core";

/** 唤醒余量：resetAt + 30s 才排唤醒（网关重置有抖动；one-shot 在 :00/:30 分
 *  钟还有 ≤90s 的早射抖动——早射命中未重置的账户只会再停一次，有界自愈）。 */
export const QUOTA_PARK_WAKE_MARGIN_MS = 30_000;

/** 同会话累计停泊上限：第 QUOTA_PARK_MAX_PER_SESSION+1 次（第 9 次）放弃，
 *  终态 failed，归因行如实记（防无限停摆循环烧时间）。 */
export const QUOTA_PARK_MAX_PER_SESSION = 8;

/** 重置视界：resetAt 距今超过 24h 视为不可等（多半是解析或账户异常），
 *  当次即放弃。 */
export const QUOTA_PARK_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

/** 唤醒被拒（busy/压缩窗/会话不可读）时的短程重排间隔——唤醒 one-shot 已
 *  自毁，重排一条 +2min 的，唤醒不丢。 */
export const QUOTA_PARK_REARM_MS = 2 * 60_000;

/** 重排上限（每停泊会话）：续跑持续失败到这个次数就停手并如实告知——自动
 *  重试链必须有界。 */
export const QUOTA_PARK_REARM_CAP = 5;

/** The M35 §2 generic-lane receipt's type string (the attribution row). */
export const QUOTA_PARK_ENTRY_TYPE = "quota_park";

/** The receipt payload (the writer's contract — not the store's). resetAt is
 *  ISO (JSONL 稳定形); attempt is the 1-based park ordinal; gaveUp marks the
 *  bounded-give-up row (with reason "cap" | "horizon"). */
export interface QuotaParkEntryData {
  readonly provider: string;
  readonly resetAt: string;
  readonly attempt: number;
  readonly gaveUp?: true;
  readonly reason?: "cap" | "horizon";
}

/** Build one attribution row (append-only; never a message, never model-visible). */
export function quotaParkEntry(data: QuotaParkEntryData): GenericSessionEntry {
  return { type: QUOTA_PARK_ENTRY_TYPE, data };
}

/** Count this session's already-persisted park rows, gave-up ones included
 *  (the cap is CUMULATIVE per session — boot/resume restores the counter
 *  from the JSONL, which IS the durable count). */
export function countQuotaParkEntries(entries: readonly SessionEntry[]): number {
  return entries.filter((e) => (e as GenericSessionEntry).type === QUOTA_PARK_ENTRY_TYPE).length;
}

// ---------------------------------------------------------------------------
// The wake injection — the one-shot's prompt carries a machine marker the
// driver's cron drain seams decode back into "continue THAT session". The
// marker never reaches the model: every drain site routes it to
// continueSession instead of startRun/steer. (The scheduler's fire wrapper
// prefixes "[scheduled task <id>] " — the decode anchors on the marker word,
// not the string head, so the wrapping is irrelevant.)
// ---------------------------------------------------------------------------

/** The marker word + session id (e.g. "quota-wake 1a2b3c…"). */
export const QUOTA_WAKE_MARKER = "quota-wake";

export function quotaWakePrompt(sessionId: string): string {
  return `${QUOTA_WAKE_MARKER} ${sessionId}`;
}

/** Decode a drained cron injection back into the parked session id; undefined
 *  when the injection is an ordinary scheduled prompt. TAIL-ANCHORED on
 *  purpose: the scheduler wraps the prompt as "[scheduled task <id>] <prompt>",
 *  and the marker pair is the whole prompt — so the decode only fires when the
 *  injection ENDS with "quota-wake <id>". A model-authored prompt that merely
 *  MENTIONS the marker mid-sentence stays an ordinary injection (never
 *  hijacked into a resume); the bounded re-arm below is the second guard. */
export function quotaWakeOf(injection: string): string | undefined {
  const m = /(?:^|\s)quota-wake\s+([A-Za-z0-9_-]+)\s*$/.exec(injection);
  return m === null ? undefined : (m[1] as string);
}

// ---------------------------------------------------------------------------
// User-facing copy (中文，含重置时刻；不惊慌不重试——说清"会自动继续"）
// ---------------------------------------------------------------------------

function formatWall(resetAt: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(resetAt.getHours())}:${p(resetAt.getMinutes())}（${resetAt.getMonth() + 1}月${resetAt.getDate()}日）`;
}

/** The park notice: one line, the reset moment, the auto-continue promise. */
export function formatQuotaParkNotice(opts: { readonly provider: string; readonly resetAt: Date; readonly attempt: number }): string {
  return (
    `⏸ 模型配额已用尽（${opts.provider}），将在 ${formatWall(opts.resetAt)} 重置——` +
    `任务已停摆等待，到点自动继续（第 ${opts.attempt}/${QUOTA_PARK_MAX_PER_SESSION} 次停泊）`
  );
}

/** The give-up notice: the bounded stop (cap or horizon), honest about why. */
export function formatQuotaGiveUpNotice(opts: {
  readonly provider: string;
  readonly resetAt: Date;
  readonly attempt: number;
  readonly reason: "cap" | "horizon";
}): string {
  const why = opts.reason === "cap"
    ? `已连续停泊 ${QUOTA_PARK_MAX_PER_SESSION} 次仍未恢复`
    : `重置时刻距今超过 24 小时（${formatWall(opts.resetAt)}）`;
  return `⛔ 放弃等待：${opts.provider} 配额 ${why}——本次任务以失败收尾，可在配额恢复后手动继续`;
}
