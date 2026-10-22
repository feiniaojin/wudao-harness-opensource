// 多 driver 并发弧 C（2026-09-16）——web 端的车道视图层，三件事：
//   ① useLaneView：从单一 UiSnapshot 派生「用户正在看哪条车道」的全部视图
//     量（history / historyEpoch / busy / sessionId / 写 op 的路由 sid）。
//     主车道 = viewLane null（一切字段退回快照主车道位——老 server 的单车
//     道路径字节不变）；副车道按 lanes 快照读；指向已消失的车道（server
//     关掉了它）时派生回主车道——被关车道的视图无处安放。
//   ② useSessionViews：视图状态按 sessionId 分键（localNotes / armed /edit
//     / 岔轮徽标 / echo——recon §G1 钉的最大风险：A 车道的本地回执绝不能
//     落进 B 车道的渲染；分键后车道互串在结构上不可能）。
//   ③ 纯函数族：busySessionIdsOf（侧栏「运行中」徽标集）/ pickLaneRoute
//     （侧栏点击的三路决策）。框架无关，测试直打。
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { DriverStatus, HistoryEntry, UiSnapshot, LaneSnapshot } from "./protocol.js";
import { mintLaneId } from "./protocol-wire.js";
import { appendNotice, type LocalNote } from "./components/app-consts.js";

/** The lane the user is LOOKING at, as one derived value bag. `sid` is the
 *  routing key for write ops (null = the main lane — send no sid); `key` is
 *  the per-session view-state key (sessionId, "" while unknown). */
export interface LaneView {
  /** A lanes-speaking server sent at least one state frame (snap.lanes is
   *  defined). False = old server: every lane face hides, the single-lane
   *  path stands. */
  readonly capable: boolean;
  /** True = the main lane's view (viewLane null OR the pointed lane is gone
   *  from the lanes map). */
  readonly viewingMain: boolean;
  readonly sid: string | null;
  readonly key: string;
  readonly sessionId: string | null;
  /** PER-LANE busy (arc C's core flip): the main view reads the main
   *  DriverStatus; a lane view reads that lane's snapshot. */
  readonly busy: boolean;
  readonly history: readonly HistoryEntry[];
  readonly historyEpoch: number;
}

export function useLaneView(snap: UiSnapshot): {
  readonly view: LaneView;
  readonly viewLane: string | null;
  readonly setViewLane: Dispatch<SetStateAction<string | null>>;
} {
  const [viewLane, setViewLane] = useState<string | null>(null);
  const lanes = snap.lanes;
  const lane: LaneSnapshot | undefined = viewLane !== null && lanes !== undefined ? lanes[viewLane] : undefined;
  const viewingMain = lane === undefined;
  const status = snap.status;
  const view: LaneView = {
    capable: lanes !== undefined,
    viewingMain,
    sid: viewingMain ? null : (viewLane as string),
    key: viewingMain ? (status?.sessionId ?? "") : lane.sessionId,
    sessionId: viewingMain ? (status?.sessionId ?? null) : lane.sessionId,
    busy: viewingMain ? (status?.busy ?? false) : lane.busy,
    history: viewingMain ? snap.history : lane.history,
    historyEpoch: viewingMain ? snap.historyEpoch : lane.historyEpoch,
  };
  return { view, viewLane, setViewLane };
}

// ---------------------------------------------------------------------------
// ② per-session view slots
// ---------------------------------------------------------------------------

/** One session's view-local state (the per-key half of what used to be App's
 *  single flat localNotes / armedEdit / forkBadgeKeys / forkEcho). */
export interface SessionViewSlot {
  readonly notes: readonly LocalNote[];
  readonly armedEdit: { readonly n: number } | null;
  readonly forkBadges: ReadonlySet<string>;
  readonly forkEcho: string | null;
}

const EMPTY_SLOT: SessionViewSlot = { notes: [], armedEdit: null, forkBadges: new Set(), forkEcho: null };

/** View state keyed by sessionId. Every setter is identity-stable (functional
 *  state updates only), so App's notify can capture the bag in a [client]
 *  callback; `slots` re-renders App when any session's slot changes. */
export interface SessionViews {
  readonly slots: Readonly<Record<string, SessionViewSlot>>;
  slot(key: string): SessionViewSlot;
  /** appendNotice into the key's slot (the merge cursor + epoch stamp at the
   *  VIEWED lane's current values — App's notify reads them off the live
   *  snapshot). */
  stampNote(key: string, text: string, after: number, epoch: number): void;
  /** The generation wipe (an epoch bump retired the old view generation). */
  filterNotes(key: string, keep: (n: LocalNote) => boolean): void;
  setArmedEdit(key: string, v: { readonly n: number } | null): void;
  setForkBadges(key: string, v: ReadonlySet<string>): void;
  setForkEcho(key: string, v: string | null): void;
}

export function useSessionViews(): SessionViews {
  const [slots, setSlots] = useState<Readonly<Record<string, SessionViewSlot>>>({});
  const mutate = useCallback((key: string, fn: (s: SessionViewSlot) => SessionViewSlot): void => {
    if (key === "") return; // no session yet — nothing to key against
    setSlots((prev) => ({ ...prev, [key]: fn(prev[key] ?? EMPTY_SLOT) }));
  }, []);
  const slot = useCallback((key: string): SessionViewSlot => slots[key] ?? EMPTY_SLOT, [slots]);
  const stampNote = useCallback(
    (key: string, text: string, after: number, epoch: number): void => {
      mutate(key, (s) => ({ ...s, notes: appendNotice(s.notes, text, after, epoch) }));
    },
    [mutate],
  );
  const filterNotes = useCallback(
    (key: string, keep: (n: LocalNote) => boolean): void => {
      mutate(key, (s) => ({ ...s, notes: s.notes.filter(keep) }));
    },
    [mutate],
  );
  const setArmedEdit = useCallback(
    (key: string, v: { readonly n: number } | null): void => {
      mutate(key, (s) => ({ ...s, armedEdit: v }));
    },
    [mutate],
  );
  const setForkBadges = useCallback(
    (key: string, v: ReadonlySet<string>): void => {
      mutate(key, (s) => ({ ...s, forkBadges: v }));
    },
    [mutate],
  );
  const setForkEcho = useCallback(
    (key: string, v: string | null): void => {
      mutate(key, (s) => ({ ...s, forkEcho: v }));
    },
    [mutate],
  );
  return useMemo(
    () => ({ slots, slot, stampNote, filterNotes, setArmedEdit, setForkBadges, setForkEcho }),
    [slots, slot, stampNote, filterNotes, setArmedEdit, setForkBadges, setForkEcho],
  );
}

// ---------------------------------------------------------------------------
// ③ pure helpers
// ---------------------------------------------------------------------------

/** The sidebar's 「运行中」badge set: every session a lane is currently
 *  running (the main lane's busy session + every busy secondary lane's
 *  session). undefined = capability absent (old server) — the badge face
 *  hides entirely, the single-lane render stays byte-identical. */
export function busySessionIdsOf(
  status: DriverStatus | null,
  lanes: Record<string, LaneSnapshot> | undefined,
): ReadonlySet<string> | undefined {
  if (lanes === undefined) return undefined;
  const out = new Set<string>();
  if (status !== null && status.busy && status.sessionId !== "") out.add(status.sessionId);
  for (const l of Object.values(lanes)) if (l.busy && l.sessionId !== "") out.add(l.sessionId);
  return out;
}

/** The sidebar-row click's three-way decision (arc C: 切会话不再阻塞——
 *  switching is a VIEW move, never a main-lane mutation):
 *   - view-main: the main lane already holds the session → look at the main
 *     lane (no op, no resume).
 *   - view-lane: a secondary lane already holds it → look at that lane (no
 *     op — the lane's history is already in the snapshot).
 *   - open-lane: nobody holds it → adopt into a freshly minted lane id
 *     (`resume {id, sid}` — the server opens the lane; its reset replay
 *     frame carries the same sid and receipts the switch). */
export type LaneRoute =
  | { readonly kind: "view-main" }
  | { readonly kind: "view-lane"; readonly laneId: string }
  | { readonly kind: "open-lane"; readonly laneId: string };

export function pickLaneRoute(
  status: DriverStatus | null,
  lanes: Record<string, LaneSnapshot> | undefined,
  id: string,
): LaneRoute {
  if (id === (status?.sessionId ?? null)) return { kind: "view-main" };
  if (lanes !== undefined) {
    for (const [laneId, l] of Object.entries(lanes)) {
      if (l.sessionId === id) return { kind: "view-lane", laneId };
    }
  }
  return { kind: "open-lane", laneId: mintLaneId() };
}
