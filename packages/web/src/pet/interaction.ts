// ω99-291 — 宠物域的交互层（指针/定时器之家）。0.3.78 回归的教训：指针
// 手势、戳一戳定时器族、拖拽回弹与渲染混在 main.tsx 单体里，任何相邻改动
// 都在同文件互相碰撞。本文件是拆分的第二内聚域——pointerdown/release/点击
// 判定/拖拽回弹/戳一戳三态/wake nudge 的全部定时器与状态；effect 与 handler
// 体从 main.tsx 逐字搬运（行为保持，278 ② 的源级钉随迁此处）。纯输入层：
// 只消费 inputOpen/setInputOpen（点击开输入是指针层的真实数据流）与 onWake
// 回调；对 ../tauri-invoke.js 只用 tauriStartDrag/tauriFocusWindow 两个直接
// 操纵原语（不是事件总线——总线接线全在 signals.ts）。
import { useEffect, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { tauriFocusWindow, tauriStartDrag } from "../tauri-invoke.js";
// ω99-278: #6 — 戳一戳/拖拽回弹/表情气泡的纯层（常量 + 轮选/分类规则，
// busy-narration/pet-chat 同款纯模块先例；机器零参与——见 pet-state.ts）。
// ω99-282（续，标记 #2 见下）— isWindowCarried/POKE_SQUASH_MS：搬运中判据
// + data-poked 瞬时窗（两边界收紧）。
import { isDragRelease, isWindowCarried, pickExpression, POKE_EXPR_MS, POKE_HOLD_MS, POKE_SQUASH_MS } from "./poke.js";

// 点击 vs 拖拽（brief §4）：release 距 press 位移 <CLICK_MOVE_PX 且历时
// <CLICK_MS 判为点击（打开气泡）；超阈=拖拽，不触发。pointercancel 永不
// 算点击；无坐标的事件（真实 pointer 必带 clientX/Y，合成事件可能不带）
// 只按拖拽释放处理，不做点击判定。
const CLICK_MOVE_PX = 5;
const CLICK_MS = 600;
// win32：按下后位移达到该阈值才进入原生拖窗（小于点击判定阈，微抖不启
// 模态循环——静止点击的 pointerup 必须正常投递页面，见 onPointerDown）。
const DRAG_START_PX = 4;

/** ω99-145 wake nudge：取代 ω99-98 的 hidden→data-paused 冻结线。宠物窗是
 *  focus:false / alwaysOnTop / visibleOnAllWorkspaces 的非键浮动小窗，macOS
 *  WKWebView 对它的 document.hidden/合成时钟判定不可靠——冻结线一旦误报
 *  hidden（或漏报 visible）即 animation-play-state:paused 钉死，宠物永久
 *  静止（用户实机「动几下就停下来了」的结构性嫌疑②）。且 visibleOnAll
 *  Workspaces 下「真隐藏」几乎不存在（托盘藏宠=window.hide()，根本不渲染
 *  ）——省电线保护的是不存在的场景。新语义：仅在 hidden→visible 转变时
 *  motionEpoch++ 以 key 重挂 PetSprite——重挂即动画重启，治愈隐藏期时钟
 *  丢失；data-paused 永不再出现（PetSprite 的 paused prop 与 pet.css 的
 *  [data-paused] 规则保留为 API，只是这里不再置 true）。拖拽不受重挂影响
 *  （dragging 是 React state；释放监听在 window 级）。onWake（回醒沿④
 *  refetch 史）首渲染捕获——其函数体不依赖渲染期值，陈闭包无害。
 *  返回 motionEpoch：PetSprite 的重挂 key。 */
export function useWakeNudge(onWake: () => void): number {
  const [motionEpoch, setMotionEpoch] = useState(0);
  // ω99-145 — 只记「上一个 hidden」以识别转变沿（hidden→visible 才 nudge）。
  const prevHidden = useRef(document.hidden);
  useEffect(() => {
    const onVisibility = (): void => {
      if (prevHidden.current && !document.hidden) {
        setMotionEpoch((e) => e + 1);
        onWake(); // ω99-271 拉取沿④回醒沿：用户回来时本地转写可能已是陈史
      }
      prevHidden.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // deps 刻意为 []（与拆分前同）：监听只注册一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return motionEpoch;
}

export interface PointerInteractionOptions {
  /** 点击开输入的判定面：release 效应 deps 含它（与拆分前同）。 */
  inputOpen: boolean;
  /** PetApp 的输入会话开关（点击 toggle 的落点）。 */
  setInputOpen: Dispatch<SetStateAction<boolean>>;
}

export interface PointerInteraction {
  dragging: boolean;
  releaseFlash: boolean;
  pokeEpoch: number;
  pokeFlash: boolean;
  pokeExpr: string | null;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/** 指针交互域：press 账本（ref）+ 窗级释放监听 + 戳/表情/回弹三定时器族
 *  （+ squash 瞬时窗）+ 戳一戳三态。drag/release/poked 皆 UI 事件态——机器
 *  （pet-state.ts）零参与，drag 边界（pet-state.ts:7-16）的同族续写。 */
export function usePointerInteraction(opts: PointerInteractionOptions): PointerInteraction {
  const { inputOpen, setInputOpen } = opts;
  const [dragging, setDragging] = useState(false);
  // ω99-278（续，标记 #6 见上）— 戳一戳三态：pokeEpoch=Q 弹层重挂纪元
  // （++ 即 pet-squash 重启，motionEpoch 同技法但只重挂内层）；pokeExpr=
  // 头顶表情气泡（POKE_EXPR_MS 自消）；releaseFlash=真·拖拽释放后的 450ms
  // 回弹窗（pet-release 同值）。三者皆 UI 事件态——机器（pet-state.ts）零
  // 参与，drag 边界（pet-state.ts:7-16）的同族续写。
  // ω99-282: #2 — 两边界收紧：① pokeEpoch 不再推断 data-poked（见下
  // pokeFlash）；② 新增 pokeFlash=data-poked 瞬时窗态——戳时置 true，
  // POKE_SQUASH_MS(600ms) 后置 false（pet-squash 单次无 fill，动画早已放
  // 完，撤属性零视觉差）——wake nudge/StrictMode 的窗外重挂（pokeEpoch 作
  // key 只重启层）不再带着 data-poked 重放 squash。仍属 UI 事件态，机器零
  // 参与。
  const [pokeEpoch, setPokeEpoch] = useState(0);
  const [pokeFlash, setPokeFlash] = useState(false);
  const [pokeExpr, setPokeExpr] = useState<string | null>(null);
  const [releaseFlash, setReleaseFlash] = useState(false);
  // ω99-282（续，标记 #2 见上）— sx/sy=按下时刻的窗位（window.screenX/
  // screenY）：原生拖窗期指针事件不投递页面，窗位差是「搬运中」的唯一可靠
  // 位移事实——戳计时到点据此判（isWindowCarried）。
  const press = useRef<{ x?: number; y?: number; sx: number; sy: number; t: number } | null>(null);
  // win32：本次手势是否已进入原生拖窗循环（阈值消费的账本位——循环期
  // 页面收不到指针事件，指针移回页面后的第一次 move 靠它分辨「拖后
  // 悬停」与「按住移动中」）。
  const nativeDragStarted = useRef(false);
  // ω99-278（续，标记 #6 见上）— 戳/表情/回弹三定时器 + 上次表情（指针层
  // 账本，与 press ref 同位；清理缝=释放开头 + 卸载效应，沿 toast 定时器
  // 范式「clearTimeout 旧再挂新」）。ω99-282（续）— 第四个 squashTimer：
  // data-poked 瞬时窗（POKE_SQUASH_MS 后撤属性）。
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exprTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const squashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastExpr = useRef<string | null>(null);

  // Release at WINDOW level: during a native window drag the pointerup
  // usually lands outside the 96px sprite — an element-level onPointerUp
  // alone would strand the pet in "drag" forever. ω99-99 folds the CLICK
  // judgment into the same release (press+release near-same spot, fast).
  useEffect(() => {
    if (!dragging) return;
    const release = (e: PointerEvent): void => {
      // ω99-278（续，标记 #6 见上）— 释放即撤戳（开头、先于一切判定）：
      // 按住 <POKE_HOLD_MS 松手的手势不算戳；已触发的戳不受影响。
      if (pokeTimer.current !== null) {
        clearTimeout(pokeTimer.current);
        pokeTimer.current = null;
      }
      setDragging(false);
      const p = press.current;
      press.current = null;
      // ω99-278（续，标记 #6 见上）— 真·拖拽释放（位移 ≥5px 且非 cancel/
      // 无坐标，isDragRelease 分类）：450ms 回弹窗（= pet-release 0.45s 同
      // 值；0% 承接 drag forwards 钉住的 1.05，零突跳）。
      if (isDragRelease(p, e)) {
        setReleaseFlash(true);
        if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
        releaseTimer.current = setTimeout(() => {
          releaseTimer.current = null;
          setReleaseFlash(false);
        }, 450);
      }
      if (p === null || e.type === "pointercancel") return; // 取消的手势不是点击
      if (p.x === undefined || p.y === undefined || e.clientX === undefined || e.clientY === undefined) return; // 无坐标→只当拖拽释放
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const dt = Date.now() - p.t;
      if (dx * dx + dy * dy < CLICK_MOVE_PX * CLICK_MOVE_PX && dt < CLICK_MS) {
        // ω99-143：点击开、再点收（toggle）——「问点什么」气泡必须永远有
        // 不依赖键盘焦点的关法（用户实机反馈：点开后无法关闭）。
        setInputOpen((open) => !open);
        if (!inputOpen) void tauriFocusWindow(); // D8：开时聚焦=意图确认；收起不抢焦点
      }
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [dragging, inputOpen]);

  // win32 拖窗阈值消费 + 拖后自愈（onPointerDown 注释的另一半）：
  // ① 按住期间位移 ≥ DRAG_START_PX 才 tauriStartDrag（进入原生模态循环）；
  // ② 循环期 pointerup 不投递页面，循环结束后的下一次 pointermove 带
  //    buttons===0（键已松）——此时收尾 dragging（回弹视觉与 release 同
  //    源），否则光标停在 grabbing。用户松手后不再动鼠标的极端边角由下
  //    一次 pointerdown 自然复位（onPointerDown 总是重置整个手势账本）。
  useEffect(() => {
    if (!dragging) {
      nativeDragStarted.current = false;
      return;
    }
    const onMove = (e: PointerEvent): void => {
      const p = press.current;
      if (nativeDragStarted.current) {
        if (e.buttons === 0) {
          // 原生拖拽已结束（模态循环退出后的悬停移动）——收尾。
          nativeDragStarted.current = false;
          press.current = null;
          setDragging(false);
          setReleaseFlash(true);
          if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
          releaseTimer.current = setTimeout(() => {
            releaseTimer.current = null;
            setReleaseFlash(false);
          }, 450);
        }
        return;
      }
      if (p === null || p.x === undefined || p.y === undefined) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (dx * dx + dy * dy >= DRAG_START_PX * DRAG_START_PX) {
        nativeDragStarted.current = true;
        void tauriStartDrag();
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
    };
  }, [dragging]);

  // ω99-278（续，标记 #6 见上）— 戳/表情/回弹定时器的卸载卫生：组件
  // 卸载一律清（沿 toast 定时器的清理范式——挂着的定时器绝不在卸载后
  // setState）。ω99-282（续，标记 #2 见上）— 第四行 squashTimer。
  useEffect(() => {
    return () => {
      if (pokeTimer.current !== null) clearTimeout(pokeTimer.current);
      if (exprTimer.current !== null) clearTimeout(exprTimer.current);
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
      if (squashTimer.current !== null) clearTimeout(squashTimer.current);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // ω99-282（续，标记 #2 见上）— sx/sy 记按下时刻的窗位（搬运判据
    // 的基准端；到点端=回调里的当下 window.screenX/screenY）。
    press.current = { x: e.clientX, y: e.clientY, sx: window.screenX, sy: window.screenY, t: Date.now() };
    setDragging(true);
    // win32（0.3.81 实机回执「点小精灵没有输入框」）：start_dragging 在
    // Windows 进入原生模态拖拽循环（SC_MOVE），循环期指针事件不投递页
    // 面——按下即启会把紧随的 pointerup 也吞进循环，点击判定永不触发，
    // 输入态在 Windows 上无法经点击打开（macOS 的 AppKit 循环结束后把
    // 事件还给页面，上游因此未见）。改为【位移阈值后】才启原生拖拽：
    // 静止按下+松开=纯点击（pointerup 正常投递），移动 ≥4px 才转拖窗
    // （阈值消费=下方 dragging 效应里的 window-level pointermove）。
    // ω99-278（续，标记 #6 见上）— 戳计时起表：按住 POKE_HOLD_MS(650)
    // 未释放 → Q 弹重挂 + 头顶表情（轮选不连击）；650>600（CLICK_MS）
    // 与单击天然互斥，释放判定不受影响。toast 范式：clearTimeout 旧
    // 再挂新（正常流旧表已死于释放，防御连按残表）。
    if (pokeTimer.current !== null) clearTimeout(pokeTimer.current);
    pokeTimer.current = setTimeout(() => {
      pokeTimer.current = null;
      // ω99-282（续，标记 #2 见上）— 边界①搬运中不戳：到点先查按下
      // ↔到点的窗位差——原生拖窗期指针事件不投递页面，窗位是唯一可靠
      // 位移事实；差 ≥5px=搬运中（用户抓着宠物拖到半路停手），整个回
      // 调 return：不 epoch、不表情、不起表情定时器（搬运读作误触）。
      if (
        isWindowCarried(
          press.current !== null ? { x: press.current.sx, y: press.current.sy } : null,
          { x: window.screenX, y: window.screenY },
        )
      ) {
        return;
      }
      lastExpr.current = pickExpression(lastExpr.current, Math.random);
      setPokeEpoch((n) => n + 1);
      // ω99-282（续，标记 #2 见上）— 边界②data-poked 瞬时窗：戳时置
      // true，POKE_SQUASH_MS(600ms) 后置 false（toast 范式 clearTimeout
      // 旧再挂新）——窗外任何重挂（wake nudge/StrictMode）都挂不上
      // data-poked，不再重放 squash。
      setPokeFlash(true);
      if (squashTimer.current !== null) clearTimeout(squashTimer.current);
      squashTimer.current = setTimeout(() => {
        squashTimer.current = null;
        setPokeFlash(false);
      }, POKE_SQUASH_MS);
      setPokeExpr(lastExpr.current);
      if (exprTimer.current !== null) clearTimeout(exprTimer.current);
      exprTimer.current = setTimeout(() => {
        exprTimer.current = null;
        setPokeExpr(null);
      }, POKE_EXPR_MS);
    }, POKE_HOLD_MS);
  };

  return { dragging, releaseFlash, pokeEpoch, pokeFlash, pokeExpr, onPointerDown };
}
