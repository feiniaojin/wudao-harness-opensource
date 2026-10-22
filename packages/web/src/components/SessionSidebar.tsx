// M78-buddy §2 — SessionSidebar: the Buddy 模式 left panel (spec §2), since
// T8 墨线 §3 in the ink-line shell: [新对话] the first citizen (28px button
// + IconPlus, hairline edge), the 26px compact search row (a DIV that opens
// the App's existing session picker — the SAME lane the topbar 📋 rides),
// the date-grouped 28px session rows (title + relative time, single line;
// the active row = .on: accent-weak + the 2px inset accent left bar, pure
// CSS), and the footer's ⚙ 设置 entry beside the Buddy 模式 note (ω99-147:
// the footer's model row is retired — the composer's chips own switching).
// The data flow is untouched: rows come from the sessions op
// (the SAME data /resume's picker reads), [+ 新对话] reports upward and App
// routes it through the SAME /clear confirm flow the command uses.
//
// The client is a STRUCTURAL slice (the FileOpsClient pattern): any object
// with sessions() satisfies it, the tests' mocks included — the WudaoClient
// plugs in with zero adapter code. The list loads on mount and re-loads on
// every active-session change (ui-review-r2 I8), sorts mtime-desc
// client-side (defensive — the server order is trusted but re-derived), and
// caps at 50 rows (spec §2).
import { Fragment, useEffect, useRef, useState } from "react";
import type { SessionRow, ScheduleListRow } from "../protocol.js";
import { IconPlus, IconSearch, IconSettings, IconPencil, IconChevronRight, IconChevronDown, IconSpinner } from "./icons.js";
import { Icon } from "./Icon.js";
// ω99-214: #2 — 会话归档：readArchive/toggleArchive（per-viewer
// wudao.archive.v1，213 recap 范式）。归档=视图层收起（活跃列表的过滤器），
// 会话数据原样在盘、恢复零损失、归档/恢复零网络零 op。
import { readArchive, toggleArchive, writeArchive } from "../archive-store.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";
// ω99-215: #2 — 会话未读徽标：readMarks/writeMarks（per-viewer
// wudao.unread.v1）。「N 新」= messages − mark 差值，纯本地算（数据源=
// 既有 sessions 轮询，零网络零 op）；mark 更新只有一个写点=该会话成为
// activeSessionId（打开/切换即清零），渲染路径零 storage 写。
import { MAX_UNREAD_MARKS, readMarks, writeMarks } from "../unread-store.js";

/** The structural slice of WudaoClient this panel consumes. */
export interface SessionsClient {
  sessions(): Promise<readonly SessionRow[]>;
  /** ω99-313 — 定时任务与提醒的读面（行 ⏰ 标记的数据源）。OPTIONAL：缺
   *  席/失败 → 标记隐藏（旧 server 降级 + 测试 mock 零改动——awaitingIds
   *  同款 undefined 先例）。 */
  schedulesList?(): Promise<readonly ScheduleListRow[]>;
}

/** Spec §2: at most 50 rows in the list. */
export const MAX_SESSION_ROWS = 50;

/** Spec §2: the preview truncates at 40 chars (+ the ellipsis). */
export const PREVIEW_CAP = 40;

/* ω99-150: the rename pre-flight bound — the SAME 48 as cli's
   SESSION_NAME_MAX_CHARS (packages/cli/src/commands/rename.ts). Web
   hardcodes the value (the cli package is import-frozen across the package
   seam); the two stay in lockstep via this cross-pointer comment. */
export const SESSION_NAME_MAX_CHARS = 48;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Spec §2: the relative time — 刚刚 / N分钟前 / N小时前 / 昨天 / N天前,
 *  then the plain date once a week out. An unparseable mtime renders ""
 *  (the row keeps its title/preview; the time cell just stays empty). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const ago = now - t;
  if (ago < MINUTE) return "刚刚";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}分钟前`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}小时前`;
  if (ago < 2 * DAY) return "昨天";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The first user message's first line, whitespace-collapsed and trimmed —
 *  the middle tier of both title ladders below (a blank line folds away). */
// ω99-147: 会话可读标题——id8 是不可读的兜底，不是默认。
function firstUserLine(r: SessionRow): string {
  return ((r.firstUser.split("\n")[0] ?? "").replace(/\s+/g, " ")).trim();
}

/** The row's title, three tiers (ω99-147): the session name → the first
 *  user message's first line capped at 16 chars (+…) → the id's first 8
 *  chars (the same id8 shorthand the statusbar and the /resume picker use —
 *  now the double-empty fallback, not the default). */
export function sessionTitle(r: SessionRow): string {
  // ω99-235: #8 — the pet lane's row short-circuits the whole ladder — the
  // badge name 小精灵 replaces the title display (pet.jsonl never carries a
  // name entry; the display layer owns the fixed name). The row's click
  // refuses to resume and toasts instead (the lane is live in the sprite
  // window) — see the onClick branch + .sb-toast below.
  if (r.lane === "pet") return "小精灵";
  const name = (r.name ?? "").trim();
  if (name !== "") return name;
  const line = firstUserLine(r);
  if (line !== "") {
    const chars = Array.from(line);
    return chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : line;
  }
  return r.id.slice(0, 8);
}

/** The row's tooltip: the FULL first line (whitespace-collapsed, capped at
 *  120 chars +…) — the 16-char cap above clips only the visible row text,
 *  the hover carries the sentence the user actually wrote. */
// ω99-147: tooltip 用完整首行（截 120），悬停可读回被截断的部分。
export function sessionTitleTip(r: SessionRow): string {
  const name = (r.name ?? "").trim();
  if (name !== "") return name;
  const line = firstUserLine(r);
  if (line !== "") {
    const chars = Array.from(line);
    return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : line;
  }
  return r.id.slice(0, 8);
}

/** The row's preview: the first user message capped at 40 chars (the
 *  sessions op carries no last-message digest — firstUser is the stand-in,
 *  the same field the resume picker shows). */
export function sessionPreview(r: SessionRow): string {
  const text = r.firstUser.trim();
  if (text === "") return "(新会话)";
  return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}…` : text;
}

/** ω99-215: the unread diff — 「N 新」= the row's CURRENT messages minus
 *  the viewer's mark (the count last SEEN here). A missing mark reads 0
 *  (first sight = already read; the seed effect below establishes the
 *  baseline once, so the count has something to diff against as it
 *  grows). Negative (a session that shrank) clamps to 0 — never a
 *  nonsense badge. */
export function unreadCount(r: SessionRow, marks: Readonly<Record<string, number>>): number {
  const m = marks[r.id];
  if (m === undefined) return 0;
  const d = r.messages - m;
  return d > 0 ? d : 0;
}

/** T8 墨线 §3: the date bucket a row groups under — relativeTime's ladder
 *  collapsed to four steps (今天/昨天/7 天内/更早). An unparseable mtime
 *  lands in 更早 (its relative time renders "", the row keeps its title). */
export function sessionGroup(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  const ago = Number.isNaN(t) ? Infinity : now - t;
  if (ago < DAY) return "今天";
  if (ago < 2 * DAY) return "昨天";
  if (ago < 7 * DAY) return "7 天内";
  return "更早";
}

export function SessionSidebar({ client, activeSessionId, onResume, onNewChat, onOpenSettings, onOpenSearch, onRenameSession, sessionsEpoch, awaitingIds, busySessionIds }: {
  client: SessionsClient;
  /** The live driver session (status.sessionId) — its row highlights. */
  activeSessionId: string | null;
  onResume: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  /** T8 墨线 §3: the compact search row's activation (click or Enter/Space)
   *  — App rides the topbar 📋 button's exact lane (the busy refusal, then
   *  the session picker + its rows load), moved verbatim. */
  onOpenSearch: () => void;
  /* ω99-150: the inline rename lane (OPTIONAL — prop-less mounts render no ✎,
   *  so every existing mount stays byte-identical). App rides the SAME
   *  /rename command the TUI repl speaks via client.submit, then bumps
   *  sessionsEpoch below. */
  onRenameSession?: (id: string, name: string) => void;
  /* ω99-150: the refreshEpoch seam — a change re-runs the load effect (web
   *  carries no rename push event; `onSessionRenamed` is the TUI lane, so
   *  the sidebar refreshes itself). Mount/activeSessionId semantics unchanged. */
  sessionsEpoch?: number;
  /* ω99-251: #3 — 等待授权会话 id 集（App 从既有 recoveryStatus 5s 轮询派
   *  生，零新 op；可选 prop——缺席挂载零徽标，字节同形）。blocked(权限) 会话
   *  行挂「等你授权」徽标：收益向短词、不堆数字；点击该行=既有 resume 通路
   *  （选中后 248 晨间行/admission 自然接管，本弧绝不重复晨间行内容）；证据
   *  落定即随下一轮行消失；老 server（无字段/拒答）零徽标。pet 行永不（渲染
   *  层防御——实况 pet 车道本就不落权限证据）。归档箱行永不（214「收起的就
   *  是不打扰的」家族纪律）。 */
  awaitingIds?: ReadonlySet<string>;
  /* 多 driver 弧 C — 「运行中」徽标集：正被某车道跑着的会话 id（主车道 busy
     的会话 + 每 busy 副车道的会话，App 的 busySessionIdsOf 派生）。行挂 ◐
     旋转标记（IconSpinner+.spin——与主车道各 busy 面同一视觉语）。可选
     prop：undefined=老 server（无 lanes）→ 面隐藏，字节同形；pet 行永不。 */
  busySessionIds?: ReadonlySet<string>;
}): React.JSX.Element {
  /* ω99-243: #3 — 侧栏三态完备：rows 三值（null=首载在途 → 3 行 CSS 骨架，
   * 非「暂无会话」谎言；[]=空态；有值=正常）+ 失败态从裸「加载失败」升为
   * FileTree 同款「加载失败 · 点击重试」行（loadEpoch 自持重取——重取期间
   * 骨架回位，恢复/换会话等既有重取路径零改）。 */
  const [rows, setRows] = useState<readonly SessionRow[] | null>(null);
  /* ω99-313 — 定时标记的 join 集：schedulesList 行里绑定了本会话且仍在
     工作的（未暂停/未熔断）sessionId。undefined = 能力缺席或读取失败 →
     标记整体隐藏（awaitingIds 同款降级语义，绝不阻塞会话列表本身）。 */
  const [schedIds, setSchedIds] = useState<ReadonlySet<string> | undefined>(undefined);
  // ui-review-r1 I5: an empty list alone cannot tell 暂无会话 from a failed
  // load — the flag picks the empty state's wording.
  const [failed, setFailed] = useState(false);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const retry = (): void => {
    setRows(null); // 骨架回位（重取在途的诚实加载态）
    setFailed(false);
    setLoadEpoch((e) => e + 1);
  };
  /* ω99-150: the row being inline-renamed (null = none) + its draft. The
     draft pre-fills with the RAW name (empty stays empty — the three-tier
     title ladder is display-only, never edit seed). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // ω99-309: 重命名输入的组合态——组合期 Enter 是确认候选词（提交=把半截
  // 拼音当会话名落盘），Esc 是取消候选（弃稿=丢掉打到一半的名字）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  /* ω99-214: #2 — 归档 id 集（挂载时从 per-viewer localStorage 重水合，
     归档箱展开态默认收起）。状态自持于侧栏——App/换会话零打扰，重挂载经
     readArchive 复原。 */
  const [archivedIds, setArchivedIds] = useState<readonly string[]>(() => readArchive());
  const [archOpen, setArchOpen] = useState(false);
  /* ω99-215: 未读水位 marks（挂载时从 per-viewer localStorage 重水合）。
     状态自持于侧栏——App/换会话零打扰（214 archivedIds 同款）。 */
  const [marks, setMarks] = useState<Record<string, number>>(() => readMarks());
  /* ω99-235: 小精灵行点击的提示 toast（该行不可 resume——精灵会话在精灵窗口
     活着，租约互斥）。瞬态：一次显示一个窗口期，定时自隐；unmount 清理。 */
  const [petToast, setPetToast] = useState(false);
  const petToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPetToast = (): void => {
    setPetToast(true);
    if (petToastTimer.current !== null) clearTimeout(petToastTimer.current);
    petToastTimer.current = setTimeout(() => setPetToast(false), 2500);
  };

  /* ω99-214: #2 — v1 禁归档活跃会话的推论：resume 拾起一个已归档会话时
     自动回列（不留「正在看却不在列表」的悬空态）。writeArchive 与 setState
     同帧落地，幂等（已在集外则零动作）。 */
  useEffect(() => {
    if (activeSessionId === null || activeSessionId === "" || !archivedIds.includes(activeSessionId)) return;
    const next = archivedIds.filter((id) => id !== activeSessionId);
    writeArchive(next);
    setArchivedIds(next);
  }, [activeSessionId, archivedIds]);

  // Load on mount AND whenever the active session changes (ui-review-r2
  // I8): the old load-once-on-mount went stale after 新对话/resume — the
  // new session's row never appeared and the active highlight stuck on the
  // previous row until a mode flip remounted the panel. A failure keeps the
  // empty list — the panel stays usable as the [+ 新对话] / 设置 surface;
  // the next change (a mode-flip remount, or the ω99-243 retry row) re-fetches.
  useEffect(() => {
    let cancelled = false;
    client
      .sessions()
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          setFailed(false);
        }
      })
      .catch(() => {
        /* the list settles empty (a null would hold the skeleton forever);
           the flag carries the why — a refresh failure keeps the last-known
           rows standing and only flips the flag off once a load lands. */
        if (!cancelled) {
          setFailed(true);
          setRows((prev) => prev ?? []);
        }
      });
    return () => {
      cancelled = true;
    };
    /* ω99-150: sessionsEpoch joins the deps — App bumps it after a /rename
       lands, so the list re-reads the store's new name (refreshEpoch 范式).
       ω99-243: loadEpoch joins too — the failed row's retry bumps it. */
  }, [client, activeSessionId, sessionsEpoch, loadEpoch]);

  // ui-review-r3 P1: the relative times are render-time reads of Date.now()
  // — without a tick, "刚刚" sat frozen until some unrelated state change.
  // One 60s interval (the ladder's coarsest step) re-renders the list;
  // cleared on unmount. The tick VALUE is never read — only its change.
  const [, setTimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval((): void => {
      setTimeTick((t) => t + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  /* ω99-313 — the ⏰ markers' data lane: reads schedulesList beside the
     sessions fetch (same refresh cadence, so a schedule the model adds shows
     its marker at the list's next refresh). Absent capability or a failed
     read → undefined → the markers hide; the sessions list itself is never
     gated on this op. */
  useEffect(() => {
    if (client.schedulesList === undefined) return;
    let cancelled = false;
    client
      .schedulesList()
      .then((r) => {
        if (!cancelled) {
          setSchedIds(new Set(r.filter((s) => s.sessionId !== undefined && s.enabled && !s.paused).map((s) => s.sessionId as string)));
        }
      })
      .catch(() => {
        if (!cancelled) setSchedIds(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [client, activeSessionId, sessionsEpoch, loadEpoch]);
  // ω99-235: the pet toast's auto-hide timer dies with the panel.
  useEffect(() => () => {
    if (petToastTimer.current !== null) clearTimeout(petToastTimer.current);
  }, []);

  const sorted = [...(rows ?? [])].sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));

  /* ω99-214: #2 — 归档只是活跃列表的过滤器：先滤后取 50（归档腾出的位置
     由更早会话自然回补，活跃列表常净），归档行改在底部折叠组渲染；时间
     分组 ladder 零改。零归档时与旧序列化 byte 等价。 */
  const archSet = new Set(archivedIds);
  const active = sorted.filter((r) => !archSet.has(r.id)).slice(0, MAX_SESSION_ROWS);
  const archivedRows = sorted.filter((r) => archSet.has(r.id));

  /* ω99-215: marks 的写点合一（渲染路径零写，单次 setMarks 单次落盘）：
     ① markSeen 语义——activeSessionId 的会话追平到**当时的** messages
     （打开/切换即清零，正在看的没有「未读」；rows 刷新时再追平一次 =
     仍在看，防「看完切走又冒徽标」的幻影）；
     ② seedMark 语义——可见活跃行首见播种 mark=当前 messages（差值从此
     有基线可比；升级当天不全员满徽标）。播种守 30 封顶内：超出的行不建
     基线、维持首见即已读（防「播种→剪枝→再播种」写循环）。归档行不播
     （徽标本就不显；恢复时首见再播）。 */
  useEffect(() => {
    const next: Record<string, number> = { ...marks };
    let changed = false;
    const act =
      activeSessionId !== null && activeSessionId !== ""
        ? (rows ?? []).find((r) => r.id === activeSessionId)
        : undefined;
    if (act !== undefined && next[act.id] !== act.messages) {
      delete next[act.id]; // 重插挪尾 = 最近触碰（剪枝序，markSeen 同款）
      next[act.id] = act.messages;
      changed = true;
    }
    for (const r of active) {
      if (Object.keys(next).length >= MAX_UNREAD_MARKS) break;
      if (next[r.id] === undefined) {
        next[r.id] = r.messages;
        changed = true;
      }
    }
    if (!changed) return;
    setMarks(writeMarks(next)); // 落盘（含封顶剪枝）+ 镜像剪枝后状态
    // deps：active 由 rows×archivedIds 纯派生（其变必缘于二者之一）。
  }, [rows, archivedIds, activeSessionId, marks]);

  // T8 墨线 §3: the date-grouped view — the mtime-desc order keeps the
  // buckets contiguous, so a group only starts when the label CHANGES (a
  // stray unparseable mtime sorts to the tail and folds into 更早).
  const groups: { label: string; rows: SessionRow[] }[] = [];
  for (const r of active) {
    const label = sessionGroup(r.mtime);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  return (
    <div className="sb">
      {/* 墨线 §3: 「新对话」 the first citizen — 28px + IconPlus + hairline.
          ω99-276: #4 — the callback is the SAME onNewChat App now routes
          DIRECTLY (no confirm): /clear rotates the driver session id → the
          view switches to the fresh empty chat, and this very list keeps the
          old session for one-click switch-back. */}
      <button type="button" className="sb-new" onClick={onNewChat}>
        <IconPlus size={13} />
        <span>新对话</span>
      </button>
      {/* The 26px compact search row — a quiet text-3 affordance that hands
          off to the App's session picker (the 📋 lane); a DIV per the shell
          contract, keyboard-activable for the focus-ring law. */}
      <div
        className="sb-search"
        role="button"
        tabIndex={0}
        onClick={onOpenSearch}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenSearch();
          }
        }}
      >
        <IconSearch size={12} />
        <span>搜索会话…</span>
      </div>
      <div className="sb-list" role="list">
        {/* ω99-243 S1: 首载在途 = 3 行 CSS 骨架（role=status 让读屏知道
            在等；骨架行自身 aria-hidden）。不是「暂无会话」的谎言。 */}
        {rows === null ? (
          <div className="sb-skels" role="status">
            <span className="sr-only">正在加载会话列表…</span>
            <div className="sb-skeleton" aria-hidden={true} />
            <div className="sb-skeleton" aria-hidden={true} />
            <div className="sb-skeleton" aria-hidden={true} />
          </div>
        ) : groups.length === 0 ? (
          /* ui-review-r1 I5: 0 sessions gets a centered empty state — the
             tree-empty idiom — instead of a blank column. ω99-243 S2: a
             FAILED load is no longer a bare wording — the FileTree retry
             idiom rides the same lane (Enter/Space too; the epoch re-fetch
             puts the skeleton back while the retry is on the wire). */
          failed ? (
            <div
              className="tree-err"
              role="button"
              tabIndex={0}
              onClick={retry}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  retry();
                }
              }}
            >
              加载失败 · 点击重试
            </div>
          ) : (
            <div className="tree-empty" role="status">暂无会话</div>
          )
        ) : (
          groups.map((g) => (
            <Fragment key={g.label}>
              <div className="sb-g" role="presentation">{g.label}</div>
              {g.rows.map((r) => {
                /* ω99-297 (I4): 行激活统一入口 —— 行容器 onClick 与 .sb-main
                   的 Enter/Space 共用一份逻辑（提取自按钮时代的行 onClick
                   内联体，行为逐字节等价）。 */
                const activateRow = (): void => {
                  // ω99-235: the pet row never resumes — the sprite's
                  // session is LIVE in the sprite window (the lane lease
                  // refuses adoption); the honest affordance is a toast.
                  if (r.lane === "pet") {
                    showPetToast();
                    return;
                  }
                  onResume(r.id);
                };
                return (
                /* ω99-150: the editing row swaps the button for a DIV — an
                   input cannot nest inside a button (interactive-in-
                   interactive), and in edit mode the row shows ONLY the
                   editor (✎/时间让位); Enter 提交 / Esc / blur / 空串 = 弃，
                   over-48 Enter stays put (前置省一趟，driver 同值会拒). */
                editingId === r.id ? (
                  <div
                    key={r.id}
                    role="listitem"
                    className={`sb-i${r.id === activeSessionId ? " on" : ""}`}
                  >
                    <input
                      className="sb-rename-in"
                      aria-label="重命名会话"
                      placeholder="会话名"
                      autoFocus
                      value={renameDraft}
                      title={
                        Array.from(renameDraft).length > SESSION_NAME_MAX_CHARS
                          ? `最多 ${SESSION_NAME_MAX_CHARS} 字`
                          : undefined
                      }
                      style={
                        Array.from(renameDraft).length > SESSION_NAME_MAX_CHARS
                          ? { borderColor: "var(--warn)" }
                          : undefined
                      }
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => {
                        setEditingId(null); // blur = 弃（简单语义，无延迟）
                      }}
                      onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
                      onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
                      onKeyDown={(e) => {
                        /* ω99-309: 组合期 IME 拥有键盘（App 搜索输入 ω99-151 同款，
                         * Safari 假 Enter 靠 endedAt 时间窗兜）。 */
                        if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
                        if (e.key === "Enter") {
                          const over = Array.from(renameDraft).length > SESSION_NAME_MAX_CHARS;
                          const name = renameDraft.trim();
                          if (over) return; // 不外呼——超长提示留在行内
                          setEditingId(null);
                          if (name !== "") onRenameSession?.(r.id, name);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div
                    key={r.id}
                    role="listitem"
                    className={`sb-i${r.id === activeSessionId ? " on" : ""}`}
                    title={sessionTitleTip(r)}
                    onClick={activateRow}
                  >
                    {/* ω99-297 (I4): 行内 ✎/归档 升真按钮 —— button 不得嵌
                        button 曾逼出 <span onClick>，键盘/读屏用户永远够不到
                        行内动作。行本体让位：.sb-main 是键盘激活面（role=button
                        + Enter/Space + 全局焦点环）；点击仍冒泡到行容器
                        （onClick 留在 .sb-i 上，行为与按钮时代等价）。 */}
                    <div
                      className="sb-main"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activateRow();
                        }
                      }}
                    >
                      <span className="sb-t">{sessionTitle(r)}</span>
                      {/* 多 driver 弧 C — 「运行中」标记：该会话正被某车道跑
                          着（◐ 旋转，IconSpinner+.spin）。行属性标记（sb-sched
                          家族——静信号，可与等待授权/未读共存）；pet 行永不。 */}
                      {busySessionIds !== undefined && busySessionIds.has(r.id) && r.lane !== "pet" ? (
                        <span className="sb-run" title="任务进行中" role="img" aria-label="任务进行中">
                          <IconSpinner size={12} className="spin" />
                        </span>
                      ) : null}
                      {/* ω99-313 — 定时标记：该会话被定时任务/提醒绑定（活跃
                          绑定才显：暂停/熔断的不算——标记即「它会自己醒」的
                          承诺）。行属性而非状态徽标（等待授权/未读的恰一枚
                          裁定不含它）；pet 行永不（防御性，同 sb-await）。 */}
                      {schedIds !== undefined && schedIds.has(r.id) && r.lane !== "pet" ? (
                        <span className="sb-sched" title="这个会话有定时任务或提醒"><Icon name="clock" size={11} /></span>
                      ) : null}
                      <span className="sb-when">{relativeTime(r.mtime)}</span>
                      {/* ω99-251 — 等待授权徽标（「等你授权」）：行上恰一枚
                          状态徽标——等待压过未读（点回去应答一句，新进展自会看
                          见；248 晨间行压过 242 对账行的同款裁决）。pet 行永不
                          （渲染层防御）；归档箱行无此徽标（.sb-arch-i 分支）。 */}
                      {awaitingIds !== undefined && awaitingIds.has(r.id) && r.lane !== "pet" ? (
                        <span className="sb-await">等你授权</span>
                      ) : null}
                      {/* ω99-215: 未读徽标——标题右侧「N 新」chip（>99 显 99+），
                          差值确切（messages − 上次亲见 mark）。仅非活跃行渲染
                          （正在看的没有未读）；归档箱行永不渲染（收起的就是
                          不打扰的——.sb-arch-i 分支无此 chip）。ω99-251: 等待
                          会话行让位（等待即该行此刻的状态，不与未读堆砌）。 */}
                      {r.id !== activeSessionId && unreadCount(r, marks) > 0 && !(awaitingIds !== undefined && awaitingIds.has(r.id) && r.lane !== "pet") ? (
                        <span className="sb-unread">{unreadCount(r, marks) > 99 ? "99+" : unreadCount(r, marks)} 新</span>
                      ) : null}
                    </div>
                    {/* ω99-150: hover ✎ — the quiet rename affordance (rendered
                        only when the lane is wired; the click never resumes). */}
                    {onRenameSession !== undefined ? (
                      <button
                        type="button"
                        className="sb-rename"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation(); // ✎ 不顺带 resume
                          setEditingId(r.id);
                          setRenameDraft((r.name ?? "").trim());
                        }}
                      >
                        <IconPencil size={12} />
                      </button>
                    ) : null}
                    {/* ω99-214: #2 — hover 归档（quiet，✎ 同款；点击不顺带
                        resume）。活跃会话行无此动作：v1 不许归档自己正在看
                        的会话（避免「归档了自己正在看的会话」的悬空态）。 */}
                    {r.id === activeSessionId ? null : (
                      <button
                        type="button"
                        className="sb-act"
                        title="归档"
                        onClick={(e) => {
                          e.stopPropagation(); // 归档不顺带 resume
                          setArchivedIds(toggleArchive(r.id));
                        }}
                      >
                        归档
                      </button>
                    )}
                  </div>
                ));
              })}
            </Fragment>
          ))
        )}
      </div>
      {/* ω99-235: 小精灵行点击的提示 toast——该行不可 resume（精灵会话在精灵
          窗口活着），提示语即全部回应。瞬态元素：无 pet 行的挂载永不渲染
          （既有 .sb 子元素序钉不受扰）。 */}
      {petToast ? (
        <div className="sb-toast" role="status">精灵会话在精灵窗口继续</div>
      ) : null}
      {/* ω99-214: #2 — 侧栏底部「已归档 N」常驻折叠组（默认收起；计数为
          零时整组不渲染——空归档箱不出占位）。归档永不删数据：展开行同
          sessionTitle/relativeTime 渲染，行点击=恢复，回活跃列表原时间
          分组（分组逻辑零改，归档只是过滤器）。 */}
      {archivedRows.length > 0 ? (
        <div className="sb-arch">
          <button
            type="button"
            className="sb-arch-h"
            aria-expanded={archOpen}
            title={archOpen ? "收起已归档" : "展开已归档"}
            onClick={() => setArchOpen((v) => !v)}
          >
            <span className="sb-arch-caret">{archOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
            <span className="sb-arch-t">已归档 {archivedRows.length}</span>
            <span className="sb-arch-hint">可随时恢复</span>
          </button>
          {archOpen ? (
            <div className="sb-arch-list" role="list">
              {archivedRows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="listitem"
                  className="sb-arch-i"
                  title={`恢复「${sessionTitle(r)}」到会话列表`}
                  onClick={() => {
                    setArchivedIds(toggleArchive(r.id));
                  }}
                >
                  <span className="sb-t">{sessionTitle(r)}</span>
                  <span className="sb-when">{relativeTime(r.mtime)}</span>
                  <span className="sb-act">恢复</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="sb-f">
        {/* ω99-147: the footer's model picker is RETIRED — the user's 双入口
            report (侧栏 footer 与输入框下模型 chips 并存). The footer is now
            [Buddy 模式 note][⚙ 设置]; model switching lives in the composer
            (the picker component itself is untouched — the composer still rides it). */}
        <span className="sb-note">Buddy 模式</span>
        <button
          type="button"
          className="settings-link"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <IconSettings size={13} />
        </button>
      </div>
    </div>
  );
}
