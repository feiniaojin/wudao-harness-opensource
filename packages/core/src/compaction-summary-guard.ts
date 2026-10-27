// 调研引入弧 A（docs/specs/research-import-2026-10.md，prime-agent 压缩弧）
// —— 压缩质量守卫包的纯函数域，两件：
//
//  A1（prime-agent #3529 形）空/截断摘要拒绝 + 单次短重试。prime 的事故：
//  complete_summary_call 只对 StopReason::Error bail，一个空白但已计费的
//  HTTP 200 回复（glm-ht 失败形）或一个 Length 截断的回复被直接提交为压缩
//  行，不可逆地替换了转录。本守卫是纯判决（verdict）——stop_reason 穷尽匹
//  配，重试与落盘是调用方的事；两次截断才允许落盘（truncated 标记）。
//  接线（summary 调用循环消费 verdict）留给后续弧，本文件先钉语义。
//
//  A4（prime-agent #3753 / 讨论 #3745 形）压缩通知累积泄漏防御。prime 的
//  [python-state] 通知在每次压缩后重追加，而切点不动的压缩保留每一条旧副
//  本——14k globals 时单条 273KB，上下文按每压缩一条的速度膨胀直到溢出恢
//  复失败。reducer 把累积通知封顶在条数与总字节（与 prime 同值：200 条 /
//  4KB），与最新一份内容相同则跳过追加（同文本重述没有信息量）。
//
// 零依赖纯函数模块：不 import compaction 域任何文件（无环），全部确定性，
// 同输入同输出。
import type { AssistantMessage } from "./types.js";

// ---------------------------------------------------------------------------
// A1 — 空/截断摘要守卫（prime #3529 complete_summary_call 的穷尽匹配语义）
// ---------------------------------------------------------------------------

/** A1: 摘要回复的 stop reason，守卫的封闭词表（下方 switch 穷尽匹配）。
 *  由 AssistantMessage 的 OpenAI 词表映射而来（summaryStopReasonOf）：
 *  "stop" 干净收尾；"length" 输出上限截断；"tool_use" 摘要器试图调工具；
 *  "aborted" 用户/协作中止；"error" 供应方侧失败（含内容过滤截断）。 */
export type SummaryStopReason = "stop" | "length" | "tool_use" | "aborted" | "error";

/** A1: 守卫判决。"accept" 可落盘；"bail" 不可用（不落盘，历史不动，调用方
 *  保留上下文完整——prime 的立场：一次失败的压缩好过一个失忆的会话）；
 *  "retry_shorter" 附「更短」指令重试一次（SHORTER_SUMMARY_INSTRUCTION，
 *  重试本身是调用方的事）；"accept_truncated" 重试仍截断，允许落盘但调用方
 *  必须落 SUMMARY_TRUNCATED_MARKER 披露。 */
export type SummaryGuardVerdict =
  | { readonly kind: "accept" }
  | { readonly kind: "bail"; readonly reason: string }
  | { readonly kind: "retry_shorter" }
  | { readonly kind: "accept_truncated" };

/** A1: 重试指令——截断回复的一次重试把它追加到请求上（prime #3529 的
 *  SHORTER_SUMMARY_INSTRUCTION：保全部必填节、压缩细节）。 */
export const SHORTER_SUMMARY_INSTRUCTION =
  "Your previous summary was cut off at the output limit. Write a shorter summary that fits: keep every required section and compress the detail.";

/** A1: 两次截断的摘要落盘时前置的披露行（调用方落的标记，本守卫只判
 *  accept_truncated；prime #3529 的 SUMMARY_TRUNCATED_MARKER）。 */
export const SUMMARY_TRUNCATED_MARKER = "[summary truncated: earlier detail may be missing]";

/** A1: 守卫选项。isRetry=true 表示这次判决的对象是重试尝试——length 不再
 *  重试而是 accept_truncated（「无循环、无计数器、无配置」：一次重试上限
 *  编死在守卫语义里，不做成配置）。 */
export interface SummaryGuardOptions {
  readonly isRetry?: boolean;
}

/** A1: 判决一条摘要回复。纯函数；顺序镜像 prime 的 complete_summary_call：
 *  (1) tool_use/aborted/error 穷尽 bail（点名 stop reason——试图调工具的
 *      「摘要」或被中止的碎片提交为压缩行都会不可逆替换转录）；
 *  (2) 空白文本对每个 stop reason 都 bail（空白但已计费的 HTTP 成功回复
 *      不是可用摘要）——空文本优先于截断判定，空+length 也是 bail 不是重试；
 *  (3) length：首次 → retry_shorter；重试（isRetry）→ accept_truncated；
 *  (4) stop：accept。 */
export function guardSummaryReply(
  text: string,
  stopReason: SummaryStopReason,
  options: SummaryGuardOptions = {},
): SummaryGuardVerdict {
  switch (stopReason) {
    case "tool_use":
    case "aborted":
    case "error":
      return { kind: "bail", reason: `stop_reason=${stopReason}` };
    case "stop":
    case "length":
      break;
    default: {
      // 穷尽护栏：词表扩员而这里没跟上时，编译期即红（never 不再 never），
      // 运行期也拒绝沉默放行（fail-closed，不落默认 accept）。
      const exhaustive: never = stopReason;
      throw new Error(`unhandled summary stop reason: ${String(exhaustive)}`);
    }
  }
  if (text.trim() === "") return { kind: "bail", reason: "empty summary" };
  if (stopReason === "length") {
    return options.isRetry === true ? { kind: "accept_truncated" } : { kind: "retry_shorter" };
  }
  return { kind: "accept" };
}

/** A1: AssistantMessage（OpenAI 词表 + 夜移 001 interrupted 标记）→ 守卫词表
 *  的适配器，后续接线弧的调用方入口。映射：interrupted → aborted（协作中止
 *  交付的前缀）；tool_calls → tool_use；content_filter → error（被过滤截断
 *  的回复不可用）；stopReason 缺席 → stop（脚本模型/不分类的供应方——缺席
 *  是「没分类」不是「分类为失败」）；其余未知词表 fail-closed 按 error
 *  （anthropic 适配器会把未映射的 stop_reason 原样透传，未知值宁可拒绝）。 */
export function summaryStopReasonOf(m: AssistantMessage): SummaryStopReason {
  if (m.interrupted === true) return "aborted";
  switch (m.stopReason) {
    case undefined:
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_use";
    case "error":
    case "content_filter":
      return "error";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// A4 — 压缩通知累积泄漏防御（prime #3753 / 讨论 #3745 形）
// ---------------------------------------------------------------------------

/** A4: 累积通知的条数封顶（prime #3753 的 NOTICE_MAX_LISTED_NAMES 同值）：
 *  通知是提醒不是清单，200 条覆盖普通会话仍有余量。 */
export const COMPACT_NOTICE_MAX_ENTRIES = 200;

/** A4: 累积通知的总字节封顶（prime #3753 的 NOTICE_MAX_LIST_BYTES 同值，
 *  UTF-8 字节）：无封顶的通知链（#3745 的 273KB）能长得比压缩省下的还多，
 *  把会话钉死在上下文溢出循环里。 */
export const COMPACT_NOTICE_MAX_TOTAL_BYTES = 4_096;

/** A4: 通知累积状态—— oldest 在前、newest 在后的通知文本列表。裸数组即
 *  状态：可 JSON 持久化、可从空数组起步、reducer 是它的唯一变更通道。 */
export type CompactNoticeLog = readonly string[];

/** UTF-8 字节数（无 TextEncoder 依赖的确定性计数；代理对计 4 字节且只在高
 *  代理位计一次，孤立代理按 3 字节——与编码器行为一致的纯函数）。 */
function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // 高代理位一次性计入整个代理对
      i += 1; // 跳过低代理位
    } else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else n += 3;
  }
  return n;
}

/** A4: 纯 reducer——一条新压缩通知并入累积状态：
 *  (1) 与最新一份（队尾）内容相同 → 跳过追加（返回原状态引用；同文本重述
 *      没有信息量，prime 的「与最新相同则跳过」）；
 *  (2) 追加后越界（>200 条或 >4KB 总字节）→ 从最旧一侧逐条驱逐直到回到
 *      界内（prime 的最终形：built context 只留最新副本——驱逐永远向着
 *      最新保留）；
 *  (3) 队尾永不驱逐：哪怕单条通知自身超 4KB 也原样保留（prime「第一个
 *      名字永远列出」同精神——单条内容封顶是通知生产方的事，不是累积器
 *      的事；累积器只保证不叠加）。 */
export function compactNoticeReducer(state: CompactNoticeLog, notice: string): CompactNoticeLog {
  const latest = state[state.length - 1];
  if (latest !== undefined && latest === notice) return state;
  const next = [...state, notice];
  let total = state.reduce((n, t) => n + utf8Bytes(t), 0) + utf8Bytes(notice);
  while (next.length > 1 && (next.length > COMPACT_NOTICE_MAX_ENTRIES || total > COMPACT_NOTICE_MAX_TOTAL_BYTES)) {
    const dropped = next.shift();
    if (dropped === undefined) break;
    total -= utf8Bytes(dropped);
  }
  return next;
}
