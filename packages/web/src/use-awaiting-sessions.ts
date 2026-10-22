// ω99-251/254 — 全局发现性三件套的 web 车道（自 App.tsx 外提，多 driver 弧
// C 的行数抵扣：行为逐字节等价）：
//   ① 侧栏「等你授权」徽标的 id 集（membership 稳定时 Set 身份稳定，轮询
//      回复不搅渲染）；
//   ② 欢迎面点名要标题——awaiting 非空才联表拉一次 sessions（既有 op），
//      成员变化才重拉；列表缺席/拉取失败的行兜 id8（标题梯子末层同语义）；
//   ③ 系统级通知（等你授权 → macOS 通知中心）：join 落定键等标题联表结束
//      才发射；失败=取不到 body 省略，通知本身不吊死。
// 无等待 = 零 fetch 零渲染（245 健康行同款零噪音门）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { WudaoClient } from "./protocol.js";
import { sessionTitle as sessionTitleLadder } from "./components/SessionSidebar.js";
import { awaitingNotificationOf } from "./components/RecoveryBanner.js";
import { windowUnfocused } from "./components/app-panels.js";
import { tauriNotify } from "./tauri-invoke.js";

export interface AwaitingSessions {
  /** The join rows for the welcome face's 点名行 ({id, title}). */
  readonly names: readonly { readonly id: string; readonly title: string }[];
  /** The badge set for the sidebar rows (identity-stable per membership). */
  readonly set: ReadonlySet<string>;
}

export function useAwaitingSessions(client: WudaoClient, awaitingIds: readonly string[]): AwaitingSessions {
  const awaitingKey = awaitingIds.join(",");
  const [awaitingTitles, setAwaitingTitles] = useState<ReadonlyMap<string, string> | null>(null);
  // ω99-254: #3 — 落定键=标题联表对「当前成员」已结束（成功失败都落）：通
  // 知要带标题进 body，等 join 结束才发射；失败=取不到 body 省略，通知本
  // 身不吊死。awaiting 派生与 251 两面零演进——这个键只有通知 effect 读。
  const [awaitingJoinKey, setAwaitingJoinKey] = useState<string | null>(null);
  useEffect(() => {
    if (awaitingKey === "") return;
    let alive = true;
    void client
      .sessions()
      .then((rows) => {
        if (!alive) return;
        const titles = new Map<string, string>();
        for (const r of rows ?? []) titles.set(r.id, sessionTitleLadder(r));
        setAwaitingTitles(titles);
        setAwaitingJoinKey(awaitingKey);
      })
      .catch(() => {
        /* 标题联表尽力而为：失败即 id8 兜底（安静，零报错面）。 */
        if (alive) setAwaitingJoinKey(awaitingKey); // 254：失败也落定——body 省略，通知照发
      });
    return () => {
      alive = false;
    };
  }, [client, awaitingKey]);
  const names = useMemo(
    () => awaitingIds.map((id) => ({ id, title: awaitingTitles?.get(id) ?? id.slice(0, 8) })),
    [awaitingIds, awaitingTitles],
  );
  const set = useMemo(
    () => new Set(awaitingIds),
    // deps 用 key（成员串）非数组身份：5s 轮询每答新数组但成员不变时 Set 身份
    // 稳定，侧栏行不因轮询重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [awaitingKey],
  );

  // ω99-254 — 系统级通知 effect：转移检测（新进入者 = 当前 awaiting − 已通
  // 知登记 ref Set；登记随离场同步清除——每次 park 事件恰一通知，settle 后
  // 再挂是新事件再通知）。发射等标题联表落定；同 tick 多新进入合并为一通
  // 知。安静门与 M76-ux2 finish 通知同门：仅 hidden 或 visible-unfocused 时
  // 发射，聚焦使用中零通知。tauriNotify 无桥/拒绝 → false 静默吞。
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const registry = notifiedRef.current;
    for (const id of [...registry]) {
      if (!awaitingIds.includes(id)) registry.delete(id); // settle 离场清登记
    }
    const entrants = awaitingIds.filter((id) => !registry.has(id));
    if (entrants.length === 0) return;
    if (awaitingJoinKey !== awaitingKey) return; // 等标题联表落定（成功失败都算）
    for (const id of entrants) registry.add(id); // 消费（含安静门关闭的在场消费）
    if (!(document.hidden || (document.visibilityState === "visible" && windowUnfocused()))) return;
    const note = awaitingNotificationOf(entrants.map((id) => ({ id, title: awaitingTitles?.get(id) })));
    void tauriNotify(note.title, note.body); // false = 静默吞（无闪烁回退，诚实边界）
  }, [awaitingIds, awaitingKey, awaitingJoinKey, awaitingTitles]);

  return { names, set };
}
