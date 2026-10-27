// 133 #9（deepagents 8ea734a80 引进，变体）— 长会话 resume 的渲染水合。
//
// 问题：500 条消息的会话 resume，首屏尾窗其实很快，但把全部行挂进
// WKWebView 的成本随行数线性涨——全是用户看不见的历史行（deepagents 实测
// 后台暖 800 行烧 57s CPU；我们的 rows.map 全量挂载同型）。
//
// 机制（deepagents 形 + wudao 变体）：
//   1. 尾窗起步——只挂最后 HISTORY_TAIL_WINDOW 个渲染单元（HistoryList 的
//      单元是分组后的 row：一组折叠工具算一行；SimpleMode 的单元是 entry）。
//   2. 顶部哨兵 + IntersectionObserver——用户向上滚到窗顶，哨兵进入视口
//      → 补一个 CHUNK。自调节停机：哨兵被新补的行推出视口即停（=
//      deepagents 的"可滚动即停止填充"事件驱动形）；不满一屏时哨兵常可见
//      → 自动补到可滚动为止。
//   3. 点击兜底——无 IO 的引擎（或用户不耐烦）点哨兵行手动补水。
//   4. 替换复位——历史替换（resume/清除后 adopted）使 total < visible 时
//      复位尾窗缺省（append-only 语义下 total 只增，收缩=换史）。
//
// M24/性能注记：纯视图层——history 数组永不改写；流中追加自然落进尾窗
// （slice(-effective) 恒显最新）。宠物几何教训的适用面注记：本特性是
// 挂载数行为（JS 层），jsdom 断言行数/哨兵在场即可；无新 CSS 引擎面。
import { useCallback, useEffect, useRef, useState } from "react";

/** 首屏尾窗（渲染单元数）。60 行：折叠分组下覆盖典型一屏的 3-5 倍。 */
export const HISTORY_TAIL_WINDOW = 60;
/** 每次水合补的单元数（哨兵可见/点击一次）。 */
export const HISTORY_HYDRATE_CHUNK = 60;

export interface HistoryTailWindow {
  /** 应挂载的尾部单元数（≤ total）。 */
  readonly visible: number;
  /** 窗口之前的未挂载单元数（0 = 全量已挂，哨兵不再渲染）。 */
  readonly hidden: number;
  /** 顶部哨兵的 ref（消费者在 hidden>0 时渲染哨兵行并挂此 ref）。 */
  readonly sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 手动补水（哨兵 onClick 兜底；与 IO 同一动作）。 */
  readonly hydrate: () => void;
}

export function useHistoryTailWindow(total: number): HistoryTailWindow {
  const [visible, setVisible] = useState(HISTORY_TAIL_WINDOW);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 替换复位：total **收缩** = 换史（resume/清除采纳——append-only 语义下
  // total 只增，收缩只会来自替换）。复位尾窗缺省，避免旧会话水合过的大窗
  // 把新会话全量挂载。注意不能判 `total < visible`：水合越顶（visible 加
  // CHUNK 后超过 total）是正常态，effective 的 min 夹取已处理。
  const prevTotal = useRef(total);
  useEffect(() => {
    if (total < prevTotal.current) setVisible(HISTORY_TAIL_WINDOW);
    prevTotal.current = total;
  }, [total]);

  const hydrate = useCallback(() => {
    setVisible((v) => v + HISTORY_HYDRATE_CHUNK);
  }, []);

  const sentinelMounted = total > visible;
  useEffect(() => {
    if (!sentinelMounted) return;
    const el = sentinelRef.current;
    if (el === null) return;
    if (typeof IntersectionObserver === "undefined") return; // 老引擎：点击兜底仍在
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) hydrate();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [sentinelMounted, hydrate, visible]);

  const effective = Math.min(visible, total);
  return { visible: effective, hidden: total - effective, sentinelRef, hydrate };
}

/** 哨兵行的文案（消费者渲染；数字=还剩多少单元未挂）。 */
export function historyHydrateLabel(hidden: number): string {
  return `（还有 ${hidden} 条更早的消息——向上滚动或点击加载）`;
}
