// @wudao/server — 多 driver 并发弧 B：车道表（lane table）。把「具名槽
// driver（+petDriver?）」泛化为可寻址的会话车道集合：主车道 key="main"
// （opts.driver，一切 op 的缺省目标）、副车道 key=sessionId（构造期
// laneDrivers 或运行时 mountLane 挂载）。pet 车道不入表——它是具名槽
// （petDriver），有自己的 petXxx op 面与状态帧 `pet` 字段，sid 寻址对它
// 不成立（"pet" 是保留字）。
// 本模块是纯装配 + 订阅簿记，不含 WS 语义：帧的发射（send/pushState）仍归
// index.ts，这里只保证「谁挂上来、谁的 emit 推到哪个缝、卸载时退订干净」。
import type { LaneDriverPort } from "./ports.js";

/** The main lane's table key — the default addressing target of every op. */
export const MAIN_LANE_SID = "main";

/** Lane sids that can never be (re)mounted through mountLane: the main lane
 *  IS the named `driver` slot; "pet" is the petDriver slot's fixed session id
 *  (its ops are petSubmit/…, never sid-addressed). */
export const RESERVED_LANE_SIDS: ReadonlySet<string> = new Set([MAIN_LANE_SID, "pet"]);

/** One mounted lane: the driving port (the sid-routed ops + the two relay
 *  channels) plus the bound accessors the frame paths consume. `status` is
 *  re-read at EVERY push — the dual-lane discipline ω99-235 #4 established:
 *  any lane's emit ships every lane's fresh state (no half-frame, no
 *  staleness). */
export interface LaneEntry {
  /** "main" | <sessionId> — the op-routing and history-frame address. */
  readonly sid: string;
  readonly driver: LaneDriverPort;
  readonly status: () => unknown;
  readonly history: () => readonly unknown[];
}

export interface LaneTable {
  /** All mounted lanes keyed by sid — "main" plus every mounted side lane
   *  (insertion order: main first, then construction/runtime mount order). */
  readonly lanes: ReadonlyMap<string, LaneEntry>;
  /** 开：运行时挂载一条副车道。同 sid 同 driver = 幂等无操作；同 sid 换
   *  driver = 原子替换（先退订旧订阅再挂新的，不双推）；保留字/坏形状
   *  throw（fail-closed）。挂载即推一帧状态（lanes 字段增行——客户端据
   *  此感知新车道）。 */
  mountLane(sid: string, driver: LaneDriverPort): void;
  /** 关：卸载一条副车道（退订 + 删表 + 推一帧状态）。返回是否确有关闭
   *  ——未挂的 sid 与 "main" 都答 false（幂等：重复关 = 目标态）。 */
  closeLane(sid: string): boolean;
  /** 状态帧 lanes 字段体：每条副车道的快照重读快照。无副车道 → undefined
   *  （字段整体缺席——旧客户端字节形状）。 */
  statuses(): Record<string, unknown> | undefined;
  /** auth 重放面：每条副车道的历史快照（sid + entries 对，main 永不在内）。 */
  replay(): readonly { readonly sid: string; readonly entries: readonly unknown[] }[];
}

/** 构造期/挂载期的 sid 形状门（fail-closed——与 createUiServer 的 host 校验
 *  同族：任何保留字/坏形状都在开端口之前拒，绝不带病上车）。 */
export function assertMountableLaneSid(sid: string): void {
  if (typeof sid !== "string" || sid.length < 1 || sid.length > 128) {
    throw new Error(`lane sid must be a 1–128 char string, got: ${JSON.stringify(sid)}`);
  }
  if (RESERVED_LANE_SIDS.has(sid)) {
    throw new Error(`lane sid "${sid}" is reserved (main/pet mount through their named slots)`);
  }
}

export function createLaneTable(init: {
  readonly main: LaneDriverPort;
  /** 任何车道的状态变化 → 一帧全表重读合并推送（pushState）。 */
  readonly onStatus: () => void;
  /** 副车道史推送（追加形与 reset 形同缝；sid 由本表标注来源车道）。主车道
   *  的史中继不在此缝——它的帧不带 sid，接线仍在 index.ts（字节不变）。 */
  readonly onSideHistory: (sid: string, entries: readonly unknown[], reset: boolean) => void;
}): LaneTable {
  const lanes = new Map<string, LaneEntry>();
  const unsubs = new Map<string, () => void>();
  const mount = (sid: string, driver: LaneDriverPort, side: boolean): void => {
    const offStatus = driver.subscribe(init.onStatus);
    let offHistory = (): void => {};
    if (side) offHistory = driver.onHistory((entries, reset) => init.onSideHistory(sid, entries, reset));
    unsubs.set(sid, () => {
      offStatus();
      offHistory();
    });
    lanes.set(sid, { sid, driver, status: () => driver.getStatus(), history: () => driver.getHistory() });
    // 挂载/卸载都推一帧：客户端据 lanes 字段的增减感知车道面（开/关在
    // wire 上可观察——不是只有 op 面可测）。
    if (side) init.onStatus();
  };
  // 主车道入表（常驻、不推首帧——auth 后的初始 pushState 已覆盖，构造期
  // 推一帧对尚无客户端的 send() 也只是空操作；语义上保持「挂载即推」只
  // 属于副车道的运行时面）。
  mount(MAIN_LANE_SID, init.main, false);
  return {
    lanes,
    mountLane: (sid, driver) => {
      assertMountableLaneSid(sid);
      const existing = lanes.get(sid);
      if (existing !== undefined) {
        if (existing.driver === driver) return; // 幂等：同 sid 同 driver
        (unsubs.get(sid) ?? ((): void => {}))(); // 换血：先退订旧订阅
      }
      mount(sid, driver, true);
    },
    closeLane: (sid) => {
      if (sid === MAIN_LANE_SID) return false; // 主车道常驻
      if (!lanes.has(sid)) return false; // 幂等：未挂 = 目标态
      (unsubs.get(sid) ?? ((): void => {}))();
      unsubs.delete(sid);
      lanes.delete(sid);
      init.onStatus();
      return true;
    },
    statuses: () => {
      const out: Record<string, unknown> = {};
      let any = false;
      for (const [sid, entry] of lanes) {
        if (sid === MAIN_LANE_SID) continue;
        out[sid] = entry.status();
        any = true;
      }
      return any ? out : undefined;
    },
    replay: () =>
      [...lanes.entries()]
        .filter(([sid]) => sid !== MAIN_LANE_SID)
        .map(([sid, entry]) => ({ sid, entries: entry.history() })),
  };
}
