// 123-2（zcode ReadSessionContext 引进）— read_session：整会话预算化读取。
//
// 问题：跨会话/跨窗口后模型看不到前会话的完整脉络——search_history 只能
// 关键词命中片段；continue_task 交棒、new_context 轮转后正需要「把那个
// 会话读进来」的通道。
//
// 机制（zcode 形，我们的超越点）：
//  · 数据源=historySearchCorpus（121 的同一构造器：user/assistant 轮+
//    compact 边界解析+时间锚——单一事实源，零新解析）；
//  · 预算=字符帽（缺省 24k、钳 [2k,48k]——zcode 同值）；**保尾**（最近的
//    轮与当前任务最相关），头行诚实记省略量（审计完整性律：披露控制，
//    不静默截断）；
//  · 压缩感知：报当前窗口（边界后的轮数）与总轮数——读的是台账不是投影，
//    前面的窗口都在；
//  · 侧链隔离同 search_history（读 <sid>.jsonl 本链）。
//
// 接线：seam `(sessionId) => corpus | undefined`（undefined=会话不存在）；
// session id 过 SESSION_ID_RE 形状门（session-delete 的防穿越先例）。
import { buildTool, SESSION_ID_RE, type Tool } from "@wudao-org/core";
import type { HistorySearchCorpus } from "@wudao-org/core";

/** 缺省/边界（zcode 同值）。 */
export const READ_SESSION_DEFAULT_BUDGET = 24_000;
export const READ_SESSION_MIN_BUDGET = 2_000;
export const READ_SESSION_MAX_BUDGET = 48_000;

/** The seam buildToolSet receives; hosts late-bind the store read. */
export interface SessionReadBox {
  read?: (sessionId: string) => Promise<HistorySearchCorpus | undefined>;
}

/** One rendered turn. */
function turnLine(i: number, e: HistorySearchCorpus["entries"][number]): string {
  const who = e.role === "user" ? "用户" : "助手";
  const at = e.at !== undefined ? ` ${e.at}` : "";
  return `#${String(i + 1)}${at} ${who}: ${e.content}`;
}

/** Pure: the budgeted transcript text. Tail-keeping (最近的轮最相关)；head
 *  行诚实记省略；压缩感知行报窗口。 */
export function readSessionText(corpus: HistorySearchCorpus, budget: number): string {
  const lines = corpus.entries.map((e, i) => turnLine(i, e));
  // 保尾：从尾往头累积，超帽即停。
  let used = 0;
  let keepFrom = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const len = lines[i]!.length + 1;
    if (used + len > budget && keepFrom < lines.length) break;
    used += len;
    keepFrom = i;
  }
  const omitted = keepFrom;
  const windowEntries = corpus.recentFromSeq !== undefined
    ? corpus.entries.filter((e) => e.seq >= corpus.recentFromSeq!).length
    : corpus.entries.length;
  const head: string[] = [];
  if (omitted > 0) head.push(`…前 ${String(omitted)} 轮已省略（共 ${String(lines.length)} 轮，预算 ${String(budget)} 字符内保最近）——需要更早的内容用 search_history 按关键词定位`);
  head.push(`当前未压缩窗口 ${String(windowEntries)} 轮（台账共 ${String(corpus.totalMessages)} 条消息，压缩过的轮也在其原位可读）`);
  return [...head, ...lines.slice(keepFrom)].join("\n");
}

export function createReadSessionTool(box: SessionReadBox): Tool {
  return buildTool({
    name: "read_session",
    description:
      'Read ANOTHER session\'s full conversation transcript within a character budget (default 24000, max 48000) — the tail (most recent turns) is kept, the omitted head is counted honestly. Use it after continue_task handoffs or new_context rotations to recover the prior conversation\'s full flow, or when the user says "接着之前那个会话". Compact-aware: the current un-compacted window and the total message count are both reported; compacted turns remain readable in place. session_id comes from schedule_list, the sidebar, or the task-chain baton.',
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session to read (its id — NOT a path; ids are [A-Za-z0-9_-])" },
        budget_chars: { type: "number", description: `Character budget (default ${String(READ_SESSION_DEFAULT_BUDGET)}, clamped to ${String(READ_SESSION_MIN_BUDGET)}-${String(READ_SESSION_MAX_BUDGET)})` },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      if (box.read === undefined) {
        return { content: "read_session 未接线（本前端没有会话台账读取缝）——UI/守护宿主可用", isError: true };
      }
      const sid = String(args.session_id ?? "");
      if (!SESSION_ID_RE.test(sid)) {
        return { content: "session_id 形状不对（应为 [A-Za-z0-9_-] 的会话 id，不是路径）", isError: true };
      }
      const budget = typeof args.budget_chars === "number" && Number.isFinite(args.budget_chars)
        ? Math.min(READ_SESSION_MAX_BUDGET, Math.max(READ_SESSION_MIN_BUDGET, Math.floor(args.budget_chars)))
        : READ_SESSION_DEFAULT_BUDGET;
      const corpus = await box.read(sid);
      if (corpus === undefined) {
        return { content: `没有会话 ${sid}（工作区台账里找不到这个 id）`, isError: true };
      }
      if (corpus.entries.length === 0) {
        return { content: `会话 ${sid} 没有对话内容（空台账或只有工具/收据行）` };
      }
      return { content: readSessionText(corpus, budget) };
    },
  });
}
