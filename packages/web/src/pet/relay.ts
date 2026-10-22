// ω99-99 — the main-window side of the pet relay. The pet window must never
// open a second WS (server is single-client, second connection → close
// 4000), so the MAIN window speaks for it: every UiSnapshot change is
// distilled (pet-frame.ts) and throttled onto the Tauri event bus, and the
// pet's ask events come back here and ride the ONE real client.submit —
// server-side queueing already handles a busy turn, the relay never queues.
// PURE TS — no React, no CSS import: the main-shell entry pulls this into
// its index chunk, so it must stay light (type-only imports of protocol).
import { tauriEmitEvent, tauriListenEvent } from "../tauri-invoke.js";
import { IDLE_PET_FRAME, PET_EMIT_MS, WUDAO_PET_ASK_EVENT, WUDAO_PET_ANSWER_EVENT, WUDAO_PET_STATE_EVENT, WUDAO_PET_TOAST_EVENT, WUDAO_PET_HISTORY_EVENT, WUDAO_PET_HISTORY_REQ_EVENT, derivePetFrame, petFramesEqual, readPetAnswer } from "./pet-frame.js";
import { WUDAO_PET_SELECTION_SUBMIT_EVENT } from "./selection.js";
import type { PetFrame } from "./pet-frame.js";
import type { SubmitOutcome, WudaoClient } from "../protocol.js";

/** Every transport + clock is injectable — tests run the whole relay with
 *  fakes; production wires tauri-invoke + Date.now + client.submit. */
export interface RelayDeps {
  emit: (e: string, p: unknown) => Promise<boolean> | boolean;
  listen: (e: string, h: (p: unknown) => void) => Promise<(() => void) | null> | null;
  now: () => number;
  submit: (t: string) => Promise<SubmitOutcome>;
}

/** Deep-equal for the frame shape — the five primitive leaves compare
 *  directly, ask field-wise (ω99-109's petFramesEqual: an ask-only change
 *  is a new frame and must re-emit). */
function framesEqual(a: PetFrame, b: PetFrame): boolean {
  return petFramesEqual(a, b);
}

export interface FramePump {
  push(f: PetFrame): void;
  cancel(): void;
}

/** Leading+trailing throttle over frames:
 *  - a frame deep-equal to the last EMITTED one is a no-op — and cancels a
 *    pending trailing (state went f→g→f within a window; the receiver's
 *    last frame already matches the sender's current state, so g is stale);
 *  - otherwise, ≥PET_EMIT_MS since the last emit → emit NOW (leading);
 *  - else park the frame as THE trailing (latest wins) to fire when the
 *    current window closes. Emission is fire-and-forget — a failed emit
 *    still counts as sent (broken IPC is P0-accepted, no retry loop). */
export function createFramePump(deps: Pick<RelayDeps, "emit" | "now">, ms = PET_EMIT_MS): FramePump {
  let lastEmitted: PetFrame | null = null;
  let lastEmitAt = -Infinity;
  let pending: PetFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;

  const fire = (): void => {
    timer = null;
    const f = pending;
    pending = null;
    if (f === null) return;
    lastEmitted = f;
    lastEmitAt = deps.now();
    void Promise.resolve(deps.emit(WUDAO_PET_STATE_EVENT, f)).catch(() => {});
  };

  return {
    push(f: PetFrame): void {
      if (dead) return;
      if (lastEmitted !== null && framesEqual(f, lastEmitted)) {
        pending = null; // 等值取消挂起 trailing
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      const wait = lastEmitAt + ms - deps.now();
      if (wait <= 0) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        pending = null;
        lastEmitted = f;
        lastEmitAt = deps.now();
        void Promise.resolve(deps.emit(WUDAO_PET_STATE_EVENT, f)).catch(() => {});
        return;
      }
      pending = f; // 只留最新帧
      if (timer === null) timer = setTimeout(fire, wait);
    },
    cancel(): void {
      dead = true;
      pending = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Mount the relay: subscribe maps every snapshot change through
 *  derivePetFrame into the pump (null status → silence, never an invented
 *  idle frame); ω99-103: once a frame has flowed over a REAL connection, a
 *  snapshot whose connection left "connected" (status lingers — onclose
 *  never clears it) pushes IDLE_PET_FRAME instead: server unreachable = no
 *  live agent, freezing at the last real frame would be a lie (the pump's
 *  equal-frame short-circuit keeps reconnect jitter from re-emitting it).
 *  The ask listener trims the payload's text and submits it on the real
 *  client (empty/whitespace → ignored, rejection → swallowed). ω99-109: the
 *  ANSWER listener rides the same bus the other way — the pet's permission
 *  card answers through client.answerPermission (the exact lane the main
 *  modal uses), malformed payloads are dropped whole (readPetAnswer) and a
 *  rejection is swallowed silently (the parked ask may already have been
 *  resolved elsewhere — same semantics as App's onChoose). ω99-110: the
 *  SELECTION-SUBMIT listener is the ask lane's third sibling — same dumb
 *  trim+submit, except malformed (non-string) payloads drop whole.
 *  ω99-235: #7 车道分流（用户指令 ②）：snap.pet 在场即 pet 源——帧由
 *  derivePetFrame({status: snap.pet}) 派生（pet-frame.ts 零改），ask/划词
 *  走 petSubmit、应答走 petAnswerPermission；缺席（旧服务端/车道禁用）→
 *  降级旧路（ω99-99/109/110 行为逐字节）。断线 idle 语义随所择源。
 *  ω99-237: pet 源的提交统一过 routePetText——斜杠早拦（trim 后 / 开头
 *  不调 petSubmit，toast 回宠物窗；主源降级路的斜杠照旧走主 submit）。
 *  Returns the unmount (unsubscribe + unlisten×4 + pump.cancel). A browser
 *  (listen → null) degrades to send-only without crashing. */
export function mountPetRelay(client: Pick<WudaoClient, "subscribe" | "getSnapshot" | "submit" | "answerPermission" | "petSubmit" | "petAnswerPermission" | "petHistory">, deps?: Partial<RelayDeps>): () => void {
  const d: RelayDeps = {
    emit: deps?.emit ?? ((e, p) => tauriEmitEvent(e, p)),
    listen: deps?.listen ?? ((e, h) => tauriListenEvent(e, h)),
    now: deps?.now ?? (() => Date.now()),
    submit: deps?.submit ?? ((t) => client.submit(t)),
  };
  /** ω99-235: pet 源判定只看 CURRENT 快照的 pet 字段（事件时点决，不缓存）。 */
  const petLaneLive = (): boolean => client.getSnapshot().pet !== undefined;
  /** ω99-237: #6 — pet 源文本的提交路由（ask 与划词接单共用的 choke
   *  point）。斜杠早拦：pet 车道是固定 id 的纯发送面，斜杠命令属主车道——
   *  trim 后以 / 开头即拦（零 RTT：根本不调 petSubmit），toast 事件回宠物窗
   *  （文案逐字，brief §二）。早拦在 web 层独立成立——旧服务端（petSubmit
   *  有求必应、无拒令）也受益，拒令不必等服务端升级；server 的 petSubmit
   *  拒令是第二层兜底（车道不变量=协议层守卫）。toast 发不出（无桥）= 静默：
   *  早拦本身已成立（petSubmit 未被调），只是少了回执面。 */
  const routePetText = (text: string): void => {
    if (text.startsWith("/")) {
      void Promise.resolve(
        d.emit(WUDAO_PET_TOAST_EVENT, { text: "精灵窗口不支持斜杠命令——直接提问，或到主窗口输入命令" }),
      ).catch(() => {});
      return;
    }
    void client.petSubmit(text).catch(() => {});
  };
  const pump = createFramePump(d);
  let hasSeenStatus = false; // 只在 connected 下推过 status 帧才算“见过”——没见过就不补假帧
  const unsubscribe = client.subscribe(() => {
    const snap = client.getSnapshot();
    // ω99-235: 帧派生源随车道——pet 源只读 pet 状态（主窗忙/权限卡不再代喂
    // 精灵窗：纯隔离的有意变化）；缺席则主源（今日行为）。
    const frame = derivePetFrame(snap.pet !== undefined ? { status: snap.pet } : snap);
    if (frame === null) return; // 所择源从无 status → 静默（冷启动的 idle 空窗本来就是诚实）
    if (snap.connection === "connected") {
      hasSeenStatus = true;
      pump.push(frame); // 真连接：真帧（ω99-99 行为不变）
      return;
    }
    if (hasSeenStatus) pump.push(IDLE_PET_FRAME); // 断线补 idle（等值短路防重复 emit）
  });
  let unlistenAsk: (() => void) | null = null;
  let unlistenAnswer: (() => void) | null = null;
  let unlistenSelectionSubmit: (() => void) | null = null;
  let dead = false;
  void Promise.resolve(
    d.listen(WUDAO_PET_ASK_EVENT, (p) => {
      const text = String((p as { text?: unknown })?.text ?? "").trim();
      // ω99-235: pet 源 → petSubmit（精灵自己的 run/队列/转写）；降级 → 主
      // submit。ω99-237: pet 源经 routePetText（斜杠早拦在 choke point）。
      if (text !== "") {
        if (petLaneLive()) routePetText(text);
        else void d.submit(text).catch(() => {});
      }
    }),
  ).then((off) => {
    if (dead) off?.();
    else unlistenAsk = off;
  });
  void Promise.resolve(
    d.listen(WUDAO_PET_ANSWER_EVENT, (p) => {
      const a = readPetAnswer(p);
      if (a === null) return; // 坏载荷整体丢弃，绝不半信
      // ω99-235: pet 源 → petAnswerPermission（答精灵自己的卡）；降级 → 旧 answerPermission。
      void (petLaneLive()
        ? client.petAnswerPermission(a.allow, undefined, a.scope)
        : client.answerPermission(a.allow, undefined, a.scope)).catch(() => {}); /* parked ask 可能已在别处解决 */
    }),
  ).then((off) => {
    if (dead) off?.();
    else unlistenAnswer = off;
  });
  void Promise.resolve(
    // ω99-110 划词接单：载荷已是成品 prompt——哑管道，非字符串/trim 空 →
    // 整丢，reject 静默（与 ask 同语义，relay 从不排队）。ω99-235 车道分流同 ask。
    d.listen(WUDAO_PET_SELECTION_SUBMIT_EVENT, (p) => {
      const raw = (p as { text?: unknown })?.text;
      if (typeof raw !== "string") return;
      const text = raw.trim();
      // ω99-237: pet 源经 routePetText（与 ask 同一 choke point——两处
      // petSubmit 调用位都护住；划词 prompt 生成器今天不产前导斜杠，此处是
      // 纵深防御位）。
      if (text !== "") {
        if (petLaneLive()) routePetText(text);
        else void d.submit(text).catch(() => {});
      }
    }),
  ).then((off) => {
    if (dead) off?.();
    else unlistenSelectionSubmit = off;
  });
  let unlistenHistoryReq: (() => void) | null = null;
  // ω99-271: #8 — 历史代取（宠物窗不开第二条 WS，史也由主窗代取——ask/answer
  // 的第四个同胞）。请求就是信号（无载荷）；pet 车道活着才代取——petHistory
  // 的 turns 由主窗转手原样转发（服务器已配对限额，relay 是哑管道）；车道缺
  // 席/旧服务端拒绝/网络失败 → 不发回执（静默降级：宠物窗本地转写仍是唯一
  // 输入，271 之前的全部行为）。响应不节流：一次性应答信号，delivery 同范式。
  void Promise.resolve(
    d.listen(WUDAO_PET_HISTORY_REQ_EVENT, () => {
      if (!petLaneLive()) return; // 主源降级路无精灵史可取——主窗转写不归宠物窗
      void client.petHistory().then(
        (turns) => {
          void Promise.resolve(d.emit(WUDAO_PET_HISTORY_EVENT, { turns })).catch(() => {});
        },
        () => {}, // unsupported/网络失败：静默（本地转写不受损）
      );
    }),
  ).then((off) => {
    if (dead) off?.();
    else unlistenHistoryReq = off;
  });
  return () => {
    dead = true;
    unsubscribe();
    unlistenAsk?.();
    unlistenAnswer?.();
    unlistenSelectionSubmit?.();
    unlistenHistoryReq?.();
    pump.cancel();
  };
}
