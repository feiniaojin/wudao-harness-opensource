// 借鉴弧 δ（the upstream harness 367ab084 思想）— the busy tool row's 转入后台
// button 的 op 处理器（模块级：client + notify 就是全部依赖；App 以
// useCallback 包装）。ok 无需 toast（driver 的 🔄 回执通知是真相点反馈）；
// typed 拒绝即时呈现，绝不静默。
import type { WudaoClient } from "./protocol.js";

export function makeDetachHandler(client: WudaoClient, notify: (text: string) => void): (callId: string) => void {
  return (callId: string): void => {
    void client.detachToolCall(callId)
      .then((v) => {
        if (v.kind === "refused") {
          notify(v.reason === "not_detachable"
            ? `⏳ ${v.toolName ?? "该工具"} 不可转后台（不可中断族）——等待其结束，或停止整个运行`
            : "（这条调用刚好已结束——无需转后台）");
        }
      })
      .catch(() => { /* socket dropped — the frame will tell */ });
  };
}
