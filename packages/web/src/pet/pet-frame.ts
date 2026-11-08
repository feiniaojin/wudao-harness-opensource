// ω99-99 — the wire contract between the main window and the pet window.
// The pet must NEVER open a second WS (the server is single-client — a
// second connection is closed with 4000), so the main window relays: every
// UiSnapshot change is distilled into this tiny frame and shipped over the
// Tauri event bus (WUDAO_PET_STATE_EVENT); the pet's ask travels the other
// way (WUDAO_PET_ASK_EVENT). This module is PURE — no DOM, no React, no
// imports beyond types, so it weighs next to nothing in either chunk.
// ω99-113: ONE value import joins (busyNarrationOf) — the busyTools 人话旁白
// is distilled main-side here, still tiny and DOM-free.
import { busyNarrationOf, busyWorkKindOf } from "./busy-narration.js";
import type { PetInput } from "./pet-state.js";
import type { DriverStatus } from "../protocol.js";

/** 主窗 → 宠物：状态帧事件名（Tauri event bus）。 */
export const WUDAO_PET_STATE_EVENT = "wudao-pet-state";
/** 宠物 → 主窗：快聊提问事件名，payload 形状 `{ text: string }`。 */
export const WUDAO_PET_ASK_EVENT = "wudao-pet-ask";
/** 宠物 → 主窗：权限应答事件名（ω99-109），payload 见 PetAnswer。 */
export const WUDAO_PET_ANSWER_EVENT = "wudao-pet-answer";
/** ω99-237: #5 — 主窗 → 宠物：toast 事件名——一次性信号（斜杠早拦的拒令
 *  回执面），不走状态帧节流泵（信号不是快照流，delivery 同范式）。PetFrame
 *  的帧形状零改（235 的「pet-frame.ts 纯函数面」姿态只让渡事件名常量）。 */
export const WUDAO_PET_TOAST_EVENT = "wudao-pet-toast";
/** ω99-271: #6 — 宠物 → 主窗：历史请求事件名（payload 无——请求就是信号，
 *  答案走 wudao-pet-history 单程回执）。与 ask/answer 同范式：宠物窗永远不
 *  开第二条 WS，历史也由主窗代取。 */
export const WUDAO_PET_HISTORY_REQ_EVENT = "wudao-pet-history-req";
/** ω99-271 — 主窗 → 宠物：历史回执事件名，payload 见 readPetHistory。 */
export const WUDAO_PET_HISTORY_EVENT = "wudao-pet-history";
/** ω99-275: #9 — 主窗 → 宠物：主题联动事件名，payload `{ theme: "light" | "dark" }`。
 *  主窗 applyTheme 切换即广播（boot 的 stampPersistedAppearance 也过它），宠物
 *  窗 stamp html[data-theme] 驱动 pet.css 的浅色覆盖块。住本文件（wire contract
 *  之家，ω99-97 隔离），与皮肤事件（skin-ids.ts）区分：那是 Rust→web 的广播，
 *  这是 web 主窗→web 宠物窗的转发。 */
export const WUDAO_PET_THEME_EVENT = "wudao-pet-theme";
/** M85-pet §2: #2 — 宠物 → 主窗：工具栏动作事件名，payload 见
 *  readPetToolbarAction（与 answer 同向同范式——宠物窗永远不开第二条 WS，
 *  工具栏动作也由主窗代发；relay 按 action.kind 翻译成 pet 四 op）。 */
export const WUDAO_PET_TOOLBAR_EVENT = "wudao-pet-toolbar-event";
/** M85-final I-1 — 主窗 → 主窗：会话列表刷新信号。relay 收到 petNewSession
 *  非 null 归档回执（真发生了归档轮换、主窗侧栏多了一行「精灵 · …」）后广
 *  播本事件，App 的监听 bump sessionsEpoch——侧栏/弹框沿 ω99-150/156/255
 *  的既有重读缝收敛（零新组件零新 fetch 逻辑）。住本文件（wire contract
 *  之家）：虽是主窗自环信号（发收两端都在主窗），但发起点在 relay（pet 域
 *  的回执面）——与工具栏动作同族同总线。payload `{ archivedId: string }`，
 *  消费端不读（信号即全部，id 仅供诊断）。 */
export const WUDAO_PET_SESSIONS_REFRESH_EVENT = "wudao-pet-sessions-refresh";
/** 状态帧的节流窗口（leading+trailing 节流，relay.ts 的 createFramePump）。 */
export const PET_EMIT_MS = 150;

/** ω99-109 — the ask card's content: the DECISION MINIMUM a permission
 *  answer needs (toolName + one-line summary + whether "always" is
 *  offered). input/warning/sidecar stay main-window-only — the pet face
 *  carries the decision, not the deep semantics; the answer set must match
 *  the main modal's exactly (allow-once / allow-always / deny — no third
 *  approval semantics). */
export interface PetFrameAsk {
  readonly toolName: string;
  readonly summary: string;
  /** settingsFile === undefined（true=可「总是允许」；运行时策略文件在场时
   *  与主窗同款降级为一次性 y/N）。 */
  readonly canAlways: boolean;
}

/** One cross-window state frame — signals + the answer tail, nothing else.
 *  pendingPermission/reasoningActive are BOOLEANS on the wire (98's
 *  PetInput sentinel semantics are rebuilt on the pet side by
 *  petFrameToInput — content never crosses the wire). ω99-109: ask carries
 *  the permission card's decision minimum (null = no card; absent on old
 *  main windows = no card). */
export interface PetFrame {
  readonly busy: boolean;
  readonly pendingPermission: boolean; // status.pendingPermission !== null
  readonly reasoningActive: boolean; // live.reasoning !== ""（内容不传，信号即全部）
  readonly answerTail: string; // live.answer 全文（ω99-272 无截断；字段名保 wire 稳定）
  readonly busyToolCount: number; // live.busyTools.length
  /** ω99-113：busyTools 的人话旁白（busy-narration 纯映射主窗侧算好）——
   *  最新一个可旁白工具在干什么；无可旁白行（或无在飞）= null，宠物面
   *  维持既有呈现。v7 γ1：映射从 browser_* 扩到全工具分类（busy-
   *  narration.ts 的三张表）。name+summary 已在 busyTools 载荷，零新事件
   *  零协议改动（帧加一个可空字段，109 ask 同款 additive 方式）。 */
  readonly busyNarration: string | null;
  /** v7 γ1：胜出行的工作种类（PetWorkKind——browser/files/command/…
   *  分类锚，与 busyNarration 同一行同源）。宠物形态的分类面：宠物窗据
   *  此可做未来的形态差异（本弧只落 wire 锚与 DOM 锚，不动 CSS——几何
   *  契约钉另立弧）。null=无可分类行（与 busyNarration 的 null 同边界）。 */
  readonly workKind: string | null;
  readonly ask: PetFrameAsk | null; // pendingPermission 的决策最小集（ω99-109）
  /** M85-pet §2 — 工具栏三 chip 的显示值（状态帧 pet 字段蒸馏）：model=
   *  model 块的 label（model id；无块=null），effort=model 块的 effort（未设
   *  档=null），workspaceName=agentRootStatus 派生的 basename（Task 3 的帧
   *  扩展字段；全路径 workspacePath 留主窗面，不进帧）。与 113 旁白同款
   *  additive 方式：旧形状=三 null 零噪音；null 边界=chip 诚实空白。 */
  readonly model: string | null;
  readonly effort: string | null;
  readonly workspaceName: string | null;
  /** M85-final（终审 M-3）— 工作区全路径（状态帧 pet 字段的 workspacePath
   *  直通；缺席/坏读=null）。spec §2 蒸馏四项的第四项：主窗侧 hover 面未消
   *  费（Bubble 无 hover 需求）但帧契约补齐——等值/读门同字段族，后续弧
   *  接消费零协议改动。 */
  readonly workspacePath: string | null;
  /** M85-final I-3 — 模型数据面（状态帧 model.choices 的 registry 矩阵蒸
   *  馏为 {provider,model} 对；块缺席/空矩阵=null）。null=数据缺席 → 宠物
   *  工具栏弹层回落手输（旧主窗/降级兼容）；非空=列表选择（spec §2 数据面
   *  复用的字面达成）。 */
  readonly modelChoices: readonly { readonly provider: string; readonly model: string }[] | null;
  /** M85-final I-3 — 工作区数据面（主窗 relay 挂载时从 recentWorkspaces op
   *  取一次的最近工作区路径，≤5 条——WorkspaceChip 同源数据）。null=缺席 →
   *  手输；非空=列表选择。注意：非状态帧字段——relay 蒸馏时经 extra 参数
   *  注入（见 derivePetFrame 第二参）。 */
  readonly recentWorkspaces: readonly string[] | null;
}

/** ω99-103 — the honest frame for "server unreachable": no connection = no
 *  live agent, so every signal is idle. The relay pushes this when the
 *  snapshot's connection leaves "connected" while a status lingers —
 *  freezing at the last real frame (e.g. a stale "working") would be a lie
 *  the pet has no way to detect (it cannot read `connection` itself).
 *  ω99-109: ask=null — a disconnect also dismisses the card (no live
 *  permission gate to answer). */
export const IDLE_PET_FRAME: PetFrame = {
  busy: false,
  pendingPermission: false,
  reasoningActive: false,
  answerTail: "",
  busyToolCount: 0,
  busyNarration: null,
  workKind: null,
  ask: null,
  model: null,
  effort: null,
  workspaceName: null,
  workspacePath: null,
  modelChoices: null,
  recentWorkspaces: null,
};

/** Distill a UiSnapshot's status into a PetFrame. No status yet (snapshot
 *  before the first state frame / no session) → null — the relay stays
 *  quiet rather than inventing an all-idle frame the server never sent.
 *  M85-final I-3: the OPTIONAL second param carries the non-status data
 *  plane (recentWorkspaces — the relay fetches it once at mount from the
 *  main window's recentWorkspaces op; absent → the frame's field is null
 *  and the pet toolbar falls back to manual input). */
export function derivePetFrame(
  snap: { status: DriverStatus | null },
  extra?: { readonly recentWorkspaces?: readonly string[] | null },
): PetFrame | null {
  const s = snap.status;
  if (s === null) return null;
  return {
    busy: s.busy,
    pendingPermission: s.pendingPermission !== null,
    reasoningActive: s.live.reasoning !== "",
    // ω99-272: #1 — 流面尾窗不再限字数（用户令 09-10「流面尾窗不要限制字数，
    // 加一个折叠的功能不就解决了」）：slice(-ANSWER_TAIL_CHARS) 撤除，帧携带
    // driver 累积的全量 live.answer（agent-driver 本就不帽）；可读性交折叠 UI
    // （Bubble 的展开/收起），不再用截断换。泵去重/节流照常——流式中每帧全
    // 文只在变化时过总线（≤6.7fps），是接受的代价换保真。字段名 answerTail
    // 保持不动：wire/测试/relay 多处钉名，改名零行为收益。
    answerTail: s.live.answer,
    busyToolCount: s.live.busyTools.length,
    busyNarration: busyNarrationOf(s.live.busyTools),
    workKind: busyWorkKindOf(s.live.busyTools),
    ask:
      s.pendingPermission === null
        ? null
        : {
            toolName: s.pendingPermission.toolName,
            summary: s.pendingPermission.summary,
            canAlways: s.pendingPermission.settingsFile === undefined,
          },
    // M85-pet §2 — 工具栏三 chip 蒸馏：model 块的 label 即 model id（块缺席
    // ——旧服务端/未配——=null）；effort 逐字段独立（块在场但未设档=null）；
    // workspaceName 直通（agentRootStatus 派生 basename，坏读降级=缺省→null）。
    model: s.model?.label ?? null,
    effort: s.model?.effort ?? null,
    workspaceName: s.workspaceName ?? null,
    // M85-final（终审 M-3）— workspacePath 直通（wire 已携带，蒸馏补齐 spec
    // §2 四项的第四项；缺席=null）。
    workspacePath: s.workspacePath ?? null,
    // M85-final I-3 — 模型数据面：model.choices 的 registry 矩阵蒸馏为
    // {provider,model} 对（source/contextLength 是主窗选择器的字段，宠物
    // 面不消费——剥掉保持帧最小）；块缺席/空矩阵=null（手输回落）。
    modelChoices:
      s.model !== undefined && s.model !== null && s.model.choices.length > 0
        ? s.model.choices.map((c) => ({ provider: c.provider, model: c.model }))
        : null,
    // M85-final I-3 — 工作区数据面：relay 注入的最近工作区（非状态帧字段，
    // 见第二参）；缺席=null（手输回落）。
    recentWorkspaces: extra?.recentWorkspaces ?? null,
  };
}

/** Rebuild ω99-98's PetInput from a frame. The 98 machine reads ONLY
 *  non-emptiness (pendingPermission ≠ null/undefined, reasoning !== "",
 *  busyTools.length > 0), so the sentinels below are the whole truth —
 *  "." carries "reasoning active" exactly as well as the full text would.
 *  ω99-109: ask deliberately does NOT participate — the card is Bubble's
 *  business, the machine stays boolean-only. */
export function petFrameToInput(f: PetFrame): PetInput {
  return {
    busy: f.busy,
    pendingPermission: f.pendingPermission ? true : null,
    live: {
      reasoning: f.reasoningActive ? "." : "",
      answer: f.answerTail,
      busyTools: Array.from({ length: f.busyToolCount }),
    },
  };
}

// --- ω99-109 反向应答（宠物 → 主窗） -----------------------------------------

/** The wudao-pet-answer payload. scope exists ONLY for "always" — the pet
 *  card offers allow-once / allow-always / deny, matching the main modal
 *  (its "session" answer stays main-window-only); a deny never carries a
 *  scope (there is no "always deny" on either face). */
export interface PetAnswer {
  readonly allow: boolean;
  readonly scope?: "always";
}

/** M85-final I-3 — modelChoices 的逐元素等值（petFramesEqual 的数组臂）：
 *  null 边界先比，长度再比，元素逐对比 provider+model。数组身份不参与
 *  （蒸馏每帧新建数组——内容等值即帧等值，泵照常短路）。 */
function sameModelChoices(
  a: readonly { readonly provider: string; readonly model: string }[] | null,
  b: readonly { readonly provider: string; readonly model: string }[] | null,
): boolean {
  if ((a === null) !== (b === null)) return false;
  if (a === null || b === null) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.provider !== b[i]!.provider || a[i]!.model !== b[i]!.model) return false;
  }
  return true;
}

/** M85-final I-3 — recentWorkspaces 的逐元素等值（sameModelChoices 的字符串
 *  版，同纪律）。 */
function sameStringList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if ((a === null) !== (b === null)) return false;
  if (a === null || b === null) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Field-wise deep equality for the pump's equal-frame short-circuit: the
 *  five primitive leaves compare directly, ask compares field-wise (a card
 *  change with all booleans equal — e.g. toolName swapped — is a NEW frame
 *  and must re-emit). */
export function petFramesEqual(a: PetFrame, b: PetFrame): boolean {
  return (
    a.busy === b.busy &&
    a.pendingPermission === b.pendingPermission &&
    a.reasoningActive === b.reasoningActive &&
    a.answerTail === b.answerTail &&
    a.busyToolCount === b.busyToolCount &&
    a.busyNarration === b.busyNarration && // ω99-113：旁白变=新帧（open→snapshot 计数同 1 也要重发）
    a.workKind === b.workKind && // v7 γ1：种类变=新帧（防御性——与旁白同源，理论不独变；比较零成本）
    a.model === b.model && // M85-pet §2：换模型=新帧（chip 显示值变必须重发）
    a.effort === b.effort && // M85-pet §2：换思考档=新帧（逐字段独立）
    a.workspaceName === b.workspaceName && // M85-pet §2：换工作区=新帧（车道重锚的显示面）
    a.workspacePath === b.workspacePath && // M85-final M-3：全路径变=新帧（与 basename 同源同变，防御性钉）
    sameModelChoices(a.modelChoices, b.modelChoices) && // M85-final I-3：模型矩阵变=新帧
    sameStringList(a.recentWorkspaces, b.recentWorkspaces) && // M85-final I-3：最近工作区变=新帧
    (a.ask === null) === (b.ask === null) &&
    (a.ask === null || b.ask === null
      ? true
      : a.ask.toolName === b.ask.toolName && a.ask.summary === b.ask.summary && a.ask.canAlways === b.ask.canAlways)
  );
}

/** Wire parse for the main window's answer listener: the payload crosses
 *  the Tauri bus untyped; a malformed payload is dropped whole, never
 *  partially trusted. allow must be a boolean; scope accepts ONLY "always"
 *  (anything else — "session", strings, objects — drops the event); a deny
 *  is normalized to no-scope (no third approval semantics may enter the
 *  wire's far side). */
export function readPetAnswer(p: unknown): PetAnswer | null {
  if (typeof p !== "object" || p === null) return null;
  const a = p as Record<string, unknown>;
  if (typeof a.allow !== "boolean") return null;
  if (a.scope !== undefined && a.scope !== "always") return null;
  return a.allow && a.scope === "always" ? { allow: true, scope: "always" } : { allow: a.allow };
}

/** WUDAO_PET_TOAST_EVENT 的 wire 解析（ω99-237 同缝）——{text:string}，
 *  坏载荷整丢（readPetAnswer/readDelivery 同纪律：跨总线载荷绝不半信）。 */
export function readPetToast(p: unknown): { text: string } | null {
  if (typeof p !== "object" || p === null) return null;
  const t = (p as Record<string, unknown>).text;
  if (typeof t !== "string") return null;
  return { text: t };
}

/** WUDAO_PET_HISTORY_EVENT 的 wire 解析（ω99-271，readPetToast 同缝）——
 *  `{ turns: readonly {q,a}[] }`，坏载荷整丢：q/a 必须都是 string，数组里
 *  任何一条不合法就整包作废（历史是「完整会话信息」的承载体，半信的历史比
 *  没有更糟——宠物窗宁可用本地转写也不展示一套被截断又拼回来的假史）。 */
export function readPetHistory(p: unknown): { turns: readonly { q: string; a: string }[] } | null {
  if (typeof p !== "object" || p === null) return null;
  const turns = (p as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) return null;
  const parsed: { q: string; a: string }[] = [];
  for (const t of turns) {
    if (typeof t !== "object" || t === null) return null;
    const row = t as Record<string, unknown>;
    if (typeof row.q !== "string" || typeof row.a !== "string") return null;
    parsed.push({ q: row.q, a: row.a });
  }
  return { turns: parsed };
}

// --- M85-pet §2 工具栏动作（宠物 → 主窗） -------------------------------------

/** WUDAO_PET_TOOLBAR_EVENT 的载荷形——宠物窗工具栏四 chip 的动作面，relay
 *  按 kind 翻译成 pet 四 op（new-session→petNewSession、set-model→
 *  petSetModel、set-effort→petSetEffort、set-workspace→petSetWorkspace）。 */
export type PetToolbarAction =
  | { kind: "new-session" }
  | { kind: "set-model"; provider: string; model?: string; effort?: string }
  | { kind: "set-effort"; effort: string }
  | { kind: "set-workspace"; path: string }
  /** 试用反馈二（2026-11-09）：浏览动作不携带路径——选择器由**主窗**开
   *  （relay 转 tauriPickDirectory）：从精灵窗直接开会把 NSOpenPanel 作
   *  sheet 挂在无边框小窗上（贴屏底、不可拖——实测）；主窗父化后是
   *  正常居中可拖的模态框。选完主窗直接下发 petSetWorkspace。 */
  | { kind: "pick-workspace" };

/** WUDAO_PET_TOOLBAR_EVENT 的 wire 解析（readPetAnswer/readPetToast 同缝的
 *  纪律）——坏载荷整丢，绝不半信；字符串门与 server 同句（provider/effort/
 *  path 必须是非空 string——空串=没给，doomed 调用根本不出主窗）；多余键
 *  归一化剥掉，解析器只出 canonical 形状。 */
export function readPetToolbarAction(p: unknown): PetToolbarAction | null {
  if (typeof p !== "object" || p === null) return null;
  const a = p as Record<string, unknown>;
  switch (a.kind) {
    case "new-session":
      return { kind: "new-session" };
    case "set-model": {
      if (typeof a.provider !== "string" || a.provider === "") return null;
      if (a.model !== undefined && typeof a.model !== "string") return null;
      if (a.effort !== undefined && typeof a.effort !== "string") return null;
      return {
        kind: "set-model",
        provider: a.provider,
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.effort !== undefined ? { effort: a.effort } : {}),
      };
    }
    case "set-effort":
      if (typeof a.effort !== "string" || a.effort === "") return null;
      return { kind: "set-effort", effort: a.effort };
    case "set-workspace":
      if (typeof a.path !== "string" || a.path === "") return null;
      return { kind: "set-workspace", path: a.path };
    case "pick-workspace":
      return { kind: "pick-workspace" };
    default:
      return null;
  }
}
