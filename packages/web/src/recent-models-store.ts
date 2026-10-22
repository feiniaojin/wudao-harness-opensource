// ω99-218: #1 — 模型选择器「最近使用」的 per-viewer 持久层（215 unread /
// 214 archive 范式：单版本化 key、try/catch 全包、畸形读作空——UI_LAYOUT_KEY
// 律）。载荷 { recent: {provider, model}[] }：最近使用的 (供应商, 模型) 对，
// **数组存序**（条目序即语义——头 = 最新，非 215 的 Record 插序），封顶 5 条
// （超限丢最旧——覆盖多供应商用户的常用组合即止，不做设置面）。写点在 App
// 的快照 effect（真实切换才 touch，失败 op 不产生快照变化就不记录）；本层
// 零网络零 op 零盘路径。
const RECENT_MODELS_KEY = "wudao.recent-models.v1";

/** The stored-list cap（最近使用封顶——超限丢最旧）。 */
export const MAX_RECENT_MODELS = 5;

/** One recently-used pair — the row's lane identity (选择器行的路由身份是
 *  (provider, model) 对，同家同名/跨家同名各是各的条目)。 */
export type RecentModel = { readonly provider: string; readonly model: string };

/** Read the persisted pairs; ANY malformed payload (corrupt JSON, wrong
 *  shape, a blocked storage) reads as empty — never a crash. Per-ENTRY
 *  guard: only {provider, model} 双非空串 entries survive（214/215 同款
 *  粒度——畸形条目不废整份）。 */
export function readRecent(): RecentModel[] {
  try {
    const raw = window.localStorage.getItem(RECENT_MODELS_KEY);
    if (raw === null) return [];
    const v = JSON.parse(raw) as { recent?: unknown };
    if (typeof v !== "object" || v === null || !Array.isArray(v.recent)) return [];
    const out: RecentModel[] = [];
    for (const e of v.recent) {
      if (typeof e !== "object" || e === null) continue;
      const { provider, model } = e as { provider?: unknown; model?: unknown };
      if (typeof provider !== "string" || provider === "") continue;
      if (typeof model !== "string" || model === "") continue;
      out.push({ provider, model });
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist the pairs (capped, oldest dropped) and return the list AS
 *  PERSISTED — the caller mirrors it in state so memory and disk never
 *  drift apart. Best-effort: a blocked storage never crashes the UI. */
export function writeRecent(list: readonly RecentModel[]): RecentModel[] {
  const kept: RecentModel[] = list.length > MAX_RECENT_MODELS ? list.slice(0, MAX_RECENT_MODELS) : [...list];
  try {
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify({ recent: kept }));
  } catch {
    /* blocked storage: recents stay a view-layer nicety */
  }
  return kept;
}

/** 滤同对 + 头插 + 裁尾（cap 默认 5）——纯函数，可脱离 localStorage 直钉。
 *  重触已有对 = 挪头去旧位，绝不重复；数组序即语义（头 = 最新）。 */
export function touchRecent(
  list: readonly RecentModel[],
  entry: RecentModel,
  cap: number = MAX_RECENT_MODELS,
): RecentModel[] {
  return [
    entry,
    ...list.filter((e) => !(e.provider === entry.provider && e.model === entry.model)),
  ].slice(0, cap);
}
