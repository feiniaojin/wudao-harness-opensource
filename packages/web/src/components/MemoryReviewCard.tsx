// ω99-260: #9 — 面四（boot 待审记忆卡）+ 记忆面的共享词表。M49 评审门
// （user-scope NEVER auto-allows → pending）此前只有 TUI 文本/命令行两个表
// 面——桌面用户看不见也点不动（门存在而无门把手）。本组件是决定驱动的第二
// 表面：pending 在场就提醒（键控 = status==="pending" 计数，surfaced 位绝不
// 参与——session-engine boot 已无条件 markSurfaced，surfaced 仍是待决开项）、
// 每条可确认/丢弃（memoryDecide 后重取）、可「稍后」（会话内 state 不持久；
// 下轮 boot 若仍有 pending 会再现——pending=等着你决定的开项，这是诚实语义
// 不是 bug）。数据 = memoryList 读 op 快照（boot 后 defer 一拍取一次，绝不
// 抢 wire 头 ops[0] 位——258 裁定①；components /help 序钉是红线）；老 server
// 缺 op → 整面隐藏（258 零噪音门），绝不白屏。SimpleMode/pet 车道零渲染——
// 只挂 advanced/buddy 共享 chatColumn。
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryEntry, WudaoClient } from "../protocol.js";
import { Icon } from "./Icon.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The kind tokens' user-facing labels（收益词表——kind 是内部 token，桌面
 * 上说人话；未知 token 原样透传，不编造）。 */
export function memoryKindLabel(kind: string): string {
  switch (kind) {
    case "fact":
      return "事实";
    case "preference":
      return "偏好";
    case "skill_note":
      return "技能心得";
    case "harness":
      return "协作心得";
    default:
      return kind;
  }
}

/** The scope tokens' user-facing labels（project=本项目，user=个人）。 */
export function memoryScopeLabel(scope: string): string {
  switch (scope) {
    case "project":
      return "本项目";
    case "user":
      return "个人";
    default:
      return scope;
  }
}

/** created 的相对时间（面板/卡片共用）：刚刚 / N 分钟前 / N 小时前 /
 * N 天前 / 超过 30 天落 YYYY-MM-DD。解析不了就省略（诚实边界）。 */
export function formatMemoryTime(created: string, now: number = Date.now()): string {
  const t = Date.parse(created);
  if (Number.isNaN(t)) return "";
  const ms = now - t;
  if (ms < 60_000) return "刚刚";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return created.slice(0, 10);
}

const preview = (text: string, max = 80): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** ω99-273: #1 — the memoryList reply's wire guard（必填键判型——readSelectionPayload
 * 家族纪律，260 的两个记忆面当年漏了这道门）。回执形状不可信：裸数组回执（测试
 * drain 家族对未知 op 的 ok:[] 兜底应答，或任何降级路径）会让 `r.entries` 取到
 * Array.prototype.entries——一个函数，React 会当 state updater 派发并在
 * this=null 上炸（Cannot convert undefined or null to object，19 套件 97 败的
 * 机制）。坏形 = 老 server 同语义：整面隐藏，绝不白屏。 */
export function readMemoryEntries(r: unknown): readonly MemoryEntry[] | null {
  if (typeof r !== "object" || r === null || !Array.isArray((r as { entries?: unknown }).entries)) return null;
  return (r as { readonly entries: readonly MemoryEntry[] }).entries;
}

/** The boot pending-review card — chat-top, no modal, no interruption.
 * null (no data yet / old server / dismissed / zero pending) = 零渲染。
 * `memorySignature` (the status frame's store-content change signal — see
 * the effect below): a CHANGE while the card is mounted refetches; absent /
 * unchanged = today's fetch-on-open bytes. */
export function MemoryReviewCard({ client, memorySignature }: { readonly client: WudaoClient; readonly memorySignature?: string }): React.JSX.Element | null {
  const [entries, setEntries] = useState<readonly MemoryEntry[] | null>(null);
  // 永续 v6 弧 A（reef C3）：被拦学习输入计数（同一次 memoryList 回执捎带；
  // 卡在场时随行显示「已拦 N 条」——被拦项绝不静默丢）。
  const [blocked, setBlocked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((): void => {
    void client.memoryList()
      .then((r) => { setEntries(readMemoryEntries(r)); setBlocked(typeof r.blocked === "number" && r.blocked > 0 ? r.blocked : 0); }) // 坏形 = 老 server 同语义：整面隐藏
      .catch(() => { setEntries(null); }); // old server / socket gone — hide the face
  }, [client]);

  // The FIRST fetch defers one macrotask: the App's synchronous boot ops
  // (listSlashCommands first among them) own the wire's head — relays and
  // tests key on that order, and a child effect would fire first (the 258
  // BranchBar precedent, 裁定① verbatim).
  const firstFetch = useRef(true);
  useEffect(() => {
    if (firstFetch.current) {
      firstFetch.current = false;
      const t = setTimeout(load, 0);
      return () => { clearTimeout(t); };
    }
    load();
  }, [load]);

  // ω99-268: #4 — the live refetch trigger (the PreferencesTab twin, the App
  // 层 sessionName watcher's armed-ref discipline): the signature CHANGING
  // refetches. The data stays fresh even while dismissed — the render gate
  // (dismissed / pending===0) still hides the face until it remounts.
  const sigSeen = useRef<{ sig: string | undefined; armed: boolean }>({ sig: undefined, armed: false });
  useEffect(() => {
    const seen = sigSeen.current;
    if (!seen.armed) {
      sigSeen.current = { sig: memorySignature, armed: true }; // 首观察只布防
      return;
    }
    if (memorySignature === seen.sig) return; // 值不变/缺场——静默
    sigSeen.current = { sig: memorySignature, armed: true };
    load();
  }, [memorySignature, load]);

  // 键控裁定：status==="pending" 计数——surfaced 位绝不参与（boot 的
  // surfacePendingReview 通常已置位，但决定仍开着；surfaced 是「TUI 一次性
  // 提醒消费过」，不是「已处理」）。
  const pending = entries?.filter((e) => e.status === "pending") ?? [];
  if (entries === null || dismissed || pending.length === 0) return null;

  const decide = (id: string, action: "ok" | "del"): void => {
    setBusyId(id);
    setNote(null);
    void client.memoryDecide(id, action)
      .then(() => load()) // the post-decide refetch flips the card (v1: snapshot, no subscription)
      .catch((e: unknown) => { setNote(`⚠️ 记忆操作失败：${errText(e)}`); })
      .finally(() => setBusyId(null));
  };

  return (
    <div className="memory-review-card" role="status">
      <div className="memory-review-head">
        <span className="memory-review-title"><Icon name="brain" size={13} /> {`有 ${pending.length} 条记忆待你确认`}</span>
        <button type="button" className="wudao action" onClick={() => setDismissed(true)}>
          稍后
        </button>
      </div>
      <div className="hint">模型替你记下的内容，确认后才会参与回忆</div>
      {/* 永续 v6 弧 A：被拦学习输入（凭据值/指令注入形状）——未入库也看得见。 */}
      {blocked > 0 ? <div className="hint mem-blocked" data-blocked-count={blocked}>{`已拦 ${blocked} 条可疑学习输入（未入库——明细在 .wudao/memory-blocked.jsonl）`}</div> : null}
      {pending.map((e) => (
        <div key={e.id} className="mem-row" data-mem-id={e.id}>
          <span className="mem-badge">待审</span>
          <span className="mem-main">
            <span className="mem-kind">{`${memoryKindLabel(e.kind)} · ${memoryScopeLabel(e.scope)}`}</span>
            <span className="mem-content">{preview(e.content)}</span>
          </span>
          <span className="mem-acts">
            <button type="button" className="wudao action" disabled={busyId !== null} onClick={() => decide(e.id, "ok")}>
              确认
            </button>
            <button type="button" className="wudao danger" disabled={busyId !== null} onClick={() => decide(e.id, "del")}>
              丢弃
            </button>
          </span>
        </div>
      ))}
      {note !== null ? <div className="mem-note">{note}</div> : null}
    </div>
  );
}
