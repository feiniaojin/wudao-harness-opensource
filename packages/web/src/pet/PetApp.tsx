// ω99-291 — 宠物应用组件（状态核心 + 组合）。从 main.tsx 单体拆出的第三件：
// machine/frame/chat/awaiting/inputOpen/layout 六态在此归账；信号层
// （signals.ts）与交互层（interaction.ts）的 hook 按总线注册序组合——
// usePetStateFrames 必须是最后一个信号 hook（pet-root 的 harness 取最末
// transformCallback 注册为 state handler，序变=测试面崩）。对
// ../tauri-invoke.js 零 import（omega99-291 钉的缝：总线接线只在 signals，
// 直接操纵只在 interaction）。渲染体从 main.tsx 逐字搬运（278 ② 的
// display/pokeEpoch/poked/pet-expr 钉仍在渲染面）。
import { useEffect, useMemo, useRef, useState } from "react";
import { initialPetMachineState, stepPetMachine } from "./pet-state.js";
import { petFrameToInput } from "./pet-frame.js";
import type { PetFrame } from "./pet-frame.js";
import { PET_SKINS } from "./skins/index.js";
import { PetSprite } from "./PetSprite.js";
import { Bubble } from "./Bubble.js";
import type { PetLayoutMode } from "./Bubble.js";
import { applyFrame, emptyPetChat, mergeChat, pushTurn } from "./pet-chat.js";
import { usePetDeliverySignal, usePetHistorySignal, usePetLayoutSync, usePetSelectionSignal, usePetSkinSignal, usePetStateFrames, usePetThemeSignal, usePetToastSignal } from "./signals.js";
import { usePointerInteraction, useWakeNudge } from "./interaction.js";

/** The pet app: the machine + the pointer layer + the bubble (ω99-99). The
 *  machine steps on every wudao-pet-state frame the MAIN window's relay
 *  emits (the pet itself never opens a WS); the bubble streams answerTail
 *  and opens into an input on a CLICK (not a drag). drag never enters the
 *  machine: the pointer layer overrides the rendered display and restores
 *  the machine's value on release (the boundary note in pet-state.ts).
 *  ω99-145 wake nudge rides visibilitychange: a hidden→visible transition
 *  remounts the sprite (motionEpoch key) — the pet never freezes itself
 *  (常活, 用户令 09-07). If the frames stop, the pet holds its last
 *  display — accepted P0 behavior, nothing is invented locally. */
export function PetApp() {
  // --- 状态核心（PetApp 自有域） ---------------------------------------------
  const [machine, setMachine] = useState(initialPetMachineState);
  const [frame, setFrame] = useState<PetFrame | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  // ω99-196 — 窗口形态机：Bubble 上抛 mode → set_pet_layout（接线在
  // signals 的 usePetLayoutSync）。挂载首帧 compact（幂等：Rust 启动已预
  // 收缩，此处兜住「窗口曾在 bubble/answer 形态下被杀」的恢复边角）。
  const [layoutMode, setLayoutMode] = useState<PetLayoutMode>("compact");
  // ω99-201: #3 — 迷你聊天窗本地态（用户令 09-08：发送即时反馈 + 回答与
  // 输入同窗）：chat=transcript（≤3 轮，applyFrame/pushTurn 纯规则归账，
  // 服务器协议零改）；awaiting=发送后首帧前的本地旗（「思考中…」即时
  // 通路①——不等帧；任何帧到达即清，之后由 livePending 的活格推导接力）。
  const [chat, setChat] = useState(emptyPetChat);
  const [awaiting, setAwaiting] = useState(false);

  // --- 信号层（hook 调用序=总线注册序；state 帧殿后——pet-root 契约） -------
  usePetLayoutSync(layoutMode);
  const { delivery, clearDelivery } = usePetDeliverySignal();
  const { selection, clearSelection } = usePetSelectionSignal();
  const skinId = usePetSkinSignal();
  // ω99-237 — toast 的被拒轮回滚（stable setter only——首渲染捕获即安全）：
  // 弹掉末位 live 活格 + 清 awaiting（被拒的轮永无来帧，不回滚就是一行
  // 永久的假「思考中…」）。
  const toast = usePetToastSignal(() => {
    setAwaiting(false);
    setChat((c) => {
      const last = c.turns.length > 0 ? c.turns[c.turns.length - 1] : undefined;
      if (last === undefined || !last.live) return c;
      return { turns: c.turns.slice(0, -1) };
    });
  });
  const { history, requestHistory } = usePetHistorySignal();
  usePetThemeSignal();
  usePetStateFrames((f) => {
    setFrame(f);
    setMachine((m) => stepPetMachine(m, petFrameToInput(f), Date.now()));
    setChat((c) => applyFrame(c, f)); // ω99-201: 帧归账进 transcript 活格
    setAwaiting(false); // ω99-201: 首帧到达——本地 awaiting 旗退役
  });

  // --- 交互层 -----------------------------------------------------------------
  const motionEpoch = useWakeNudge(requestHistory);
  const { dragging, releaseFlash, pokeEpoch, pokeFlash, pokeExpr, onPointerDown } = usePointerInteraction({ inputOpen, setInputOpen });

  const figure = PET_SKINS[skinId].component;

  // --- 输入会话与史拉取的边沿（PetApp 自有域的效应） --------------------------

  // ω99-143：失焦自动收起输入——用户点了别处（主窗/其它 app）即视为放弃，
  // always-on-top 气泡不钉屏。关闭通路自此三条皆不依赖键盘焦点（取消按钮/
  // 再点宠物/失焦；Esc 仅在宠物窗仍持焦时可用）。
  useEffect(() => {
    if (!inputOpen) return;
    const onBlur = (): void => setInputOpen(false);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [inputOpen]);

  // ω99-271 — 拉取沿②开沿：inputOpen 置 true（用户点开聊天面）时 refetch——
  // 正要被读的就是史。StrictMode 双挂载会多发一发，读幂等无害。
  useEffect(() => {
    if (inputOpen) requestHistory();
  }, [inputOpen]);

  // ω99-271 — 拉取沿③落定沿：busy true→false（run 刚结束——本轮此刻才进
  // pet.jsonl，回执把完整问答带回来，替换掉流式尾窗归账的截断版）。
  const frameBusy = frame?.busy ?? false;
  const prevFrameBusy = useRef(false);
  useEffect(() => {
    if (prevFrameBusy.current && !frameBusy) requestHistory();
    prevFrameBusy.current = frameBusy;
  }, [frameBusy]);

  // --- 派生与回调 ---------------------------------------------------------------

  // ω99-201 — onPetTurn（宠物源轮入账 + 置 awaiting）与 livePending 派生：
  // awaiting（发送后首帧前）|| 末位活格有问无答且帧 busy（推理期）——两条通路
  // 合成「思考中…」的完整覆盖；主窗轮（q=""的兜底格或无格）天然不置
  // livePending（D8：主窗工作时宠物只有精灵动画，不弹独立思考中形态）。
  const onPetTurn = (d: string): void => {
    setChat((c) => pushTurn(c, d));
    setAwaiting(true);
  };
  // ω99-271 — 显示层转写 = 本地 chat ∥ 完整史 的纯合并（史在场则升级匹配轮
  // 为全文；缺席照旧本地）。livePending 也读合并末位：史里已落定的轮拿全文
  // 后 a≠""，思考中旗自然熄灭——不靠帧冻结先到。
  const turns = useMemo(
    () => (history === null ? chat.turns : mergeChat(history, chat).turns),
    [history, chat],
  );
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const livePending =
    awaiting ||
    (lastTurn !== undefined && lastTurn.live && lastTurn.q !== "" && lastTurn.a === "" && (frame?.busy ?? false) === true);

  return (
    <>
      <Bubble
        inputOpen={inputOpen}
        answerTail={frame?.answerTail ?? ""}
        waitingUser={machine.display === "waiting-user"}
        busyNarration={frame?.busyNarration ?? null}
        workKind={frame?.workKind ?? null}
        onInputClose={() => setInputOpen(false)}
        delivery={delivery}
        onDeliveryClose={clearDelivery}
        ask={frame?.ask ?? null}
        selection={selection}
        onSelectionClose={clearSelection}
        onLayoutMode={setLayoutMode}
        transcript={turns}
        onPetTurn={onPetTurn}
        livePending={livePending}
        skinId={skinId}
      />
      {/* ω99-274: #3 — skinId 下传 Bubble：聊天记录头像跟随当前肤（换肤事件
          已驱动本组件重渲，头像随新 sheet 即时换图，与精灵同帧生效）。 */}
      {/* ω99-145: key=motionEpoch — hidden→visible 转变时重挂精灵，重建 CSS
          动画（wake nudge，取代旧 paused 冻结线）。 */}
      <PetSprite
        key={motionEpoch}
        display={dragging ? "drag" : releaseFlash ? "release" : machine.display}
        skinId={skinId}
        figure={figure}
        pokeEpoch={pokeEpoch}
        poked={pokeFlash}
        onPointerDown={onPointerDown}
      />
      {/* ω99-237 — 斜杠早拦 toast（主窗 relay 拒令的回执面）：独立浮层，
          不进 Bubble 的形态机（input 态在场时也必须可见——用户刚在输入框
          发的斜杠；compact 窗也不与精灵/气泡重叠——窗顶居中）。 */}
      {toast !== null && (
        <div className="pet-toast" data-pet-toast="" role="status">{toast}</div>
      )}
      {/* ω99-278（续，标记 #6 见上）— 戳一戳表情气泡：精灵头顶小话泡
          （toast 的底部镜像位），POKE_EXPR_MS 后自消；独立浮层不进 Bubble
          形态机（input 态在场时也可见——用户刚戳了精灵）。 */}
      {pokeExpr !== null && (
        <div className="pet-expr" data-pet-expr="" role="status">{pokeExpr}</div>
      )}
    </>
  );
}
