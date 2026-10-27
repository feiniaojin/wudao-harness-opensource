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
};

/** Distill a UiSnapshot's status into a PetFrame. No status yet (snapshot
 *  before the first state frame / no session) → null — the relay stays
 *  quiet rather than inventing an all-idle frame the server never sent. */
export function derivePetFrame(snap: { status: DriverStatus | null }): PetFrame | null {
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
