// packages/cli/src/soft-warn-tracker.ts — ω99-320 流式软警告的会话级槽。
//
// 315 铺了双档看门狗的 soft 档回调（onStreamIdleWarning——纯 out-of-band：
// 不取消、零模型请求），但 cli 从未消费它——90s 静默期用户面对一个一动
// 不动的界面。本弧把它接到 driver：计数（run-stats「等待较久 N 次」）、
// 首次软警告的温和 live notice、settle 收据、resume 回放。
//
// 交付载具（与 brief 面 1 的偏差，报告 §偏差有全文）：`onStreamIdleWarning`
// 是 ProviderOptions 的**构造期**字段（openai-compatible.ts:122/:227、
// anthropic.ts:522、responses.ts:262 都在工厂闭包里一次性解析进
// createStreamIdleGuard），ModelInput 上没有这个字段、没有任何适配器从
// input 读它——往 input 里注入是生产静默 no-op（假绿）。所以走构造缝：
// 前端（session-engine / TUI app）在每个 createProvider 位点把
// `onStreamIdleWarning: slot.forward` 传进去，slot 持有「当前 listener」，
// driver 在 run 开始时把 listener 指向本 run 的处理器、settle 边界清空
// （迟来回调写不进下一个 run）。core/providers 零改动；slot 语义与 brief
// 一致：可变槽、缺省无 listener=纯透传零行为变化、fail-open。
//
// M24（前缀缓存不变量）：本槽是纯旁路——回调对象永远不进 ModelInput、
// 不进请求体序列化（适配器的 body 构建只挑显式字段）、不进
// state.messages / system prompt。测试双证钉在 320 的 cli 测试里
// （构造缝 A/B 请求字节同一 + 软警告路径 store 零调用）。
import type { StreamIdleWarningInfo } from "@wudao/providers";

/** The per-session soft-warn slot: the stable callback handed to every
 *  createProvider site (spread as `onStreamIdleWarning`), plus the mutable
 *  listener holder the driver re-points per run. */
export interface SoftWarnSlot {
  /** The constructor-seam callback — STABLE identity for the process
   *  lifetime. Forwards to the current listener; no listener (the default,
   *  and post-settle) = no-op. Fail-open: a throwing listener is swallowed —
   *  this fires inside the provider guard's setTimeout, where an escaping
   *  exception is an uncaughtException, not a streamed error. */
  readonly forward: (info: StreamIdleWarningInfo) => void;
  /** Point the slot at THIS run's handler (run start); undefined disarms
   *  (run settle — a late callback lands nowhere, never in the next run). */
  setListener(listener?: (info: StreamIdleWarningInfo) => void): void;
}

/** Create the session's soft-warn slot. One per session (shared by the boot
 *  provider build and every /provider-switch rebuild — the budget fragment's
 *  exact discipline), handed to the driver as `softWarnSlot`. */
export function createSoftWarnSlot(): SoftWarnSlot {
  let listener: ((info: StreamIdleWarningInfo) => void) | undefined;
  return {
    forward(info: StreamIdleWarningInfo): void {
      if (listener === undefined) return;
      try {
        listener(info);
      } catch {
        /* fail-open：计数/notice 失败=少一条收据，不是死流（brief §4） */
      }
    },
    setListener(next?: (info: StreamIdleWarningInfo) => void): void {
      listener = next;
    },
  };
}
