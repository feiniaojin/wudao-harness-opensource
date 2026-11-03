// R3 深测弧（永续迭代）——one-shot run 的结算面。
//
// 背景（真 bug，R2/R3 深测实证）：一次性 run 的统计收据（耗时/模型/工具/
// 缓存）此前只打 stdout；TUI/web 走 driver settle 落 run_stats_receipt
// （omega99-217），one-shot 是第二套结算、只打印 → resume/考古/探针监督
// 回路对 one-shot 会话全盲。且 run 中途异常（实证：压缩死亡螺旋断路器
// CompactionThrashError）时 happy-path 收尾全被跳过——已执行工具结果丢失
// （JSONL 留孤儿 tool_use，resume 被修成 UNKNOWN 结局）、收据不落、搜索
// 索引不 flush。
//
// 本模块承载两形结算的公共件（index.ts 的主装配保持薄）：
//   appendRunStatsReceipt  happy 形与 aborted 形同一载荷形状（text 必带；
//                          idleReconnects/cacheDebtTokens additive >0 才带
//                          ——与 driver 侧逐字节同形，读侧
//                          receiptNoticesFromEntries 无差别回放）；
//                          aborted 形带 additive 布尔 aborted:true +
//                          text 尾注异常名（机器章+人读双面）。
//   persistNewMessages     identity 选差（selectMessagesToPersist）+ 会话
//                          追加 + 搜索索引入账——应急结算与 run-complete
//                          尾部同一语义，一处定义。
//
// 纪律：不受 --quiet 门（审计完整性不是日志详略问题——数据层完整原则）；
// 一律 AWAITED（one-shot 此后就是 process exit，fire-and-forget 会跟退出
// 竞速丢条；driver 侧可不 await 是因为宿主进程继续活）；结算失败绝不改写
// 原始异常（调用方 catch 吞掉结算错误、rethrow 原异常）。
import { formatRunStats } from "./driver/agent-driver.js";
import { selectMessagesToPersist } from "./persist.js";
import type { AgentMessage, SessionStore } from "@wudao-org/core";
import type { SessionSearchIndex } from "./session-search.js";

/** 一个 pass 的统计快照（runPass 局部的同名六元组）。 */
export interface OneShotRunStats {
  readonly runStartMs: number;
  readonly llmMs: number | null;
  readonly toolMs: number;
  readonly toolCalls: number;
  readonly idleReconnects: number;
  readonly cacheDebtTokens: number;
}

/** 应急结算的可选异常标注（happy 形缺席）。 */
export interface AbortedMarker {
  /** 中断异常的 name（构造 text 尾注与 aborted:true）。 */
  readonly errName: string;
}

interface ReceiptData {
  readonly text: string;
  readonly aborted?: boolean;
  readonly idleReconnects?: number;
  readonly cacheDebtTokens?: number;
}

/** 落一枚 run_stats_receipt（同一 M35 §2 泛型车道；AWAITED——见模块头）。 */
export async function appendRunStatsReceipt(
  store: Pick<SessionStore, "appendEntry">,
  sessionId: string,
  stats: OneShotRunStats,
  aborted?: AbortedMarker,
): Promise<void> {
  const text = formatRunStats(
    performance.now() - stats.runStartMs,
    stats.llmMs,
    stats.toolMs,
    stats.toolCalls,
    stats.idleReconnects,
    0,
    stats.cacheDebtTokens,
  );
  const data: ReceiptData = {
    text: aborted === undefined ? text : `${text}（异常中断：${aborted.errName}）`,
    ...(aborted !== undefined ? { aborted: true as const } : {}),
    ...(stats.idleReconnects > 0 ? { idleReconnects: stats.idleReconnects } : {}),
    ...(stats.cacheDebtTokens > 0 ? { cacheDebtTokens: stats.cacheDebtTokens } : {}),
  };
  await store.appendEntry(sessionId, { type: "run_stats_receipt", data });
}

/** identity 选差后的新消息追加 + 搜索索引入账（应急结算与 run-complete
 *  尾部同一语义）。返回入账条数（调用方可用于审计）。 */
export async function persistNewMessages(
  deps: {
    readonly store: Pick<SessionStore, "append">;
    readonly sessionId: string;
    readonly searchIndex: Pick<SessionSearchIndex, "indexMessage" | "flush">;
    readonly messages: readonly AgentMessage[];
    readonly history: readonly AgentMessage[];
  },
): Promise<number> {
  const toPersist = selectMessagesToPersist(deps.messages, deps.history);
  for (const m of toPersist) {
    await deps.store.append(deps.sessionId, m);
    deps.searchIndex.indexMessage(deps.sessionId, m);
  }
  await deps.searchIndex.flush().catch(() => {});
  return toPersist.length;
}
