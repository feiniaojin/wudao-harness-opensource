// ω99 拆分运动：协议类型/纯函数族（自 protocol.ts 外提；文件头文档见 protocol.ts）。
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
import type { ImageBlockWire, FileBlockWire, ImageAttachmentRefWire, PersonaDefinition, LaneStatusWire } from "./protocol-wire.js";
// —— 协议类型/纯函数族外提（ω99 拆分运动：纯移动段外提）——
export type Mode = "workspace" | "ask" | "auto" | "plan";

/** The submit op's outcome word (PROTOCOL "submit"). M80: "cleared" — the
 *  driver's own /clear arm (conversation wiped, session id rotated, its
 *  history-reset frame owns the view). */
export type SubmitOutcome = "started" | "steered" | "notice" | "noop" | "frontend" | "cleared";

/** Mirrors cli/src/permission.ts modeLabel. 0.3.13: the display word is
 *  the Claude-Code-style vocabulary — workspace shows as "accept" (≈ CC
 *  acceptEdits); the mode VALUE stays workspace (persistence and the wire
 *  protocol are unchanged). plan already displays as "plan". */
export {
  isSwitchableModel,
  modelPickCommand,
  languagePickCommand,
  languageDefaultKey,
} from "./protocol-commands.js";
export type { LanguageKnob } from "./protocol-commands.js";

export function modeLabel(mode: Mode): string {
  return mode === "workspace" ? "accept" : mode;
}

/** The WEB's shift+tab order — the 0.3.14 four-mode cycle, same stop order
 *  as the CLI (workspace → ask → auto → plan → workspace). */
export function cycleMode(mode: Mode): Mode {
  return mode === "workspace" ? "ask" : mode === "ask" ? "auto" : mode === "auto" ? "plan" : "workspace";
}

/** 0.3.15（用户需求：LLM 回复耗时展示）：毫秒 → 紧凑时长（回复卡 meta 用）。
 *  `<0.1s`（百毫秒内）/ `2.1s`（一分钟内，一位小数）/ `3m07s`（一小时内）/
 *  `1h04m`。与 cli 侧 formatMs 同一规则——web 不 import cli，两端各持一份。 */
export function formatDur(ms: number): string {
  if (ms < 100) return "<0.1s";
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s);
  if (total < 3_600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3_600)}h${String(Math.floor((total % 3_600) / 60)).padStart(2, "0")}m`;
}

/** One in-flight tool (the live busyTools list; `gating` = sidecar check in
 *  flight — the 🛡 检查中 badge). ω99-63 (additive-only): `callId` is the
 *  call's id (lands at tool_call_started), `tail` the call's live-output
 *  bounded tail (driver-side ≤2000 chars; append→append→snapshot folding).
 *  The server relay is transport-only — both ride the state verbatim; absent
 *  on pre-ω99-63 servers, and rows without them render byte-identically. */
export interface LiveBusyTool {
  readonly name: string;
  readonly summary: string;
  readonly gating?: boolean;
  readonly callId?: string;
  readonly tail?: string;
}

/** 借鉴弧 δ — the mid-flight detach verdict (the driver's typed union,
 *  mirrored on the wire). ok = the request reached the loop's race (the
 *  next status frame carries the truth); refused carries the typed reason
 *  for the busy-row button's honest disable/reply. */
export type DetachVerdictWire =
  | { readonly kind: "ok"; readonly callId: string; readonly toolName: string }
  | { readonly kind: "refused"; readonly reason: "not_detachable" | "not_in_flight"; readonly toolName?: string };

export interface LiveState {
  readonly reasoning: string;
  /** 0.3.8：reasoning 流仍在进行（driver 的 reasoning_delta 置 true、
   * assistant_delta 置 false）——思考块据此自动展开/收起。可选：老 server
   * 无此字段按收起渲染，行为与 0.3.7 一致。 */
  readonly thinking?: boolean;
  readonly answer: string;
  readonly busyTools: readonly LiveBusyTool[];
}

/** ω99-318 — 审批面 Unicode 视觉欺骗防线的手工镜像（PendingPermission 的
 *  加性可选载荷）。单一事实源在 core（unicode-security.ts）；这里只镜像
 *  wire 形状——绝不复制码点表（源检验、边渲染：server 纯透传，字段自动
 *  过境）。缺省=干净输入/老 server：渲染零变化（加性契约）。 */
export interface SpoofInspection {
  readonly text: readonly {
    readonly key: string;
    readonly issues: readonly { readonly codepoint: string; readonly nameZh: string; readonly position: number; readonly category: string }[];
    /** 超出 issue 帽的剩余数量（0=未超帽）。 */
    readonly more?: number;
  }[];
  readonly urls: readonly { readonly key: string; readonly original: string; readonly normalizedUrl: string; readonly warnings: readonly string[] }[];
}

/** A parked permission ask (state.pendingPermission) — the y/a/N modal's
 *  data. settingsFile degrades the answer set to plain y/N; sidecar carries
 *  the M45 classifier reason; warning is the git-risk block. */
export interface PendingPermission {
  readonly toolName: string;
  readonly summary: string;
  readonly input: Record<string, unknown>;
  readonly settingsFile?: string;
  readonly warning?: string;
  readonly sidecar?: string;
  /** ω99-318: the visual-spoof inspection (codepoint badges + URL
   *  true-targets), computed at the driver's ask seam. Reveal-not-block —
   *  presence changes only what the eye sees, never the answer set. */
  readonly spoof?: SpoofInspection;
}

/** 借鉴弧 α1（Codex 0.154 思想）— 停泊中的 ask_user 澄清卡（state.
 *  pendingAskUser）：agent 运行中需要用户澄清时的问题+建议选项 chips+
 *  自由输入面。answerAskUser(answer?) 作答或解散；问答进历史沿用 ask_user
 *  既有契约（tool_use + tool_result）。OPTIONAL：老 server 无此字段 → 无卡，
 *  零变化。 */
export interface PendingAskUser {
  readonly question: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
}

/** ω99-216（托付闭环·亲验改动）：一条回合净变更收据的轻摘要行——相对
 *  路径 / 新建或修改 / 本轮写入次数。before/after 全内容快照绝不入历史
 *  （detail 已有渲染后的 diff）；面板的「+M/−K 行」不解析（渲染层不当
 *  数据层）。server 纯透传，字段自动过境。
 *  ω99-288: #6 — 「+M/−K 行」在数据层补齐：settle 时从 diff hunk 累计
 *  过境（可选、append-only——老收据缺省、老前端不读零变化）；渲染层仍
 *  不当数据层，分色只是排版。 */
export interface HistoryChange {
  readonly path: string;
  readonly op: "created" | "modified";
  readonly writes: number;
  /** 本轮该文件净增行数（hunk `+` 行累计；老收据缺省）。 */
  readonly plus?: number;
  /** 本轮该文件净删行数（hunk `-` 行累计；老收据缺省）。 */
  readonly minus?: number;
  /** ω99-314: 本轮开始前内容在快照仓里的指针（可恢复面的判据——「恢复到
   *  这里」按此渲染；恢复时原样回传 fileRevert）。可选、append-only——老
   *  收据缺省、老前端不读零变化。 */
  readonly beforeSha?: string;
  /** ω99-319: 命令级归因标记——该行的改动来自这条 shell 命令（命令原文的
   *  200 字符帽截断）。带此标记的行渲染「命令改动」徽标（title=命令原文）
   *  并与同命令行连续分组（组头可一键整组回退）。可选、append-only——老
   *  收据缺省、老前端不读零变化；只进 UI 历史永不进模型上下文。 */
  readonly cmd?: string;
}

/** The history channel's entry shapes (HistoryEntry over the wire). */
export type HistoryEntry =
  /** M79b: user entries carry their submit's image refs (durable pointers —
   *  never bytes; the same ImageBlockWire the submit envelope took). Absent
   *  on pre-M79 servers and text-only turns — always optional. */
  | { kind: "user"; text: string; images?: readonly ImageBlockWire[]; files?: readonly FileBlockWire[] }
  | { kind: "assistant"; text: string; /** 0.3.8（用户反馈：think 过程要展示）：思考流。0.3.29（#302 分段）：多轮工具回合里每次模型调用的分段条目携带该调用窗口内的 reasoning 切片，落定条目只带最后一段——时间序与正文对齐。可选、append-only——UI 历史展示用，与 LLM 上下文无关。 */ reasoning?: string; /** 0.3.15（用户需求：LLM 回复耗时展示）：本回合最后一次模型调用的 durationMs（provider 实测墙钟，reasoning+正文全程）。可选、additive-only——脚本模型/未知网关不上报时缺省，老 server 不受影响。 */ durationMs?: number; /** v7 γ3：本轮实际服务模型回执——fallback 链换腿作答时该轮答案出自谁（「实际用了什么」与 provider 面板的「配置了什么」互补）。omit-when-no-fallback：主模型作答=整字段缺席零噪音。老 server 不受影响。 */ servedBy?: { readonly model: string; readonly from?: string } }
  | {
      kind: "tool";
      name: string;
      summary: string;
      isError?: boolean;
      resultPreview?: string;
      /** UI-4 C10: the finished call's duration, mirrored by the driver from
       *  the tool's finished event (gate + execution, ω-5b I21). The server
       *  relay is transport-only — the field rides the entry verbatim, so it
       *  is purely additive on the wire. Absent on board-mapped results and
       *  pre-I21 history: always optional, never assumed. */
      durationMs?: number;
      /** ω99-125：交付物文件卡——make_xlsx/make_pptx 收据的结构化一行由 driver 提取（名字门控，非通用嗅探）；缺省=老 server/老历史零变化。可选、append-only。 */
      file?: { readonly path: string; readonly name: string; readonly bytes: number };
    }
  | { kind: "edit"; path: string; oldString: string; newString: string }
  | { kind: "board"; done: number; total: number; lines: string[] }
  | { kind: "notice"; text: string; /** 0.3.7（0.3.6 反馈追修）：meta_note 全文（剥信封、保留换行）。可选、append-only——预览行截断/折叠丢信息时才携带，气泡渲染展开箭头。 */ detail?: string; /** 0.3.9（用户裁定）：模型可见的注入上下文置 true——回复卡形态渲染；胶囊专属 harness 内部状态（与模型上下文无关）。可选、append-only。 */ card?: boolean; /** 0.3.10（用户反馈：「系统注入」太笼统）：注入来源标注（如「SessionStart 钩子（startup）」「记忆召回」）——渲染为卡的署名；缺省回退「系统注入」。可选、append-only。 */ source?: string; /** ω99-216: #2（托付闭环·亲验改动）——回合净变更收据的轻摘要（HistoryChange；server 纯透传自动过境），会话改动面板的聚合数据源。可选、append-only：老历史缺省、老前端不读零变化；只进 UI 历史永不进模型上下文。 */ changes?: readonly HistoryChange[] }
  | { kind: "divider"; text: string }
  | { kind: "error"; text: string };

/** The state channel's full snapshot (PROTOCOL "state" — never history). */
export interface DriverStatus {
  readonly live: LiveState;
  readonly busy: boolean;
  readonly queued: readonly string[];
  readonly boardProgress: { readonly done: number; readonly total: number } | null;
  readonly ctxTokens: { readonly used: number | null; readonly window: number; readonly nearLimit: boolean } | null;
  readonly mode: Mode;
  readonly cachePercent: number | null;
  readonly bg: { readonly active: number; readonly spawned: number };
  readonly pendingPermission: PendingPermission | null;
  /** 借鉴弧 α1 — the parked ask_user clarification card (OPTIONAL: an old
   *  server / an unwired host sends nothing → no card, zero change). */
  readonly pendingAskUser?: PendingAskUser | null;
  readonly planBoard: string | null;
  readonly sessionId: string;
  readonly sidecar: { readonly checks: number; readonly breakerOpen: boolean } | null;
  /** M57 §2: the model segment's data — current identity + the switchable
   *  matrix (the structured bare /model listing). Optional: protocol v1
   *  servers without it simply hide the clickable segment. */
  readonly model?: {
    readonly label: string;
    readonly provider?: string;
    readonly choices: readonly {
      readonly provider: string;
      readonly model: string;
      readonly source: string;
      /** Task 5: the choice's registered context window (when the registry
       *  catalogs one) — the picker's window placeholder; absent =
       *  uncataloged. */
      readonly contextLength?: number;
    }[];
  } | null;
  /** 推理档三级配置 S4 (spec 2026-08-28 §4): the session-effective language
   *  pair — the SAME fold the next submit's transient blocks use (the live
   *  /language lane). Optional: protocol-v1 servers without it simply hide
   *  the language chip. */
  readonly language?: { readonly reply: "auto" | "on" | "off"; readonly reasoning: "auto" | "zh" | "en" | "off" };
  /** ω99-249: #11 — the live goal's face — the status strip's「目标」segment.
   *  Optional and nullable: an old server (or a session with no budgeted
   *  mission task claimed) sends nothing / null and the segment simply does
   *  not render (quiet degradation). */
  readonly goal?: {
    readonly objective: string;
    readonly status: "active" | "paused" | "budget_limited";
    readonly usedTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly budgetTokens?: number;
    readonly missionTaskId: string;
    readonly progress: { readonly done: number; readonly total: number };
  } | null;
  /** ω99-253: #10 — the agent root's git branch — the status strip's branch chip
   *  (a property of the 224 workspace anchor, not a new status item).
   *  "HEAD" = a detached checkout shown verbatim; null / absent (old
   *  server, non-repo, read failure) renders NOTHING — the zero-noise
   *  gate, no placeholder. */
  readonly gitBranch?: string | null;
  /** ω99-255: #2 — the session's current name (the auto-title / /rename
   *  landing). NOT a display source (the sidebar's rows are the store's
   *  truth) — it is a CHANGE SIGNAL: App watches it across frames and bumps
   *  the sessions refresh epoch when it changes, so an auto-titled session
   *  surfaces in the sidebar with zero new ops. Absent (old server) or
   *  null = no signal, quiet. */
  readonly sessionName?: string | null;
  /** ω99-268: #2 — the memory store's content signature
   *  (`count:pending:maxVersion`). Same lane as sessionName: NOT a display
   *  source (the list data rides the memoryList op unchanged) — the 管理记忆
   *  panel and the boot 待审卡 watch it across frames and REFETCH when it
   *  changes, so other windows' decisions/edits and this process's own
   *  Dream/refine landings stay visible while a face is open. Absent (old
   *  server / no workspace) = no signal, quiet — fetch-on-open bytes. */
  readonly memorySignature?: string;
}

/** M57 §2: is this choice switchable in-session? Same provider only —
 *  baseURL + API key are provider-bound, everything else needs the restart
 *  (the picker disables those entries with the hint). Mirrors the driver's
 *  resolveModelArgument rule. M63 §A: the picker no longer DISABLES the
 *  false rows — it routes them through /provider; this predicate now names
 *  which LANE a row rides. */
/** The EffortSelector footer's provider-effort pin: the settingsSaveProvider
 *  payload REPLACES the registry row wholesale (the F1 rule), so the pin
 *  must echo EVERY field the wire card carries — exactly the ProviderDetail
 *  save payloads' rule, built from the card (server truth) instead of an
 *  edit draft. Pure. */
export function providerEffortSavePayload(card: ProviderCard, effort: string): Record<string, unknown> {
  const models = card.models.map((m) => (m.contextLength != null ? { name: m.name, contextLength: m.contextLength } : { name: m.name }));
  return card.custom
    ? {
        ...(card.label !== "" ? { label: card.label } : {}),
        baseUrl: card.baseUrl ?? "",
        ...(card.defaultModel !== "" ? { defaultModel: card.defaultModel } : {}),
        ...(card.defaultContextLength != null ? { defaultContextLength: card.defaultContextLength } : {}),
        ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
        ...(card.wire !== undefined ? { wire: card.wire } : {}),
        ...(card.persona !== undefined ? { persona: card.persona } : {}),
        models,
        effort,
      }
    : {
        // Builtin → OVERLAY payload: the compiled profile's fields ride
        // ALONGSIDE the pin, never replaced (a bare {effort} would eat the
        // overlay — the same reason ProviderDetail's builtin lane echoes).
        models,
        ...(card.reasoningFormat !== undefined ? { reasoningFormat: card.reasoningFormat } : {}),
        ...(card.wire !== undefined ? { wire: card.wire } : {}),
        ...(card.persona !== undefined ? { persona: card.persona } : {}),
        effort,
      };
}

/** Downstream frames (server → client). */
/** 多 driver 弧 C：加性车道寻址——state 帧的 lanes / history 帧的 sid / 写 op 的可选 sid（缺省=主车道；老 server 忽略未知字段零破坏）。 */
export type ServerFrame =
  /** ω99-235: #2 — the OPTIONAL `pet` field on the state frame — the pet
   *  lane's own driver snapshot (the same DriverStatus mirror over the
   *  SECOND session; absent on servers without the lane, in which case the
   *  pet relay degrades to the main lane). */
  | { t: "state"; state: DriverStatus; pet?: DriverStatus | null; lanes?: Record<string, LaneStatusWire> | null }
  | { t: "history"; entries: readonly HistoryEntry[]; reset?: boolean; sid?: string }
  | { t: "event"; event: unknown }
  | { t: "result"; id: number; ok?: unknown; err?: string };

/** ω99-258: #8 — 面二 web 半（BranchLeaf 镜像 + branchLeaves/disarmEdit 客户端）。
 * one switchable branch leaf — the web mirror of the driver's
 *  BranchLeaf (M53 core semantics; forkPreview is the 60-char cap of the
 *  fork point's turn, "" for the trunk root). Optional-op era: an old server
 *  without the branchLeaves op makes the caller's fetch reject — the branch
 *  chip hides, never a white screen. */
export interface BranchLeaf {
  readonly n: number;
  readonly leafKey: string;
  readonly forkPreview: string;
  readonly messageCount: number;
  readonly isCurrent: boolean;
}

/** ω99-260: #6 — 面三 web 半（MemoryEntry 镜像 + memoryList/memoryDecide
 * 客户端）。one memory ledger row — the web mirror of the store's MemoryEntry
 * (the FULL field table; `surfaced`/`seq`/`version` ride the wire but the v1
 * UI does not consume them — surfaced NEVER keys the 待审卡, which counts
 * `status==="pending"` because the session-engine boot has usually already
 * marked entries surfaced). Optional-op era: an old server without the
 * memoryList op makes the caller's fetch reject — both memory faces hide,
 * never a white screen. */
export interface MemoryEntry {
  readonly id: string;
  /** fact | preference | skill_note | harness. */
  readonly kind: string;
  readonly content: string;
  /** project | user. */
  readonly scope: string;
  readonly tags: readonly string[];
  readonly created: string;
  /** Shadow-ranking telemetry (被想起 N 次 — observed only, never ranking). */
  readonly hits: number;
  /** active = 生效 (recalled); pending = 待审 (awaiting the user's decision). */
  readonly status: "active" | "pending";
  readonly surfaced?: boolean;
  readonly seq?: number;
  readonly version?: number;
}

/** ω99-260: the memory decision's verdict — the driver's structured reply
 * (ok / message; the MISS message is the honest "没有这条待审记忆"). */
export interface MemoryDecideResult {
  readonly ok: boolean;
  readonly message: string;
}

/** ω99-264: #4 — the memory rewrite's verdict — the same {ok, message} shape the
 *  decide op rides (`已改写一条记忆` / `已改写一条记忆（仍待你确认）` / the
 *  MISS "没有这条记忆（可能已处理过）"). A type alias, not a second shape:
 *  the wire carries one verdict grammar for both memory mutations. */
export type MemoryEditResult = MemoryDecideResult;

/** ω99-271 — the pet lane's history turn (the server pairs pet.jsonl into
 *  these): q = the user line, a = the joined non-empty assistant texts of
 *  the round (or the run's error text when it never answered). Caps live
 *  server-side: 50 turns, 8000 chars per turn with an explicit mid-omit
 *  marker — truncation is never silent. */
export interface PetTurnWire {
  readonly q: string;
  readonly a: string;
}

/** Upstream ops (client → server), minus the auth frame. */
export type ClientOp =
  | { op: "submit"; text: string; plan?: boolean; expand?: boolean; images?: readonly ImageBlockWire[]; files?: readonly FileBlockWire[]; sid?: string }
  | { op: "interrupt"; sid?: string }
  | { op: "setMode"; mode: Mode; sid?: string }
  | { op: "answerPermission"; allow: boolean; reason?: string; /** 0.3.14 #1: the answer's scope — "session"/"always" record a rule (absent = once). */ scope?: "session" | "always"; sid?: string }
  | { op: "recallSteer"; index: number; text: string; sid?: string }
  | { op: "answerAskUser"; answer?: string; sid?: string }
  /** 借鉴弧 δ（penguin 367ab084 思想）— move ONE in-flight tool call to the
   *  background: its result stops blocking the turn (the run closes at the
   *  turn boundary), the landed result merges later through the background
   *  lane. callId from the status frame's busyTools rows; absent = the
   *  first detachable row. Vaulted like recallSteer (convergent refusals). */
  | { op: "detachToolCall"; callId?: string; sid?: string }
  /** ω99-235: #1 — the pet lane's ops (the sprite's own SECOND driver session;
   *  a server without the lane answers a clean "pet ops not supported by this
   *  driver" and the relay degrades to the main lane). text-only v1: Bubble
   *  is a pure send face — no images/files/plan on this lane. Vaulted like
   *  their main-lane twins. */
  | { op: "petSubmit"; text: string }
  | { op: "petInterrupt" }
  | { op: "petAnswerPermission"; allow: boolean; reason?: string; scope?: "session" | "always" }
  /** ω99-271: #5 — the pet lane's history READ (the 260 memoryList
   *  precedent: never vaulted). Answers the pet window's structural
   *  truncation (500-char tail frames + local 3-turn transcript) with the
   *  lane driver's own paired pet.jsonl turns. */
  | { op: "petHistory" }
  | { op: "listSlashCommands" }
  | { op: "sessions" }
  /** ω99-277: #5 — the session-picker's full-text search READ (the 260
   *  memoryList precedent: never vaulted). q is passed through verbatim;
   *  hits carry session identity + kind + a ±30-char snippet. */
  | { op: "sessionSearch"; q: string }
  /** ω99-279: #7 — the session-picker's trash delete（回收站式：the file
   *  moves into the sessions dir's .trash/ subdirectory — recoverable,
   *  never rm'd; sessions/sessionSearch both hide it）. Converges on replay
   *  (an absent file is the goal state — the settingsDeleteProvider
   *  precedent): a READ for census/vaulting, never vaulted, never replayed. */
  | { op: "sessionDelete"; id: string }
  /** ω99-283: #4 — the session-picker's trash face（回收站）: the trashed
   *  sessions' rows (the ONLY reader of .trash/) + the one-click restore
   *  (link+unlink back into the sessions dir — atomic no-overwrite: a live
   *  session owning the id refuses with target-exists, its bytes untouched).
   *  Both converge like their delete twin (a replay lands target-exists /
   *  not-found and touches nothing): READS for census/vaulting. */
  | { op: "sessionTrashList" }
  | { op: "sessionRestore"; id: string }
  /** ω99-286: #5 — 断点续跑（durable runs L1）：把「没跑完的会话」原样续跑
   *  （不注引导语——前缀字节稳定）。started:true 唯一成功形；false 收敛
   *  （id 不在 / 尾形已 settled / busy 不空转）。NOT vaulted：driver 的
   *  busy/尾形门让 mid-flap 重放收敛 started:false（写语义同 submit 族，
   *  但重放零双跑——无需 vault）。 */
  | { op: "sessionContinue"; id: string }
  /** ω99-313 — 定时任务与提醒的读面：行带人话触发器（「每周一、周三
   *  09:00」）/ 下跑时间 / 状态位 / 会话绑定（侧栏 ⏰ 标记按 sessionId
   *  join）。纯读 store，never vaulted。 */
  | { op: "schedulesList" }
  /** ω99-317 — 定时任务管理面三写：暂停/恢复（=pause/unpause，unpause 兼
   *  任熔断重开）、删除（.wudao 调度条目，绝不触碰用户文件）、立即试跑
   *  （busy 守卫 + 显式熔断复位旗）。回执联合 {ok,message}（守护中文回执
   *  原样中继）。setEnabled/runNow 是 VAULTED（重放恰好一次）；remove 收
   *  敛（读表）。 */
  | { op: "schedulesSetEnabled"; id: string; enabled: boolean }
  | { op: "schedulesRemove"; id: string }
  | { op: "schedulesRunNow"; id: string; resetBreaker?: boolean }
  | { op: "resume"; id: string; sid?: string; /** 小精灵会话弧 — 追问形：字节
   *  复制该会话到全新 id 后 resume 副本（原会话永不改写；回执联合=
   *  ResumeForkOutcome）。vaulting 蹭既有 resume 条目（op 名不变）。 */
    fork?: true }
  | { op: "rewind"; target: number | "last" | "list" }
  /** M53 §1: arm message n for editing — the result carries the original
   *  text (null when out of range / busy) for the input box. ω99-258: n:0 is
   *  the DISARM form (the armed banner's cancel; reply true). */
  | { op: "edit"; n: number }
  | { op: "tree" }
  | { op: "switch"; n?: number }
  /** ω99-258: the structured branch leaf table (read) — the web branch panel's rows; old servers answer an err and the chip hides. */
  | { op: "branchLeaves" }
  /** ω99-260: the full memory ledger (read) — the 待审卡/管理面's data; old servers answer an err and both faces hide. */
  | { op: "memoryList" }
  /** ω99-260: decide one pending memory (vaulted like settingsSet — ok/del
   *  converge on replay; a replayed second ok answers ok:false). */
  | { op: "memoryDecide"; id: string; action: "ok" | "del" }
  /** ω99-264: rewrite one memory entry's content — status-preserving (active
   *  stays active, pending stays pending). Vaulted; the DRIVER short-circuits
   *  a content-equal replay, so a mid-flap replay converges (version 恰 +1). */
  | { op: "memoryEdit"; id: string; content: string }
  /** 永续 v6 wave2（reef C1）：门控自改进面——list 拉全部提案记录卡；五个
   *  决策=两道人工门+簿记（consent/ignore/activate/reject/undo）。决策
   *  vaulted（consent 起子代理、activate 写规则文件——恰一次），重放收敛
   *  MISS 形。 */
  | { op: "improvementFace"; action: "list" | "consent" | "ignore" | "activate" | "reject" | "undo"; id?: string }
  /** M63 §B settings ops (same first-frame auth; replies are status-only). */
  | { op: "settingsStatus" }
  | { op: "settingsSaveKey"; provider: string; key: string }
  | { op: "settingsTestConnection"; provider: string; key?: string; model?: string }
  | { op: "settingsSet"; key: string; value: unknown }
  /** Provider management §5: register/update one provider in the machine
   *  registry (~/.wudao/providers.json) — a custom or a builtin overlay.
   *  `config` is REGISTRY config only (baseUrl/defaultModel/models/…): it
   *  arrives as an opaque object the server re-validates, and API keys NEVER
   *  ride it (settingsSaveKey owns them, into .credentials.yaml). The reply
   *  is status-only; a vaulted mutation like settingsSet. */
  | { op: "settingsSaveProvider"; id: string; config: unknown }
  /** Provider management §5: remove one registry entry. Customs only — a
   *  builtin id refuses (the compiled profile always exists); a stored
   *  model.defaultModel pointing at the deleted id falls back. Idempotent:
   *  an already-absent row is the goal state, so the op is NOT vaulted. */
  | { op: "settingsDeleteProvider"; id: string }
  /** Provider management §5: probe GET ${endpoint}/models through the target
   *  provider (a read — never vaulted). `key` tests an unsaved paste, absent
   *  → the resolved key (the testConnection ladder); the request key NEVER
   *  echoes back — replies carry models/failure states only. */
  | { op: "settingsListModels"; provider: string; key?: string }
  /** M75-ux1 §2: the workspace switcher's recents (PROTOCOL "recentWorkspaces")
   *  — read the list, or (with `add`) unshift + persist + read through the
   *  same handler (there is no separate write op). */
  | { op: "recentWorkspaces"; add?: string }
  /** M77-workspace §1: same-window switch — starts a new UI session for the
   *  target directory and returns its URL; the client navigates there.
   *  @deprecated workspace-ux B: the old "switch directory = switch session"
   *  model. The web no longer calls it — panelRootSet (immediate view
   *  re-root) + agentRootSwitch (confirmed agent re-root, session preserved)
   *  replaced it. The op stays on the wire for older clients only. */
  | { op: "switchWorkspace"; path: string }
  /** M74-ide §1: the file-panel data ops (path = workspace-relative; "" =
   *  root). Errors (path escape, sensitive path, missing target) reject the
   *  promise with the server's err string. */
  | { op: "fileTree"; path: string }
  | { op: "fileRead"; path: string }
  /** 高亮/编辑 spec §3: the viewer's save — user-hand edit, NOT a model
   *  action (never rides the permission pipeline). `base` is the content
   *  the editor opened with; the driver compares it to disk
   *  (compare-and-swap), so a replay can never double-write. NOT vaulted:
   *  the CAS makes an auto-replay converge to a conflict reply, which is
   *  noise for a user edit — the 保存 button is the retry. */
  | { op: "fileWrite"; path: string; content: string; base: string }
  /** ω99-314: 文件级时光机——把指定文件恢复到指定快照（改动面板「恢复到
   *  这里」的引擎；sha 来自该行的 beforeSha）。VAULTED（写面 side effect：
   *  mid-flap 重放 join 原执行，绝不双恢复）。守卫序与判决联合见
   *  FileRevertResult。 */
  | { op: "fileRevert"; path: string; sha: string }
  /** ω99-316: /btw 侧问——主任务跑着时旁路问一句、不写回主会话（「顺便问」
   *  chip 的引擎）。NOT vaulted（读面：detached loop 克隆投影作答，绝不写
   *  session JSONL/store——重放=重新问一次）。回执见 SideQuestionResult。 */
  | { op: "sideQuestion"; sessionId: string; text: string }
  /** workspace-ux B1: the panel-root ops. panelRootSet switches the file
   *  panel's VIEW root (exists-and-directory validated driver-side — a
   *  nonexistent/non-directory path rejects with the typed error); the
   *  reply's root is the caller's display source. agentRootStatus reads the
   *  dual-root snapshot. Neither touches the session: busy-safe by design. */
  | { op: "panelRootSet"; path: string }
  | { op: "agentRootStatus" }
  /** workspace-ux B2: switch the AGENT's workspace root (the confirm-card
   *  action after a panelRootSet) — idle applies now ({applied:true}); busy
   *  parks until the run's settle seam ({queued:true} — the in-flight run
   *  keeps the old root throughout). The driver appends the landing notice
   *  to the history channel itself; the caller never re-appends it. */
  | { op: "agentRootSwitch"; path: string }
  /** M76-ux2 §8: the ctx hover's breakdown (PROTOCOL "ctxInfo") — read-only
   *  over live driver state; errors on an old server (the StatusBar falls
   *  back to the plain ctx segment). */
  | { op: "ctxInfo" }
  /** ω99-213: #4 — the away recap (PROTOCOL "recap"): what landed in the
   *  session since THIS viewer's mark (an index into the history channel the
   *  client mirrors 1:1 — count entries, not local notes). `sinceTs` is the
   *  viewer's own last-visible timestamp, echoed back in stats.sinceTs so the
   *  card can render the away span. Resolves undefined = no recap (session
   *  mismatch / below the dual gate) — a legitimate quiet answer, not an
   *  error. */
  | { op: "recap"; sessionId: string; sinceMark: number; sinceTs?: number }
  /** ω99-242: #8 — the recovery reconciliation surface: per-session rows counted
   *  by the server's crash-recovery coordinator (journal settle records —
   *  receipt-verified completions + remaining mission tasks). A READ; old
   *  servers answer an err (callers treat that as "no banner", quiet). */
  | { op: "recoveryStatus" }
  /** PB-2 — 探针遥测读面三 op（server-answered，recoveryStatus 同族；纯读
   *  never vaulted；probeStream 订阅后事件走 {t:"probe"} 帧）。 */
  | { op: "probeStream"; cat?: string } | { op: "probeRecent"; cat?: string; limit?: number } | { op: "probeStats" } | { op: "probeEnable"; on: boolean } | { op: "sessionAnatomy" }
  /** M79 §4: admit base64 images → durable refs (fail-closed admission in
   *  the driver's AttachmentStore BEFORE any write; the error string names
   *  TOO_MANY_IMAGES / IMAGES_TOO_LARGE / the invalid field). */
  | { op: "attachmentSave"; inputs: readonly { data: string; mediaType: string }[] }
  /** M79 §4: one stored image back as base64 (rendering history images). */
  | { op: "attachmentGet"; ref: ImageAttachmentRefWire }
  /** ω99-55: admit base64 generic files → content-addressed FileBlocks
   *  (fail-closed admission BEFORE any write; bytes cross the wire exactly
   *  once, inside this op's inputs). */
  | { op: "fileSave"; inputs: readonly { data: string; name: string }[] }
  /** cc-plugins C1: the plugin-management ops (PROTOCOL "pluginList" …
   *  "pluginDisable"). Engine failures reject with the marketplace engine's
   *  message; the two directory-deleting ops refuse while a run is in
   *  flight (the 「⚠️ 运行中无法 …（任务进行中）」 family). */
  | { op: "pluginList" }
  | { op: "pluginMarketList" }
  | { op: "pluginMarketAdd"; source: string; name?: string }
  | { op: "pluginMarketUpdate"; name: string }
  | { op: "pluginMarketRemove"; name: string }
  | { op: "pluginInstall"; name: string; market: string; scope: "user" | "project" }
  | { op: "pluginInstallSpec"; spec: string; preview?: boolean }
  | { op: "longtermMemoryList" }
  | { op: "longtermMemoryForget"; id: string }
  | { op: "pluginUninstall"; id: string }
  | { op: "pluginEnable"; id: string }
  | { op: "pluginDisable"; id: string }
  /** MCP visibility: every configured MCP server across the three tiers
   *  (user ~/.wudao/mcp.json · root .mcp.json · project .wudao/mcp.json)
   *  with runtime status. Read-only; secrets never ride the reply. */
  | { op: "mcpList" }
  /** Persona ops (persona-settings T5): list every registered persona
   *  (builtin + global + workspace), read one full definition, save one
   *  global persona (create or update), delete one global persona (with the
   *  unbind escape hatch). Reads reject on an unknown id; saves reject with
   *  a field-path error list; deletes report the referencing providers when
   *  the persona is bound (the confirm card's reference list). */
  | { op: "personaList" }
  | { op: "personaGet"; id: string }
  | { op: "personaSave"; definition: PersonaDefinition }
  | { op: "personaDelete"; id: string; unbind?: boolean };

/** The /resume picker's row (collectSessionRows over the wire; mtime is an
 *  ISO string — JSON has no Date). */
export interface SessionRow {
  readonly id: string;
  readonly mtime: string;
  readonly messages: number;
  readonly firstUser: string;
  readonly model: string;
  readonly name?: string;
  /** ω99-235: the pet lane's fixed row carries lane:"pet" (the sidebar's
   *  小精灵 badge; the row must NOT resume — the lane is live in the sprite
   *  window, the lease refuses adoption). Absent on every other row. */
  readonly lane?: "pet";
  /** ω99-286（续，标记见上）— 该会话有「没跑完的 turn」（app 退出/崩溃的
   *  尾部形状派生；sessions 行的断点续跑位）。OPTIONAL：旧 server 的行无
   *  此字段——读侧一律 `?? false` 容忍（能力缺席=面隐藏）。 */
  readonly unfinished?: boolean;
  /** ω99-289: #3 — 该会话以「跑失败的回合」收尾（run 错误收束落的合成
   *  "(error: …)" 尾派生；sessions 行的失败重试位）。OPTIONAL：旧 server
   *  的行无此字段——读侧一律 `?? false` 容忍（能力缺席=面隐藏，unfinished
   *  同款先例）。 */
  readonly errored?: boolean;
}

/** ω99-286（续，标记见上）— 断点续跑的结果联合镜像（cli driver 是源头；
 *  the web keeps its own copy, it imports neither — SessionDeleteResult
 *  先例）。started:true 唯一成功形；false 收敛（id 不在 / 尾形已
 *  settled / busy 不空转——重放安全，零双跑）。 */
export type SessionContinueResult = { readonly started: boolean };

/** ω99-313 — 定时任务与提醒的行镜像（cli 的 ScheduleListRow 是源头；同
 *  SessionRow 的自家拷贝纪律——跨包零 import）。trigger 是人话日历文本
 *  （绝不出现 cron 内部词）；nextRunAt 是 epoch ms 或 null。 */
export interface ScheduleListRow {
  readonly id: string;
  readonly kind: "task" | "reminder";
  readonly prompt: string;
  readonly trigger: string;
  /** 借鉴弧 ε — 触发大类（calendar=看钟 | event=盯信号）；缺省=calendar
   *  （老 server 行的加性缺省，面板零崩）。 */
  readonly triggerKind?: "calendar" | "event" | "idle";
  /** 借鉴弧 ε — 事件源（file/webhook）；非 event 行缺省。 */
  readonly eventSource?: "file" | "webhook";
  readonly nextRunAt: number | null;
  readonly enabled: boolean;
  readonly paused: boolean;
  /** ω99-317: 最近一次触发（busy-skip 也算）；老 server 行缺省 → null。 */
  readonly lastFiredAt?: number | null;
  /** ω99-317: 连败计数（仅 spawn 车道计）；缺省 → 0。 */
  readonly consecutiveFailures?: number;
  /** ω99-317: 最近一次运行结果（schedules 会话日志 join）；缺省 → null。 */
  readonly lastRun?: { readonly ok: boolean; readonly at: number; readonly mode?: string } | null;
  readonly sessionId?: string;
}

/** ω99-317 — 管理面写 op 的结果联合镜像（cli 的 ScheduleActionResult 是
 *  源头；自家拷贝纪律同上）。message 是守护中文回执原样；ok=false 即拒答
 *  （回执以 ⚠️ 开头）。 */
export interface ScheduleActionResult {
  readonly ok: boolean;
  readonly message: string;
}

// ω99-277（续，标记见上）— a full-text search hit (sessionSearch's reply row;
// the cli's driver/session-search.ts is the source — the web keeps its own
// copy, it imports neither). name is "" when the session has no name entry
// (the picker's name→firstUser→id8 ladder owns the fallback).
export interface SessionSearchHit {
  readonly sessionId: string;
  readonly name: string;
  readonly firstUser: string;
  /** The session file's mtime ISO (ordering). */
  readonly mtime: string;
  readonly kind: "user" | "assistant";
  /** The ±30-char context around the match ("…" marks a clipped side). */
  readonly snippet: string;
}

// ω99-279（续，标记见上）— the trash-delete verdict's type mirror (the cli's
// driver/session-delete.ts is the source; the web keeps its own copy, it
// imports neither). deleted:true is the ONLY success shape; the three false
// reasons branch the toast (active = in use; not-found = already gone —
// replay-safe convergence; invalid-id = a malformed id refused before disk).
export type SessionDeleteResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: "invalid-id" | "not-found" | "active" };

// ω99-283（续，标记见上）— the trash-restore verdict's type mirror (the cli's
// driver/session-delete.ts is the source; the web keeps its own copy, it
// imports neither — the SessionDeleteResult precedent). restored:true is the
// ONLY success shape; the three false reasons branch the toast (target-exists
// = a live session already owns the id, nothing overwritten; not-found = the
// trash copy is gone — replay-safe convergence; invalid-id = a malformed id
// refused before disk).
export type SessionRestoreResult =
  | { readonly restored: true }
  | { readonly restored: false; readonly reason: "invalid-id" | "not-found" | "target-exists" };

// ω99-225: #4 — the resume verdict's type mirror (the CLI/server twin is the
// source; the web keeps its own copy — it imports neither). The old bare
// boolean conflated "held by another process" with "does not exist" and the
// toast had to guess; the outcome object makes the refusal actionable.
export type ResumeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "occupied"; readonly holderPid: number };

// 小精灵会话弧 — resume 的 fork 形（追问）回执联合镜像（cli driver 的
// settings-ops.forkSession 是源头；自家拷贝纪律同上）。ok:true 唯一成功
// 形，forkedId=副本会话 id（视图随主车道的 reset 帧自然切过去）；三路
// 拒答：busy=主车道正在跑（换血不能打断回合）、not_found=源会话不存在
// 或不可读、occupied=副本 resume 撞租约（罕见——全新 v7 id）。
export type ResumeForkOutcome =
  | { readonly ok: true; readonly forkedId: string }
  | { readonly ok: false; readonly reason: "busy" | "not_found" }
  | { readonly ok: false; readonly reason: "occupied"; readonly holderPid: number };

// ---------------------------------------------------------------------------
// M63 §B — the settings ops (PROTOCOL "settingsStatus" / "settingsSaveKey" /
// "settingsTestConnection" / "settingsSet"). No key material EVER flows
// downstream: the server strips secret fields from every settings reply, and
// the payloads below are the status-only shapes the handler returns.
// ---------------------------------------------------------------------------

/** One provider card's status dot data (deepseek/glm/qwen/wudao=兼容端点 +
 *  registry customs). Provider management §5 extends the card with the
 *  registry facts the detail panel renders; the pre-§5 fields are unchanged. */
export interface ProviderCard {
  readonly provider: string;
  readonly label: string;
  /** ready = key resolvable (env or file) AND endpoint known. */
  readonly status: "ready" | "missing-key" | "missing-endpoint";
  readonly keySource: "env" | "credentials" | null;
  readonly endpoint: string | null;
  readonly defaultModel: string;
  /** §5: the REGISTERED/compiled baseUrl (the edit form's prefill source) —
   *  `endpoint` above stays the resolved URL (env override applied when this
   *  provider is the selected one). Absent when the profile has none (wudao). */
  readonly baseUrl?: string;
  /** 0.3.28 ②: the RAW registry overlay's baseUrl — the user's override on a
   *  BUILTIN. `baseUrl` above is the EFFECTIVE base (overlay ?? compiled
   *  default); THIS field is absent when no overlay exists. The builtin 端点
   *  edit input seeds from it (empty = revert to the compiled default) so an
   *  un-overlaid builtin never prefills-and-pins the compiled URL. */
  readonly registeredBaseUrl?: string;
  /** §5: user-registered (registry row) vs compiled-in. */
  readonly custom: boolean;
  /** §5: the provider's model catalog with optional context windows
   *  (registry rows; empty for a pure builtin). */
  readonly models: readonly { readonly name: string; readonly contextLength?: number }[];
  /** §5: the provider-level context-window default (registry rows only). */
  readonly defaultContextLength?: number;
  /** 模型配置反馈 ① (2026-08-29): the RESOLVED inheritance tail — what an
   *  empty per-model window actually resolves to (defaultContextLength ??
   *  WUDAO_CONTEXT_WINDOW ?? 200000). The edit form's 继承 hint shows this
   *  NUMBER, so「继承供应商默认」never hides the value again. */
  readonly windowFallback?: number;
  /** T4b (provider-management): the effective profile's reasoning format —
   *  the registry custom's registered format (customs materialize "none" when
   *  unset) or the builtin's compiled one. Display semantics for builtins;
   *  for customs it is the wire half of the round-trip — the edit form's FULL
   *  save payload echoes it back, because the server's custom save REPLACES
   *  the registry row wholesale (an unechoed field would be destroyed). */
  readonly reasoningFormat?: string;
  /** 0.3.13 (#215): the protocol the row speaks ("anthropic" for the
   *  anthropic builtin; a registry custom's `wire` column; absent = the
   *  dispatch default openai-chat). The detail panel's 协议 row: builtins
   *  render it fixed, customs seed their editable selector; both save
   *  payloads echo it (the save REPLACES the registry row wholesale). */
  readonly wire?: string;
  /** persona-settings T7 — the card's THREE-STATE persona binding (the
   *  registry row's `persona` column): absent = follow the global default;
   *  a string = bound persona id; null = forced none. The detail panel's
   *  「Persona 绑定」row seeds from it, and both save payloads echo the
   *  current state back — the server's save REPLACES the registry row
   *  wholesale (the F1 rule), so an unechoed binding would die. */
  readonly persona?: string | null;
  /** 推理档三级配置 S2/S5 (spec 2026-08-28 §1): the card's THREE-STATE
   *  effort binding (the registry row's `effort` column, the same rule the
   *  cli's readProviderEffortBinding reads): absent = follow the global
   *  default (settings model.defaultEffort); a string = bound level; null =
   *  explicit don't-send. The detail panel's 推理档绑定 row seeds from it,
   *  and every save payload echoes it (the wholesale-replace rule). */
  readonly effort?: string | null;
  /** §5 (fail-visible): the registry row REFUSED to load — the card is a
   *  grayed, minimal id+reason row (never selectable). */
  readonly invalidReason?: string;
}

/** The settingsStatus reply: the card matrix, the credentials COUNT (never
 *  values), the personal-settings values, and the env-resolved identity.
 *  M63 §C: `readiness` (any provider ready) + `settings.wizardCompletedVersion`
 *  drive the first-run wizard's gate (see wizard.ts).
 *  M63 §D: uiDefaultMode is tri-state — null = the key was never written
 *  (the web app's 简洁/高级 default resolves null → advanced, so existing
 *  users never flip modes without having chosen one). */
export interface SettingsStatus {
  readonly providers: readonly ProviderCard[];
  readonly credentials: { readonly path: string; readonly keyCount: number };
  readonly settings: {
    readonly memoryEnabled: boolean;
    /** M78-buddy §4: the shell pick is now tri+1 — "buddy" (the two-panel
     *  会话列表+对话 shell) joins simple/advanced; null still resolves
     *  advanced (existing users never flip without an explicit pick). */
    readonly uiDefaultMode: "simple" | "buddy" | "advanced" | null;
    /** The wizard copy version already completed/skipped (0 = never). */
    readonly wizardCompletedVersion: number;
    /** M64-visual §4: the theme/accent channels — the SAME tri-state shape
     *  as uiDefaultMode. null = never written → the app resolves the factory
     *  defaults (dark theme, green accent); an explicit value rides the ◐
     *  topbar toggle and the settings page's 外观 pickers. */
    readonly uiTheme: "light" | "dark" | null;
    readonly uiAccent: "black" | "blue" | "green" | null;
    /** persona-settings T5: the global default persona id (the persona
     *  tab's picker's current value). null / absent = never written (no
     *  default persona active). Optional so older fixtures stay
     *  shape-compatible. */
    readonly personaId?: string | null;
    /** 0.3.11（用户反馈：权限档两入口 1:1 联动）：持久默认权限档（全局
     *  settings.json permissions.defaultMode，向导⑤/设置页写；新会话起步
     *  档，CLI 旗标更高）。null = never written → 起步 "workspace"。
     *  与实时档（status.mode）语义分开——设置页据此绑「默认」，不再镜像
     *  实时档。0.3.14 四档值：workspace/ask/auto/plan（server 读取旧持久
     *  值时已迁移）。Optional so older fixtures stay shape-compatible. */
    readonly permissionsDefaultMode?: "workspace" | "ask" | "auto" | "plan" | null;
    /** 推理档三级配置 + 语言 chip S3: the RESOLVED boot-fold knobs (ablation
     *  > settings > env > auto — what the NEXT session starts at). Optional
     *  so older fixtures stay shape-compatible; the live session pair rides
     *  the top-level `language`. */
    readonly languageReply?: "auto" | "on" | "off";
    readonly languageReasoning?: "auto" | "zh" | "en" | "off";
    /** ω99-236: #1 — the doc trio's RESOLVED mount gate (docSuite.enabled;
     *  what the NEXT session starts at). The 插件 tab「内置」段's toggle
     *  initial value. Optional so older fixtures/servers stay shape-
     *  compatible — absent degrades to default-ON (the memoryEnabled `??
     *  true` 缺省门语义, the trio already ships on). */
    readonly docSuiteEnabled?: boolean;
    /** ω99-287: #1 — the desktop's 关窗后台 bit (desktop.backgroundOnClose
     * through the same layered read). Default false (Q1: 用户显式开) —
     * absent (old server) / false both read as off. The 偏好 tab's toggle
     * initial value (desktop shell only) and the close bridge's decision
     * bit. */
    readonly desktopBackgroundOnClose?: boolean;
    /** 122 项 2 — the 定时任务离线唤起 opt-in (schedules.launchAgent; junk/
     * absent reads false = off). The 偏好 tab's toggle initial value
     * (desktop shell + macOS only — schedulesLaunchAgentSupported gates
     * the render). */
    readonly schedulesLaunchAgent?: boolean;
    /** 122 项 2 — the platform gate (LaunchAgents are macOS-only); false
     * hides the toggle instead of promising a wake the OS cannot deliver. */
    readonly schedulesLaunchAgentSupported?: boolean;
  };
  readonly current: { readonly provider: string; readonly model: string; readonly effort?: string };
  /** 推理档三级配置 + 语言 chip S4: the SESSION-effective language pair
   *  (the live /language lane), overlaid by the cli's withSettingsOps onto
   *  this payload — what the web's language chip renders as current.
   *  Optional so older fixtures/servers stay shape-compatible. */
  readonly language?: { readonly reply: "auto" | "on" | "off"; readonly reasoning: "auto" | "zh" | "en" | "off" };
  readonly envKey: boolean;
  /** The readiness join (any provider ready = ready) — the wizard's gate. */
  readonly readiness: boolean;
  readonly efforts: readonly string[];
  /** R6 quickwin: the Ctrl+S-persisted pick defaults (null = never written)
   *  — the `wudao ui` boot applies them; the settings page badges them.
   *  Optional on the wire so older fixtures stay shape-compatible. */
  readonly defaultModel?: { readonly provider: string; readonly model: string } | null;
  readonly defaultEffort?: string | null;
}

/** settingsSaveKey's reply: status only — the key never echoes back. */
export interface SaveKeyResult {
  readonly provider: string;
  readonly saved: boolean;
  readonly keyCount: number;
}

/** The human failure states of 测试连接 (spec §B/§C wording). */
export type TestConnectionState = "ok" | "auth" | "network" | "model" | "no-key" | "no-endpoint" | "http";

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly state: TestConnectionState;
  readonly message: string;
}

/** settingsSet's reply. */
export interface SettingsSetResult {
  readonly key: string;
  readonly saved: boolean;
}

// Provider management §5 — the registry ops' replies. Status-only shapes: no
// key material EVER appears (the server strips stray secret fields, and the
// handlers never echo the config or the request key).
/** settingsSaveProvider's reply: which provider landed (or why it refused). */
export type SaveProviderResult = { readonly ok: true; readonly provider: string } | { readonly ok: false; readonly error: string };

/** settingsDeleteProvider's reply (a builtin id refuses). */
export type DeleteProviderResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** settingsListModels's reply: the catalog with optional prefilled context
 *  windows (the OpenRouter/models.dev shape), or the testConnection failure
 *  classification. The request key never rides back. */
export type ListModelsResult =
  | { readonly ok: true; readonly models: readonly { readonly name: string; readonly contextLength?: number }[] }
  | { readonly ok: false; readonly state: TestConnectionState; readonly message: string };

// M75-ux1 §2 — the workspace switcher's recents (PROTOCOL "recentWorkspaces").
/** One recent-workspace row (`lastUsed` is an ISO string — JSON has no Date). */
export interface RecentWorkspace {
  readonly path: string;
  readonly lastUsed: string;
}

/** The recentWorkspaces reply: max 5, most-recent-first (the ▾ menu's data). */
export interface RecentWorkspacesResult {
  readonly workspaces: ReadonlyArray<RecentWorkspace>;
}

// ---------------------------------------------------------------------------
// M74-ide §1 — the file-panel ops (PROTOCOL "fileTree" / "fileRead"). The
// shapes mirror the driver payloads in packages/cli/src/driver/agent-driver.ts.
// ---------------------------------------------------------------------------

/** One fileTree row: `size` is files-only; `hidden` marks dotfiles and the
 *  hidden list (.git, node_modules, .DS_Store, __pycache__, .env*, dist,
 *  target) — THIS side filters on the flag; the server only marks. */
export interface FileTreeEntry {
  readonly name: string;
  readonly type: "file" | "dir";
  readonly size?: number;
  readonly hidden?: boolean;
}

/** The fileTree reply: one directory level, dirs first alphabetically then
 *  files. */
export interface FileTreeResult {
  readonly entries: readonly FileTreeEntry[];
}

/** The fileRead reply: `lines` is pre-truncation; `binary: true` means the
 *  content is intentionally "" (render the binary placeholder). */
export interface FileReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly lines: number;
  readonly language: string;
  readonly binary?: boolean;
}

/** The fileWrite reply: `written` = the save landed; `conflict` = disk no
 *  longer matches `base` (nothing written; `current` is the 100KB-capped
 *  prefix of what IS on disk — the editor's 重开 draft). */
export type FileWriteResult =
  | { readonly written: true }
  | { readonly conflict: true; readonly current: string };

/** ω99-314 — the fileRevert verdict（驱动判决联合的 wire 镜像）。
 *  ok:true 唯一成功形：stale = 文件在快照之后被改过（回执已明示——UI 确认
 *  面先行，这里是事实回执）；false 四因：busy（任务正在跑）/ evicted（快照
 *  已被清理）/ bad-path（路径或快照编号无效）/ no-store（未启用快照）。 */
export type FileRevertResult =
  | { readonly ok: true; readonly stale: boolean; readonly message: string }
  | { readonly ok: false; readonly reason: "busy" | "evicted" | "bad-path" | "no-store"; readonly message: string };

/** ω99-316 — the sideQuestion reply（/btw 侧问的 wire 回执）。answer 是旁路
 *  回答全文（轮数用尽时自带诚实尾注「（旁路回答轮数用尽，可能不完整）」）；
 *  rounds 是实际花掉的模型调用轮数。传输层错误才 reject——会话不匹配/空
 *  文本走 err 通道（server relay 原样回）。 */
export interface SideQuestionResult {
  readonly answer: string;
  readonly rounds: number;
}

/** workspace-ux B1 — the panelRootSet reply: the root now in effect (the
 *  tree-top switcher's label/tooltip source). */
export interface PanelRootSetResult {
  readonly root: string;
}

/** workspace-ux B1 — the agentRootStatus reply: the dual-root snapshot.
 *  `panelRoot` is the file panel's view root; `agentRoot` is the session's
 *  workspace root; `aligned` is true until a panelRootSet diverges them. */
export interface AgentRootStatusResult {
  readonly panelRoot: string;
  readonly agentRoot: string;
  /** 138 续（2026-11-03 用户令）：boot 根（会话锚）——工作区菜单「默认空
   * 间」钉项的落点。可选：老 server 缺席 → 钉项不渲染，字节不变。 */
  readonly bootRoot?: string;
  readonly aligned: boolean;
}

/** workspace-ux B2 — the agentRootSwitch reply: `applied` = the switch
 *  landed NOW (idle); `queued` = a run was in flight, so it parks until the
 *  run's settle seam (the in-flight run keeps the OLD root throughout).
 *  Exactly one of the two is true. */
export interface AgentRootSwitchResult {
  readonly applied: boolean;
  readonly queued: boolean;
}

/** M76-ux2 §8 — the ctxInfo reply (PROTOCOL "ctxInfo"): the serialized
 *  prompt's per-section token estimates plus the free remainder against the
 *  context window — the StatusBar ctx segment's hover breakdown. R5-I1:
 *  `imagesTokens` is the image estimate; OPTIONAL because an old server
 *  predates it (absent = treat as 0 — no hover line). */
/** 140 — 会话解剖（PROTOCOL "sessionAnatomy"）：系统提示词 + 消息链全量
 * （监控面板的「会话解剖」区段）。消息行是持久 AgentMessage 的直读形：
 * role/user|assistant|tool、content、reasoning?（思考全文）、toolCalls?、
 * toolCallId?/name?（tool 行）、isError?。可选 op：老 server 拒答。 */
export interface SessionAnatomyResult {
  readonly systemPrompt: string;
  readonly messages: readonly Record<string, unknown>[];
}

export interface CtxInfoResult {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  readonly imagesTokens?: number;
  readonly availableTokens: number;
}

/** The recap reply's deterministic half (PROTOCOL "recap"):
 *  counters the driver counted from structured history (never model-made).
 *  `sinceTs` echoes the caller's own last-visible timestamp (null when the
 *  caller sent none). */
export interface RecapStatsWire {
  readonly turns: number;
  readonly toolCalls: number;
  readonly filesTouched: number;
  readonly sinceTs: number | null;
}

/** The recap payload. `narrative` absent is LEGAL: the degraded
 *  stats-only card is the honest fallback (model failed / no key / nothing
 *  assistant-shaped to summarize), never an error. */
export interface RecapPayload {
  readonly stats: RecapStatsWire;
  readonly narrative?: string;
}

/** ω99-242 — one recoveryStatus row (the server coordinator's status shape,
 *  mirrored; `state` is its lifecycle word — the banner only reads the
 *  counts). `verifiedDone`/`remaining` absent until the first settle.
 *  ω99-248: #9 — `permissionAsk` rides a permission-blocked row (the
 *  persisted waiting-for-human evidence; the morning line's source, withdrawn
 *  once the record settles). */
