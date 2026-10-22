// ω99-213: #4 — 回来摘要的 viewer 侧触发器。语义：web 会话页从隐藏转可见
// （或带旧缺席记录重载）时，若 ①距本 viewer 上次可见 ≥ 10 分钟 且 ②期间该
// 会话有 ≥ 3 条新消息 → 发 recap op；任一不满足零动作零调用。per-viewer
// lastSeen 落 localStorage（同会话多端互不打扰）；按 (sessionId, mark) 记忆
// 化——servedMark 已服务的缺席不重烧（关闭横幅即记新 baseline）。historyEpoch
// 变化（重连//clear/resume 重放）= mark 索引的是被替换的数组 → 作废该次缺席
// 重播种（IDE tree 水位线先例）。web 对 @wudao/cli 零依赖（既有约定），阈值/
// 计数在 cli session-recap.ts 钉正本、此处手工镜像孪生。
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecapPayload, WudaoClient, HistoryEntry } from "./protocol.js";

const RECAP_KEY = "wudao.recap.v1";
/** Mirrors cli's RECAP_MIN_AWAY_MS / RECAP_MIN_NEW_MESSAGES (receipts pin the
 *  cli originals — the web cannot import them; keep the twins in sync). */
const MIN_AWAY_MS = 10 * 60_000;
const MIN_NEW_MESSAGES = 3;
/** The stored-records prune bound (per-viewer, per-session rows). */
const MAX_SESSIONS = 20;

interface AwayRecord {
  mark: number;
  at: number;
  servedMark?: number;
}

/** Read the persisted away records; ANY malformed payload (corrupt JSON,
 *  wrong shape, a blocked storage) reads as empty — the UI_LAYOUT_KEY law. */
function readRecords(): Record<string, AwayRecord> {
  try {
    const raw = window.localStorage.getItem(RECAP_KEY);
    if (raw === null) return {};
    const v = JSON.parse(raw) as { sessions?: unknown };
    if (typeof v !== "object" || v === null || typeof v.sessions !== "object" || v.sessions === null) return {};
    return v.sessions as Record<string, AwayRecord>;
  } catch {
    return {};
  }
}

function writeRecords(sessions: Record<string, AwayRecord>): void {
  try {
    const ids = Object.keys(sessions);
    if (ids.length > MAX_SESSIONS) {
      // Prune the stalest rows (oldest `at`) — best-effort, never a crash.
      const keep = new Set(ids.sort((a, b) => (sessions[b]?.at ?? 0) - (sessions[a]?.at ?? 0)).slice(0, MAX_SESSIONS));
      for (const id of ids) if (!keep.has(id)) delete sessions[id];
    }
    window.localStorage.setItem(RECAP_KEY, JSON.stringify({ sessions }));
  } catch {
    /* blocked storage: recap is best-effort */
  }
}

function recordFor(sessionId: string): AwayRecord | undefined {
  const rec = readRecords()[sessionId];
  if (rec === undefined || typeof rec !== "object") return undefined;
  if (typeof rec.mark !== "number" || typeof rec.at !== "number") return undefined;
  return rec;
}

function putRecord(sessionId: string, rec: AwayRecord): void {
  const sessions = readRecords();
  sessions[sessionId] = rec;
  writeRecords(sessions);
}

/** Shape guard on the op reply — a malformed/absent payload never renders a
 *  fabricated card (old relays, `ok: []` generics, drift). */
function isRecapPayload(v: unknown): v is RecapPayload {
  if (typeof v !== "object" || v === null) return false;
  const stats = (v as { stats?: unknown }).stats;
  if (typeof stats !== "object" || stats === null) return false;
  const s = stats as Record<string, unknown>;
  return typeof s.turns === "number" && typeof s.toolCalls === "number" && typeof s.filesTouched === "number";
}

export interface UseRecapArgs {
  readonly client: WudaoClient;
  readonly sessionId: string | null;
  /** The WIRE history (snap.history) — index-consistent with the driver's
   *  getHistory. NOT the merged view (local notes would shift the marks). */
  readonly history: readonly HistoryEntry[];
  readonly historyEpoch: number;
}

/** Returns the banner payload (null = no banner) + the dismiss callback
 *  (closing records a fresh baseline — the same absence never re-shows). */
export function useRecap(args: UseRecapArgs): { payload: RecapPayload | null; onDismiss: () => void } {
  const { client, sessionId, history, historyEpoch } = args;
  const [payload, setPayload] = useState<RecapPayload | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  /** The "returned?" evaluation — shared by the mount/session/epoch check and
   *  every visibilitychange-to-visible. */
  const evaluateReturn = useCallback((): void => {
    const sid = sessionRef.current;
    const hist = historyRef.current;
    if (sid === null || sid === "" || hist.length === 0) return;
    const rec = recordFor(sid);
    if (rec === undefined) return; // no away record: nothing to recap.
    if (!Number.isInteger(rec.mark) || rec.mark < 0 || rec.mark > hist.length) {
      putRecord(sid, { mark: hist.length, at: Date.now() }); // stale index — reseed.
      return;
    }
    if (rec.servedMark === rec.mark) return; // this absence already served.
    const newMessages = hist.slice(rec.mark).filter((e) => e.kind === "user" || e.kind === "assistant").length;
    if (Date.now() - rec.at < MIN_AWAY_MS || newMessages < MIN_NEW_MESSAGES) {
      // The viewer is back below either gate — the absence is consumed.
      putRecord(sid, { mark: hist.length, at: Date.now() });
      return;
    }
    // Memoize BEFORE the call: one burn per (sessionId, mark), even if the
    // visible event fires twice or the payload comes back empty.
    putRecord(sid, { ...rec, servedMark: rec.mark });
    client
      .recap(sid, rec.mark, rec.at)
      .then((p) => {
        if (isRecapPayload(p)) setPayload(p);
      })
      .catch(() => {
        /* old server / transport — no card, never a crash */
      });
  }, [client]);

  // The reload-while-away check: once per settled (sessionId, historyEpoch) —
  // a stored away record predating the page load is still a real absence.
  useEffect(() => {
    evaluateReturn();
  }, [sessionId, historyEpoch, evaluateReturn]);

  // The visibility lane: hidden records the baseline; visible evaluates.
  useEffect(() => {
    const onVisibility = (): void => {
      const sid = sessionRef.current;
      if (sid === null || sid === "") return;
      if (document.hidden) {
        putRecord(sid, { mark: historyRef.current.length, at: Date.now() });
      } else {
        evaluateReturn();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [evaluateReturn]);

  const onDismiss = useCallback((): void => {
    setPayload(null);
    const sid = sessionRef.current;
    if (sid !== null && sid !== "") putRecord(sid, { mark: historyRef.current.length, at: Date.now() });
  }, []);

  return { payload, onDismiss };
}
