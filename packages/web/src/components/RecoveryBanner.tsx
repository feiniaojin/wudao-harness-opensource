// ω99-242: #9 — 被恢复会话的对账面（R6）：当前会话若有恢复记录，chat 顶渲染
// 「已验证完成 X / 待续 Y」一行。收益文案（用户看得懂夜里发生了什么），不露
// 实现术语（journal/claim/admission 一概不出现）；X/Y 是 recoveryStatus op 的
// 结构化数据数出来的（cli 收据投影 + mission 台账），前端零编造。
// ω99-213 RecapBanner 的挂载先例：chat-top、无 modal、null 载荷=零渲染。
import { useEffect, useState } from "react";
import type { WudaoClient, RecoveryStatusRowWire } from "../protocol.js";

/** The reconciliation line for a session's recovery row (null = none). */
export function recoveryLineOf(row: RecoveryStatusRowWire | undefined): string | null {
  if (row === undefined) return null;
  if (row.verifiedDone === undefined || row.remaining === undefined) return null;
  if (row.verifiedDone <= 0 && row.remaining <= 0) return null;
  return `已验证完成 ${row.verifiedDone} / 待续 ${row.remaining}`;
}

// ω99-251: #1 — 全局发现性派生（面一）：「有会话在等你」不依赖选中。同一
// 份 5s 全量行轮询（242 起 recoveryStatus 本就返回所有会话的行）派生等待
// 会话列表——零新 op、零协议膨胀。入选口径与晨间行同门：state==="blocked"
// 且行带 permissionAsk 证据（服务端镜像规则保证这恰是「非当前会话停在权限
// 问句上」——当前会话的证据走自己的 modal，永不入列，点击该行=既有 resume
// 通路，选中后 248 晨间行/admission 机制自然接管，本弧绝不重复晨间行内容）。
// 证据撤（落定）即出列：纯函数无状态，下一轮轮询的行就是真相。老 server
// 拒答 → 派生输入 undefined → 空列表（安静降级，零徽标零点名零报错）。
/** The sessions waiting on YOU (their permission ask is parked): the ids of
 *  every blocked row that carries ask evidence. Pure over the polled rows. */
export function sessionsAwaitingYou(
  rows: readonly RecoveryStatusRowWire[] | undefined,
): readonly string[] {
  if (rows === undefined) return [];
  return rows
    .filter((r) => r.state === "blocked" && r.permissionAsk !== undefined)
    .map((r) => r.sessionId);
}

// ω99-254: #2 — 等待授权系统通知的文案形（发现性三件套第三面）。同 tick
// 多新进入合并为一通知（N 进文案，绝不连发轰炸——等待会话数可以一夜累积
// 很多，逐条通知即灾难）；body=会话标题（251 标题联表的成果），前几个顿号
// 连缀 ≤3 个、超出「等」；标题缺席不兜 id8——通知 body 的诚实边界是「取不
// 到就省略」（251 点名的 id8 梯子是应用内面的兜底，通知面不重复）。纯函数：
// App 的通知 effect 消费（转移检测在彼处），R2 逐字单测在此。
/** The system notification for one batch of newly-parked awaiting sessions
 *  (same-tick arrivals MERGE into this single shape). */
export interface AwaitingNotifyShape {
  readonly title: string;
  readonly body?: string;
}

/** 单会话 title=⏸ 悟道Harness — 有会话在等你授权（body=该会话标题，取不到省
 *  略）；多会话 title=N 进、body=前几个标题顿号连缀。 */
export function awaitingNotificationOf(
  entrants: readonly { readonly id: string; readonly title: string | undefined }[],
): AwaitingNotifyShape {
  const titles = entrants
    .map((e) => e.title)
    .filter((t): t is string => t !== undefined && t.trim() !== "");
  if (entrants.length <= 1) {
    // 单形（空批次不可达：effect 先行早退；纯函数守 1 形）。
    return titles.length === 1
      ? { title: "⏸ 悟道Harness — 有会话在等你授权", body: titles[0] }
      : { title: "⏸ 悟道Harness — 有会话在等你授权" };
  }
  const head = titles.slice(0, 3).join("、");
  return {
    title: `⏸ 悟道Harness — 有 ${entrants.length} 个会话在等你授权`,
    ...(head === "" ? {} : { body: titles.length > 3 ? `${head} 等` : head }),
  };
}

/** Fetch the current session's recovery row and derive BOTH banner lines (the
 *  242 reconciliation line + the ω99-248 morning waiting line) from ONE
 *  fetch. Refetches on session/epoch change AND on a light 5s poll while
 *  connected — the boot admission can land AFTER the viewer connected (the
 *  coordinator's 2s tick), and the morning receipt must not be missed to a
 *  race. An old server's refusal is a legitimate quiet answer (no banner),
 *  never an error surface.
 *  ω99-251 — the SAME fetch also derives the global awaiting list (the
 *  sidebar badge + the welcome face's source; see sessionsAwaitingYou). The
 *  banner derivations and the poll cadence are untouched — the new value is
 *  a third read of the same rows, nothing more. */
export function useRecoveryBanner(
  client: WudaoClient | null,
  sessionId: string | null | undefined,
  historyEpoch: number,
): { readonly line: string | null; readonly morning: string | null; readonly awaiting: readonly string[] } {
  const [state, setState] = useState<{ line: string | null; morning: string | null; awaiting: readonly string[] }>({ line: null, morning: null, awaiting: [] });
  useEffect(() => {
    if (client === null || sessionId === null || sessionId === undefined) {
      setState({ line: null, morning: null, awaiting: [] });
      return;
    }
    let alive = true;
    const fetchRow = (): void => {
      void client.recoveryStatus()
        .then((rows) => {
          if (!alive) return;
          const row = (rows ?? []).find((r) => r.sessionId === sessionId);
          setState({ line: recoveryLineOf(row), morning: morningLineOf(row), awaiting: sessionsAwaitingYou(rows) });
        })
        .catch(() => {
          if (alive) setState({ line: null, morning: null, awaiting: [] }); // old server / op refused — quiet
        });
    };
    fetchRow();
    const timer = window.setInterval(fetchRow, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [client, sessionId, historyEpoch]);
  return state;
}

/** The one-line reconciliation banner (the morning receipt). */
export function RecoveryBanner({ line }: { line: string }): React.JSX.Element {
  return (
    <div className="recovery-banner" role="status">
      <div className="recovery-title">{line}</div>
    </div>
  );
}

// ω99-248: #7 — 权限挂起的晨间「等你决定」面（面三）：被恢复会话的行若带着
// permissionAsk 证据（持久记录、跨重启成立）→ 渲染晨间状态行——收益向文案，
// 把内部 blocked 态翻译成可行动的晨间提示（应答即续跑）；证据撤（记录落定/
// 行推进）→ 状态行消失（241 横幅语义家族：null 载荷=零渲染）。逐字钉在
// tests/omega99-248-morning-line.test.tsx（R5）。
/** The morning waiting-for-your-decision line (null = none). Only the
 *  BLOCKED row with ask evidence carries it — the settle/recovery states have
 *  no morning line (their face is the reconciliation line / the re-floated
 *  ask's own card). */
export function morningLineOf(row: RecoveryStatusRowWire | undefined): string | null {
  if (row === undefined || row.state !== "blocked") return null;
  const ask = row.permissionAsk;
  if (ask === undefined) return null;
  return `昨夜停在这里等你授权：${ask.question}应答后任务自动继续`;
}

/** The one-line morning banner (the 等你决定 face). */
export function MorningBanner({ line }: { line: string }): React.JSX.Element {
  return (
    <div className="recovery-banner" role="status">
      <div className="recovery-title">{line}</div>
    </div>
  );
}
