// ω99-215: #1 — 会话未读徽标的 per-viewer 持久层（214 archive-store /
// 213 recap 范式：单版本化 key、try/catch 全包、畸形读作空——UI_LAYOUT_KEY
// 律）。载荷 { marks: Record<string, number> }：sessionId → 上次亲见时的
// messages 计数（「N 新」= 当前列表 messages − mark 的差值，纯本地算，
// 零网络零 op）。**封顶剪枝 30 条**（writeMarks 丢最旧触碰——与 214 归档
// 不设上限的取舍相反、理由对称：归档剪枝会复活会话，未读剪枝只丢水位线，
// 被剪会话次轮首见重播种、无静默错徽标风险）。触碰序 = 对象插序（更新走
// delete+重插挪尾；会话 id 恒 wudao-* 前缀，非整数样键，插序即落盘序）。
const UNREAD_KEY = "wudao.unread.v1";

/** The stored-marks prune bound（剪枝保最近触碰的 30 条）。 */
export const MAX_UNREAD_MARKS = 30;

/** Read the persisted marks; ANY malformed payload (corrupt JSON, wrong
 *  shape, a blocked storage) reads as empty — never a crash. Per-ENTRY
 *  value guard: only finite non-negative numbers survive（214 数组滤除非
 *  串项同款粒度——好条目不陪葬）。 */
export function readMarks(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(UNREAD_KEY);
    if (raw === null) return {};
    const v = JSON.parse(raw) as { marks?: unknown };
    if (
      typeof v !== "object" || v === null ||
      typeof v.marks !== "object" || v.marks === null || Array.isArray(v.marks)
    ) return {};
    const out: Record<string, number> = {};
    for (const [id, n] of Object.entries(v.marks as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the marks (cap-pruned to the most-recently-touched 30) and
 *  return the record AS PERSISTED — the caller mirrors it in state so
 *  memory and disk never drift apart. Best-effort: a blocked storage
 *  never crashes the UI. */
export function writeMarks(marks: Record<string, number>): Record<string, number> {
  const entries = Object.entries(marks);
  const kept: Record<string, number> = {};
  for (const [id, n] of entries.length > MAX_UNREAD_MARKS ? entries.slice(entries.length - MAX_UNREAD_MARKS) : entries) {
    kept[id] = n;
  }
  try {
    window.localStorage.setItem(UNREAD_KEY, JSON.stringify({ marks: kept }));
  } catch {
    /* blocked storage: unread is a view-layer nicety */
  }
  return kept;
}

/** First-sight seeding — set the baseline ONLY when absent (首次得见即
 *  已读，零徽标；升级当天不全员满徽标)。Never overwrites an existing
 *  mark. Persists and returns the record as persisted. */
export function seedMark(id: string, messages: number): Record<string, number> {
  const cur = readMarks();
  if (cur[id] !== undefined) return cur;
  cur[id] = messages;
  return writeMarks(cur);
}

/** Catch the mark up to the messages the viewer is seeing NOW (打开/切换
 *  即清零——「N 新」归零的唯一写点). Absent → seeds; same value → no
 *  write (idempotent, zero disk churn). Touch moves the entry to the
 *  prune-surviving tail. */
export function markSeen(id: string, messages: number): Record<string, number> {
  const cur = readMarks();
  if (cur[id] === messages) return cur;
  delete cur[id];
  cur[id] = messages;
  return writeMarks(cur);
}
