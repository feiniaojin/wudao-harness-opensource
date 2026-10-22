// ω99-214: #1 — 会话归档的 per-viewer 持久层（213 wudao.recap.v1 范式：单
// 版本化 key、try/catch 全包、畸形读作空——UI_LAYOUT_KEY 律）。载荷
// { archived: string[] }：已归档会话 id 集。**不设条目上限**——剪枝会静默
// 复活会话（归档箱里的行必须一直在），与 recap 的 20 封顶相反，取舍在案。
// 归档=视图层收起：本层只存 id，绝不触碰会话数据（JSONL 原样在盘，恢复零
// 损失）；读写零网络零 op。
const ARCHIVE_KEY = "wudao.archive.v1";

/** Read the archived-id set; ANY malformed payload (corrupt JSON, wrong
 *  shape, a blocked storage) reads as empty — never a crash. */
export function readArchive(): string[] {
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY);
    if (raw === null) return [];
    const v = JSON.parse(raw) as { archived?: unknown };
    if (typeof v !== "object" || v === null || !Array.isArray(v.archived)) return [];
    return v.archived.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Persist the id set — best-effort (a blocked storage never crashes the UI;
 *  the in-memory set keeps the session working, the next visit re-reads). */
export function writeArchive(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify({ archived: ids }));
  } catch {
    /* blocked storage: archiving stays a view-layer nicety */
  }
}

/** Set membership against the snapshot the caller renders from. */
export function isArchived(ids: readonly string[], id: string): boolean {
  return ids.includes(id);
}

/** Archive an unarchived id / restore an archived one — the UI's two actions
 *  are the same toggle (which side a row renders on disambiguates). Persists
 *  and returns the NEW set. */
export function toggleArchive(id: string): string[] {
  const cur = readArchive();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  writeArchive(next);
  return next;
}
