// @wudao-org/web — the WS protocol client (M43-B). This file is the web package's
// ONLY knowledge of the server: every type below hand-mirrors a frame or op
// shape documented in packages/server/PROTOCOL.md (WS protocol v1), and
// WudaoClient is a pure consumer of that contract —
//
//   - first-frame auth: the token rides the URL fragment (never a request
//     line); the client's first message after open is {t:"auth", token}
//   - two channels: {t:"state"} full small snapshots (never history) and
//     {t:"history"} append-only batches (reset:true = whole replacement —
//     the post-auth replay, /clear, and a session load)
//   - ops: every {t:"op", id, op} gets exactly one {t:"result", id, …} —
//     correlated here by id
//   - reconnect: an abnormal close retries with backoff; the re-run auth
//     gets a full history replay, which restores the surface (reset:true)
//
// The class doubles as the UI store (subscribe/getSnapshot for
// useSyncExternalStore); snapshots are referentially stable until a change.
import type { SlashCommandInfo } from "./slash.js";
import type { SessionAnatomyResult } from "./protocol-core.js";

// ---------------------------------------------------------------------------
// Mirrored contract types (PROTOCOL.md)
// ---------------------------------------------------------------------------

/** setMode values (the harness's modes; PROTOCOL "setMode"). 0.3.12: the
 *  three-mode redesign (对齐 Claude 模式设计) — workspace(默认,工作区可
 *  读写)/ask(每次执行工具都问)/auto(完全权限); 0.3.14 adds plan(只读探查
 *  — reads and safe read-only commands only, everything else denied). The
 *  retired read-only and the 0.3.11 default/acceptEdits pair are gone, and
 *  the host accepts exactly these four. */
import { mintClientId, WS_OPEN } from "./protocol-wire.js";
import type { LongtermMemoryEntryWire } from "./protocol-wire.js";
export type { LongtermMemoryEntryWire };
// —— 协议类型/纯函数族外提（re-export 门面 + 内部使用导入）——
export type {
  Mode,
  SubmitOutcome,
  LiveBusyTool,
  DetachVerdictWire,
  LiveState,
  SpoofInspection,
  PendingPermission,
  PendingAskUser,
  HistoryChange,
  HistoryEntry,
  DriverStatus,
  LanguageKnob,
  ServerFrame,
  BranchLeaf,
  MemoryEntry,
  MemoryDecideResult,
  MemoryEditResult,
  PetTurnWire,
  ClientOp,
  SessionRow,
  SessionContinueResult,
  ScheduleListRow,
  ScheduleActionResult,
  SessionSearchHit,
  SessionDeleteResult,
  SessionRestoreResult,
  ResumeOutcome,
  ResumeForkOutcome,
  ProviderCard,
  SettingsStatus,
  SaveKeyResult,
  TestConnectionState,
  TestConnectionResult,
  SettingsSetResult,
  SaveProviderResult,
  DeleteProviderResult,
  ListModelsResult,
  RecentWorkspace,
  RecentWorkspacesResult,
  FileTreeEntry,
  FileTreeResult,
  FileReadResult,
  FileWriteResult,
  FileRevertResult,
  SideQuestionResult,
  PanelRootSetResult,
  AgentRootStatusResult,
  AgentRootSwitchResult,
  CtxInfoResult,
  RecapStatsWire,
  RecapPayload,
} from "./protocol-core.js";
export {
  modeLabel,
  cycleMode,
  formatDur,
  isSwitchableModel,
  modelPickCommand,
  languagePickCommand,
  languageDefaultKey,
  providerEffortSavePayload,
} from "./protocol-core.js";
import {
  Mode,
  SubmitOutcome,
  HistoryEntry,
  DriverStatus,
  BranchLeaf,
  MemoryEntry,
  DetachVerdictWire,
  MemoryDecideResult,
  MemoryEditResult,
  PetTurnWire,
  ClientOp,
  SessionRow,
  SessionContinueResult,
  ScheduleListRow,
  ScheduleActionResult,
  SessionSearchHit,
  SessionDeleteResult,
  SessionRestoreResult,
  ResumeOutcome,
  ResumeForkOutcome,
  SettingsStatus,
  SaveKeyResult,
  TestConnectionResult,
  SettingsSetResult,
  SaveProviderResult,
  DeleteProviderResult,
  ListModelsResult,
  RecentWorkspacesResult,
  FileTreeResult,
  FileReadResult,
  FileWriteResult,
  FileRevertResult,
  SideQuestionResult,
  PanelRootSetResult,
  AgentRootStatusResult,
  AgentRootSwitchResult,
  CtxInfoResult,
  RecapPayload,
} from "./protocol-core.js";
export type {
  RecoveryStatusRowWire,
  ImageAttachmentRefWire,
  ImageBlockWire,
  AttachmentSaveResult,
  AttachmentGetResult,
  FileBlockWire,
  FileSaveResult,
  InstalledPluginRowWire,
  PluginListResult,
  McpServerRowWire,
  McpListResult,
  InstallDetailWire,
  MarketplacePluginEntryWire,
  MarketplaceRowWire,
  PluginMarketListResult,
  PluginMarketInfoWire,
  RescanReceiptWire,
  PluginMarketRemoveResult,
  PluginInstallResult,
  PluginSpecInstallResult,
  PluginUninstallResult,
  PluginToggleResult,
  PersonaProtocolId,
  PersonaDefinition,
  PersonaSummary,
  PersonaListResult,
  PersonaGetResult,
  PersonaSaveResult,
  PersonaDeleteResult,
  ImprovementWire,
  ImprovementGateWire,
  ImprovementStatus,
  ImprovementFaceResult,
  WudaoClientOptions,
  WsEventMap,
  WebSocketLike,
  ConnectionState,
  UiSnapshot, LaneStatusWire, LaneSnapshot,
} from "./protocol-wire.js";
export {
  domWebSocket,
  tokenFromLocation,
  shellFromLocation,
  wsUrlFromLocation,
  defaultBackoff,
  MAX_RECONNECT_ATTEMPTS,
  isRetryableMutation, mintLaneId, mergeLaneStatuses, applyLaneHistory,
} from "./protocol-wire.js";
import {
  RecoveryStatusRowWire,
  ImageAttachmentRefWire,
  ImageBlockWire,
  AttachmentSaveResult,
  AttachmentGetResult,
  FileBlockWire,
  FileSaveResult,
  PluginListResult,
  McpListResult,
  PluginMarketListResult,
  PluginMarketInfoWire,
  PluginMarketRemoveResult,
  PluginInstallResult,
  PluginUninstallResult,
  PluginToggleResult,
  PluginSpecInstallResult,
  // 永续 v6 wave2（reef C1）：门控自改进面的回执形状 + 外提归位的
  // WudaoClientOptions（纯移动，protocol-wire.ts 现为唯一定义点）。
  ImprovementFaceResult,
  WudaoClientOptions,
  PersonaDefinition,
  PersonaListResult,
  PersonaGetResult,
  PersonaSaveResult,
  PersonaDeleteResult,
  WebSocketLike,
  domWebSocket,
  UiSnapshot,
  defaultBackoff,
  MAX_RECONNECT_ATTEMPTS,
  isRetryableMutation, LaneStatusWire, mergeLaneStatuses, applyLaneHistory,
} from "./protocol-wire.js";
export class WudaoClient {
  private readonly opts: {
    readonly url: string;
    readonly token: string;
    readonly wsFactory: (url: string) => WebSocketLike;
    readonly reconnect: boolean;
    readonly backoff: (attempt: number) => number;
    readonly maxReconnectAttempts: number;
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
  // 139：探针帧直通订阅（高频通道，独立于快照 notify）。
  private probeListeners = new Set<(event: unknown) => void>();
  // 140：LoopEvent 帧直通订阅（同上，独立于快照 notify）。
  private loopListeners = new Set<(event: unknown, at: number) => void>();
  private ws: WebSocketLike | null = null;
  private nextId = 1;
  /** ω-3a: retryable mutations keep their op payload here, so a drop can
   *  move them to the replay queue without losing the caller's promise. */
  private readonly pendingOps = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; replay?: ClientOp }>();
  /** ω-3a: mutations that were in flight when the socket dropped, in send
   *  order — flushed under their ORIGINAL ids right after the next (re)auth
   *  lands (the server's idempotency vault makes that safe). Rebuilt from
   *  pendingOps on every close, so an op may ride several reconnects. */
  private replayQueue: { readonly id: number; readonly op: ClientOp }[] = [];
  private readonly listeners = new Set<() => void>();
  private snap: UiSnapshot;
  private userClosed = false;
  private reconnectAttempt = 0;
  private timer: unknown = null;
  /** ω-3a: this client instance's vault namespace (see mintClientId). */
  private readonly clientId = mintClientId();
  /** The one queued setMode (latest wins — mode is idempotent state): a
   *  mode click while the socket is CONNECTING/disconnected resolves
   *  optimistically and flushes right after the (re)auth lands. */
  private queuedSetMode: Mode | null = null;

  constructor(opts: WudaoClientOptions) {
    this.opts = {
      ...opts,
      wsFactory: opts.wsFactory ?? domWebSocket,
      reconnect: opts.reconnect ?? true,
      backoff: opts.backoff ?? defaultBackoff,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS,
      setTimeout: opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: opts.clearTimeout ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0])),
    };
    this.snap = { connection: "connecting", reconnectAttempt: 0, lastClose: null, status: null, history: [], historyEpoch: 0 };
  }

  // --- store face (useSyncExternalStore) -----------------------------------

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  readonly getSnapshot = (): UiSnapshot => this.snap;

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  // --- lifecycle -------------------------------------------------------------

  connect(): void {
    if (this.userClosed) return;
    this.opts.clearTimeout(this.timer);
    this.timer = null;
    const ws = this.opts.wsFactory(this.opts.url);
    this.ws = ws;
    if (this.snap.connection !== "reconnecting") {
      this.snap = { ...this.snap, connection: "connecting" };
      this.notify();
    }
    // ω99-246: #2 — 连接代守卫（合流保真）：一个 WudaoClient 同时只有一代
    // socket。重连/手动 reconnect 换代后，被换代的旧 socket 上仍可能有在途
    // 帧在其 close 事件之后迟到到达（真实传输的 message/close 竞态）——旧
    // 帧一旦并流就是转录失真：history 尾帧把权威重放已收编的行追加成第二
    // 行（工具卡双现）、旧 reset 把已合并的行滚回旧态、旧 state 帧把已落
    // 定的终态打回运行中（busy/busyTools/pendingPermission 复活）。帧上没
    // 有行级 id 也没有版本号（HistoryEntry 实况），实有的次序信号只有连接
    // 代与 historyEpoch——纪律落在流身份：同一代流=唯一来源，被换代流的帧
    // （open/message/close）一律不并流、不触发状态机。open 同守：换代的
    // socket 迟开绝不再发 auth 抢服务端的持有槽。
    const isCurrent = (): boolean => this.ws === ws;
    ws.addEventListener("open", () => {
      if (!isCurrent()) return; // superseded before it ever opened
      // PROTOCOL: the FIRST message after connect must be the auth frame —
      // wrong token or silence for 5s closes 4401.
      ws.send(JSON.stringify({ t: "auth", token: this.opts.token }));
      this.snap = { ...this.snap, connection: "authenticating" };
      this.notify();
    });
    ws.addEventListener("message", (ev) => {
      if (!isCurrent()) return; // the superseded socket's late tail never merges
      this.onMessage(ev.data);
    });
    ws.addEventListener("close", (ev) => {
      // A superseded socket's late close must not clobber the LIVE successor
      // (rebuild the replay queue, bump the attempt counter, spawn a rival
      // socket). this.ws === null is the just-dropped own socket (onClose
      // nulls it) — that close still owns the state machine.
      if (this.ws !== ws && this.ws !== null) return;
      this.onClose(ev.code, ev.reason ?? "");
    });
    ws.addEventListener("error", () => { /* close handling owns the state */ });
  }

  /** User-initiated close: no reconnect, pending ops rejected. */
  close(): void {
    this.userClosed = true;
    this.opts.clearTimeout(this.timer);
    this.timer = null;
    this.failPending(new Error("client closed"));
    this.replayQueue = [];
    this.queuedSetMode = null;
    this.ws?.close(1000, "client closed");
    this.ws = null;
    this.snap = { ...this.snap, connection: "closed", reconnectAttempt: 0 };
    this.notify();
  }

  /** Manual reconnect (the gave-up banner's 重连 button): resets the attempt
   *  count and dials again. Ignored after an explicit close(). */
  reconnect(): void {
    if (this.userClosed) return;
    this.opts.clearTimeout(this.timer);
    this.timer = null;
    this.reconnectAttempt = 0;
    this.snap = { ...this.snap, connection: "connecting", reconnectAttempt: 0 };
    this.notify();
    this.connect();
  }

  /** View-level /clear (the offline/fallback arm of the unified clear — see
   *  App's performClear): wipes the rendered history locally. The server
   *  session persists — a reconnect replay or /resume restores it. */
  clearView(): void {
    // ui-review-r2 I7: a VIEW-only wipe is still a history REPLACEMENT to
    // every append-watcher (App's agent-write high-water) — bump the epoch
    // like the reset frames do, or the first N write-tools after a clear
    // are silently skipped.
    this.snap = { ...this.snap, history: [], historyEpoch: this.snap.historyEpoch + 1 };
    this.notify();
  }

  private onClose(code: number, reason: string): void {
    const err = new Error(`connection closed (${code})`);
    this.ws = null;
    this.snap = { ...this.snap, lastClose: { code, reason } };
    // 4401 = auth failed: retrying with the same fragment is futile — stop
    // and let the banner say so. Everything else reconnects (the re-run auth
    // gets a full history replay, which restores the surface).
    if (this.userClosed || this.opts.reconnect === false || code === 4401) {
      this.failPending(err);
      this.replayQueue = [];
      this.snap = { ...this.snap, connection: code === 4401 ? "auth-failed" : "closed", reconnectAttempt: 0 };
      this.notify();
      return;
    }
    // The reconnect CAP: never spin forever — after maxReconnectAttempts the
    // client parks in the terminal gave-up state and the banner offers a
    // manual retry (the server may simply be gone; restart `wudao ui` first).
    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) {
      this.failPending(err);
      this.replayQueue = [];
      this.snap = { ...this.snap, connection: "gave-up", reconnectAttempt: this.reconnectAttempt };
      this.notify();
      return;
    }
    // ω-3a: partition instead of failing wholesale — a retryable mutation
    // KEEPS its pendingOps entry (the caller's promise stays pending; the
    // drop must not silently eat the user's submit) and rides the replay
    // queue; everything else (reads, anything the vault does not cover)
    // fails now, exactly as before. The queue is rebuilt from pendingOps on
    // every close, so an op already replayed-and-dropped-again simply
    // re-queues.
    this.replayQueue = [];
    for (const [id, p] of this.pendingOps) {
      if (p.replay !== undefined) this.replayQueue.push({ id, op: p.replay });
      else {
        this.pendingOps.delete(id);
        p.reject(err);
      }
    }
    this.reconnectAttempt += 1;
    this.snap = { ...this.snap, connection: "reconnecting", reconnectAttempt: this.reconnectAttempt };
    this.notify();
    const delay = this.opts.backoff(this.reconnectAttempt);
    this.timer = this.opts.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  // --- downstream -----------------------------------------------------------

  private onMessage(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return; // a non-JSON frame is a protocol violation; ignore defensively
    }
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as { t?: unknown };
    if (f.t === "state") {
      // Frames only flow post-auth — the first one flips us to connected.
      // ω99-235: #4 — the pet field rides the same frame (absent on a server
      // without the lane → snapshot keeps pet undefined, the relay degrades).
      const wasConnected = this.snap.connection === "connected";
      this.snap = {
        ...this.snap,
        connection: "connected",
        reconnectAttempt: 0,
        status: (f as { state: DriverStatus }).state,
        pet: (f as { pet?: DriverStatus | null }).pet,
        lanes: mergeLaneStatuses(this.snap.lanes, (f as { lanes?: Record<string, LaneStatusWire> | null }).lanes), // 弧 C：state 帧重读全部副车道（缺席=老 server，快照 lanes 不动）
      };
      this.reconnectAttempt = 0;
      if (!wasConnected) {
        this.snap = { ...this.snap, lastClose: null };
        // ω-3a: the mutations caught mid-flight by the drop go out FIRST
        // (they predate anything clicked while offline), then the queued
        // setMode — chronological order.
        this.flushReplayOps();
        this.flushQueuedSetMode();
      }
      this.notify();
      return;
    }
    if (f.t === "history") {
      const h = f as { entries: readonly HistoryEntry[]; reset?: boolean; sid?: string };
      if (typeof h.sid === "string" && h.sid !== "") { this.snap = { ...this.snap, lanes: applyLaneHistory(this.snap.lanes, h.sid, h.entries, h.reset === true) }; this.notify(); return; } // 弧 C：带 sid 的帧进对应车道（主车道不带 sid=字节不变）
      const history = h.reset === true ? [...h.entries] : [...this.snap.history, ...h.entries];
      // M74-ide §3: a reset is a REPLACEMENT (auth/reconnect/clear/resume
      // replay) — bump the epoch so append-watchers reseed instead of reading
      // the replayed tail as new entries.
      this.snap = {
        ...this.snap,
        connection: "connected",
        history,
        ...(h.reset === true ? { historyEpoch: this.snap.historyEpoch + 1 } : {}),
      };
      this.notify();
      return;
    }
    if (f.t === "event") {
      // 140：原始 LoopEvent 直通（监控面板的实时时间线——思考流/工具入参
      // 出参/轮界）。不进快照（高频），onLoopEvent 订阅者自取。
      const ef = f as { event?: unknown; at?: number };
      if (ef.event !== undefined) for (const cb of [...this.loopListeners]) cb(ef.event, typeof ef.at === "number" ? ef.at : Date.now());
      return;
    }
    if (f.t === "probe") {
      // 139：高频直通——不建快照、不触发 notify（仪表盘自订阅）。
      const ev = (f as { event?: unknown }).event;
      if (ev !== undefined) for (const cb of [...this.probeListeners]) cb(ev);
      return;
    }
    if (f.t === "result") {
      const r = f as { id: number; ok?: unknown; err?: string };
      const p = this.pendingOps.get(r.id);
      if (p === undefined) return;
      this.pendingOps.delete(r.id);
      if (typeof r.err === "string") p.reject(new Error(r.err));
      else p.resolve(r.ok);
      return;
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pendingOps) p.reject(err);
    this.pendingOps.clear();
  }

  // --- upstream ops -----------------------------------------------------------

  private sendOp<T>(op: ClientOp): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Guard: sending on a CONNECTING/CLOSED socket throws (the DOM's
      // "Still in CONNECTING state") — reject cleanly instead; the UI's
      // controls are disabled while offline so this is a race guard, not the
      // primary defense.
      if (this.ws === null || this.ws.readyState !== WS_OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      this.pendingOps.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(isRetryableMutation(op) ? { replay: op } : {}) });
      this.ws.send(JSON.stringify({ t: "op", id, op, cid: this.clientId }));
    });
  }

  /** ω-3a: re-send the mutations that were in flight when the socket
   *  dropped, under their ORIGINAL op ids and this client's cid — the
   *  server's idempotency vault joins the original execution (or replays
   *  its cached result), so the replay never re-executes a mutation that
   *  already landed. The pendingOps entries (and the caller promises) stay
   *  live: the eventual result resolves them. */
  private flushReplayOps(): void {
    while (this.replayQueue.length > 0) {
      const next = this.replayQueue[0];
      if (next === undefined || this.ws === null || this.ws.readyState !== WS_OPEN) return; // stay queued for the next reconnect
      this.replayQueue.shift();
      this.ws.send(JSON.stringify({ t: "op", id: next.id, op: next.op, cid: this.clientId }));
    }
  }

  /** Submit one input line. Driver-executable commands (/plan, /skill:…,
   *  /rewind, plan review ok/改…) route server-side; a "frontend" outcome
   *  means the line was a UI-presentational command THIS frontend renders. 弧 C：sid=副车道路由（缺省主车道）。 */
  submit(text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly ImageBlockWire[]; readonly files?: readonly FileBlockWire[]; readonly sid?: string }): Promise<SubmitOutcome> {
    return this.sendOp<SubmitOutcome>({
      op: "submit",
      text,
      ...(opts?.plan === true ? { plan: true } : {}),
      ...(opts?.expand === false ? { expand: false } : {}),
      ...(opts?.images !== undefined && opts.images.length > 0 ? { images: opts.images } : {}),
      ...(opts?.files !== undefined && opts.files.length > 0 ? { files: opts.files } : {}),
      ...(opts?.sid !== undefined ? { sid: opts.sid } : {}),
    });
  }

  interrupt(sid?: string): Promise<true> { // 弧 C：sid=打断对应副车道（缺省主车道）
    return this.sendOp<true>({ op: "interrupt", ...(sid !== undefined ? { sid } : {}) });
  }

  /** setMode queues while offline (latest wins — mode is idempotent state)
   *  and flushes right after the (re)auth lands; a click while the socket is
   *  CONNECTING never surfaces an error. 弧 C：带 sid 的车道档位不走离线队列（主车道档位的补偿路径），直接随连接态成败。 */
  setMode(mode: Mode, sid?: string): Promise<true> {
    if (sid === undefined && (this.ws === null || this.ws.readyState !== WS_OPEN || this.snap.connection !== "connected")) {
      this.queuedSetMode = mode;
      return Promise.resolve(true);
    }
    return this.sendOp<true>({ op: "setMode", mode, ...(sid !== undefined ? { sid } : {}) });
  }

  private flushQueuedSetMode(): void {
    if (this.queuedSetMode === null) return;
    const mode = this.queuedSetMode;
    this.queuedSetMode = null;
    this.sendOp<true>({ op: "setMode", mode }).catch(() => { /* dropped with the socket; the mode re-clicks */ });
  }

  /** Answer the parked pendingPermission (false when nothing is parked).
   *  0.3.14 #1: scope "session"/"always" records a rule (once when absent). */
  answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): Promise<boolean> {
    return this.sendOp<boolean>({ op: "answerPermission", allow, ...(reason !== undefined ? { reason } : {}), ...(scope !== undefined ? { scope } : {}) });
  }

  /** 借鉴弧 α2（CC 2.1.269 思想）— recall ONE still-queued steering message
   *  (CAS: index+text from the same state frame; consumed → false). */
  recallSteer(index: number, text: string): Promise<boolean> {
    return this.sendOp<boolean>({ op: "recallSteer", index, text });
  }

  /** 借鉴弧 α1（Codex 0.154 思想）— answer the parked ask_user clarification
   *  card (absent/empty answer = dismiss → the model decides itself). */
  answerAskUser(answer?: string): Promise<boolean> {
    return this.sendOp<boolean>({ op: "answerAskUser", ...(answer !== undefined ? { answer } : {}) });
  }

  /** 借鉴弧 δ（penguin 367ab084 思想）— move ONE in-flight tool call to the
   *  background (the turn unblocks; the run closes at the turn boundary;
   *  the landed result merges later). Typed verdict: ok, or refused with
   *  not_detachable (block family) / not_in_flight. */
  detachToolCall(callId?: string): Promise<DetachVerdictWire> {
    return this.sendOp<DetachVerdictWire>({ op: "detachToolCall", ...(callId !== undefined ? { callId } : {}) });
  }

  // --- ω99-235: #6 — pet lane ops (the sprite's own SECOND driver session) ----

  /** Submit one line into the PET lane (text-only v1). Rejects with
   *  "pet ops not supported by this driver" on a server without the lane —
   *  the relay degrades to the main submit before ever calling this. */
  petSubmit(text: string): Promise<SubmitOutcome> {
    return this.sendOp<SubmitOutcome>({ op: "petSubmit", text });
  }

  /** Interrupt the PET lane's run (never the main run). */
  petInterrupt(): Promise<true> {
    return this.sendOp<true>({ op: "petInterrupt" });
  }

  /** Answer the PET lane's parked permission card (the sprite window's own
   *  ask; the main modal keeps answerPermission). */
  petAnswerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): Promise<boolean> {
    return this.sendOp<boolean>({ op: "petAnswerPermission", allow, ...(reason !== undefined ? { reason } : {}), ...(scope !== undefined ? { scope } : {}) });
  }

  /** ω99-271 — read the PET lane's paired session history (pet.jsonl, paired
   *  server-side into {q,a} turns, capped 50 turns / 8000 chars per turn).
   *  Rejects with "pet ops not supported by this driver" on a lane-less
   *  server — callers degrade silently (the local transcript stands). */
  petHistory(): Promise<readonly PetTurnWire[]> {
    return this.sendOp<readonly PetTurnWire[]>({ op: "petHistory" });
  }

  // --- M85-pet §2 — the pet toolbar's four ops（宠物窗工具栏的动作面） -------

  /** Rotate the PET lane to a fresh session (archive the current pet.jsonl
   *  under a stamped id → reset keep-id). Resolves the archived session id,
   *  or null when there was nothing to archive (the empty-session boundary).
   *  Rejects with "pet ops not supported by this driver" on a lane-less
   *  server — the toolbar degrades silently. */
  petNewSession(): Promise<string | null> {
    return this.sendOp<string | null>({ op: "petNewSession" });
  }

  /** The model chip: provider is the selector's primary key; model/effort
   *  are optional refinements riding the same write (the driver-side
   *  liveConfig re-parse seam). The reply is a constant true — the honest
   *  face of a bad provider/model lands in the lane's session notices. */
  petSetModel(provider: string, model?: string, effort?: string): Promise<true> {
    return this.sendOp<true>({ op: "petSetModel", provider, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) });
  }

  /** The effort chip: the configureModel seam's single-slot narrowing (the
   *  /effort twin landing on the pet lane's own config). */
  petSetEffort(effort: string): Promise<true> {
    return this.sendOp<true>({ op: "petSetEffort", effort });
  }

  /** The workspace chip: the pet lane's agentRootSwitch mirror — the reply
   *  is the AgentRootSwitchResult shape verbatim (applied now, or queued at
   *  the run's settle seam); existence/dir validation and busy-parking all
   *  live driver-side. */
  petSetWorkspace(path: string): Promise<AgentRootSwitchResult> {
    return this.sendOp<AgentRootSwitchResult>({ op: "petSetWorkspace", path });
  }

  listSlashCommands(): Promise<readonly SlashCommandInfo[]> {
    return this.sendOp<readonly SlashCommandInfo[]>({ op: "listSlashCommands" });
  }

  sessions(): Promise<readonly SessionRow[]> {
    return this.sendOp<readonly SessionRow[]>({ op: "sessions" });
  }

  /** ω99-277: full-text search every session's visible text (the picker's
   *  search box) — one hit per matching message, newest sessions first. */
  sessionSearch(q: string): Promise<readonly SessionSearchHit[]> {
    return this.sendOp<readonly SessionSearchHit[]>({ op: "sessionSearch", q });
  }

  /** ω99-279（续，标记见上）— trash-delete one session (the picker's 🗑 — the file moves to
   *  .trash/, recoverable). Resolves the verdict; the caller branches its
   *  toast on the three refusal reasons. */
  sessionDelete(id: string): Promise<SessionDeleteResult> {
    return this.sendOp<SessionDeleteResult>({ op: "sessionDelete", id });
  }

  /** ω99-283（续，标记见上）— the trashed sessions' rows (the picker's 回收站
   *  face; the SAME SessionRow shape sessions() answers, mtime-desc cap 20).
   *  Rejects on old servers — the trash entry degrades (hidden), never
   *  crashes. */
  sessionTrashList(): Promise<readonly SessionRow[]> {
    return this.sendOp<readonly SessionRow[]>({ op: "sessionTrashList" });
  }

  /** ω99-283（续，标记见上）— restore one trashed session (link+unlink back
   *  into the sessions dir — atomic no-overwrite). Resolves the verdict; the
   *  caller branches its toast on the three refusal reasons. */
  sessionRestore(id: string): Promise<SessionRestoreResult> {
    return this.sendOp<SessionRestoreResult>({ op: "sessionRestore", id });
  }

  /** ω99-286（续，标记见上）— continue the unfinished session's interrupted
   *  turn as-is (no new user message; the historical tail is the model input
   *  tail). Resolves {started}; false = nothing to continue. */
  sessionContinue(id: string): Promise<SessionContinueResult> {
    return this.sendOp<SessionContinueResult>({ op: "sessionContinue", id });
  }

  /** ω99-313 — 定时任务与提醒的读面（侧栏 ⏰ 标记的数据源；失败时调用方
   *  把面藏掉——undefined 先例同 awaitingIds）。 */
  schedulesList(): Promise<readonly ScheduleListRow[]> {
    return this.sendOp<readonly ScheduleListRow[]>({ op: "schedulesList" });
  }

  /** ω99-317（续，标记见上）— 暂停/恢复一条定时任务（enabled:false=暂停；
   *  true=恢复——unpause 兼任熔断重开，313 语义零动）。回执联合原样中
   *  继，调用方按 ok 分叉通知语气。 */
  schedulesSetEnabled(id: string, enabled: boolean): Promise<ScheduleActionResult> {
    return this.sendOp<ScheduleActionResult>({ op: "schedulesSetEnabled", id, enabled });
  }

  /** ω99-317（续，标记见上）— 删除一条定时任务（只动 .wudao 调度条目，
   *  绝不触碰用户文件；删除收敛）。 */
  schedulesRemove(id: string): Promise<ScheduleActionResult> {
    return this.sendOp<ScheduleActionResult>({ op: "schedulesRemove", id });
  }

  /** ω99-317（续，标记见上）— 立即试跑（手动运行——计划不变）。busy 守卫
   *  与 in-flight 拒答走 ok:false；resetBreaker 是熔断行的显式复位旗（确认
   *  弹框后才带——复位计数 + 重新打开后跑）。 */
  schedulesRunNow(id: string, opts?: { readonly resetBreaker?: boolean }): Promise<ScheduleActionResult> {
    return this.sendOp<ScheduleActionResult>({ op: "schedulesRunNow", id, ...(opts?.resetBreaker === true ? { resetBreaker: true } : {}) });
  }

  /** ω99-225: returns the outcome object — ok / not_found / occupied (with
   *  the holder pid). Request shape unchanged (`{op:"resume", id}`).
   *  弧 C：sid=把会话采纳进该副车道（server 按需开车道；车道侧 reset 重放帧带同一 sid 收据）。 */
  resume(id: string, sid?: string): Promise<ResumeOutcome> {
    return this.sendOp<ResumeOutcome>({ op: "resume", id, ...(sid !== undefined ? { sid } : {}) });
  }

  /** 小精灵会话弧 — 追问形 resume：字节复制该会话到全新 id 后 resume 副本
   *  （原会话永不改写）。回执联合=ResumeForkOutcome（busy/not_found/
   *  occupied 三路拒答各有 toast 文案）。不带 sid——fork 永远落在主车道。 */
  resumeFork(id: string): Promise<ResumeForkOutcome> {
    return this.sendOp<ResumeForkOutcome>({ op: "resume", id, fork: true });
  }

  rewind(target: number | "last" | "list"): Promise<string> {
    return this.sendOp<string>({ op: "rewind", target });
  }

  /** M53 §1: arm /edit target n — the original text for the input box. */
  edit(n: number): Promise<string | null> {
    return this.sendOp<string | null>({ op: "edit", n });
  }

  /** M53 §1: the ASCII branch topology (/tree). */
  tree(): Promise<string> {
    return this.sendOp<string>({ op: "tree" });
  }

  /** M53 §1: list branches (no n) or switch the active chain (n). */
  switchBranch(n?: number): Promise<string> {
    return this.sendOp<string>({ op: "switch", ...(n !== undefined ? { n } : {}) });
  }

  /** ω99-258: void a pending /edit arm (the banner's 取消) — the edit op's
   *  n:0 form; true once the mainline owns the next submit again. */
  disarmEdit(): Promise<true> {
    return this.sendOp<true>({ op: "edit", n: 0 });
  }

  /** ω99-258: the structured branch leaf table (the branch panel's rows).
   *  Rejects on old servers — callers degrade (chip hidden), never crash. */
  branchLeaves(): Promise<readonly BranchLeaf[]> {
    return this.sendOp<readonly BranchLeaf[]>({ op: "branchLeaves" });
  }

  /** ω99-260: the full memory ledger (the 待审卡/管理面's data — file order,
   *  active + pending). 永续 v6 弧 A（reef C3）: blocked = 被拦学习输入计数
   *  （凭据值/指令注入形状，未入库）——「已拦 N 条」提示行的数据源；老
   *  server 不回该字段（undefined=零渲染，静默降级）。Rejects on old
   *  servers — callers degrade (faces hidden), never crash. */
  memoryList(): Promise<{ readonly entries: readonly MemoryEntry[]; readonly blocked?: number }> {
    return this.sendOp<{ readonly entries: readonly MemoryEntry[]; readonly blocked?: number }>({ op: "memoryList" });
  }

  /** ω99-260: decide one pending memory — ok confirms (pending→active), del
   *  drops the line; the reply is the structured {ok, message} verdict. */
  memoryDecide(id: string, action: "ok" | "del"): Promise<MemoryDecideResult> {
    return this.sendOp<MemoryDecideResult>({ op: "memoryDecide", id, action });
  }

  /** ω99-264: rewrite one memory entry's content — status-preserving (active
   *  stays active, pending stays pending); the reply is the structured
   *  {ok, message} verdict (the driver short-circuits a content-equal
   *  replay, so a re-sent edit never double-bumps version). */
  memoryEdit(id: string, content: string): Promise<MemoryEditResult> {
    return this.sendOp<MemoryEditResult>({ op: "memoryEdit", id, content });
  }

  /** 永续 v6 wave2（reef C1）：门控自改进面——list 拉全部提案记录卡（设置→
   *  偏好→改进提案 的数据）；决策动作用同一方法（consent/ignore/activate/
   *  reject/undo + id）。老 server 缺 op → reject，调用面隐藏整节。 */
  improvementFace(action: "list"): Promise<ImprovementFaceResult>;
  improvementFace(action: "consent" | "ignore" | "activate" | "reject" | "undo", id: string): Promise<ImprovementFaceResult>;
  improvementFace(action: "list" | "consent" | "ignore" | "activate" | "reject" | "undo", id?: string): Promise<ImprovementFaceResult> {
    return this.sendOp<ImprovementFaceResult>({ op: "improvementFace", action, ...(id !== undefined ? { id } : {}) });
  }

  // --- M63 §B settings ops ---------------------------------------------------

  /** The provider-card matrix + credentials count + settings values. */
  settingsStatus(): Promise<SettingsStatus> {
    return this.sendOp<SettingsStatus>({ op: "settingsStatus" });
  }

  /** Persist one provider key to the credentials file (0600). The reply is
   *  a status — the saved key NEVER comes back (the input clears on
   *  success; there is nothing to read here even on reconnect). */
  settingsSaveKey(provider: string, key: string): Promise<SaveKeyResult> {
    return this.sendOp<SaveKeyResult>({ op: "settingsSaveKey", provider, key });
  }

  /** One minimal request through the target provider. `key` tests an
   *  unsaved paste (the wizard flow); absent → the resolved key. */
  settingsTestConnection(provider: string, opts?: { readonly key?: string; readonly model?: string }): Promise<TestConnectionResult> {
    return this.sendOp<TestConnectionResult>({
      op: "settingsTestConnection",
      provider,
      ...(opts?.key !== undefined ? { key: opts.key } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
    });
  }

  /** Write one allowlisted personal preference (ui.defaultMode / memoryEnabled). */
  settingsSet(key: string, value: unknown): Promise<SettingsSetResult> {
    return this.sendOp<SettingsSetResult>({ op: "settingsSet", key, value });
  }

  // --- provider management §5 — the registry ops ------------------------------

  /** Register/update one provider (custom or builtin overlay). `config` is
   *  registry config only — API keys go through settingsSaveKey, never here. */
  settingsSaveProvider(id: string, config: unknown): Promise<SaveProviderResult> {
    return this.sendOp<SaveProviderResult>({ op: "settingsSaveProvider", id, config });
  }

  /** Remove one registry entry (customs only — builtin ids refuse; a stored
   *  defaultModel pointing at the id falls back). */
  settingsDeleteProvider(id: string): Promise<DeleteProviderResult> {
    return this.sendOp<DeleteProviderResult>({ op: "settingsDeleteProvider", id });
  }

  /** Probe GET ${endpoint}/models — the model catalog with optional context
   *  windows; failures reuse the testConnection states. The key never echoes. */
  settingsListModels(provider: string, opts?: { readonly key?: string }): Promise<ListModelsResult> {
    return this.sendOp<ListModelsResult>({
      op: "settingsListModels",
      provider,
      ...(opts?.key !== undefined ? { key: opts.key } : {}),
    });
  }

  /** M75-ux1 §2: the workspace switcher's recents — the list (max 5,
   *  most-recent-first); with `add`, the path is unshifted + persisted first
   *  (the switch click's write rides this same op). */
  recentWorkspaces(add?: string): Promise<RecentWorkspacesResult> {
    return this.sendOp<RecentWorkspacesResult>({ op: "recentWorkspaces", ...(add !== undefined ? { add } : {}) });
  }

  /** M77-workspace §1: same-window switch — returns the new session's URL.
   *  @deprecated workspace-ux B: no web call site remains (panelRootSet +
   *  agentRootSwitch replaced the flow). Kept for the wire shape only. */
  switchWorkspace(path: string): Promise<{ url: string }> {
    return this.sendOp<{ url: string }>({ op: "switchWorkspace", path });
  }

  // --- M74-ide §1 file-panel ops ---------------------------------------------

  /** One directory level for the tree (path = workspace-relative, "" = root):
   *  dirs first alphabetically then files; hidden:true marks dotfiles + the
   *  hidden list — the CALLER filters on that flag. */
  fileTree(path: string): Promise<FileTreeResult> {
    return this.sendOp<FileTreeResult>({ op: "fileTree", path });
  }

  /** One file's UTF-8 content for the viewer. Over 1MB → truncated:true with
   *  the first 100KB; binary:true → content is "" (placeholder); sensitive
   *  paths reject. */
  fileRead(path: string): Promise<FileReadResult> {
    return this.sendOp<FileReadResult>({ op: "fileRead", path });
  }

  /** 高亮/编辑 spec §3: the viewer's save — user-hand edit with a
   *  compare-and-swap `base`. written | conflict(current) | rejects on the
   *  read-side guards / IO. */
  fileWrite(path: string, content: string, base: string): Promise<FileWriteResult> {
    return this.sendOp<FileWriteResult>({ op: "fileWrite", path, content, base });
  }

  /** ω99-314 — 把指定文件恢复到指定快照（「恢复到这里」的引擎）。拒答
   *  （busy/evicted/…）不 reject——判决联合原样 resolve，调用方按 reason
   *  分叉回执；仅传输层错误 reject（与其他 op 同）。 */
  fileRevert(path: string, sha: string): Promise<FileRevertResult> {
    return this.sendOp<FileRevertResult>({ op: "fileRevert", path, sha });
  }

  /** ω99-316 — /btw 侧问（「顺便问」chip 的引擎）：不打断主 run，克隆请求
   *  时刻的投影旁路作答，不写回主会话。busy/idle 双态同一入口；错误
   *  （会话不匹配 / 模型失败）reject——调用方落 err 气泡。 */
  sideQuestion(sessionId: string, text: string): Promise<SideQuestionResult> {
    return this.sendOp<SideQuestionResult>({ op: "sideQuestion", sessionId, text });
  }

  /** workspace-ux B1: switch the file panel's view root — the reply's root
   *  drives the tree-top label and the tree's re-render. Never touches the
   *  session (no restart, no navigate); rejects on a nonexistent or
   *  non-directory path. */
  panelRootSet(path: string): Promise<PanelRootSetResult> {
    return this.sendOp<PanelRootSetResult>({ op: "panelRootSet", path });
  }

  /** workspace-ux B1: the dual-root snapshot (panel vs agent root). */
  agentRootStatus(): Promise<AgentRootStatusResult> {
    return this.sendOp<AgentRootStatusResult>({ op: "agentRootStatus" });
  }

  // ── 139 探针仪表盘面（PROTOCOL "probeStream"/"probeRecent"/"probeStats"/
  //    "probeEnable"）。事件本体走 {t:"probe"} 帧 → onProbe 订阅（不进快照，
  //    高频通道不给 React 快照面加抖动）。老 server 拒答 → 调用方降级。
  /** 订阅探针流（cat 缺省=全部五类；"off"=退订——关页停流）。 */
  probeStream(cat?: string): Promise<boolean> {
    return this.sendOp<boolean>({ op: "probeStream", ...(cat !== undefined ? { cat } : {}) });
  }
  /** 环形缓冲尾拉（backfill；limit 1..1000）。 */
  probeRecent(cat?: string, limit?: number): Promise<readonly unknown[]> {
    return this.sendOp<readonly unknown[]>({ op: "probeRecent", ...(cat !== undefined ? { cat } : {}), ...(limit !== undefined ? { limit } : {}) });
  }
  /** 统计面（各类目累计计数 + 最近时间戳）。 */
  probeStats(): Promise<Record<string, unknown>> {
    return this.sendOp<Record<string, unknown>>({ op: "probeStats" });
  }
  /** 139：运行时翻转探针总闸（agent.* 与 tool.* 下一 run 起；model.call 需
   *  带 WUDAO_PROBE=on 启动——回执字段照实说明）。 */
  probeEnable(on: boolean): Promise<{ enabled: boolean; modelCallNeedsRestart: boolean }> {
    return this.sendOp<{ enabled: boolean; modelCallNeedsRestart: boolean }>({ op: "probeEnable", on });
  }
  /** {t:"probe"} 帧的直通订阅（高频：不进快照）。返回退订。 */
  onProbe(cb: (event: unknown) => void): () => void {
    this.probeListeners.add(cb);
    return () => this.probeListeners.delete(cb);
  }
  /** 140 — 会话解剖（系统提示词 + 消息链全量）。老 server 拒答 → 调用方
   *  降级为「暂无数据」。 */
  sessionAnatomy(): Promise<SessionAnatomyResult> {
    return this.sendOp<SessionAnatomyResult>({ op: "sessionAnatomy" });
  }
  /** 140 — {t:"event"} 原始 LoopEvent 帧的直通订阅（思考流/工具入参出参/
   *  轮界，137 起带 at）。高频：不进快照。返回退订。 */
  onLoopEvent(cb: (event: unknown, at: number) => void): () => void {
    this.loopListeners.add(cb);
    return () => this.loopListeners.delete(cb);
  }

  /** workspace-ux B2: switch the agent's workspace root — idle applies now
   *  ({applied:true}); busy parks until the run's settle seam ({queued:true}).
   *  The landing notice rides the driver's history channel — the caller never
   *  re-appends it. */
  agentRootSwitch(path: string): Promise<AgentRootSwitchResult> {
    return this.sendOp<AgentRootSwitchResult>({ op: "agentRootSwitch", path });
  }

  /** M76-ux2 §8: the ctx hover's breakdown — the serialized prompt's section
   *  estimates + availableTokens. Rejects on an old server (unknown op) —
   *  callers treat that as "no breakdown, keep the generic title". */
  ctxInfo(): Promise<CtxInfoResult> {
    return this.sendOp<CtxInfoResult>({ op: "ctxInfo" });
  }

  /** The away recap: stats since the viewer's mark + an
   *  optional narrative. Resolves undefined on zero action (session mismatch
   *  / below the dual gate); rejects on an old server (the hook shows no
   *  card — recap is best-effort). */
  recap(sessionId: string, sinceMark: number, sinceTs?: number): Promise<RecapPayload | undefined> {
    return this.sendOp<RecapPayload | undefined>({
      op: "recap",
      sessionId,
      sinceMark,
      ...(sinceTs !== undefined ? { sinceTs } : {}),
    });
  }

  /** ω99-242 — the recovery reconciliation rows (the current session's row
   *  drives the 「已验证完成 X / 待续 Y」 banner). Rejects on an old server —
   *  the hook shows no banner (recovery is informational, best-effort). */
  recoveryStatus(): Promise<readonly RecoveryStatusRowWire[] | undefined> {
    return this.sendOp<readonly RecoveryStatusRowWire[] | undefined>({ op: "recoveryStatus" });
  }

  // --- M79 §4 attachment ops (TYPES surface; the M79b composer uses them) ---

  /** Admit a base64 image batch → durable refs (same admission policy as the
   *  CLI's --image: maxImages 9, 20MiB request budget, media-type allowlist).
   *  Rejects with the store's error string on any admission failure. */
  attachmentSave(inputs: readonly { data: string; mediaType: string }[]): Promise<AttachmentSaveResult> {
    return this.sendOp<AttachmentSaveResult>({ op: "attachmentSave", inputs });
  }

  /** One stored image back as base64 — the history-image render source. */
  attachmentGet(ref: ImageAttachmentRefWire): Promise<AttachmentGetResult> {
    return this.sendOp<AttachmentGetResult>({ op: "attachmentGet", ref });
  }

  /** ω99-55: admit a base64 generic-file batch → content-addressed blocks. */
  fileSave(inputs: readonly { data: string; name: string }[]): Promise<FileSaveResult> {
    return this.sendOp<FileSaveResult>({ op: "fileSave", inputs });
  }

  // --- cc-plugins C1 plugin ops (the settings page's 插件 tab is C2) ---

  /** The install registry + enable state (the 已装 list). */
  pluginList(): Promise<PluginListResult> {
    return this.sendOp<PluginListResult>({ op: "pluginList" });
  }

  /** Every configured MCP server (three tiers) with runtime status. */
  mcpList(): Promise<McpListResult> {
    return this.sendOp<McpListResult>({ op: "mcpList" });
  }

  /** Every registered market + its discover entries (with install-preview
   *  counts for local-dir sources; null for git-location sources). */
  pluginMarketList(): Promise<PluginMarketListResult> {
    return this.sendOp<PluginMarketListResult>({ op: "pluginMarketList" });
  }

  /** Add a market (owner/repo · git URL#ref · 本地目录 · marketplace.json
   *  路径); `name` overrides the manifest's own. Rejects with the engine's
   *  message on a bad source. */
  pluginMarketAdd(source: string, name?: string): Promise<PluginMarketInfoWire> {
    return this.sendOp<PluginMarketInfoWire>({ op: "pluginMarketAdd", source, ...(name !== undefined ? { name } : {}) });
  }

  /** Re-pull / re-copy one registered market. */
  pluginMarketUpdate(name: string): Promise<PluginMarketInfoWire> {
    return this.sendOp<PluginMarketInfoWire>({ op: "pluginMarketUpdate", name });
  }

  /** Remove a market (cascade-uninstalls the plugins it installed). Refuses
   *  while a run is in flight — the cascade deletes plugin dirs. */
  pluginMarketRemove(name: string): Promise<PluginMarketRemoveResult> {
    return this.sendOp<PluginMarketRemoveResult>({ op: "pluginMarketRemove", name });
  }

  /** Install a market's plugin into a scope root; the reply carries the
   *  install preview (InstallDetail) + the rescan receipt. */
  pluginInstall(name: string, market: string, scope: "user" | "project"): Promise<PluginInstallResult> {
    return this.sendOp<PluginInstallResult>({ op: "pluginInstall", name, market, scope });
  }

  /** 长期记忆（M-Memory 新库）：跨会话记忆条目。 */
  longtermMemoryList(): Promise<{ readonly entries: readonly LongtermMemoryEntryWire[] }> {
    return this.sendOp<{ readonly entries: readonly LongtermMemoryEntryWire[] }>({ op: "longtermMemoryList" });
  }

  /** 长期记忆：tombstone 删除。 */
  longtermMemoryForget(id: string): Promise<void> {
    return this.sendOp<void>({ op: "longtermMemoryForget", id });
  }

  /** 引导安装（guided-install）：spec 三形态；preview 只 inspect 不装。 */
  pluginInstallSpec(spec: string, preview?: boolean): Promise<PluginSpecInstallResult> {
    return this.sendOp<PluginSpecInstallResult>({ op: "pluginInstallSpec", spec, ...(preview === true ? { preview: true } : {}) });
  }

  /** Uninstall (delete dir + registry record + enable key). Refuses while a
   *  run is in flight. */
  pluginUninstall(id: string): Promise<PluginUninstallResult> {
    return this.sendOp<PluginUninstallResult>({ op: "pluginUninstall", id });
  }

  /** Re-enable a disabled plugin. */
  pluginEnable(id: string): Promise<PluginToggleResult> {
    return this.sendOp<PluginToggleResult>({ op: "pluginEnable", id });
  }

  /** Hide a plugin from the current mapping (record kept). */
  pluginDisable(id: string): Promise<PluginToggleResult> {
    return this.sendOp<PluginToggleResult>({ op: "pluginDisable", id });
  }

  // --- persona-settings T5 persona ops (the settings page's persona tab) ---

  /** Every registered persona (builtin + global + workspace) — the master
   *  list's rows. `editable` is source === "global" (builtin/workspace are
   *  read-only surfaces). */
  personaList(): Promise<PersonaListResult> {
    return this.sendOp<PersonaListResult>({ op: "personaList" });
  }

  /** One persona's full definition (the detail form's data). An unknown id
   *  rejects with the server's error. */
  personaGet(id: string): Promise<PersonaGetResult> {
    return this.sendOp<PersonaGetResult>({ op: "personaGet", id });
  }

  /** Create/update one GLOBAL persona (the definition's id is the key). The
   *  reply carries the server's per-field error list on a refused save —
   *  the form matches the field-path prefixes back to its rows. */
  personaSave(definition: PersonaDefinition): Promise<PersonaSaveResult> {
    return this.sendOp<PersonaSaveResult>({ op: "personaSave", definition });
  }

  /** Delete one global persona. The first call reports the reference
   *  inventory when the persona is still bound (providers + the global
   *  default); the second call with `unbind: true` clears the bindings and
   *  lands. */
  personaDelete(req: { readonly id: string; readonly unbind?: boolean }): Promise<PersonaDeleteResult> {
    return this.sendOp<PersonaDeleteResult>({
      op: "personaDelete",
      id: req.id,
      ...(req.unbind === true ? { unbind: true } : {}),
    });
  }
}
