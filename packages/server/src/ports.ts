// @wudao/server — the localhost WS protocol server for an AgentDriver (M43-A
// §2). node:http serves the static frontend (placeholder when absent) and
// carries the WS endpoint; `ws` is the ONLY new runtime dependency. The server
// is transport-only: it relays the driver's two channels (append-only history,
// small full-snapshot status) and ops, and owns none of the agent logic — the
// driver is injected as the structural UiDriverPort below (the CLI's
// AgentDriver satisfies it; this package never imports the CLI, keeping the
// workspace graph acyclic).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
// ω99-242 — the crash-recovery coordinator's server-facing slice + the
// status row type (the recoveryStatus op's reply shape). The coordinator
// itself lives in recovery.ts; this file only mounts it like petDriver.
import type { RecoveryStatusRow } from "./recovery.js";

export type {
  RecoveryJournalEntry,
  RecoveryJournalFold,
  FoldSessionState,
  RecoveryObservation,
  RecoveryClassification,
  RecoverySettle,
  RecoveryPort,
  RecoveryStatusRow,
  RecoveryCoordinatorOptions,
  RecoveryCoordinator,
} from "./recovery.js";
export {
  createRecoveryJournal,
  foldRecoveryLines,
  classifyRecovery,
  createRecoveryCoordinator,
  RECOVERY_INTERVAL_MS,
  RECOVERY_CONCURRENCY,
  RECOVERY_ROTATION_BOUND,
} from "./recovery.js";

/** Loopback hostnames the Host header may carry (DNS-rebinding guard)。*/
/** Close codes (documented in PROTOCOL.md)。*/
/** ω99-225: the resume verdict relayed verbatim — a structural mirror of the
 *  CLI's ResumeOutcome (this package never imports the CLI; the shapes are
 *  kept identical by the twin tests in each package). `occupied` carries the
 *  live lease holder's pid so the web can tell a busy session from a missing
 *  one instead of guessing off the old bare boolean. */
// —— UI 端口类型族外提（ω99 拆分运动：纯移动段外提；原文件 re-export 门面）——
export type ResumeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "occupied"; readonly holderPid: number };

/** The driver surface this server speaks to (structural — no CLI import).
 *  Payloads are JSON-serializable values the server relays verbatim. */
export interface UiDriverPort {
  subscribe(cb: () => void): () => void;
  getStatus(): unknown;
  getHistory(): readonly unknown[];
  onHistory(cb: (entries: readonly unknown[], reset: boolean) => void): () => void;
  onLoopEvent(cb: (event: unknown) => void): () => void;
  submit(text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly unknown[]; readonly files?: readonly unknown[] }): unknown;
  interrupt(): void;
  /** 0.4.0 集成缝：车道工厂打开后恢复到该会话（主 driver 的同形方法）。 */
  resume(id: string): Promise<{ ok: boolean; not_found?: boolean; occupied?: { pid: number } }>;
  setMode(mode: string): void;
  answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): boolean;
  /** 借鉴弧 α2（CC 2.1.269 思想）— recall ONE still-queued steering message
   *  (CAS: index+text from the same status frame; consumed entries → false).
   *  User lane only. OPTIONAL like searchSessions: the ui host's ask-lane
   *  wrapper mounts it; a driver without it cleanly refuses (server op). */
  recallSteer?(index: number, text: string): boolean;
  /** 借鉴弧 α1（Codex 0.154 思想）— answer the parked ask_user clarification
   *  card (an absent/empty answer = dismiss → the tool's error result tells
   *  the model to decide itself). Returns false when nothing is parked.
   *  OPTIONAL — mounted by the same ask-lane wrapper. */
  answerAskUser?(answer?: string): boolean;
  /** 借鉴弧 δ（penguin 367ab084 思想）— move ONE in-flight tool call to the
   *  background (its result stops blocking the turn; the run closes at the
   *  turn boundary; the landed result merges later). callId from the status
   *  frame's busyTools rows; absent = the first detachable row. Typed
   *  refusals: {kind:"refused", reason:"not_detachable"|"not_in_flight"}.
   *  OPTIONAL like recallSteer — mounted by the settings-ops wrapper. */
  detachToolCall?(callId?: string): unknown;
  listSlashCommands(): readonly unknown[];
  sessions(): Promise<readonly unknown[]>;
  // ω99-277: #3 — 弹框全文搜索（PROTOCOL "sessionSearch"）：q 直传
  // driver.searchSessions，命中数组原样回。OPTIONAL like branchLeaves ——
  // 无该方法的 driver 干净拒答（真实车道由 withSettingsOps 显式转发）。
  searchSessions?(q: string): Promise<readonly unknown[]>;
  // ω99-279: #6 — 回收站式删除（PROTOCOL "sessionDelete"）：id 直传
  // driver.deleteSession，结果原样回（{deleted:true} 唯一成功形；false 三因
  // invalid-id/not-found/active）。OPTIONAL like searchSessions —— 无该方法
  // 的 driver 干净拒答。删除收敛（absent 即 goal state，
  // settingsDeleteProvider 先例）——读表语义，never vaulted。
  deleteSession?(id: string): Promise<unknown>;
  // ω99-283: #3 — 回收站面两 op（PROTOCOL "sessionTrashList" /
  // "sessionRestore"）：列表零参直通 driver.trashSessions；恢复 id 直传
  // driver.restoreSession，结果联合原样回（{restored:true} 唯一成功形；
  // false 三因 invalid-id/not-found/target-exists）。OPTIONAL like
  // deleteSession —— 无该方法的 driver 干净拒答。恢复收敛同删除（重放落
  // target-exists/not-found，零盘触碰）——读表语义，never vaulted。
  trashSessions?(): Promise<readonly unknown[]>;
  restoreSession?(id: string): Promise<unknown>;
  // ω99-286: #4 — 断点续跑（PROTOCOL "sessionContinue"）：id 直传
  // driver.continueSession，结果联合原样回（{started:true} 唯一成功形；
  // false 三因：invalid-id 形状拒 / not-found / 尾形已 settled 或 busy 不
  // 空转——driver 收敛，重放零双跑）。OPTIONAL like deleteSession —— 无该
  // 方法的 driver 干净拒答。启动非 vaulted 写语义（写面同 submit 族，但
  // driver 的 busy/尾形门让 mid-flap 重放收敛 started:false——无需 vault；
  // isVaultedMutation 零动）。
  continueSession?(id: string): Promise<unknown>;
  // 小精灵会话弧 — 会话级 fork 的驱动面（PROTOCOL "resume" 携 fork:true 时
  // 调用）：字节复制源会话 JSONL 到全新 id，再把本 driver resume 到副本上
  // （原会话文件永不以写模式打开——CLI --fork-session 的 forkSessionFile
  // 能力经 op 通道复用）。回执联合 {ok:true,forkedId} | {ok:false,reason:
  // "busy"|"not_found"|"occupied",holderPid?}（fork+resume 两段合一，一次
  // op 一个回执）。vaulting 蹭既有 resume 条目（op 名不变，digest 覆盖整
  // 个 op 对象含 fork 字段——mid-flap 重放重发原回执，绝不双 fork）。
  // OPTIONAL like continueSession —— 无该方法的 driver 干净拒答（老 server
  // 降级=web 追问入口收到失败回执）。
  forkSession?(id: string): Promise<unknown>;
  // ω99-313: 定时任务与提醒的读面（PROTOCOL "schedulesList"）：零参直通
  // driver.schedulesList，行数组原样回（id/kind/prompt/trigger 人话/
  // nextRunAt/enabled/paused/sessionId?——侧栏 ⏰ 标记按 sessionId join）。
  // OPTIONAL like sessionContinue —— 无该方法的 driver 干净拒答。纯读
  // store，never vaulted。
  schedulesList?(): Promise<unknown>;
  // ω99-317 — 定时任务管理面的写面三件（PROTOCOL "schedulesSetEnabled" /
  // "schedulesRemove" / "schedulesRunNow"）：typed 门 → optional-port 检查 →
  // 结果联合 {ok,message}（driver 的守护中文回执原样中继）原样回。
  // OPTIONAL like schedulesList —— 无该方法的 driver 干净拒答。删除是
  // 收敛写（never vaulted）；setEnabled/runNow 是 VAULTED mutations
  // （mid-flap 重放恰好一次——runNow 重放会双跑）。
  schedulesSetEnabled?(id: string, enabled: boolean): Promise<unknown>;
  schedulesRemove?(id: string): Promise<unknown>;
  schedulesRunNow?(id: string, opts?: { readonly resetBreaker?: boolean }): Promise<unknown>;
  resume(id: string): Promise<ResumeOutcome>;
  rewind(target: number | "last" | "list"): Promise<string>;
  /** M53 §1: /edit arming — returns the original text (null when out of
   *  range or a run is in flight) so the web input can present it. */
  beginEdit(n: number): string | undefined;
  /** M53 §1: /tree //switch notice text. */
  tree(): Promise<string>;
  switchBranch(n?: number): Promise<string>;
  // ω99-258: #5 — 面二（branchLeaves 读 op + edit n:0 解除门）。
  /** ω99-258: the structured branch leaf table (PROTOCOL "branchLeaves") —
   *  tree()'s data twin for the web branch panel: rows of {n, leafKey,
   *  forkPreview, messageCount, isCurrent}. OPTIONAL like the settings ops —
   *  a driver without it gets a clean "unsupported" error (old-server
   *  degradation is the CLIENT's chip-hidden branch). Read-only, never
   *  vaulted. */
  branchLeaves?(): Promise<unknown>;
  /** ω99-258: void a pending /edit arm (the web banner's 取消 — edit op with
   *  n:0). OPTIONAL for the same reason; absent → the op refuses. */
  disarmEdit?(): boolean;
  // ω99-260: #5 — 面二（memoryList 读 op + memoryDecide 决定 op）。
  /** ω99-260: the full memory ledger (PROTOCOL "memoryList") — the store's
   *  load() table passed through structured (file order, active + pending)
   *  for the web memory faces. OPTIONAL like branchLeaves — a driver without
   *  it gets a clean "unsupported" error (old-server degradation is the
   *  CLIENT's hidden face). Read-only, never vaulted. */
  memoryList?(): Promise<unknown>;
  /** ω99-260: decide one pending memory (PROTOCOL "memoryDecide") — ok
   *  (confirm, pending→active) or del (remove the line); store.confirm/
   *  remove are the single source. VAULTED: the decision is a side effect
   *  that must survive a mid-flap replay exactly once, and ok/del converge
   *  (a replayed second ok answers ok:false, never breaks). */
  memoryDecide?(id: string, action: "ok" | "del"): Promise<unknown>;
  /** ω99-264: #2 — rewrite one memory entry's content (PROTOCOL "memoryEdit") —
   *  update + a conditional confirm (status-preserving: active stays active,
   *  pending stays pending; tags/hits ride verbatim). VAULTED like the
   *  decision, but the convergence lives in the DRIVER: a bare update is
   *  NOT idempotent (v+1 per call), so the driver short-circuits a
   *  content-equal replay (ok:true, zero writes) — a mid-flap replay lands
   *  exactly once. */
  memoryEdit?(id: string, content: string): Promise<unknown>;
  // 永续 v6 wave2（reef C1）：门控自改进面（improvementFace）——读+决定
  // 一体 op。list 是纯读（memoryList 同形，never vaulted）；consent/ignore/
  // activate/reject/undo 是写副作用（VAULTED——consent 会起子代理+模型调用，
  // activate 写规则文件；重放恰一次，收敛在驱动状态机的 MISS 形）。
  improvementFace?(action: "list" | "consent" | "ignore" | "activate" | "reject" | "undo", id?: string): Promise<unknown>;
  // M63 §B — the settings/credentials ops (all OPTIONAL: a driver without
  // them gets a clean "unsupported" error instead of a crash). They ride the
  // SAME first-frame auth as every other op — there is no unauthenticated
  // settings surface. KEY HYGIENE: the server strips any `key` field from
  // these ops' replies at the protocol boundary, so a saved or tested key is
  // never sent back to the client (statuses only).
  /** The provider matrix + credentials count + settings values (no secrets). */
  settingsStatus?(): Promise<unknown>;
  /** Persist one provider key to the credentials file (cli-side write). */
  settingsSaveKey?(provider: string, key: string): Promise<unknown>;
  /** One minimal request through the target provider; human failure states. */
  settingsTestConnection?(provider: string, opts?: { readonly key?: string; readonly model?: string }): Promise<unknown>;
  /** Write one allowlisted settings key — the 13 writable keys (ω99-237: #2 —
   *  see settingsSet's unknown-key error in driver/settings-ops.ts, the
   *  single source of truth; this mirror once drifted to "8" when the
   *  language pair landed uncounted; ω99-287: #5 bumps 12→13 with
   *  desktop.backgroundOnClose, doc-only). */
  settingsSet?(key: string, value: unknown): Promise<unknown>;
  // Provider management §5 — the registry ops (OPTIONAL like the settings
  // ops; same first-frame auth, same reply stripping). `config` is REGISTRY
  // config only (the handler re-validates it — API keys never ride these
  // paths; settingsSaveKey owns keys). Reply shapes: {ok:true,provider} |
  // {ok:false,error} for the save, {ok:true} | {ok:false,error} for the
  // delete (builtin ids refuse), and the /models probe's
  // {ok:true,models:[{name,contextLength?}]} | {ok:false,state,message}.
  /** Register/update one provider (custom or builtin overlay) in the
   *  machine registry; the reply is status-only. */
  settingsSaveProvider?(id: string, config: unknown): Promise<unknown>;
  /** Remove one registry entry (customs only); a stored defaultModel
   *  pointing at the deleted id falls back. Idempotent. */
  settingsDeleteProvider?(id: string): Promise<unknown>;
  /** Probe GET ${endpoint}/models through the target provider (the
   *  testConnection key ladder + failure states); the request key never
   *  echoes back. */
  settingsListModels?(provider: string, opts?: { readonly key?: string }): Promise<unknown>;
  /** M75-ux1 §2: the workspace switcher's recents (PROTOCOL "recentWorkspaces")
   *  — read the list, or (with `add`) unshift + persist + read. No separate
   *  write op: the switch click adds through the same handler. */
  recentWorkspaces?(add?: string): Promise<unknown>;
  /** M77-workspace §1: same-window switch — starts a new UI session for the
   *  target directory and returns its URL; the client navigates there. */
  switchWorkspace?(path: string): Promise<unknown>;
  // M74-ide §1 — the file-panel data ops (OPTIONAL like the settings ops; a
  // driver without them gets a clean "unsupported" error). Read-only
  // listing/reading for the IDE's left/middle panels: they never ride the
  // permission pipeline (that is the agent tools' path) — the handler
  // enforces workspace containment plus the data-panel sensitive-path list
  // itself, so the relay below stays shape-validation only.
  /** One directory level: dirs first alphabetically, then files; dotfiles
   *  and the hidden list carry hidden:true (the CLIENT filters). */
  fileTree?(path: string): Promise<unknown>;
  /** One file's UTF-8 content (1MB limit / 100KB prefix, binary sniff);
   *  sensitive paths (.git, .ssh, .env*, credentials*) reject. */
  fileRead?(path: string): Promise<unknown>;
  /** 高亮/编辑 spec §3: the viewer's save — user-hand edit, no permission
   *  pipeline; the driver enforces the read-side guards + the base
   *  compare-and-swap + the atomic write. */
  fileWrite?(path: string, content: string, base: string): Promise<unknown>;
  /** ω99-314: 文件级时光机——把指定文件恢复到指定快照（改动面板「恢复到
   *  这里」的引擎）。写面 op：VAULTED（isVaultedMutation），一次重放绝不
   *  双写。守卫序与判决联合见 driver 的 fileRevert（busy/evicted/bad-path/
   *  no-store 拒；ok:true 带 stale 事实）。OPTIONAL like fileWrite — 无该
   *  方法的 driver 干净拒答（老 server 降级=面板恢复钮隐藏）。 */
  fileRevert?(path: string, sha: string): Promise<unknown>;
  /** workspace-ux B1: switch the file panel's VIEW root (PROTOCOL
   *  "panelRootSet") — exists-and-directory validated driver-side; the
   *  reply carries the new root. Deliberately NOT the agent root: the
   *  session and its tool boundary never move (that is agentRootSwitch's
   *  job, B2). */
  panelRootSet?(path: string): Promise<unknown>;
  /** workspace-ux B1: the dual-root snapshot (PROTOCOL "agentRootStatus") —
   *  panelRoot (the view) vs agentRoot (the session's workspace root) and
   *  whether they still agree. */
  agentRootStatus?(): Promise<unknown>;
  /** workspace-ux B2: switch the agent's workspace root (PROTOCOL
   *  "agentRootSwitch") — idle applies now ({applied:true}); busy parks until
   *  the run's settle seam ({queued:true}). Moves the builtin file tools'
   *  boundary, shell's cwd, the FileChanged watchers, and the hook
   *  payload root — NEVER the system prompt, the session id, or any .wudao
   *  anchor. */
  agentRootSwitch?(path: string): Promise<unknown>;
  /** M76-ux2 §8: the ctx hover's breakdown (PROTOCOL "ctxInfo") — the
   *  serialized prompt's per-section token estimates + the free remainder
   *  (the StatusBar ctx segment's tooltip data). Read-only over driver
   *  state; the relay below is a pass-through. */
  ctxInfo?(): Promise<unknown>;
  /** The away recap (PROTOCOL "recap"): stats counted from the
   *  session's structured history since the viewer's mark, plus an optional
   *  narrative from one tiny background model call. The reply is the payload
   *  or undefined (a legitimate "no recap", not an error). Session identity,
   *  the mark, and the ≥3-new-messages gate live in the driver handler
   *  (agent-driver.ts) — the relay stays shape-validation only. */
  recap?(sessionId: string, sinceMark: number, sinceTs?: number): Promise<unknown>;
  /** ω99-316 — /btw 侧问 (PROTOCOL "sideQuestion"): ask the session's
   *  side lane a question without interrupting the main run — a detached
   *  loop over a sanitized clone of the request-time projection (frozen
   *  tool table, maxTurns=3), answering {answer, rounds}. Read-only over
   *  the session (never writes JSONL/store — a replay just re-asks, never
   *  vaulted). Session identity and the empty-text gate live in the driver
   *  handler; the relay stays shape-validation only. */
  sideQuestion?(sessionId: string, text: string): Promise<unknown>;
  // M79 §4 — the attachment ops (OPTIONAL like the settings/file ops; a
  // driver without them gets a clean "unsupported" error). Same first-frame
  // auth as every op. The web composer (M79b) saves images here BEFORE
  // submit, then sends the returned refs on the submit envelope's optional
  // `images` field — the session log only ever sees refs.
  /** Admit a base64 image batch → durable refs (limits live in the driver's
   *  AttachmentStore: fail-closed admission BEFORE any write). */
  attachmentSave?(inputs: readonly { data: string; mediaType: string }[]): Promise<unknown>;
  /** One stored image back as base64 (for rendering history images). */
  attachmentGet?(ref: { attachmentId: string; mediaType: string; byteLength: number }): Promise<unknown>;
  // ω99-55 — the file lane of the SAME attachment domain (OPTIONAL like the
  // image ops). The composer saves generic files here BEFORE submit (bytes
  // cross the wire exactly once, inside this op's inputs), then sends the
  // returned FileBlocks on the submit envelope's optional `files` field; the
  // session log only ever sees blocks, the model only ever sees the
  // projected handle text naming the saved read-only path.
  /** Admit a base64 generic-file batch → content-addressed FileBlocks
   *  (fail-closed admission BEFORE any write; equal bytes dedup). */
  fileSave?(inputs: readonly { data: string; name: string }[]): Promise<unknown>;
  // cc-plugins C1 — the plugin-management ops (OPTIONAL like the settings
  // ops; a driver without them gets a clean "plugin ops not supported"
  // error). Same first-frame auth as every op. The handler owns the
  // marketplace engine; engine failures reject with the engine's message
  // (passthrough — the err string IS the contract), and the two
  // directory-deleting ops (uninstall, marketplace remove — cascade) refuse
  // while a run is in flight (the CLI handler enforces the busy law: the
  // web client can call ops anytime, so the driver's slash-path guard is
  // not the only gate).
  /** The install registry + enable state (the settings page's 已装 list). */
  pluginList?(): Promise<unknown>;
  /** MCP visibility (settings page's MCP tab): every configured server
   *  across the three tiers with runtime status. */
  mcpList?(): Promise<unknown>;
  /** Every registered market + its discover entries (with install-preview
   *  counts for local-dir sources; null for git-location sources). */
  pluginMarketList?(): Promise<unknown>;
  /** Add a market from a source (owner/repo · git URL#ref · 本地目录 ·
   *  marketplace.json 路径); `name` overrides the manifest's own. */
  pluginMarketAdd?(source: string, name?: string): Promise<unknown>;
  /** Re-pull / re-copy one registered market. */
  pluginMarketUpdate?(name: string): Promise<unknown>;
  /** Unregister + delete a market, cascading the uninstall of the plugins
   *  it installed (busy → refusal error, nothing touched). */
  pluginMarketRemove?(name: string): Promise<unknown>;
  /** Install a market's plugin into a scope root (reply carries the loader
   *  dry-run's InstallDetail). */
  pluginInstall?(name: string, market: string, scope: "user" | "project"): Promise<unknown>;
  /** 引导安装（guided-install 弧）：spec 三形态（本地路径/GitHub 简写/git URL）+ 可选预览。 */
  pluginInstallSpec?(spec: string, preview?: boolean): Promise<unknown>;
  /** 长期记忆（M-Memory）：列表 + tombstone 删除。 */
  longtermMemoryList?(): Promise<unknown>;
  longtermMemoryForget?(id: string): Promise<unknown>;
  /** Delete the install dir + registry record + enable key (busy → refusal). */
  pluginUninstall?(id: string): Promise<unknown>;
  /** Re-enable a disabled plugin (deletes the enabledPlugins key). */
  pluginEnable?(id: string): Promise<unknown>;
  /** Hide a plugin from discovery's mapping (registry record kept). */
  pluginDisable?(id: string): Promise<unknown>;
  // SDD 2026-08-23 persona Task 5 — the persona-management ops (OPTIONAL like
  // the settings ops; absent → a clean "persona ops not supported" error).
  // Same first-frame auth. Reads reject on an unknown id; personaSave refuses
  // with the validator's per-field error list (builtin/workspace id
  // collisions included — the wire's {ok:false, errors[]} shape); personaDelete
  // reports the referencing providers when the persona is still bound, and
  // {id, unbind:true} clears the bindings (cards back to key-absent + the
  // global default cleared) before deleting the file.
  /** Every registered persona (builtin + global + workspace) with its tier
   *  source, layers label, and edit gate (global only). */
  personaList?(): Promise<unknown>;
  /** One persona's full definition (unknown id rejects). */
  personaGet?(id: string): Promise<unknown>;
  /** Create/update one GLOBAL persona (~/.wudao/personas/<id>.json). */
  personaSave?(definition: unknown): Promise<unknown>;
  /** Delete one global persona; the reference inventory when bound. */
  personaDelete?(id: string, unbind?: boolean): Promise<unknown>;
}

/** ω99-235: #1 — the pet lane's server surface (this file's whole lane: the
 *  narrow port below, the optional UiServerOptions.petDriver mount, the three
 *  pet ops (#3), the dual-lane state frames (#4/#5), the sessions lane mark
 *  (#6), and the vaulted-set join (#2)). The desktop sprite's own session —
 *  a SECOND driver the same host process mounts beside the main one. The
 *  five-method slice is all the pet ops and the state frame's `pet` field
 *  consume — history/loop-events/settings/plugin surfaces stay main-lane-only
 *  (no /commands, no resume).
 *  ω99-271: #2 — the "Bubble is a pure send face: no history replay" premise
 *  is RETIRED (user report 09-10: 「很多消息没有展示完全，也看不到完整的会话
 *  信息」): the lane driver HAS the full pet.jsonl history (ui.ts resumes it
 *  into getHistory at boot) — the window just had no way to ask. The port
 *  gains ONE read; the send-face discipline (no commands, no resume, no
 *  loop-event relay) stands. */
export interface UiPetDriverPort {
  subscribe(cb: () => void): () => void;
  getStatus(): unknown;
  submit(text: string): unknown;
  interrupt(): void;
  answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): boolean;
  /** ω99-271 — the lane's own session history (pet.jsonl, already
   *  branch-walked at boot). Structurally minimal read: `text` optional so
   *  the driver's HistoryEntry union (tool/edit/board entries lack text)
   *  assigns without a cli-side type dependency. */
  getHistory(): readonly { kind: string; text?: string }[];
}

/** 多 driver 并发弧 B —— sid 寻址车道的驱动面：UiDriverPort 的交互切片
 *  （状态/历史两个中继道 + submit/interrupt/setMode/answerPermission 四个
 *  必选写面 + recallSteer/answerAskUser/detachToolCall 三个可选写面）。
 *  结构化注入如 UiDriverPort：本包不 import cli，真实副车道由宿主的车道
 *  管理器装配传入（参照 pet 车道的降配清单）。完整 UiDriverPort 天然满足
 *  本接口（必需面全在场）——主车道就是 opts.driver 原样入表（key "main"）。
 *  会话寻址面（resume/sessions/settings/file/plugin/persona/…）刻意不在
 *  本接口：v1 车道弧只车道化「交互写面 + 两个中继道」（见 PROTOCOL.md
 *  Lanes 节）。 */
export interface LaneDriverPort {
  /** 状态帧订阅：任何车道的 emit 都触发一次全表重读合并推送。 */
  subscribe(cb: () => void): () => void;
  /** 车道状态快照（推送时重读——永不携带陈旧车道态）。 */
  getStatus(): unknown;
  /** 车道当前史（auth 重放面 + petHistory 式拉取的数据源）。 */
  getHistory(): readonly unknown[];
  /** 史推送道：副车道帧由 server 侧统一标注 sid，driver 自身零感知。 */
  onHistory(cb: (entries: readonly unknown[], reset: boolean) => void): () => void;
  submit(text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly unknown[]; readonly files?: readonly unknown[] }): unknown;
  interrupt(): void;
  /** 0.4.0 集成缝：车道工厂打开后恢复到该会话（主 driver 的同形方法）。 */
  resume(id: string): Promise<{ ok: boolean; not_found?: boolean; occupied?: { pid: number } }>;
  setMode(mode: string): void;
  answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): boolean;
  /** 以下三面 OPTIONAL——与 UiDriverPort 的同款可选面同形，server op 层
   *  沿用「not supported by this driver」干净拒答族。 */
  recallSteer?(index: number, text: string): boolean;
  answerAskUser?(answer?: string): boolean;
  detachToolCall?(callId?: string): unknown;
}

/** ω99-242: #3 — the crash-recovery coordinator's server-facing slice (the
 *  petDriver mounting precedent: a host process owns the coordinator and
 *  mounts it here; the server relays its status and forwards the ONE
 *  invalidation seam). All three members are OPTIONAL-mounted: absent → the
 *  recoveryStatus op answers a clean "not supported" and the submit op's
 *  invalidation call is skipped — today's byte-identical behavior.
 *  M24 声明（§二.10）：恢复注入发生在 resume 边界=冷转预期（cold turn
 *  expected）——详见 recovery.ts 头注与弧报告。 */
export interface UiRecoveryPort {
  /** A manual client submit landed on the driver's CURRENT session — cancel
   *  that session's pending recovery (invariant 7; permission replies ride
   *  answerPermission and deliberately never reach this seam). */
  noteUserInput(): void;
  /** Structured per-session rows (the web reconciliation line's X/Y). */
  status(): readonly RecoveryStatusRow[];
  /** Graceful-shutdown checkpoint — freeze the in-flight session before the
   *  engine dies (the orphan self-exit path calls this before exit(0)). */
  stop(): Promise<void>;
}

/** ω99-235 — the pet lane's fixed session id, as a SERVER-SIDE LITERAL: this
 *  package never imports the CLI (the workspace graph stays acyclic), so the
 *  twin of cli/src/ui.ts's exported PET_SESSION_ID lives here — the pet-ops
 *  tests pin both sides to the same bytes ("pet"). */
export const PET_LANE_SESSION_ID = "pet";

// ω99-272: #3 — petHistory 全保真（用户令 09-10「本地转写无限」+ 报障「看不
// 到完整的会话信息」）：271 的轮上限 50 / 单轮字上限 8000（保头尾 + 中段省略
// 标注）全撤——史是「完整会话信息」的承载体，任何 server 侧截断都会让宠物窗
// 拿到一套被裁过的假史；可读性由宠物窗折叠 UI 承接，不靠丢内容。配对规则不
// 动：user.text 开轮、其后非空 assistant.text 以 \n\n 连接、error 只在无
// assistant 文本时兜底为 a、其余 kind（tool/notice/board/…）跳过、无先导
// user 的悬挂 assistant 丢弃。

export interface PetHistoryTurnWire {
  readonly q: string;
  readonly a: string;
}

/** Pair the lane driver's session history into chat turns for the pet window. */
