// 借鉴弧 α1（Codex rust-v0.154.0 中途内联问答思想）— ask_user 的 web 车道
// 停泊园。core 的 ask_user 工具本来就是 interaction-free：等待机制=注入的
// askUser 缝 + 工具自身的 120s 超时赛跑（packages/core/src/tools/ask-user.ts，
// M34 §1）。TUI 早已接线（app.tsx 的 onAskUser）；`wudao ui` 是唯一没接的
// 前端——AskUserCards 组件从诞生起就「tested and ready for the v1.1 seam
// that parks questions in the state snapshot」。本模块就是那条缝：
//   • createAskUserPark——把「问一句等回答」停泊成状态帧里的
//     pendingAskUser（问题+选项 chips+自由输入），answer()/dismiss() 回答或
//     解散（解散=工具的 error 结果→「自行决定并继续」——不丢任务状态，
//     run 从未中断）；自清计时器镜像工具自己的 120s（工具的 race 先定终
//     态，迟到回答 resolve 一个已 settle 的 promise，无害）。
//   • withAskUserLane——把停泊园挂上 UiDriverPort：getStatus 合并
//     pendingAskUser，answerAskUser/recallSteer 两个 op 在这里接线（借 α2
//     的撤回 op 顺车），停泊/清空时触发自己的订阅者（server 的 pushState
//     骑 subscribe，驱动本身无状态变化不会自发 emit）。
// M24：澄清问答进历史的形状沿用 ask_user 既有契约（tool_use + tool_result，
// 轮界追加、纯后缀）——零新历史形状、零 system prompt 变更、零前缀代价。
import type { UiDriverPort } from "@wudao/server";
import type { AgentDriver } from "./contract.js";
import { ASK_USER_TIMEOUT_MS, type AskUserOption } from "@wudao/core";

/** The state-frame face of a parked clarification (JSON-serializable; the
 *  web protocol mirrors this shape). */
export interface PendingAskUser {
  readonly question: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
}

export interface AskUserPark {
  /** The tool's seam (createAskUserTool's askUser): parks and resolves with
   *  the user's answer; rejects on dismiss / park timeout (the tool turns a
   *  rejection into its decide-yourself error result). */
  askUser(question: string, options?: readonly AskUserOption[]): Promise<string>;
  /** Resolve with the user's answer (empty/absent = dismiss). Returns false
   *  when nothing is parked. */
  answer(text?: string): boolean;
  /** The status-frame snapshot (null when nothing is parked). */
  snapshot(): PendingAskUser | null;
  /** Reject a parked ask without an answer (interrupt lane). */
  rejectPending(reason: string): void;
}

export function createAskUserPark(opts: {
  readonly timeoutMs?: number;
  /** Fires on park AND on settle — the wrapper's status push. */
  readonly onChange?: () => void;
}): AskUserPark {
  const timeoutMs = opts.timeoutMs ?? ASK_USER_TIMEOUT_MS;
  let pending: { readonly question: string; readonly options?: readonly AskUserOption[]; readonly resolve: (a: string) => void; readonly reject: (e: Error) => void; readonly timer: NodeJS.Timeout } | null = null;
  const clear = (): void => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
    opts.onChange?.();
  };
  return {
    askUser(question, options) {
      // One parked ask at a time: ask_user is isConcurrencySafe:false — the
      // loop never overlaps two calls; a double park can only be a bug, and
      // the honest move is to fail the NEW one closed (the old one still
      // owns the card).
      if (pending !== null) return Promise.reject(new Error("another question is already parked"));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Mirror of the tool's own timeout race: the tool result has already
          // settled as decide-yourself; this clears the card AND rejects the
          // seam so nothing dangles (the TUI's timer twin).
          if (pending !== null && pending.resolve === resolve) {
            clear();
            reject(new Error("user did not answer in time"));
          }
        }, timeoutMs);
        timer.unref?.();
        pending = { question, ...(options !== undefined ? { options } : {}), resolve, reject, timer };
        opts.onChange?.();
      });
    },
    answer(text) {
      if (pending === null) return false;
      const settled = pending;
      const trimmed = (text ?? "").trim();
      clear();
      if (trimmed === "") settled.reject(new Error("user dismissed the question"));
      else settled.resolve(trimmed);
      return true;
    },
    snapshot() {
      return pending === null ? null : { question: pending.question, ...(pending.options !== undefined ? { options: pending.options } : {}) };
    },
    rejectPending(reason) {
      if (pending === null) return;
      const settled = pending;
      clear();
      settled.reject(new Error(reason));
    },
  };
}

/** The lane: the park (created before the driver exists — the tool's seam
 *  closes over it at session construction) + a late mount on the finished
 *  port (merged status, the two ops, the interrupt rider). */
export interface AskUserLane {
  readonly park: AskUserPark;
  /** Mount on the finished driver port: merged status (pendingAskUser), the
   *  answerAskUser op (the park), and the α2 recallSteer op (straight to the
   *  driver's CAS face — the port-optional seam the server validates). */
  mount(port: UiDriverPort, driver: AgentDriver): UiDriverPort;
}

export function createAskUserLane(opts?: { readonly timeoutMs?: number }): AskUserLane {
  let notify: (() => void) | undefined;
  const park = createAskUserPark({ timeoutMs: opts?.timeoutMs, onChange: () => notify?.() });
  return {
    park,
    mount(port, driver) {
      const listeners = new Set<() => void>();
      const fire = (): void => { for (const cb of [...listeners]) cb(); };
      notify = fire;
      return {
        ...port,
        subscribe: (cb) => {
          listeners.add(cb);
          const off = port.subscribe(cb);
          return () => { listeners.delete(cb); off(); };
        },
        getStatus: () => ({ ...(port.getStatus() as Record<string, unknown>), pendingAskUser: park.snapshot() }),
        answerAskUser: (answer?: string) => park.answer(answer),
        recallSteer: (index: number, text: string) => driver.recallSteer(index, text),
        // An interrupt must not leave the card parked for the tool's leftover
        // 120s: reject FIRST (the tool settles as decide-yourself — the same
        // posture denyPendingAsk gives a parked permission), then interrupt.
        interrupt: () => { park.rejectPending("interrupted"); port.interrupt(); },
      };
    },
  };
}
