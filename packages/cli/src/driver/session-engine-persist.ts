// ω99 拆分运动 弧 B：session-engine 的持久化 seam 族外提（原 createAgentDriver
// options 体内连续段，闭包体逐字保留——仅两类机械改写：两个可变 let
// （earlyUserPersist/freshBootPending）走单一 persistState holder（单绑定+直写，
// 不双份）；model 的 rotate() 走 getModel()（/provider 重建换实例后仍指向活模型）。
// 其余闭包自由变量收进 ctx 显式线程。
import type { AgentMessage, SessionStore } from "@wudao/core";
import type { AgentDriverOptions, AgentDriver } from "./agent-driver.js";
import type { MutableProviderConfig } from "../commands/model.js";
import type { SessionAllowlist } from "../permission.js";
import type { MissionController } from "../mission.js";
import { selectMessagesToPersist } from "../persist.js";
import { modelStateDivergence } from "../run.js";
import { buildWorkspaceRootEntry } from "../session-list.js";
import { appendSessionEntry, buildDeferredLoadedEntry, buildCompactBoundaryEntry, buildClearBoundaryEntry, buildLoopReflectionEntry } from "../session-entry.js";

/** The persistence seams' shared state — the extracted twin of the engine's
 *  two `let` bindings (ONE holder object; every site reads/writes through it,
 *  never a second binding). */
export interface SessionPersistState {
  earlyUserPersist: Promise<void>;
  freshBootPending: boolean;
}

/** The seams' closure context (verbatim free variables, now explicit). */
export interface SessionPersistCtx {
  readonly store: SessionStore;
  readonly loadedRef: AgentMessage[];
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly liveConfig: MutableProviderConfig;
  readonly allowlist: SessionAllowlist;
  readonly missionBox: { current?: MissionController };
  readonly memoryRuntime: { refresh: () => Promise<void> };
  readonly driverBox: { current: AgentDriver | null };
  readonly persistFailed: (e: unknown) => void;
  /** The engine's live model (the /provider rebuild rebinds it — read through
   *  the getter so a rotation always hits the CURRENT wrapper). */
  readonly getModel: () => { rotate: () => void };
  readonly persistState: SessionPersistState;
}

export function createSessionPersistenceSeams(ctx: SessionPersistCtx): Pick<
  AgentDriverOptions,
  | "onUserTurn"
  | "onBeforeToolDispatch"
  | "onRunComplete"
  | "onCompacted"
  | "onCompactBoundary"
  | "onDeferLoaded"
  | "onLoopReflection"
  | "onHistoryReplaced"
  | "onSessionCleared"
> {
  const { store, loadedRef, workspaceRoot, sessionId, liveConfig, allowlist, missionBox, memoryRuntime, driverBox, persistFailed, getModel, persistState } = ctx;
  return {
    // 夜移 017 (#31): the user's own turn persists BEFORE the first model
    // call — a crash mid-run must never lose the one un-regenerable message.
    // The loadedRef reservation is SYNCHRONOUS (a fast model can settle the
    // whole run before any append resolves — an async reserve would race the
    // run-complete pass into a duplicate line); the append's failure path
    // un-reserves so run-complete retries. The store has no internal append
    // serialization, so run-complete awaits `earlyUserPersist` first — the
    // user line always lands before the run's tail in the JSONL.
    onUserTurn: (m) => {
      loadedRef.push(m);
      const sid = driverBox.current?.getSessionId() ?? sessionId;
      // ω99-211: #2 — the first materializing write: a still-armed fresh boot
      // id lands its deferred bookkeeping (model_change/thinking_level_change
      // for the live config — a fresh session diverges from {} exactly like
      // the old boot write — plus workspace_root) immediately BEFORE the user
      // line. All writes enqueue in THIS tick: the store's one FIFO queue
      // then flushes them back-to-back in issue order, and earlyUserPersist
      // (the user line itself) keeps the 夜移 017 crash-safety contract
      // verbatim — no await gap widens the window for another store instance
      // (the auto-title fork's own writer) to interleave.
      if (persistState.freshBootPending && sid === sessionId) {
        persistState.freshBootPending = false;
        const div = modelStateDivergence(
          { provider: liveConfig.provider, model: liveConfig.model, reasoningEffort: liveConfig.reasoningEffort },
          {},
        );
        if (div.modelChange !== undefined) void store.appendEntry(sid, div.modelChange);
        if (div.effortChange !== undefined) void store.appendEntry(sid, div.effortChange);
        // Fresh arm ⇒ the file has no entries: nothing recorded to re-point,
        // the entry is append-ready without the load-read.
        void store.appendEntry(sid, buildWorkspaceRootEntry(workspaceRoot));
      }
      persistState.earlyUserPersist = store.append(sid, m).catch((e) => {
        const i = loadedRef.indexOf(m);
        if (i >= 0) loadedRef.splice(i, 1);
        persistFailed(e);
      });
    },
    // 波次 8 #45 (dsh session-checkpoint-policy): the pre-dispatch durability
    // barrier — the ORDERED PREFIX (everything selectMessagesToPersist would
    // pick from the messages the loop hands us, i.e. the user turn and each
    // tool-carrying assistant plus any real messages before it) lands on the
    // JSONL BEFORE any tool body runs. A crash mid-tool then leaves a durable
    // unmatched tool_use — repairOrphanedToolCalls answers it with the
    // UNKNOWN-outcome text instead of the side effect vanishing untraceably.
    // earlyUserPersist is awaited first (same discipline as onRunComplete:
    // the user line always lands before the run's tail). Projection markers
    // never persist — selectMessagesToPersist's filters apply unchanged.
    // A rejection fails the batch CLOSED inside the loop (nothing executes).
    onBeforeToolDispatch: async (messages) => {
      await persistState.earlyUserPersist;
      const toPersist = selectMessagesToPersist(messages, loadedRef);
      if (toPersist.length === 0) return;
      const sid = driverBox.current?.getSessionId() ?? sessionId;
      for (const m of toPersist) {
        await store.append(sid, m);
        loadedRef.push(m);
      }
    },
    // Persistence mirrors the TUI: identity-based tail selection against the
    // loaded base; the session follows the driver (the resume op rotates it).
    onRunComplete: (messages) => {
      (async () => {
        await persistState.earlyUserPersist;
        const toPersist = selectMessagesToPersist(messages, loadedRef);
        const sid = driverBox.current?.getSessionId() ?? sessionId;
        for (const m of toPersist) {
          await store.append(sid, m);
          loadedRef.push(m);
        }
      })().catch(persistFailed);
      // M49 §1: refresh the recall pool (the run may have written memories).
      void memoryRuntime.refresh();
    },
    onCompacted: (summaryMessage) => {
      store.append(driverBox.current?.getSessionId() ?? sessionId, summaryMessage).catch(persistFailed);
    },
    // M52 §1: the compact_boundary entry rides the same event as the marker.
    onCompactBoundary: (info) => {
      appendSessionEntry(store, driverBox.current?.getSessionId() ?? sessionId, buildCompactBoundaryEntry(info)).catch(persistFailed);
    },
    onDeferLoaded: (names) => {
      appendSessionEntry(store, driverBox.current?.getSessionId() ?? sessionId, buildDeferredLoadedEntry(names)).catch(persistFailed);
    },
    // ω-4b: the loop-safety reflection fork's adjudication — the audit entry
    // lands on the JSONL (append-only; the directive's durable record, since
    // the note itself is projection-only).
    onLoopReflection: (info) => {
      appendSessionEntry(store, driverBox.current?.getSessionId() ?? sessionId, buildLoopReflectionEntry(info)).catch(persistFailed);
    },
    // M53 §1: /switch swapped the conversation for a reloaded chain — the
    // identity-based persistence base must follow or the next run would
    // re-append the whole chain to the JSONL.
    onHistoryReplaced: (messages) => {
      loadedRef.length = 0;
      loadedRef.push(...messages);
    },
    // M80: the routed /clear rotated the session id — the clear_boundary
    // marker lands on the PRE-clear id's JSONL (append-only; this engine
    // owns the store, so the seam writes it — the driver holds no
    // sessionStore here).
    onSessionCleared: (info) => {
      // ω99-211 — a /clear rotating away from a STILL-UNMATERIALIZED
      // fresh boot id writes no boundary marker: the from-id has no content
      // to boundary-mark (appendEntry would materialize the very empty row
      // the deferral exists to prevent). Any other from-id keeps the M80
      // marker verbatim.
      if (persistState.freshBootPending && info.fromSessionId === sessionId) {
        persistState.freshBootPending = false; // the boot segment is abandoned — nothing will ever materialize it
      } else {
        appendSessionEntry(store, info.fromSessionId, buildClearBoundaryEntry(info.toSessionId)).catch(persistFailed);
      }
      // ω99-73: the routed /clear ends the session allowlist too — the
      // engine's mirror of the REPL wipe (repl.ts /clear). The driver itself
      // holds no allowlist; THIS engine seam is where the web/Slack lanes'
      // `a` receipts live, and they must not outlive the boundary the
      // conversation just crossed (`p` rules live in .wudao/settings.json).
      allowlist.clear();
      // ω99-34: the driver shares the wrapper across the rotation (one
      // instance for the whole engine lifetime — the /provider rebuild is
      // the only replacement seam), so its diff state is pre-clear context
      // exactly like the REPL's: reset it with the SAME rotate() API. Here
      // there is no break renderer (no onBreak on this wrapper), but the
      // reset still matters — the untreated pair armed phantom one-shots
      // and fired a mislabeled "message:user" window-advance receipt for
      // what is really a session rotation.
      getModel().rotate();
      // ω99-36: the rotation is a session boundary — settle a dangling SHELL
      // mission (a non-empty campaign keeps resuming across it). Fire-and-
      // forget: the clear path never blocks on the ledger write.
      void missionBox.current?.settleAtSessionBoundary();
    },
  };
}
