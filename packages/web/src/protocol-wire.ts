// @wudao/web — the WS protocol client (M43-B). This file is the web package's
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

// ---------------------------------------------------------------------------
// Mirrored contract types (PROTOCOL.md)
// ---------------------------------------------------------------------------

/** setMode values (the harness's modes; PROTOCOL "setMode"). 0.3.12: the
 *  three-mode redesign (对齐 Claude 模式设计) — workspace(默认,工作区可
 *  读写)/ask(每次执行工具都问)/auto(完全权限); 0.3.14 adds plan(只读探查
 *  — reads and safe read-only commands only, everything else denied). The
 *  retired read-only and the 0.3.11 default/acceptEdits pair are gone, and
 *  the host accepts exactly these four. */
import type { DriverStatus, HistoryEntry, ClientOp } from "./protocol-core.js";
// —— 协议类型/纯函数族外提（ω99 拆分运动：纯移动段外提）——
export interface RecoveryStatusRowWire {
  readonly sessionId: string;
  readonly state: "blocked" | "active" | "recovering" | "unfinished" | "terminal" | "tracked";
  readonly verifiedDone?: number;
  readonly remaining?: number;
  readonly permissionAsk?: {
    readonly toolName: string;
    readonly summary: string;
    readonly question: string;
  };
}

// ---------------------------------------------------------------------------
// M79 §4 — the attachment ops (PROTOCOL "attachmentSave" / "attachmentGet")
// and the submit envelope's optional images field. TYPES ONLY in M79: the
// composer/history rendering that uses them lands in M79b (web 展示层).
// ---------------------------------------------------------------------------

/** The durable image pointer (the ONLY image shape on the wire — never
 *  bytes on a session payload; base64 crosses ONLY inside attachmentSave's
 *  inputs and attachmentGet's reply). */
export interface ImageAttachmentRefWire {
  readonly kind: "image";
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/** One image riding a user turn (submit envelope / history entries). */
export interface ImageBlockWire {
  readonly kind: "image";
  readonly ref: ImageAttachmentRefWire;
}

/** attachmentSave's reply: refs in input order. */
export type AttachmentSaveResult = readonly ImageAttachmentRefWire[];

/** attachmentGet's reply: the stored bytes, base64 again. */
export interface AttachmentGetResult {
  readonly data: string;
  readonly mediaType: string;
}

/** ω99-55 — the file lane's wire shapes: one content-addressed file block
 *  (the ONLY file form on a session payload — bytes never ride; base64
 *  crosses ONLY inside fileSave's inputs). */
export interface FileBlockWire {
  readonly kind: "file";
  readonly name: string;
  readonly bytes: number;
  readonly attachmentId: string;
}

/** fileSave's reply: blocks in input order. */
export type FileSaveResult = readonly FileBlockWire[];

// ---------------------------------------------------------------------------
// cc-plugins C1 — the plugin-management ops (PROTOCOL "pluginList" …
// "pluginDisable"). TYPES + client methods only here; the settings page's
// 插件 tab that consumes them is C2. Same marketplace engine as /plugin and
// `wudao plugin` — engine failures reject with the engine's message.
// ---------------------------------------------------------------------------

/** One installed row (the 已装 list): the install registry + enable state.
 *  `adhoc` rows are the session's `--plugin` mounts (always enabled). */
export interface InstalledPluginRowWire {
  readonly id: string;
  readonly name: string;
  readonly market: string;
  readonly scope: "user" | "project" | "adhoc";
  readonly enabled: boolean;
  readonly version?: string;
}

/** pluginList's reply. */
export interface PluginListResult {
  readonly installed: readonly InstalledPluginRowWire[];
}

// ---------------------------------------------------------------------------
// MCP visibility — mcpList's reply types (mirrors the driver's
// McpListPayload in cli/src/driver/settings-ops.ts; the web never imports
// the CLI package).
// ---------------------------------------------------------------------------

/** One mcpList row: the EFFECTIVE entry for a server name. `command` is
 *  process-list-visible data only (stdio: command + args; http: the
 *  redacted URL) — env/headers never ride the wire. */
export interface McpServerRowWire {
  readonly name: string;
  readonly tier: "user" | "root" | "project";
  readonly transport: "stdio" | "http";
  readonly command: string;
  /** The earlier same-name tiers this entry replaced ([] when none). */
  readonly replaces: readonly ("user" | "root")[];
  /** This session's runtime lane: 未连接 = not connected YET (lazy load
   *  included), never an error. */
  readonly connected: boolean;
  readonly tools: number;
  readonly failure?: string;
}

/** mcpList's reply. */
export interface McpListResult {
  readonly servers: readonly McpServerRowWire[];
  readonly warnings: readonly string[];
  /** The three config file paths (the tab's where-to-add hints). */
  readonly files: { readonly user: string; readonly root: string; readonly project: string };
}

/** The install-preview counts (the loader dry-run's mapping — the 将安装
 *  numbers an install reply and a discover entry share). */
export interface InstallDetailWire {
  readonly skills: number;
  readonly commands: number;
  readonly agents: number;
  readonly hooks: number;
  readonly mcp: number;
}

/** One discover entry: `detail` carries the counts when the entry's source
 *  resolves to a local directory; `null` for git-location sources
 *  (inspectable only by cloning — render "—"). */
export interface MarketplacePluginEntryWire {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly detail: InstallDetailWire | null;
}

/** One pluginMarketList row: the registered market + its discover entries.
 *  A market whose materialization cannot be read lists with `plugins: []`
 *  (pluginMarketUpdate is the repair path). */
export interface MarketplaceRowWire {
  readonly name: string;
  readonly source: string;
  readonly addedAt: string;
  readonly description?: string;
  readonly plugins: readonly MarketplacePluginEntryWire[];
}

/** pluginMarketList's reply. */
export interface PluginMarketListResult {
  readonly marketplaces: readonly MarketplaceRowWire[];
}

/** pluginMarketAdd / pluginMarketUpdate's reply (the engine's registry row). */
export interface PluginMarketInfoWire {
  readonly name: string;
  readonly source: string;
  readonly addedAt: string;
  readonly description?: string;
}

/** The hot-rescan receipt riding the mutating replies (absent when the
 *  rescan itself failed — the ⚠️ line rides `warnings` instead). */
export interface RescanReceiptWire {
  readonly skills: number;
  readonly plugins: number;
  readonly hooks: number;
}

/** pluginMarketRemove's reply: the cascaded uninstall ids + engine warnings
 *  (e.g. a corrupt install registry removed nothing). */
export interface PluginMarketRemoveResult {
  readonly removedPlugins: readonly string[];
  readonly warnings: readonly string[];
  readonly rescan?: RescanReceiptWire;
}

/** pluginInstall's reply: the installed dir + the install preview. */
export interface PluginInstallResult {
  readonly dir: string;
  readonly detail: InstallDetailWire;
  readonly warnings: readonly string[];
  readonly rescan?: RescanReceiptWire;
}

/** pluginUninstall's reply (`warnings` non-empty when the engine refused to
 *  guess a deletion — e.g. a rootless project record). */
export interface PluginUninstallResult {
  readonly id: string;
  readonly warnings: readonly string[];
  readonly rescan?: RescanReceiptWire;
}

/** pluginEnable / pluginDisable's reply. */
export interface PluginToggleResult {
  readonly id: string;
  readonly enabled: boolean;
  readonly rescan?: RescanReceiptWire;
}

// ---------------------------------------------------------------------------
// 永续 v6 wave2（reef C1）——门控自改进面（PROTOCOL "improvementFace"）。
// The web mirror of the cli improve store's wire rows (.wudao/proposals/ 记录
// 卡——设置→偏好→改进提案 的数据)。Optional-op era：老 server 缺 op → 整节
// 隐藏（零噪音门），绝不白屏。
// ---------------------------------------------------------------------------

/** One improvement record card's status grammar (the two human gates are
 *  offered → consent and gated → activate; the rest is bookkeeping). */
export type ImprovementStatus =
  | "offered"
  | "proposing"
  | "gated"
  | "gate-failed"
  | "rejected"
  | "ignored"
  | "abandoned"
  | "activated"
  | "undone";

/** The paired-replay gate's archived verdict (the card's 门禁 result face). */
export interface ImprovementGateWire {
  readonly ok: boolean;
  readonly reason?: string;
  readonly paired: { readonly baselineOk: boolean; readonly candidateOk: boolean; readonly errors: readonly string[] };
  readonly suites: readonly { readonly name: string; readonly status: string; readonly errors: readonly string[] }[];
  readonly durationMs: number;
  readonly at: string;
}

/** One improvement record (the driver's toImprovementWire row). */
export interface ImprovementWire {
  readonly id: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly stage: string;
  readonly count: number;
  readonly streak: number;
  readonly status: ImprovementStatus;
  readonly attempts: number;
  readonly problemSummary?: string;
  readonly ruleText?: string;
  readonly scope?: string;
  readonly paths?: readonly string[];
  readonly gate?: ImprovementGateWire;
  readonly ruleFile?: string;
  readonly lastError?: string;
  readonly preview?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

/** improvementFace's reply — list carries rows; decisions carry the verdict. */
export interface ImprovementFaceResult {
  readonly ok: boolean;
  readonly message: string;
  readonly records?: readonly ImprovementWire[];
}

// —— protocol.ts 外提（994 行贴帽的头部减重——同文件既有「协议类型/纯函数
// 族外提」范式的续篇；纯移动，零语义变更）——
/** WudaoClient's constructor options (moved from protocol.ts verbatim). */
export interface WudaoClientOptions {
  readonly url: string;
  readonly token: string;
  /** Transport seam (tests inject an in-memory fake). Default: DOM WebSocket. */
  readonly wsFactory?: (url: string) => WebSocketLike;
  /** Reconnect on abnormal close (default true). */
  readonly reconnect?: boolean;
  /** Backoff in ms by attempt number (1-based). */
  readonly backoff?: (attempt: number) => number;
  /** Reconnect attempts before the terminal gave-up state (default 8). */
  readonly maxReconnectAttempts?: number;
  /** Timer seams (tests). Default: the global setTimeout/clearTimeout. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// persona-settings T5 — the persona ops (PROTOCOL "personaList" /
// "personaGet" / "personaSave" / "personaDelete"). The shapes mirror the
// providers package's persona types (packages/providers/src/persona/types.ts
// — the web package never imports it; protocol.ts is its only server
// knowledge, so the structural mirror lives here).
// ---------------------------------------------------------------------------

/** The three wire protocols a persona can carry per-layer overlays for —
 *  the registry key space (mirror of providers ProtocolId). */
export type PersonaProtocolId = "openai-chat" | "anthropic" | "responses";

/** One persona definition (mirror of providers PersonaDefinition). The
 *  server re-validates on save — this type is the WIRE shape, not a
 *  client-side guarantee. */
export interface PersonaDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly source: {
    readonly kind: "workspace-source" | "external-research";
    readonly provenance: string;
    readonly pinnedVersion: string;
  };
  readonly defaultLayers?: { readonly headers?: boolean; readonly body?: boolean; readonly prompt?: boolean };
  readonly headers: Readonly<Partial<Record<PersonaProtocolId, Readonly<Record<string, string>>>>>;
  readonly body?: Readonly<Partial<Record<PersonaProtocolId, Readonly<Record<string, unknown>>>>>;
  readonly prompt?: {
    readonly system?: { readonly mode: "snapshot" | "prefix"; readonly text: string };
    readonly toolNameMap?: Readonly<Record<string, string>>;
  };
  readonly confidence?: "byte-verified" | "community-reverse-engineered";
}

/** One personaList row. `layers` is a display label of the persona's active
 *  layers (e.g. "headers+body" / "all"); `editable` is source === "global"
 *  — builtin and workspace personas are read-only in the settings tab. */
export interface PersonaSummary {
  readonly id: string;
  readonly displayName?: string;
  readonly source: "builtin" | "global" | "workspace";
  readonly layers: string;
  readonly editable: boolean;
}

/** personaList's reply. */
export interface PersonaListResult {
  readonly personas: readonly PersonaSummary[];
}

/** personaGet's reply (the full definition; an unknown id rejects). */
export interface PersonaGetResult {
  readonly definition: PersonaDefinition;
}

/** personaSave's reply: success, or the server's per-field error list —
 *  field-path prefixed (e.g. `headers.anthropic.user-agent: unknown
 *  template slot {{foo}}`), which the form matches back to its rows. */
export type PersonaSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/** personaDelete's reply: success, or the reference inventory when the
 *  persona is still bound (providers bound to it + the global-default
 *  flag) — the confirm card's reference list; the second call with
 *  `{ id, unbind: true }` clears the bindings and lands. */
export type PersonaDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly references: { readonly providers: readonly string[]; readonly isGlobalDefault: boolean } };

// ---------------------------------------------------------------------------
// Transport port (the DOM WebSocket behind a structural seam for tests)
// ---------------------------------------------------------------------------

export interface WsEventMap {
  open: Record<string, never>;
  message: { data: unknown };
  close: { code: number; reason?: string };
  error: Record<string, never>;
}

/** The socket surface WudaoClient needs — the DOM WebSocket satisfies it via
 *  the domWebSocket adapter; tests supply an in-memory fake. */
export interface WebSocketLike {
  /** 0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED (the DOM constants). */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WsEventMap>(type: K, cb: (ev: WsEventMap[K]) => void): void;
}

export const WS_OPEN = 1;

export function domWebSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    addEventListener: (type, cb) => ws.addEventListener(type, cb as unknown as EventListener),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "closed"
  | "auth-failed"
  /** The reconnect cap tripped — the banner offers a manual retry. */
  | "gave-up";

export interface UiSnapshot {
  readonly connection: ConnectionState;
  /** Reconnect attempt count while reconnecting (0 otherwise). */
  readonly reconnectAttempt: number;
  readonly lastClose: { readonly code: number; readonly reason: string } | null;
  readonly status: DriverStatus | null;
  readonly history: readonly HistoryEntry[];
  /** M74-ide §3: how many reset:true history replays have landed (the auth
   *  replay, every reconnect, /clear, resume). Consumers watching history for
   *  NEW entries (the IDE tree's write-refresh) reseed their high-water mark
   *  when this changes — a replay is a replacement, not an append. */
  readonly historyEpoch: number;
  /** ω99-235: #3 — the pet lane's own status (the state frame's `pet` field).
   *  undefined = this server hosts no pet lane (old server / lane occupied)
   *  — the pet relay then derives frames from the MAIN status, today's
   *  behavior. Only a state frame carries it; other channels spread it. */
  readonly pet?: DriverStatus | null;
  /** 多 driver 并发弧 C — 副车道快照表（state 帧 `lanes` 字段的客户端形）。
   *  undefined = 老 server（不发 lanes）——单车道路径字节不变，一切车道面
   *  隐藏；`{}` = 能力在场、零副车道。每车道自带 history/historyEpoch（与
   *  主车道同一套 replace/append 纪律：该车道的 reset 只 bump 它自己的
   *  epoch）。 */
  readonly lanes?: Record<string, LaneSnapshot>;
}

// ---------------------------------------------------------------------------
// 多 driver 并发弧 C（2026-09-16）——副车道（secondary lane）的 wire 镜像族。
// 车道寻址模型：主车道不需要 id（帧/操作不带 sid = 主车道，旧客户端零变
// 化）；每个副车道持一个 lane id（web 端 mint、server 认领——侧栏点开「尚
// 无车道的会话」时 `resume {id, sid}` 就是开车道动作，会话史的 reset 重放
// 帧带同一 sid 收据化这次采纳）。state 帧的 `lanes` 按 lane id 携带每车道
// 的最小状态（busy + 它此刻持有的会话——车道会话可轮换，id ≠ lane id）；
// history 帧的 `sid` 把 entries 路由进对应车道。全部加性可选——老 server
// 不发 lanes/sid、忽略写 op 里的未知 sid 字段，零破坏。
// ---------------------------------------------------------------------------

/** One secondary lane's status on the state frame's `lanes` record. */
export interface LaneStatusWire {
  readonly busy: boolean;
  readonly sessionId: string;
}

/** The client-side per-lane view: the wire status + the lane's own history
 *  channel (entries + epoch — the main lane's replacement discipline, keyed
 *  per lane; a lane's reset bumps ONLY that lane's epoch). */
export interface LaneSnapshot {
  readonly busy: boolean;
  readonly sessionId: string;
  readonly history: readonly HistoryEntry[];
  readonly historyEpoch: number;
}

/** Mint a web-side lane id (the resume-with-sid adoption's `sid` target). */
export function mintLaneId(): string {
  return `L-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** State-frame merge: the incoming lanes record is AUTHORITATIVE for
 *  busy/sessionId/membership (the server re-reads every lane on each push —
 *  the pet 双车道重读纪律), while each lane's history/epoch ride the
 *  client-side snapshot across the merge. A lane absent from the frame is
 *  GONE (the server closed it — its history dies with it); an absent/null
 *  frame field (old server / pre-lanes frame) keeps the previous snapshot
 *  untouched. Returns the PREVIOUS identity when nothing changed (state
 *  frames arrive per keystroke — no churn without a diff). */
export function mergeLaneStatuses(
  prev: Record<string, LaneSnapshot> | undefined,
  next: Record<string, LaneStatusWire> | null | undefined,
): Record<string, LaneSnapshot> | undefined {
  if (next === undefined || next === null) return prev;
  let changed = prev === undefined || Object.keys(prev).length !== Object.keys(next).length;
  const out: Record<string, LaneSnapshot> = {};
  for (const [sid, w] of Object.entries(next)) {
    if (w === null || typeof w !== "object") {
      changed = true; // a malformed row drops (fail-closed membership)
      continue;
    }
    const busy = w.busy === true;
    const sessionId = typeof w.sessionId === "string" ? w.sessionId : "";
    const ex = prev?.[sid];
    if (ex === undefined || ex.busy !== busy || ex.sessionId !== sessionId) {
      out[sid] = { busy, sessionId, history: ex?.history ?? [], historyEpoch: ex?.historyEpoch ?? 0 };
      changed = true;
    } else out[sid] = ex;
  }
  return changed ? out : prev;
}

/** History-frame apply (a frame WITH sid): append/replace into THAT lane
 *  only — the main lane's arrays are never touched. A lane's frame may beat
 *  its first state frame (the adoption race) — the entry auto-creates with a
 *  placeholder status the next state frame reconciles. */
export function applyLaneHistory(
  prev: Record<string, LaneSnapshot> | undefined,
  sid: string,
  entries: readonly HistoryEntry[],
  reset: boolean,
): Record<string, LaneSnapshot> {
  const ex = prev?.[sid];
  return {
    ...(prev ?? {}),
    [sid]: {
      busy: ex?.busy ?? false,
      sessionId: ex?.sessionId ?? "",
      history: reset ? [...entries] : [...(ex?.history ?? []), ...entries],
      historyEpoch: (ex?.historyEpoch ?? 0) + (reset ? 1 : 0),
    },
  };
}

/** The token rides the URL fragment (`http://127.0.0.1:<port>/#<token>`) — it
 *  never appears in a request line. Mirrors the v1-A placeholder's read. */
export function tokenFromLocation(loc: { hash: string } = window.location): string {
  return decodeURIComponent(loc.hash.replace(/^#/, ""));
}

/** M65-space §1: the desktop shell marks its sidecar URL with
 * ?shell=desktop (the Rust navigation adds it before location.replace); the
 * entry reads it and stamps <html data-shell="desktop"> BEFORE first paint,
 * so the topbar's 84px traffic-light inset applies at render. Any other
 * value (or none — a plain browser tab) leaves the attribute unset. */
export function shellFromLocation(loc: { search: string } = window.location): "desktop" | null {
  return new URLSearchParams(loc.search).get("shell") === "desktop" ? "desktop" : null;
}

export function wsUrlFromLocation(loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}`;
}

/** Default reconnect backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap). */
export function defaultBackoff(attempt: number): number {
  return [1000, 2000, 4000, 8000, 16000, 30000][Math.min(attempt - 1, 5)] ?? 30000;
}

/** Reconnect attempts before the terminal gave-up state (the banner's
 *  manual 重连 button resets this). Configurable via the client options. */
export const MAX_RECONNECT_ATTEMPTS = 8;

/** ω-3a: one qualifier per WudaoClient instance. The op envelope's numeric
 *  ids restart at 1 on every page load, so the server's idempotency vault
 *  namespaces them by client instance — a reloaded page must never join or
 *  conflict with the previous page's ops (same id, possibly same payload,
 *  genuinely a new request). Minted once per client; rides every op frame. */
export function mintClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ω-3a: the MUTATIONS the server vaults — and therefore the ops this client
 *  replays on reconnect under their original ids (the vault joins the
 *  original execution or replays its cached result, so the replay never
 *  re-executes what already landed). Reads are NOT here: they keep failing
 *  on a drop (re-executing them would be safe, but serving a 5-minute-cached
 *  read server-side is not — and a fresh fetch is one op away). Dual-form
 *  ops replay only in their mutating form (`switch` with n,
 *  `recentWorkspaces` with add). Mirrors the server's isVaultedMutation. */
export function isRetryableMutation(op: ClientOp): boolean {
  switch (op.op) {
    case "submit":
    case "interrupt":
    case "setMode":
    case "answerPermission":
    // 借鉴弧 α2/α1 — vaulted on the server, retried here: both converge on
    // replay (nothing left parked/queued answers false), and the vault keeps
    // a mid-flap replay from re-executing against a MOVED queue.
    case "recallSteer":
    case "answerAskUser":
    // 借鉴弧 δ — the same family law: convergent refusals on replay, the
    // vault keeps a mid-flap replay from detaching a MOVED busy row.
    case "detachToolCall":
    case "resume":
    case "rewind":
    // ω-3a review M1 follow-up: /edit arming is a mutation (an armed edit
    // branch is driver state) — replayed like every other vaulted mutation.
    case "edit":
    case "settingsSaveKey":
    case "settingsSet":
    // Provider management §5: a provider write is a side effect that must
    // survive a mid-flap replay exactly once — vaulted like settingsSet
    // (delete converges on replay, the /models probe is a read: not vaulted).
    case "settingsSaveProvider":
    case "switchWorkspace":
    case "panelRootSet":
    case "agentRootSwitch":
    case "attachmentSave":
    // ω99-55: the file lane's save writes content-addressed objects — a
    // mutation the server vaults (mirrors its isVaultedMutation).
    case "fileSave":
    case "pluginMarketAdd":
    case "pluginMarketUpdate":
    case "pluginMarketRemove":
    case "pluginInstall":
    case "pluginUninstall":
    case "pluginEnable":
    case "pluginDisable":
    // persona-settings T5: persona writes are side effects — vaulted like
    // the other registry mutations (delete converges on replay).
    case "personaSave":
    case "personaDelete":
    // ω99-235: #5 — the pet lane's ops are mutations of the SECOND driver
    // session — replayed like their main-lane twins (mirrors the server's
    // isVaultedMutation).
    case "petSubmit":
    case "petInterrupt":
    case "petAnswerPermission":
    // ω99-260: the memory decision is a side effect — vaulted like the
    // other registry mutations (ok/del converge on replay; a replayed
    // second ok answers ok:false, never breaks).
    // ω99-264: the memory REWRITE is the same kind of side effect — its
    // replay convergence is the driver's content-equal short-circuit.
    case "memoryDecide":
    case "memoryEdit":
    // ω99-314: the time machine's restore is a working-face side effect —
    // replayed (mirrors the server's isVaultedMutation) so a mid-flap retry
    // joins the original execution, never double-reverts.
    case "fileRevert":
    // ω99-317: the schedules management writes — setEnabled is a state write
    // (settingsSet shape), runNow would double-run on a mid-flap replay —
    // both replayed (mirrors the server's isVaultedMutation). The delete
    // (schedulesRemove) converges on replay and stays out, the
    // sessionDelete precedent.
    case "schedulesSetEnabled":
    case "schedulesRunNow":
      return true;
    // 永续 v6 wave2（reef C1）：改进提案面的五个决策是写副作用（镜像服务端
    // isVaultedMutation——consent 起子代理、activate 写规则文件，恰一次）；
    // list 是读，不 retry。
    case "improvementFace":
      return op.action !== "list";
    case "switch":
      return op.n !== undefined;
    case "recentWorkspaces":
      return op.add !== undefined;
    default:
      return false;
  }
}

