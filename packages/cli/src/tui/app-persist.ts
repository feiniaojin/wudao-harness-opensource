// 拆分运动弧 C：从 app.tsx 原样外提的持久化回调簇（usePersistCallbacks）——
// M33 append-only JSONL 落账、夜移 017 用户先行持久化、波次8 #45 工具前屏障、
// ω99-38 /clear 旋转镜像。hook 簇原序整体迁移；显式依赖对象。
import { useCallback, useRef } from "react";
import type { AgentMessage, SessionStore } from "@wudao-org/core";
import { repairOrphanedToolCalls } from "@wudao-org/core";
import { appendSessionEntry, buildClearBoundaryEntry, buildCompactBoundaryEntry, buildDeferredLoadedEntry } from "../session-entry.js";
import { selectMessagesToPersist } from "../persist.js";
import type { CacheTrackingModel } from "../cache.js";
import type { SessionAllowlist } from "../permission.js";
import { createMemoryRuntime } from "../memory/index.js";

/** usePersistCallbacks' explicit dependency slice. */
export interface PersistDeps {
  readonly storeRef: { readonly current: SessionStore };
  readonly sessionRef: { current: string };
  readonly loadedRef: { current: AgentMessage[] };
  readonly searchIndexRef: { readonly current: { indexMessage(id: string, m: AgentMessage): unknown; flush(): Promise<void> } };
  readonly memoryRuntime: ReturnType<typeof createMemoryRuntime>;
  readonly notifyRef: { current: (text: string) => void };
  readonly setDeferredLoaded: (f: (n: number) => number) => void;
  readonly setSessionId: (id: string) => void;
  readonly setSessionName: (name: string | undefined) => void;
  readonly allowlistRef: { current: SessionAllowlist };
  readonly trackedModelRef: { current: CacheTrackingModel | null };
}

export function usePersistCallbacks(S: PersistDeps) {
// Persistence is fire-and-forget but never unhandled: a failed write turns
// into a dim notice line (the run itself already succeeded).
const persistFailed = useCallback((e: unknown): void => {
  S.notifyRef.current(`⚠️ 会话保存失败：${e instanceof Error ? e.message : String(e)}`); // ω99-175: #5（漏判面：§五.5 grep 门迫使进场，与 #4 同串同族，report 披露）
}, []);

// Tier-2 compaction marker: append immediately (append-only store stays
// authoritative even if the run dies mid-flight) — mirrors index.ts.
const onCompacted = useCallback((summaryMessage: AgentMessage): void => {
  S.storeRef.current.append(S.sessionRef.current, summaryMessage).catch(persistFailed);
}, [persistFailed]);

// M52 §1: the compact boundary rides the same event as the marker — the
// session records where the kept region began, so a resumed session's next
// compaction continues the chain from the recorded firstKeptEntryId.
// 125 项 1/项 2: windowIndex/worldState ride as the entry's additive fields.
const onCompactBoundary = useCallback((info: {
  readonly firstKeptEntryId: string;
  readonly reason: string;
  readonly tier: 0 | 1 | 2 | 3;
  readonly windowIndex?: number;
  readonly worldState?: import("@wudao-org/core").WorldState;
}): void => {
  appendSessionEntry(S.storeRef.current, S.sessionRef.current, buildCompactBoundaryEntry(info)).catch(persistFailed);
}, [persistFailed]);

// 夜移 017 (#31): the user's own turn persists BEFORE the first model call
// — a crash mid-run must never lose the one un-regenerable message. The
// S.loadedRef reservation is SYNCHRONOUS (a fast model can settle the whole
// run before any append resolves — an async reserve would race the
// run-complete pass into a duplicate line); the append's failure path
// un-reserves so run-complete retries, and the index rides the append's
// success. The session id is captured synchronously (a /clear between the
// append and its resolution must not mis-file the line).
const earlyUserPersistRef = useRef<Promise<void>>(Promise.resolve());
const onUserTurn = useCallback((m: AgentMessage): void => {
  const sid = S.sessionRef.current;
  S.loadedRef.current.push(m);
  earlyUserPersistRef.current = S.storeRef.current.append(sid, m).then(() => {
    // M49 §3: incremental session-search indexing rides the append.
    S.searchIndexRef.current.indexMessage(sid, m);
  }, (e: unknown) => {
    const i = S.loadedRef.current.indexOf(m);
    if (i >= 0) S.loadedRef.current.splice(i, 1);
    persistFailed(e);
  });
}, [persistFailed]);

const onRunComplete = useCallback((messages: readonly AgentMessage[]): void => {
  (async () => {
    // 夜移 017: the store has no internal append serialization — wait for
    // the run's early user append so the user line always lands before the
    // tail in the JSONL.
    await earlyUserPersistRef.current;
    const toPersist = selectMessagesToPersist(messages, S.loadedRef.current);
    // Capture the session ONCE: a /clear between awaits below rotates
    // S.sessionRef, and this run's messages must land in the file they
    // belong to, not the fresh one.
    const sid = S.sessionRef.current;
    for (const m of toPersist) {
      await S.storeRef.current.append(sid, m);
      S.loadedRef.current.push(m);
      // M49 §3: incremental session-search indexing rides the append.
      S.searchIndexRef.current.indexMessage(sid, m);
    }
    await S.searchIndexRef.current.flush();
  })().catch(persistFailed);
  // M49 §1: a run may have written memories — refresh the recall pool so
  // the next run's auto-recall sees them.
  void S.memoryRuntime.refresh().catch(() => {});
}, [persistFailed, S.memoryRuntime]);

// 波次8 #45 (dsh session-checkpoint-policy): the pre-dispatch durability
// barrier — a tool-carrying assistant turn persists BEFORE any tool body
// runs, so a crash mid-tool leaves a durable unmatched tool_use (the input
// repairOrphanedToolCalls answers with the UNKNOWN-outcome text instead of
// blindly re-issuing the write). Same ordering contract as onRunComplete:
// earlyUserPersist first (the user line always heads the JSONL), then the
// ordered prefix; S.loadedRef identity dedup keeps run-complete from
// re-appending, and search indexing rides each append. Unlike
// onRunComplete, the promise is RETURNED (not fire-and-forget) — the loop
// awaits it, and its rejection fails CLOSED: no tool body, the model sees
// PERSIST_FAILED_TOOL_RESULT.
const onBeforeToolDispatch = useCallback((messages: readonly AgentMessage[]): Promise<void> => {
  return (async () => {
    await earlyUserPersistRef.current;
    const toPersist = selectMessagesToPersist(messages, S.loadedRef.current);
    // Capture the session ONCE — same /clear-rotation guard as onRunComplete.
    const sid = S.sessionRef.current;
    for (const m of toPersist) {
      await S.storeRef.current.append(sid, m);
      S.loadedRef.current.push(m);
      // M49 §3: incremental session-search indexing rides the append.
      S.searchIndexRef.current.indexMessage(sid, m);
    }
  })();
}, []);

// M35 §2: the run's one load_tools call applied — append the receipt entry
// (the JSONL is authoritative even if the run dies mid-flight) and bump the
// status-bar count.
const onDeferLoaded = useCallback((names: readonly string[]): void => {
  appendSessionEntry(S.storeRef.current, S.sessionRef.current, buildDeferredLoadedEntry(names)).catch(persistFailed);
  S.setDeferredLoaded((n) => n + 1);
  S.notifyRef.current(`↳ 工具已加载：${names.join(", ")}（一次性工具集变更）`); // ω99-172: #1（f-iii #1-孪生，与 repl:1904 同源）
}, [persistFailed]);

// M53 §1: /switch replaced the conversation with a reloaded chain — the
// persistence base MUST follow (identity-based selection keys on object
// identity, and the reloaded objects are new) or the next run would append
// the whole chain to the JSONL again.
const onHistoryReplaced = useCallback((messages: readonly AgentMessage[]): void => {
  S.loadedRef.current = [...messages];
}, []);

// ω99-38: the ROUTED /clear (performClear submits "/clear") owns the rotation
// — the driver wipes, rotates the id, and fires this seam (M80's full
// surface; the TUI's private id rotation is retired). The TUI MIRRORS the
// protocol event into its own state:
//   · the clear_boundary seal lands on the PRE-clear id's JSONL — the App
//     owns the store (the driver holds no sessionStore here, the web
//     engine's arrangement). Chained after earlyUserPersist so a
//     still-settling user append can never land behind the seal (ω99-32's
//     ONE persistence-layer contract; the reassigned chain also makes the
//     next turn's barrier serialize after the seal).
//   · the React identity follows the fresh segment (the old performClear's
//     local newSessionId()/S.setSessionId rotation, now a follower of the
//     driver's) — the extensions' bindSession, the file-history dir, and
//     the tools' closures all re-derive from the sessionId state.
//   · the cache wrapper resets at the SAME seam (rotate() — see
//     S.trackedModelRef): the first post-clear call names its cold start
//     (ℹ️ session-rotation) instead of misreporting a ⚠️ break.
const onSessionCleared = useCallback((info: { readonly fromSessionId: string; readonly toSessionId: string }): void => {
  earlyUserPersistRef.current = earlyUserPersistRef.current
    .then(() => appendSessionEntry(S.storeRef.current, info.fromSessionId, buildClearBoundaryEntry(info.toSessionId)))
    .catch(persistFailed);
  S.sessionRef.current = info.toSessionId;
  S.setSessionId(info.toSessionId);
  S.setSessionName(undefined);
  // ω99-77 (73 rider): the session allowlist dies with the boundary too —
  // the TUI lane's mirror of the REPL wipe (repl.ts /clear) and the engine
  // seam (session-engine.ts onSessionCleared): `/clear` ⇒ ask 复活 is a
  // three-lane mechanical law. `p` rules live in .wudao/settings.json and
  // are untouched here.
  S.allowlistRef.current.clear();
  S.trackedModelRef.current?.rotate();
}, [persistFailed]);
  return { onCompacted, onCompactBoundary, onUserTurn, onRunComplete, onBeforeToolDispatch, onDeferLoaded, onHistoryReplaced, onSessionCleared };
}
