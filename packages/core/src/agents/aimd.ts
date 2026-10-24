// 121 项 1（CodeWhale 498490680 + prime-agent 5362cf300 形）— AIMD 速率自适
// 应并发门：把 429/overload 从「人肉调参信号」变成「容量控制信号」。静态
// 并发帽（registry 的 maxConcurrent）不能感知 provider 状态——429 风暴时该
// 收敛、空闲时该扩张；quota-park 是停泊版（二进制：停/不停），本模块补的是
// 连续调节。乘性减（overload → 容量减半，min=1 兜底）+ 加性增（成功 → +1，
// max 封顶）——经典 AIMD，落点是子代理扇出的 launch gate（registry 的 pump）。
//
// 纪律：
// - 状态只活在本进程内存，绝不持久化——provider 容量是瞬态事实，重启后
//   重新探测比沿用陈旧容量更诚实（缺省 initial=max 亦即「重启=静态帽」）。
// - 纯状态机：无 IO、无回调、无时钟。观察者接线（谁调 onSuccess/onThrottle）
//   属于部署层；core 只拥有机制。
// - 零行为变化缺省：调用方以 max=旧静态帽、initial=max 构造，行为与静态帽
//   字节等价，直到第一个 overload 信号到来。

/** The concurrency-gate port the registry (and any launch gate) consults.
 *  Structural so embedders can route it at a remote/proxied gate without
 *  depending on the class. */
export interface ConcurrencyGate {
  /** Currently admitted concurrency (always within [min, max]). */
  current(): number;
  /** A capacity-healthy observation: additive +1, capped at max. */
  onSuccess(): void;
  /** An overload-class observation (429/503/529/overload body): multiplicative
   *  halving, floored at min. */
  onThrottle(): void;
}

export interface AimdGateOptions {
  /** Ceiling (also the default initial value). Required; must be ≥ min. */
  readonly max: number;
  /** Floor; default 1 (a gate that admits nothing cannot observe anything —
   *  recovery needs at least one in-flight probe). */
  readonly min?: number;
  /** Starting admission; default = max (the zero-behavior-change default:
   *  a fresh gate behaves exactly like the static cap it replaces). */
  readonly initial?: number;
}

/** AIMD (additive-increase / multiplicative-decrease) concurrency gate.
 *  In-memory only — see the module head for why persistence is deliberately
 *  absent. Thread-safety note: Node is single-threaded and every method is
 *  synchronous, so the check-then-act in a launcher's admission loop is
 *  atomic by construction. */
export class AimdGate implements ConcurrencyGate {
  private admission: number;
  readonly min: number;
  readonly max: number;

  constructor(opts: AimdGateOptions) {
    const min = opts.min ?? 1;
    if (!Number.isInteger(min) || min < 1) {
      throw new Error(`AimdGate min must be an integer ≥ 1 (received ${String(opts.min)})`);
    }
    if (!Number.isInteger(opts.max) || opts.max < min) {
      throw new Error(`AimdGate max must be an integer ≥ min ${min} (received ${String(opts.max)})`);
    }
    this.min = min;
    this.max = opts.max;
    const initial = opts.initial ?? opts.max;
    if (!Number.isInteger(initial)) {
      throw new Error(`AimdGate initial must be an integer (received ${String(opts.initial)})`);
    }
    // Clamp, not reject: an out-of-range initial is a policy slip, not a
    // reason to refuse construction (the gate's contract is [min, max]).
    this.admission = Math.max(min, Math.min(opts.max, initial));
  }

  current(): number {
    return this.admission;
  }

  onSuccess(): void {
    this.admission = Math.min(this.max, this.admission + 1);
  }

  onThrottle(): void {
    this.admission = Math.max(this.min, Math.floor(this.admission / 2));
  }
}
