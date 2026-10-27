// packages/providers/src/dispatcher.ts — Persona Phase B 的统一构造缝
// (design 93 §4.2-2)。CLI 的每个生产构造点都走 `createProvider(config)`：
// `switch (config.wire)` 三路派发到协议适配器，wire 缺省 = 历史
// openai-compatible 引擎（字节等价——缺省路径的行为由既有 cli 测试守）。
// 未知 wire 值在构造期抛错（pi `apiFor` 先例：查不到即抛，绝不静默回落）。
//
// 派发只挑适配器：Phase A 的梯子/看门狗在各适配器工厂内部，persona 层1/2
// 在各适配器 fetch 入口传自己的协议，层3 `withPersona` 协议无关 —— 本函数
// 对三者零改动。wire 变更必断前缀缓存，冷启动归因沿用
// PROVIDER_SWITCH_COLD_ATTRIBUTION（§4.2-4，调用方职责）。
import type { ModelClient } from "@wudao/core";
import type { ProtocolId } from "./persona/types.js";
import { PROTOCOL_IDS } from "./persona/schema.js";
import type { ProviderConfig } from "./config.js";
import type { ProviderOptions } from "./openai-compatible.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createResponsesProvider } from "./responses.js";

export function createProvider(config: ProviderConfig, options: ProviderOptions = {}): ModelClient {
  // Widen to string so the default arm stays reachable: a hand-built config
  // (JS caller, or one parsed off disk) can carry any runtime value — the
  // ProtocolId type is the compile-time promise, not the runtime guarantee.
  const wire: string = config.wire ?? "openai-chat";
  switch (wire as ProtocolId) {
    case "openai-chat":
      return createOpenAICompatibleProvider(config, options);
    case "anthropic":
      return createAnthropicProvider(config, options);
    case "responses":
      return createResponsesProvider(config, options);
    default:
      throw new Error(`unknown wire "${wire}" (expected one of: ${PROTOCOL_IDS.join(", ")})`);
  }
}
