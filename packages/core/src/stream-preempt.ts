// 124b 项 1（the upstream projectinstant_interrupt 裁决）——流抢占通道。
//
// 问题：steering 只能在模型调用边界落地（loop 在每次模型调用前 drain
// 队列）。DeepSeek/GLM 的长 reasoning 流可达数分钟，期间用户提交的新指
// 令只能排队干等。本通道给驱动一个「只中断当前在飞模型流、绝不结束运
// 行」的触发器：
//
//   - 循环在每次模型 attempt 前 next() 取一个全新（未触发）的 signal，
//     与运行级 options.signal 合成（AbortSignal.any）后作为该次调用的
//     input.signal 传给 provider——fetch/流读循环随 signal 原生中断。
//   - request() 由驱动的 busy-submit 路径调用（用户提交新消息时）。
//     attempt 之间调用是无害空操作：陈旧的已触发控制器会被下一次
//     next() 整体替换，绝不污染后续调用。
//   - fired() 是中止归类面：AbortError 冒出后，循环以「运行 signal 未
//     触发 && 本通道已触发」识别抢占——被弃 partial 不进转录、不进模型
//     （M24：模型所见前缀字节稳定），抢注走 stream_preempted 事件的
//     旁路审计；随后立即开始下一轮，steering drain 把用户的新指令作为
//     下一条 user 消息注入。
//
// 边界：工具调用与压缩摘要器不接此通道（只有模型调用收到合成 signal），
// 抢占永远不会打断一次工具执行或一次压缩。

/** The per-run preemption channel between the driver's submit path and the
 *  loop's model calls. Pure state holder — no I/O, no clock. */
export interface StreamPreemptChannel {
  /** Arm the NEXT model attempt: returns a fresh, never-aborted signal. The
   *  loop calls this exactly once per attempt (every leg — main + the
   *  overflow ladder's retries + the ω99-9 recovery resends). */
  next(): AbortSignal;
  /** True iff the CURRENT attempt's signal was fired — the loop's abort
   *  classification reads this right after an AbortError escapes a call. */
  fired(): boolean;
  /** The trigger: abort the in-flight attempt's stream. Returns true when an
   *  attempt was armed and got aborted; false = nothing in flight (the
   *  request is a harmless no-op — the steering text drains at the next turn
   *  boundary exactly as before this channel existed). */
  request(): boolean;
}

export function createStreamPreemptChannel(): StreamPreemptChannel {
  let current: AbortController | undefined;
  return {
    next(): AbortSignal {
      current = new AbortController();
      return current.signal;
    },
    fired(): boolean {
      return current?.signal.aborted === true;
    },
    request(): boolean {
      if (current === undefined) return false;
      const armed = !current.signal.aborted;
      current.abort();
      return armed;
    },
  };
}
