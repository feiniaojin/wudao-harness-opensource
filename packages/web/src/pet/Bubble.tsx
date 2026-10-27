// ω99-99 — the quick-chat bubble (D1): the pet's SAME-WINDOW overlay — the
// user clicks the pet, types, and the text rides the Tauri event bus to the
// main window's relay (which owns the ONE WS client). Feedback after send =
// the state frames flowing back (thinking appears within ~150ms+RTT); no
// faked "received" copy — if the frames never come the pet just stays idle,
// accepted P0 behavior. The answer faces render markdown since ω99-210 —
// the .pet-bubble-a transcript cell and the stream tail both go through
// PetMarkdown (the 0.3.57 验装回执: raw **/-- markers were showing);
// delivery digests stay plain text; bottom-aligned stays so the newest
// text is always on screen.
import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { tauriEmitEvent, tauriInvokeCommand } from "../tauri-invoke.js";
import { WUDAO_PET_ANSWER_EVENT, WUDAO_PET_ASK_EVENT } from "./pet-frame.js";
import { WUDAO_PET_OPEN_MAIN_EVENT } from "./delivery.js";
import { WUDAO_PET_SELECTION_SUBMIT_EVENT, explainPrompt, genericPrompt, isUrlSelection, questionPrompt, translatePrompt, urlPrompt } from "./selection.js";
import { digest } from "./pet-chat.js";
import { PET_SKIN_SHEETS } from "./skins/index.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "../components/ime-guard.js";
import { PetMarkdown } from "./pet-md.js";
import type { PetDelivery } from "./delivery.js";
import type { PetFrameAsk } from "./pet-frame.js";
import type { PetSelection } from "./selection.js";
import type { ChatTurn } from "./pet-chat.js";
import type { PetSkinId } from "./skins/index.js";

/** 回 idle 后气泡的停留时长（brief §5，fake timers 可测）。 */
export const PET_BUBBLE_LINGER_MS = 2500;
/** 淡出窗口（linger 到点后挂 data-bubble-fading 的时长，pet.css 过渡）。 */
export const PET_BUBBLE_FADE_MS = 250;
/** ω99-105 送达形态的停留时长——远长于 ask 的 2500ms：送达面向「不在屏幕
 *  前」的用户量级（30s 内随时可点开主窗看全文）。 */
export const PET_DELIVERY_MS = 30_000;
// ω99-272: #4 — 折叠触发阈值（用户令 09-10「加一个折叠的功能不就解决了」：
// 字符数只当触发器，绝不截断——全文恒在 state/DOM，折叠只是视觉钳制）。
// STREAM=stream 形态「展开全文」钮的出现阈值；TRANSCRIPT=transcript 冻结轮
// q/a 气泡折叠钮的出现阈值（live 轮永不折——流式增长中的折叠跳变是打扰）。
// ω99-274: 阈值 300→100（用户令「超过100字则在信息末尾折叠，查看全文」）。
export const STREAM_FOLD_CHARS = 600;
export const TRANSCRIPT_FOLD_CHARS = 100;

export interface BubbleProps {
  /** 点击宠物后为 true（input 形态）；入口在 onInputClose 时翻回 false。 */
  inputOpen: boolean;
  /** 最新状态帧的 answerTail（stream 形态的文本）。 */
  answerTail: string;
  /** 机器 display === "waiting-user"（hint 行压过 stream）。 */
  waitingUser: boolean;
  /** ω99-113 busyTools 的人话旁白（帧的 busyNarration；null=无可旁白行——
   *  无在飞或全部不可旁白，宠物面维持既有呈现）。缺省（调用方未接线）
   *  = null，同 ask/selection 的缺省归一。 */
  busyNarration: string | null;
  /** v7 γ1 胜出行的工作种类（帧的 workKind；null=无可分类行）——仅作
   *  旁白行的 data-work-kind DOM 锚（宠物形态差异的将来缝；本弧不动
   *  CSS，零视觉变化）。缺省归一同 busyNarration。 */
  workKind: string | null;
  /** input 收起回调（Esc / 发送后）。 */
  onInputClose: () => void;
  /** ω99-105 送达槽（null=无）：单槽，新送达由入口整只替换；busy 帧
   *  （hint/stream）优先于送达——新 turn 开跑时送达形态立即让位。 */
  delivery: PetDelivery | null;
  /** 送达关闭回调（TTL 到点 / Esc / 点击）。 */
  onDeliveryClose: () => void;
  /** ω99-109 权限确认卡（null=无）：决策最小集（toolName+summary+
   *  canAlways），来自状态帧的 ask 字段；有卡时压过一切形态。 */
  ask: PetFrameAsk | null;
  /** ω99-110 划词接单卡（null=无）：来自 wudao-pet-selection 事件（Rust 热键
   *  → AX 读选区）；入口整只替换（新选段换旧卡）。三形态：granted+有文=接单
   *  卡（三路发送）、granted+空文=「没划到文字」空态、!granted=权限引导卡。 */
  selection: PetSelection | null;
  /** 接单卡关闭回调（发送后本地清 / 取消 / Esc）。与 ask 相反：本地清合法
   *  ——卡由热键事件驱动，无服务器态可等，卡的存在本身就是本地事实。 */
  onSelectionClose: () => void;
  /** ω99-196 — 布局形态回调（可选，缺省 undefined=测试零触）：宠物窗三态
   *  compact/bubble/answer 变化时上抛，入口接 Rust set_pet_layout（窗口随
   *  气泡起落收缩/扩张，点击死区归零）。Bubble 自身不 invoke——Tauri 面
   *  是入口的职责。 */
  onLayoutMode?: (mode: PetLayoutMode) => void;
  // ω99-201: #2 — 迷你聊天窗三 props（用户令 09-08：发送即时反馈 + 回答与
  // 输入同窗）。transcript=宠物窗本地 ≤3 轮问答（入口持有，Bubble 只投影）；
  // onPetTurn=宠物源轮的发送回调（携带 digest(q)≤24 字摘要）——发送不再
  // onInputClose 收起（聊天窗保持开）；livePending=宠物源轮在飞（发送后首
  // 帧前 awaiting 或推理期活格），关窗后以独立 thinking 形态给「思考中…」
  // 即时反馈——主窗轮不置（D8 打扰纪律：主窗工作时宠物只有精灵动画）。
  /** 宠物窗本地聊天记录（≤3 轮；随 input 形态渲染成 chat 复合体）。 */
  transcript: readonly ChatTurn[];
  /** 发送回调（宠物源轮）：入口 pushTurn 进 transcript + 置 awaiting。 */
  onPetTurn: (digest: string) => void;
  /** 宠物源轮在飞：关窗后独立 thinking 形态（「思考中…」）。 */
  livePending: boolean;
  /** ω99-274 — 当前肤 id（可选，缺省 "default"）：聊天记录宠物侧消息的
   *  头像用该肤 sheet 的左帧（睁眼）。肤切换时入口重渲即换图；测试直挂
   *  Bubble 不传即 default（既有挂载零演进）。 */
  skinId?: PetSkinId;
}

type BubbleContent =
  | { kind: "ask"; ask: PetFrameAsk }
  | { kind: "selection"; selection: PetSelection }
  | { kind: "input" }
  | { kind: "hint" }
  | { kind: "narration"; text: string }
  | { kind: "thinking" }
  | { kind: "stream"; text: string }
  | { kind: "delivery"; delivery: PetDelivery };

/** What the bubble shows right now — ω99-109: the ask card wins outright
 *  (a pending permission gate must never be masked by the chat input or a
 *  lingering delivery — it IS the waiting-user state made actionable), then
 *  input (the user is typing), then the waiting-user hint, then the stream
 *  tail, and LAST the delivery (busy frames outrank it: a new turn starting
 *  must never be masked by a lingering delivery). ω99-110: the selection
 *  card slots in right under ask — a fresh hotkey delegation outranks the
 *  chat input and every busy/lingering form (two cards up = ask wins, the
 *  109 semantics untouched). ω99-113: narration slots between hint and
 *  stream — the 98 chain's own order (waiting-user > busyTools > answer)
 *  as the bubble projection: the busyTools 人话 line outranks a lingering
 *  answer tail (the model speaks, THEN calls the tool — the tail must not
 *  mask what's happening now), and null narration changes nothing.
 *  ω99-201: thinking slots between narration and stream — the pet-originated
 *  turn's instant feedback (「思考中…」): livePending rides the WAITING gap
 *  (after send, before the first frame) and the reasoning phase; inputOpen
 *  outranks it (the chat composite shows the thinking cell in-transcript
 *  instead — same-window semantics, not a second form). */
function activeContent(p: BubbleProps, dismissedTail: string): BubbleContent | null {
  const ask = p.ask ?? null; // 缺省（调用方未接线）=无卡——同老帧「无字段=无卡」兼容语义
  if (ask !== null) return { kind: "ask", ask };
  const selection = p.selection ?? null; // 同 ask 的缺省归一（未接线=无卡）
  if (selection !== null) return { kind: "selection", selection };
  if (p.inputOpen) return { kind: "input" };
  if (p.waitingUser) return { kind: "hint" };
  const narration = p.busyNarration ?? null; // 同 ask/selection 的缺省归一
  if (narration !== null && narration !== "") return { kind: "narration", text: narration };
  if (p.livePending) return { kind: "thinking" }; // ω99-201: 宠物源轮在飞
  // ω99-196: 用户已 ✕ 关闭且 tail 未变 → 不再显示 stream（活流中 tail 续变
  // 即自动复现；held 后 tail 稳定即永关）。空 tail 本就不进本支。
  if (p.answerTail !== "" && p.answerTail !== dismissedTail) return { kind: "stream", text: p.answerTail };
  if (p.delivery !== null) return { kind: "delivery", delivery: p.delivery };
  return null;
}

/** ω99-196 — 宠物窗布局三态：compact=只精灵（104×71，点击死区归零）、
 *  bubble=常态气泡窗（220×320 conf 尺寸）、answer=加宽回答阅读窗
 *  （360×440）。Rust set_pet_layout 的 mode 字面量域（两边双端钉）。 */
export type PetLayoutMode = "compact" | "bubble" | "answer";

/** ω99-196 — stream 抑制判定（纯）：用户 ✕ 关掉的这条尾巴不再显示。 */
function streamSuppressed(c: BubbleContent | null, dismissed: string): boolean {
  return c !== null && c.kind === "stream" && c.text === dismissed;
}

/** ω99-196 — 窗口形态机（纯函数，receipts 直测）：无显示=compact；
 *  input/ask/selection/hint/narration/delivery=bubble；stream（content 或
 *  held）=answer；answer 粘滞——prev=answer 且仍有任何显示（含其他形态）
 *  则保持 answer（防 narration 瞬态把 360 窗缩成 220 再弹回的形变抖动）；
 *  显示链断（全空）即复位 compact。ω99-201: input 与 thinking 也映射
 *  answer——聊天复合体（transcript+textarea）与「思考中…」反馈窗都按
 *  360×440 阅读窗渲染（196 receipts 钉随演进）。 */
export function bubbleLayoutMode(
  prev: PetLayoutMode,
  content: BubbleContent | null,
  held: BubbleContent | null,
  dismissed: string,
): PetLayoutMode {
  const visible = (c: BubbleContent | null): BubbleContent | null =>
    c !== null && !streamSuppressed(c, dismissed) ? c : null;
  const shown = visible(content) ?? visible(held);
  if (shown === null) return "compact";
  if (shown.kind === "stream" || shown.kind === "thinking" || shown.kind === "input") return "answer";
  return prev === "answer" ? "answer" : "bubble";
}

// ω99-274: #2 — 单轮投影组件（ω99-272 的折叠纪律全保：字符数只当触发器、
// 全文恒在 DOM、live 轮 a 永不折、每轮一个组件实例持折叠态），三处升级
// （用户令 09-10「聊天记录用小精灵头像和聊天气泡……超过100字在信息末尾
// 折叠，查看全文」+「现在的折叠太粗暴，直接只显示半行内容，太丑」）：
// ① 聊天 App 行式布局——q 右侧用户气泡（尾角右下），宠物侧 = 当前肤
// sheet 左帧头像 + 左气泡（尾角左下，「思考中…」也进宠物行）；
// ② 阈值 300→100，q 与 a 各自独立折叠（mergeChat 会把 q 从摘要升级成
// 全文——用户气泡同样会超长）；折叠钮在气泡内信息末尾，词面「查看全文」
// /「收起」；
// ③ 折叠钳制锚点移到内层 .pet-bubble-body——css 按 1.65 行高的整倍数钳
// 行数 + 只淡出末 ~1.4 行（旧 96px 钳制落在 4.47 行=切半行，即「粗暴」
// 病根），见 pet.css 的行量化钳制。data-folded 仍挂气泡本体（DOM 锚点
// 零演进）。hook 数恒定（q/a 各一枚折叠态）。
function TranscriptTurn(props: { turn: ChatTurn; thinking: boolean; avatarSheet: string }) {
  const [qFolded, setQFolded] = useState(true);
  const [aFolded, setAFolded] = useState(true);
  const qFoldable = props.turn.q.length > TRANSCRIPT_FOLD_CHARS;
  const aFoldable = !props.turn.live && props.turn.a.length > TRANSCRIPT_FOLD_CHARS;
  return (
    <div className="pet-turn">
      {props.turn.q !== "" && (
        <div className="pet-msg pet-msg-user">
          <div className="pet-bubble-q" data-folded={qFoldable && qFolded ? "" : undefined}>
            <div className="pet-bubble-body">{props.turn.q}</div>
            {qFoldable && (
              <button type="button" className="pet-bubble-fold" data-bubble-fold="" onClick={() => setQFolded((f) => !f)}>
                {qFolded ? "查看全文" : "收起"}
              </button>
            )}
          </div>
        </div>
      )}
      {(props.thinking || props.turn.a !== "") && (
        <div className="pet-row pet-row-pet" data-pet-msg="">
          {/* 头像=当前肤 2 帧 sheet 左帧（睁眼）：css 200% auto 定尺寸，
              与精灵同资产零新图；肤切换由入口传新 skinId 重渲换图。 */}
          <div className="pet-avatar" data-pet-avatar="" style={{ backgroundImage: `url(${props.avatarSheet})` }} />
          {props.thinking && <div className="pet-bubble-thinking">思考中…</div>}
          {/* // ω99-210: #4 — 回答格换 markdown 渲染（0.3.57 验装回执
              「** -- 裸露」）；wrapper div 的 DOM 锚点不动（.pet-bubble-a
              的 textContent 断言面零演进——PetMarkdown 纯文本逐字等值）。 */}
          {!props.thinking && props.turn.a !== "" && (
            <div className="pet-bubble-a" data-folded={aFoldable && aFolded ? "" : undefined}>
              <div className="pet-bubble-body">
                <PetMarkdown source={props.turn.a} />
              </div>
              {aFoldable && (
                <button type="button" className="pet-bubble-fold" data-bubble-fold="" onClick={() => setAFolded((f) => !f)}>
                  {aFolded ? "查看全文" : "收起"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Bubble(props: BubbleProps) {
  const { inputOpen, answerTail, waitingUser, onInputClose, delivery } = props;
  const [text, setText] = useState("");
  // ω99-196 — ✕ 关闭的回答尾巴（用户令 09-08「应该让用户主动关」；ω99-143
  // 军规：不依赖键盘焦点的确定性关闭通路）。值=点击时显示中的尾巴（held.text
  // ——活流态与 answerTail 同串）；抑制规则见 activeContent；空 tail（新
  // turn / 无回答在飞）复位。
  const [dismissedTail, setDismissedTail] = useState("");
  // ω99-272 — 流面展开态（裸提，标记见 #4）：折叠是视觉钳制不是内容删减。
  // 新 turn 开跑（空 tail）复位——与 dismissedTail 同一 effect 模式，新一轮
  // 从尾窗重新看起。
  const [streamExpanded, setStreamExpanded] = useState(false);
  const content = activeContent(props, dismissedTail);
  useEffect(() => {
    if (answerTail === "") {
      setDismissedTail(""); // 新 turn 开跑=旧关闭作废
      setStreamExpanded(false); // ω99-272: 折叠复位
    }
  }, [answerTail]);

  // Linger memory: a hint/narration/stream stays on screen after the pet
  // returns to idle (hint/narration fades after PET_BUBBLE_LINGER_MS; stream
  // ω99-196 never fades — ✕ is its only close). The INPUT form never lingers
  // — and opening it CLEARS the memory, so a fresh turn doesn't resurrect the
  // previous turn's tail after send. The DELIVERY form clears it too (its
  // own TTL governs it; a closed delivery must not resurrect an old tail).
  // ω99-109: the ASK card clears it as well — the card never lingers (a
  // resolved permission gate must vanish with the frame that says so; a
  // lingering card would re-offer buttons for an ask already answered).
  // ω99-110: the SELECTION card likewise never lingers (send/cancel clears
  // the card outright — the local-clear rule in its props doc).
  const lastRef = useRef<BubbleContent | null>(null);
  if (content === null) {
    // keep lastRef — it IS the linger content
  } else if (content.kind === "input" || content.kind === "delivery" || content.kind === "ask" || content.kind === "selection") {
    lastRef.current = null;
  } else {
    lastRef.current = content;
  }

  const [shown, setShown] = useState(content !== null);
  const [fading, setFading] = useState(false);
  const active = content !== null;
  useEffect(() => {
    if (active) {
      setShown(true);
      setFading(false);
      return;
    }
    if (!shown) return;
    // ω99-196: stream（回答）永不自动淡出——回答是用户主动问出来的，必须
    // 用户主动关（✕，dismissedTail）；hint/narration 是 busy 瞬态，保持
    // 2500ms linger 语义（PET_BUBBLE_LINGER_MS 仍被这两路消费）。
    const heldKind = lastRef.current?.kind;
    if (heldKind === undefined || heldKind === "stream") return;
    const fadeAt = setTimeout(() => setFading(true), PET_BUBBLE_LINGER_MS);
    const removeAt = setTimeout(() => setShown(false), PET_BUBBLE_LINGER_MS + PET_BUBBLE_FADE_MS);
    return () => {
      clearTimeout(fadeAt);
      clearTimeout(removeAt);
    };
  }, [active, shown]);

  // ω99-196: 形态机的 prev（ref 存形态连续量）与上抛回调（ref 隔离身份——
  // 入口传 setState 稳定引用，但与 delivery/selection 的 ref 纪律一致）。
  const modeRef = useRef<PetLayoutMode>("compact");
  const onLayoutRef = useRef(props.onLayoutMode);
  onLayoutRef.current = props.onLayoutMode;

  // ω99-105 送达 TTL：送达落槽起 PET_DELIVERY_MS 后关闭。回调走 ref——
  // 入口传的是内联箭头（每次渲染新身份），进 deps 会让 30s 窗随父渲染
  // 反复重开。替换=新对象身份 → 效果重跑 → 窗口从新送达重新起算。
  const closeRef = useRef(props.onDeliveryClose);
  closeRef.current = props.onDeliveryClose;
  useEffect(() => {
    if (delivery === null) return;
    const t = setTimeout(() => closeRef.current(), PET_DELIVERY_MS);
    return () => clearTimeout(t);
  }, [delivery]);

  // ω99-105 Esc 关送达（inputOpen 时让位给 textarea 自身的 Esc，不双关）。
  // ω99-109: 权限卡在场时同样不挂——权限门不让 Esc 逃逸（主窗 modal 同款
  // 语义），卡只随 ask=null 的状态帧消失。ω99-110: 接单卡在场时也抑制
  // （selection 显示优先于 delivery，Esc 归最上层卡——下方自有自己的监听）。
  useEffect(() => {
    if (delivery === null || inputOpen || (props.ask ?? null) !== null || (props.selection ?? null) !== null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [delivery, inputOpen, props.ask, props.selection]);

  // ω99-110 Esc 清 selection 卡（仅清卡不发送）。ask 在场时被 109 语义抑制
  // （权限门优先，最上层卡的 Esc 归属不动）。回调走 ref（入口传内联箭头）。
  const selectionCloseRef = useRef(props.onSelectionClose);
  selectionCloseRef.current = props.onSelectionClose;
  useEffect(() => {
    if ((props.selection ?? null) === null || (props.ask ?? null) !== null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        selectionCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.selection, props.ask]);

  // ω99-109 ask 卡应答：点击即 emit（主窗 relay 转 client.answerPermission），
  // 本地不乐观清卡——服务器是唯一事实源，卡随 ask=null 的下一状态帧消失。
  // 点击后整组按钮禁用（防连点重复 emit）；一个内容不同的新 ask 到达时
  // 复位（新权限门可再答）。
  const [answered, setAnswered] = useState(false);
  const ask = props.ask ?? null; // 同 activeContent 的缺省归一（未接线=无卡）
  const askKey = ask === null ? "" : `${ask.toolName} ${ask.summary} ${String(ask.canAlways)}`;
  useEffect(() => {
    setAnswered(false);
  }, [askKey]);
  const answer = (allow: boolean, scope?: "always"): void => {
    setAnswered(true);
    void tauriEmitEvent(WUDAO_PET_ANSWER_EVENT, scope === undefined ? { allow } : { allow, scope });
  };

  // ω99-110 接单卡三路发送：①chip 即发（translatePrompt/explainPrompt，与提
  // 问框互斥——点 chip 即发，忽略框内未发文字）；②提问框（框空=genericPrompt
  // 框有字=questionPrompt，回车=发送）；③取消=仅清卡。每路 = emit submit 事件
  // + 本地清卡——客户端源=本地清合法（与 ask 的服务器真相语义相反，依据：
  // 卡由热键事件驱动、无服务器态可等，卡的存在本身就是本地事实）。防连点锁
  // 存照 ask（sent 挡按钮 + 挡 Enter 路径；新选段到达复位，旧问题草稿不迁移）。
  const selection = props.selection ?? null; // 同 activeContent 的缺省归一
  const selectionKey = selection === null ? "" : `${selection.granted}|${selection.truncated}|${selection.text}`;
  const [selectionSent, setSelectionSent] = useState(false);
  const [question, setQuestion] = useState("");
  // ω99-309: 两个文本输入各自的组合态（聊天 textarea / 划词追问 input）。
  // 组合期 Enter=确认候选（发送=把拼音半截当问题发给主窗），Esc=取消候选
  // （关窗/清卡=丢掉打到一半的稿）。两个 ref 分开——两输入可同时在屏。
  const chatImeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  const questionImeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  useEffect(() => {
    setSelectionSent(false);
    setQuestion(""); // 新选段整只替换：旧选段的问题草稿不迁移
  }, [selectionKey]);
  const sendSelectionPrompt = (prompt: string): void => {
    if (selectionSent) return; // 防连点（Enter 路径按钮禁用挡不住）
    setSelectionSent(true);
    void tauriEmitEvent(WUDAO_PET_SELECTION_SUBMIT_EVENT, { text: prompt });
    props.onPetTurn(digest(prompt)); // ω99-201: 划词轮也进 transcript（chat 复合体同窗追问）
    selectionCloseRef.current(); // 本地清卡（依据见 props.onSelectionClose 注释）
  };
  const sendFromQuestion = (): void => {
    if (selection === null) return;
    const q = question.trim();
    sendSelectionPrompt(q === "" ? genericPrompt(selection.text) : questionPrompt(selection.text, q));
  };
  const onQuestionKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    /* ω99-309: 组合期 IME 拥有键盘（ω99-151 同款守卫）。 */
    if (imeSwallows(e.nativeEvent, questionImeRef.current, Date.now())) return;
    if (e.key === "Enter") {
      e.preventDefault(); // 单行：Enter 即发送
      sendFromQuestion();
    }
  };

  // ω99-201 — 发送不再收起：onPetTurn(digest) 进 transcript（q 行 +
  // 思考中格立即出现——「思考中…」的第一条通路，本地即时不等帧），聊天窗
  // 保持开（回答与输入同窗，用户令 09-08）。关法仍 Esc/✕/取消/失焦（143）。
  const send = (): void => {
    const t = text.trim();
    if (t === "") return; // 空输入 no-op
    setText("");
    props.onPetTurn(digest(t));
    void tauriEmitEvent(WUDAO_PET_ASK_EVENT, { text: t }); // 主窗 relay 负责提交
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    /* ω99-309: 组合期 IME 拥有键盘——Enter/Escape 全让位（盖整个 handler，
     * InputBox ω99-151 同款）。 */
    if (imeSwallows(e.nativeEvent, chatImeRef.current, Date.now())) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onInputClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault(); // 单行：Enter 即发送，不换行
      send();
    }
  };

  const held = content ?? lastRef.current;
  // ω99-196 — ✕ 关闭回答（stream 形态独有；hint/narration busy 瞬态与
  // delivery 30s TTL 是别域，零触）。点击 = 记 dismissedTail + 清 linger
  // 记忆（content 被抑制成 null 时，held 不得从 lastRef 复活）。记
  // held.text：活流态=answerTail 同串；held 态 answerTail 已是空串——记空
  // 串既不触发重渲（React 同值 bail-out）也永不合 suppression，「held 后
  // tail 稳定即永关」要求记显示中的这条尾巴。
  const dismissAnswer = (): void => {
    if (held === null || held.kind !== "stream") return; // 钮只在 stream 形态渲染
    setDismissedTail(held.text);
    lastRef.current = null;
  };
  // ω99-196 — 窗口形态机（纯函数 bubbleLayoutMode）：渲染期求值，变化经
  // effect 上抛（渲染期不做副作用）。shown=false（淡出移除后）视同无显示
  // ——窗口随之收回 compact，死区修复的收口信号。
  const layoutMode = bubbleLayoutMode(modeRef.current, content, shown ? held : null, dismissedTail);
  useEffect(() => {
    if (layoutMode === modeRef.current) return;
    modeRef.current = layoutMode;
    onLayoutRef.current?.(layoutMode);
  }, [layoutMode]);

  // ω99-208: #2 — chat 复合体自动滚底（0.3.56 验装回执「看不到底下的内
  // 容」）：transcript 变化（新轮入账/末轮流式增长/livePending 翻转）后把
  // scrollTop 钉到 scrollHeight——最新内容恒在可视区，同 stream 形态
  // bottom-aligned「最新永远在屏」的 201 设计意图。ref/effect 只挂 input
  // 态复合体；css 侧 flex 高度链接通后长内容在 transcript 内滚，输入行恒
  // 钉可视区（LiveArea 粘底同族范式：直接赋值，无 smooth）。
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [props.transcript, props.answerTail, props.livePending]);
  // ω99-274 — 聊天头像的 sheet（当前肤左帧，缺省 default；PET_SKIN_SHEETS
  // 单一事实源，与精灵本尊同资产）。
  const avatarSheet = PET_SKIN_SHEETS[props.skinId ?? "default"];
  if (!shown || held === null) return null;
  // ω99-105 点击送达气泡 = 关闭 + 唤起主窗（正文即「点开看全文」通路）。
  const openMain = (): void => {
    closeRef.current();
    void tauriEmitEvent(WUDAO_PET_OPEN_MAIN_EVENT, null); // 信号事件：无载荷
  };
  return (
    <div
      className="pet-bubble"
      data-bubble=""
      data-bubble-state={held.kind}
      data-bubble-fading={fading && content === null ? "" : undefined}
      data-bubble-held={content === null && held.kind === "stream" ? "" : undefined}
      onClick={held.kind === "delivery" ? openMain : undefined}
      style={held.kind === "delivery" ? { cursor: "pointer" } : undefined}
    >
      {held.kind === "ask" && (
        <div className="pet-bubble-ask" data-ask-card="">
          <div className="pet-bubble-ask-tool" data-ask-tool="">
            {held.ask.toolName}
          </div>
          <div className="pet-bubble-ask-summary" data-ask-summary="">
            {held.ask.summary}
          </div>
          <div className="pet-bubble-ask-actions" data-ask-actions="">
            <button type="button" data-ask-allow="" disabled={answered} onClick={() => answer(true)}>
              允许
            </button>
            {held.ask.canAlways && (
              <button type="button" data-ask-always="" disabled={answered} onClick={() => answer(true, "always")}>
                总是允许
              </button>
            )}
            <button type="button" data-ask-deny="" disabled={answered} onClick={() => answer(false)}>
              拒绝
            </button>
          </div>
        </div>
      )}
      {held.kind === "input" && (
        // ω99-201 — chat 复合体（回答与输入同窗，用户令 09-08）：kind
        // 保持 "input"（状态机/DOM 锚点不动），渲染体 = transcript（近 ≤3
        // 轮 q 行+a 格，末位活格空答 → 「思考中…」格）+ 原 textarea/发送/
        // 取消行（锚点 data-bubble-input 等全保——追问时旧回答不消失）。
        <div className="pet-bubble-chat">
          <div className="pet-bubble-transcript" data-bubble-transcript="" ref={transcriptRef}>
            {props.transcript.map((turn, i) => {
              const isLast = i === props.transcript.length - 1;
              const thinking = isLast && turn.live && turn.a === "";
              return <TranscriptTurn key={i} turn={turn} thinking={thinking} avatarSheet={avatarSheet} />;
            })}
          </div>
          <div className="pet-bubble-input">
            <textarea
              data-bubble-input=""
              placeholder="问点什么…"
              rows={1}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onCompositionStart={() => { chatImeRef.current = imeStart(chatImeRef.current); }}
              onCompositionEnd={() => { chatImeRef.current = imeEnd(chatImeRef.current, Date.now()); }}
              onKeyDown={onKeyDown}
            />
            {/* ω99-143：用户实机反馈「问点什么」气泡无法关闭——input 原本只有
                Esc（需宠物窗持键盘焦点，点别处即失）与发送两条关法。取消是
                不依赖键盘焦点的确定性关闭通路。
                ω99-292：用户令 09-12「发送在最右边，取消按钮稍微离远点，并且
                不要太显眼」——DOM 换序（取消在前、发送殿后=flex-end 行的最右
                主操作位）+ 行距拉开 + 取消退为低调文字钮（见 pet.css）。 */}
            <div className="pet-bubble-input-row" data-bubble-actions="">
              <button type="button" data-bubble-cancel="" className="pet-bubble-cancel" onClick={onInputClose}>
                取消
              </button>
              <button type="button" data-bubble-send="" className="pet-bubble-send" onClick={send}>
                发送
              </button>
            </div>
          </div>
        </div>
      )}
      {held.kind === "selection" && held.selection.granted && held.selection.text !== "" && (
        <div className="pet-bubble-selection" data-selection-card="">
          <div className="pet-bubble-selection-text" data-selection-text="">
            {held.selection.text}
          </div>
          <div className="pet-bubble-selection-actions" data-selection-actions="">
            <button type="button" data-selection-translate="" disabled={selectionSent} onClick={() => sendSelectionPrompt(translatePrompt(held.selection!.text))}>
              翻译
            </button>
            <button type="button" data-selection-explain="" disabled={selectionSent} onClick={() => sendSelectionPrompt(explainPrompt(held.selection!.text))}>
              解释
            </button>
            {/* ω99-113 第五路：划的是网址 → 多出「读这个网页」chip（复用既有
                chip 样式与提交车道，话术走 urlPrompt；非 URL 不出现）。 */}
            {isUrlSelection(held.selection.text) && (
              <button type="button" data-selection-url="" disabled={selectionSent} onClick={() => sendSelectionPrompt(urlPrompt(held.selection!.text))}>
                读这个网页
              </button>
            )}
          </div>
          <div className="pet-bubble-selection-row" data-selection-row="">
            <input
              data-selection-question=""
              placeholder="想问它什么？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onCompositionStart={() => { questionImeRef.current = imeStart(questionImeRef.current); }}
              onCompositionEnd={() => { questionImeRef.current = imeEnd(questionImeRef.current, Date.now()); }}
              onKeyDown={onQuestionKeyDown}
            />
            <button type="button" data-selection-send="" disabled={selectionSent} onClick={sendFromQuestion}>
              发送
            </button>
            <button type="button" data-selection-cancel="" onClick={() => selectionCloseRef.current()}>
              取消
            </button>
          </div>
        </div>
      )}
      {held.kind === "selection" && held.selection.granted && held.selection.text === "" && (
        <div className="pet-bubble-selection" data-selection-empty="">
          <div className="pet-bubble-selection-text">没划到文字</div>
          <div className="pet-bubble-selection-actions">
            <button type="button" data-selection-cancel="" onClick={() => selectionCloseRef.current()}>
              取消
            </button>
          </div>
        </div>
      )}
      {held.kind === "selection" && !held.selection.granted && (
        <div className="pet-bubble-selection" data-selection-guide="">
          <div className="pet-bubble-selection-text">需要辅助功能权限</div>
          <div className="pet-bubble-selection-actions">
            <button type="button" data-selection-open-settings="" onClick={() => void tauriInvokeCommand("open_accessibility_settings", {})}>
              去系统设置打开
            </button>
            <button type="button" data-selection-cancel="" onClick={() => selectionCloseRef.current()}>
              取消
            </button>
          </div>
        </div>
      )}
      {held.kind === "hint" && <div className="pet-bubble-hint">在等你确认操作</div>}
      {/* ω99-113 旁白行：复用 hint 行样式（同一族状态行，不新开视觉语言）。
          v7 γ1：data-work-kind 锚随行（种类→形态差异的将来缝；无 CSS 消费
          =零视觉变化，DOM 键名钉死供后续弧接）。 */}
      {held.kind === "narration" && (
        <div className="pet-bubble-hint" data-bubble-narration="" data-work-kind={props.workKind ?? undefined}>
          {held.text}
        </div>
      )}
      {/* ω99-201 — 独立 thinking 形态（关窗后宠物源轮在飞）：复用 hint
          行样式 + data-bubble-thinking 锚；词面逐字「思考中…」（用户原词）。 */}
      {held.kind === "thinking" && (
        <div className="pet-bubble-hint" data-bubble-thinking="">
          思考中…
        </div>
      )}
      {held.kind === "stream" && (
        <>
          {/* ω99-196：用户主动关（✕）——回答是用户主动问的，必须操作对应
              （用户令 09-08「应该让用户主动关」）；不依赖键盘焦点的确定性
              关闭通路（ω99-143 军规）。活流态与 held 阅读态均在场。 */}
          <button type="button" className="pet-bubble-close" data-bubble-close="" aria-label="关闭回答" onClick={dismissAnswer}>
            ✕
          </button>
          {/* ω99-210: stream 尾同换 PetMarkdown（与 #4 同因；wrapper 与 ✕ 逻辑
              不动——dismissedTail 抑制/形态机零触）。 */}
          <div className="pet-bubble-stream" data-stream-expanded={streamExpanded ? "" : undefined}>
            <PetMarkdown source={held.text} />
          </div>
          {/* ω99-272 — 流面折叠钮（裸提，标记见 #4）：全文超 STREAM_FOLD_CHARS
              才出现。折叠态=既有尾窗（底对齐+overflow hidden 的尾视——最新恒
              在屏）；展开态=从头通读+内滚（css [data-stream-expanded]）。字符
              数只是触发器，held.text 全文恒在 DOM。 */}
          {held.text.length > STREAM_FOLD_CHARS && (
            <button type="button" className="pet-bubble-fold" data-stream-toggle="" onClick={() => setStreamExpanded((e) => !e)}>
              {streamExpanded ? "收起" : "展开全文"}
            </button>
          )}
        </>
      )}
      {held.kind === "delivery" && (
        <>
          <div className="pet-bubble-hint">定时任务送达</div>
          <div className="pet-bubble-stream" data-delivery-prompt="">
            {held.delivery.promptDigest}
          </div>
          {held.delivery.answerDigest !== "" && (
            <div className="pet-bubble-stream" data-delivery-answer="">
              {held.delivery.answerDigest}
            </div>
          )}
        </>
      )}
    </div>
  );
}
