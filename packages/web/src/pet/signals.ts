// ω99-291 — 宠物域的信号层（总线接线之家）。0.3.78 回归（宠物窗零像素）的
// 病根之一是 main.tsx 单体：7 个事件域 + 指针层 + 渲染全在一个 612 行组件
// 里，任何一次改动（T9 加戳一戳）都在同一文件里撞几何/接线/渲染。本文件是
// 拆分的第一内聚域——「哪条总线事件进哪个 state」只在此演进；effect 体从
// main.tsx 逐字搬运（行为保持，既有源级钉同形迁移：275 ③ 的 theme 钉挪到
// 此处）。缝契约：PetApp 对 ../tauri-invoke.js 零 import（omega99-291 钉）。
//
// 注册序=总线契约（pet-root 的 harness 取最末 transformCallback 注册为 state
// handler）：delivery → selection → skin → toast → history → theme → state
// 帧殿后。PetApp 的 hook 调用序即生效序——新增信号 hook 必须插在
// usePetStateFrames 之前（各 effect 原注释保留「声明在 state 帧效果之前」的
// 纪律说明）。
import { useEffect, useState } from "react";
import { tauriEmitEvent, tauriInvokeCommand, tauriListenEvent } from "../tauri-invoke.js";
import { WUDAO_PET_STATE_EVENT, WUDAO_PET_THEME_EVENT, WUDAO_PET_TOAST_EVENT, WUDAO_PET_HISTORY_EVENT, WUDAO_PET_HISTORY_REQ_EVENT, readPetHistory, readPetToast } from "./pet-frame.js";
import type { PetFrame, PetFrameAsk } from "./pet-frame.js";
import { WUDAO_PET_DELIVERY_EVENT, readDelivery } from "./delivery.js";
import type { PetDelivery } from "./delivery.js";
import { WUDAO_PET_SELECTION_EVENT, readSelectionPayload } from "./selection.js";
import type { PetSelection } from "./selection.js";
import { WUDAO_PET_SKIN_EVENT, normalizePetSkinId } from "./skins/index.js";
import type { PetSkinId } from "./skins/index.js";
import type { PetLayoutMode } from "./Bubble.js";

/** ω99-237 — toast 停留时长：长于 hint 的 2500（PET_BUBBLE_LINGER_MS）——
 *  这是一句可行动指引（「到主窗口输入命令」），要给读完的时间。 */
const PET_TOAST_MS = 4000;

/** ω99-109 — the ask field's wire parse. Absent/null → null (an OLD main
 *  window's frames carry no card — compat, never an error); an object must
 *  have all three fields type-correct; anything else marks the whole frame
 *  malformed (the caller drops it — same never-partially-trusted rule). */
const BAD_ASK: unique symbol = Symbol("bad-ask");
function readAsk(p: unknown): PetFrameAsk | null | typeof BAD_ASK {
  if (p === undefined || p === null) return null;
  if (typeof p !== "object") return BAD_ASK;
  const a = p as Record<string, unknown>;
  if (typeof a.toolName !== "string" || typeof a.summary !== "string" || typeof a.canAlways !== "boolean") return BAD_ASK;
  return { toolName: a.toolName, summary: a.summary, canAlways: a.canAlways };
}

/** M85-final I-3/M-3 — 数据面/全路径字段的 wire 解析（readAsk 的 BAD 哨兵
 *  同缝）：absent/null → null；数组元素形不对（非对象/provider/model 非
 *  串）→ BAD（整帧丢弃——绝不半信，同 readPetHistory 纪律）。 */
const BAD_LIST: unique symbol = Symbol("bad-list");
function readModelChoices(p: unknown): readonly { provider: string; model: string }[] | null | typeof BAD_LIST {
  if (p === undefined || p === null) return null;
  if (!Array.isArray(p)) return BAD_LIST;
  const out: { provider: string; model: string }[] = [];
  for (const e of p) {
    if (typeof e !== "object" || e === null) return BAD_LIST;
    const r = e as Record<string, unknown>;
    if (typeof r.provider !== "string" || typeof r.model !== "string") return BAD_LIST;
    out.push({ provider: r.provider, model: r.model });
  }
  return out;
}

/** M85-final I-3 — recentWorkspaces 的 wire 解析（readModelChoices 的字符串
 *  版，同哨兵同纪律）。 */
function readStringList(p: unknown): readonly string[] | null | typeof BAD_LIST {
  if (p === undefined || p === null) return null;
  if (!Array.isArray(p)) return BAD_LIST;
  const out: string[] = [];
  for (const e of p) {
    if (typeof e !== "string") return BAD_LIST;
    out.push(e);
  }
  return out;
}

/** Wire parse — the frame crosses the Tauri bus as an untyped payload; a
 *  malformed frame is dropped whole, never partially trusted. ω99-113:
 *  busyNarration follows ask's compat rule — ABSENT (an old main window's
 *  frames) or null → null; a non-string non-null value marks the frame
 *  malformed whole. v7 γ1: workKind rides the same lane (absent/null →
 *  null；非串非 null 整帧丢弃). */
function readFrame(p: unknown): PetFrame | null {
  if (typeof p !== "object" || p === null) return null;
  const f = p as Record<string, unknown>;
  if (typeof f.busy !== "boolean") return null;
  if (typeof f.pendingPermission !== "boolean") return null;
  if (typeof f.reasoningActive !== "boolean") return null;
  if (typeof f.answerTail !== "string") return null;
  if (typeof f.busyToolCount !== "number") return null;
  if (f.busyNarration !== undefined && f.busyNarration !== null && typeof f.busyNarration !== "string") return null;
  if (f.workKind !== undefined && f.workKind !== null && typeof f.workKind !== "string") return null;
  // M85-pet §2 — 工具栏三 chip 的显示值同车道：absent/null（旧主窗/未配/
  // 坏读降级）→ null；非串非 null 整帧丢弃（同 busyNarration 纪律）。
  if (f.model !== undefined && f.model !== null && typeof f.model !== "string") return null;
  if (f.effort !== undefined && f.effort !== null && typeof f.effort !== "string") return null;
  if (f.workspaceName !== undefined && f.workspaceName !== null && typeof f.workspaceName !== "string") return null;
  // M85-final（终审 M-3/I-3）— workspacePath 同串门；两数据面列表走
  // BAD 哨兵解析（元素形不对整帧丢弃）。
  if (f.workspacePath !== undefined && f.workspacePath !== null && typeof f.workspacePath !== "string") return null;
  const modelChoices = readModelChoices(f.modelChoices);
  if (modelChoices === BAD_LIST) return null;
  const recentWorkspaces = readStringList(f.recentWorkspaces);
  if (recentWorkspaces === BAD_LIST) return null;
  const ask = readAsk(f.ask);
  if (ask === BAD_ASK) return null;
  return {
    busy: f.busy,
    pendingPermission: f.pendingPermission,
    reasoningActive: f.reasoningActive,
    answerTail: f.answerTail,
    busyToolCount: f.busyToolCount,
    busyNarration: typeof f.busyNarration === "string" ? f.busyNarration : null,
    workKind: typeof f.workKind === "string" ? f.workKind : null,
    ask,
    model: typeof f.model === "string" ? f.model : null,
    effort: typeof f.effort === "string" ? f.effort : null,
    workspaceName: typeof f.workspaceName === "string" ? f.workspaceName : null,
    workspacePath: typeof f.workspacePath === "string" ? f.workspacePath : null,
    modelChoices,
    recentWorkspaces,
  };
}

/** ω99-196 — 窗口形态机：Bubble 上抛 mode → set_pet_layout（Rust 把宠物窗
 *  在 compact/bubble/answer 三态间收缩/扩张，底中心锚定——精灵视觉位置全
 *  态不变，点击死区随无显示归零）。挂载首帧 compact（幂等：Rust 启动已预
 *  收缩，此处兜住「窗口曾在 bubble/answer 形态下被杀」的恢复边角）。
 *  力量形态（2026-11-05）：skinId 进依赖——换肤即时重应用当前 mode（Rust
 *  pet_layout_size 按持久肤解析 compact 高度：power 120，其余 84；切肤时
 *  托盘已先持久化再广播，此处读到的一定是新肤）。 */
export function usePetLayoutSync(mode: PetLayoutMode, skinId: PetSkinId): void {
  useEffect(() => {
    void tauriInvokeCommand("set_pet_layout", { mode });
  }, [mode, skinId]);
}

export interface PetDeliveryHandle {
  delivery: PetDelivery | null;
  /** 清槽（Bubble 的接单卡关闭回调——槽归信号域，清也走它的 API）。 */
  clearDelivery: () => void;
}

/** ω99-105: the delivery signal (main window → pet, one-shot — NOT the
 *  throttled frame pump). A scheduled task's result arrives as
 *  {taskId, promptDigest, answerDigest} and occupies the bubble's delivery
 *  slot (single slot: a new delivery replaces the old one outright). The
 *  listen registers BEFORE the state-frame effect on purpose: the harness
 *  in pet-root picks the LAST transformCallback registration as the state
 *  handler — this order keeps that contract intact. Malformed payloads are
 *  dropped whole (readDelivery). Browser (no bridge) → resolves null, no
 *  delivery ever lands, the pet just stays a state mirror. */
export function usePetDeliverySignal(): PetDeliveryHandle {
  const [delivery, setDelivery] = useState<PetDelivery | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_DELIVERY_EVENT, (payload) => {
      const d = readDelivery(payload);
      if (d !== null) setDelivery(d);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  return { delivery, clearDelivery: () => setDelivery(null) };
}

export interface PetSelectionHandle {
  selection: PetSelection | null;
  /** 清槽（Bubble 的接单卡关闭回调——槽归信号域，清也走它的 API）。 */
  clearSelection: () => void;
}

/** ω99-110: the selection hotkey's intake signal (Rust → pet, one-shot like
 *  delivery). A press arrives as {text,truncated,granted}; malformed
 *  payloads drop whole (readSelectionPayload) and a new selection replaces
 *  the old card outright (single slot). Declared BEFORE the state-frame
 *  effect on purpose: pet-root's harness picks the LAST transformCallback
 *  registration as the state handler — this order keeps that contract.
 *  Browser (no bridge) → resolves null, nothing ever lands, no crash. */
export function usePetSelectionSignal(): PetSelectionHandle {
  const [selection, setSelection] = useState<PetSelection | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_SELECTION_EVENT, (payload) => {
      const s = readSelectionPayload(payload);
      if (s !== null) setSelection(s);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  return { selection, clearSelection: () => setSelection(null) };
}

/** ω99-111 — the skin domain: get_pet_skin reads the Rust-persisted
 *  pet-skin.json at mount (capability: allow-get-pet-skin in
 *  capabilities/pet.json — the pet origin is REMOTE in tauri's ACL), and
 *  wudao-pet-skin events (tray 换肤 clicks) re-skin live. Browser (no
 *  bridge) → null → "default"; the invoke is fire-once, and a late answer
 *  after unmount is dropped via `dead` (same pattern as the listeners).
 *  Malformed/unknown ids normalize to "default" — never a blank pet.
 *  Registry lookup stays HERE (the registry's only consumer — keeps
 *  PetSprite ↔ skins a single directed import). */
export function usePetSkinSignal(): PetSkinId {
  const [skinId, setSkinId] = useState<PetSkinId>("default");
  useEffect(() => {
    let dead = false;
    void tauriInvokeCommand("get_pet_skin", {}).then((raw) => {
      if (!dead) setSkinId(normalizePetSkinId(raw));
    });
    return () => {
      dead = true;
    };
  }, []);
  // live skin switching — the tray's 换肤 submenu broadcasts {"skin":"<id>"};
  // normalize + setSkinId re-skins in place, zero restart. Malformed payloads
  // are dropped whole (unknown id stays on the current skin — never a blank
  // pet). Declared BEFORE the state-frame effect on purpose: pet-root's
  // harness picks the LAST transformCallback registration as the state
  // handler — this order keeps that contract.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_SKIN_EVENT, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const skin = (payload as Record<string, unknown>).skin;
      if (typeof skin !== "string") return; // 坏形状整帧丢弃
      const id = normalizePetSkinId(skin);
      if (id !== skin) return; // 注册表外 id → 丢弃（保持当前肤）
      setSkinId(id);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  return skinId;
}

/** ω99-237: #7 — 斜杠早拦的宠物窗回执面：主窗 relay 的 pet 源早拦（relay.ts
 *  routePetText）经事件总线回 wudao-pet-toast。单槽（新 toast 整只替换旧
 *  的），PET_TOAST_MS 后自动收（timer 死于卸载）。同事件还回滚「被拒轮」：
 *  onPetTurn 在发送时就 push 了 q 行 + 置 awaiting（「思考中…」的即时通路
 *  ①）——轮被拒就永无来帧，不回滚就是一行永久的假「思考中…」。回滚经
 *  onRejectedTurn 回调（PetApp 供：弹掉末位 live 活格 + 清 awaiting——
 *  只用稳定 setter，首渲染闭包捕获即安全，与拆分前同语义）。声明在 state
 *  帧效果之前（delivery/selection/skin 同纪律：pet-root harness 取最末注册
 *  为 state handler）。 */
export function usePetToastSignal(onRejectedTurn: (text: string) => void): string | null {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void tauriListenEvent(WUDAO_PET_TOAST_EVENT, (payload) => {
      const t = readPetToast(payload);
      if (t === null) return; // 坏载荷整丢（不覆盖在场 toast）
      setToast(t.text);
      onRejectedTurn(t.text);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), PET_TOAST_MS);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
      if (timer !== null) clearTimeout(timer);
    };
    // deps 刻意为 []（与拆分前同）：监听只注册一次；onRejectedTurn 首渲染
    // 捕获——其函数体只用稳定 setter，陈闭包无害。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return toast;
}

export interface PetHistoryHandle {
  /** ω99-271 — 最近一次 wudao-pet-history 回执（服务器已配对限额的
   *  pet.jsonl 轮）；null=从未收到（冷窗/旧主窗/车道缺席——本地转写照旧，
   *  271 前行为零变）。 */
  history: readonly { q: string; a: string }[] | null;
  /** 主动拉取（三沿 + 回醒沿共用）：发出 wudao-pet-history-request。 */
  requestHistory: () => void;
  /** M85-pet §2 — 史槽清空（新会话的本地清屏面）：setHistory(null) →
   *  显示层落回本地转写。不清则 mergeChat 会用 stale 史复活刚清掉的旧轮
   *  （新会话后服务器史已归档轮换，本地旧回执不再是真值）。诚实收敛：
   *  若 petNewSession op 失败，下一拉取沿（inputOpen 开沿/busy 落定沿/
   *  回醒沿）带回服务器真值。 */
  clearHistory: () => void;
}

/** ω99-271（续，标记 #9）— 历史回执监听（主窗代取的 pet.jsonl 轮）：
 *  readPetHistory 坏载荷整丢（整包作废，不半信——半套史比没有更糟）。
 *  拉取沿①挂载：冷窗起手就问（主窗 relay 的监听可能尚未就绪——丢这一发
 *  不致命：开沿/落定沿/回醒沿都会再问）。声明在 state 帧效果之前
 *  （delivery/selection/skin/toast 同纪律：pet-root harness 取最末
 *  transformCallback 注册为 state handler）。 */
export function usePetHistorySignal(): PetHistoryHandle {
  const [history, setHistory] = useState<readonly { q: string; a: string }[] | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_HISTORY_EVENT, (payload) => {
      const h = readPetHistory(payload);
      if (h !== null) setHistory(h.turns);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  const requestHistory = (): void => {
    void tauriEmitEvent(WUDAO_PET_HISTORY_REQ_EVENT, {}).catch(() => {});
  };
  useEffect(() => {
    requestHistory();
  }, []);
  return { history, requestHistory, clearHistory: () => setHistory(null) };
}

/** ω99-275（续）— 主题联动（用户令「主窗口切换主题，小精灵也要切换」）：
 *  wudao-pet-theme 事件（主窗 applyTheme 广播）→ stamp html[data-theme]，
 *  pet.css 末尾的 [data-theme="light"] 覆盖块取效。payload 坏形整帧丢弃
 *  （非 light/dark 不动当前主题）。声明在 state 帧效果之前
 *  （delivery/selection/skin/toast/history 同纪律——pet-root 的 harness 取
 *  最后一个 transformCallback 注册者为 state 处理器）。 */
export function usePetThemeSignal(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_THEME_EVENT, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const t = (payload as Record<string, unknown>).theme;
      if (t !== "light" && t !== "dark") return;
      document.documentElement.dataset.theme = t;
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
}

/** D2: the state frames drive the machine (one step per frame — done 也能
 *  过期离开，98 报告 §3 的输入源就是这里). Browser (no bridge) → listen
 *  resolves null and the pet simply idles. 本 hook 必须是全部信号 hook 的
 *  最末一个（pet-root harness 取最末 transformCallback 注册为 state
 *  handler）。onFrame 首渲染捕获——PetApp 的实现只用稳定/函数式 setter，
 *  与拆分前同语义。 */
export function usePetStateFrames(onFrame: (f: PetFrame) => void): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    void tauriListenEvent(WUDAO_PET_STATE_EVENT, (payload) => {
      const f = readFrame(payload);
      if (f === null) return;
      onFrame(f);
    }).then((off) => {
      if (dead) off?.();
      else unlisten = off;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
    // deps 刻意为 []（与拆分前同）：监听只注册一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
