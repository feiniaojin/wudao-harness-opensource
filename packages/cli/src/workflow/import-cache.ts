// M11 #3（a reference harness amend-resume 导入缓存引进，第一写关闭规则）— 跨 run 结果
// 复用的失效判据。
//
// 问题定义：修订脚本后 resume，前缀的旧结果按编辑点截断——但编辑点之后
// **不依赖编辑处变化的任务**也被丢弃重跑。a reference harness 的教训：曾按"第一个未
// 命中后关全部兄弟"关缓存，50 路扇出丢 6 个命中、5 路丢唯一 1 个——
// "那是拿时钟代替依赖"。正确关门规则是**第一笔写入**（有副作用的实际
// 执行），不是位置/时间/首个未命中。
//
// wudao 形（纯函数，engine 消费）：
//   - 编辑点后，任务按键在**全量**重放清单中查找（非仅光标位）——内容寻
//     址键天然支持随机访问
//   - **关门规则**：首个带工具的实际执行（副作用写入）关闭导入池的非纯
//     项；纯项（toolCalls===0）永远可导入——"只依赖指令与转录前缀，旧
//     世界的答案对新世界同样成立"
//   - **cmd 执行永远关门**（live 副作用，a reference harness 的 world.run live 执行同义）
//   - 已关后仍可导入纯项：a reference harness 明示"缓存已关后仍放行纯 ask"

import type { TaskJournalEntry } from "./journal.js";

/** 导入池的判定输入。 */
export interface ImportPoolState {
  /** 编辑点之后（invalidated=true）。 */
  readonly pastEditPoint: boolean;
  /** 已发生首笔写入（带工具的实际执行 or cmd 执行）。 */
  readonly firstWrite: boolean;
}

/** 从全量重放清单按键查找可导入的条目（纯函数）。 */
export function importableEntry(
  pool: readonly TaskJournalEntry[],
  key: string,
  state: ImportPoolState,
): TaskJournalEntry | undefined {
  if (!state.pastEditPoint) return undefined; // 编辑前走光标重放，不走导入
  const hit = pool.find((e) => e.type === "task-finished" && e.ok && e.key === key);
  if (hit === undefined) return undefined;
  // 关门规则：首写后只放行纯项（toolCalls===0——无副作用，旧世界答案
  // 对新世界同样成立）。T008 β：旧版 journal 可能缺 toolsUsed 字段——
  // undefined 防护（缺字段视为纯项——保守方向：多导入不如少导入危险）。
  if (state.firstWrite && (hit.toolsUsed?.length ?? 0) > 0) return undefined;
  return hit;
}

/** 一次实际执行后的关门判定（纯函数——引擎在结算点调用）。
 *  T008 β：toolsUsed 缺失（旧版 journal）不关门——undefined 无工具可指。 */
export function closesImportPool(toolsUsed: readonly string[] | undefined): boolean {
  return (toolsUsed?.length ?? 0) > 0;
}
