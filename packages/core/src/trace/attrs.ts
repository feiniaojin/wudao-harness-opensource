// 135 — trace 属性名的单一事实源（OTLP 导出面）。
//
// 三条纪律（本模块钉死，任何 span 构造点都只能从这里取键）：
//   1. 双写：每条 span 同时写 `gen_ai.*`（跨后端最小公约数）与 `langfuse.*` /
//      `langsmith.*`（两个主流后端的专有覆盖）与本仓自己的 `wudao.*`。
//      理由：GenAI semconv 仍在演进（已迁至独立仓），任何单一命名空间都不是
//      稳定契约；Langfuse 官方文档亦明确 `langfuse.*` 优先级高于 `gen_ai.*`。
//   2. 命名空间归属：`wudao.*` 只放**本 harness 独有**的语义（缓存取证、压缩梯、
//      门禁、循环守护）。通用字段一律走 `gen_ai.*`，不重复发明。
//   3. 版本锚：`wudao.trace.schema_version` 必写，供后端做跨版本判定。

/** 本投影层生产的事件/属性 schema 版本。属性语义变更才动它。 */
export const WD_TRACE_SCHEMA_VERSION = "1";

export const ATTR = {
  // —— resource / 身份 ——
  SERVICE_NAME: "service.name",
  SERVICE_VERSION: "service.version",
  SDK_NAME: "telemetry.sdk.name",
  SDK_VERSION: "telemetry.sdk.version",

  // —— trace 级（Langfuse 要求传播到每个 span 才能筛选聚合）——
  SESSION_ID: "langfuse.session.id",
  SESSION_ID_ALT: "session.id",
  LANGSMITH_SESSION_ID: "langsmith.trace.session_id",
  TRACE_NAME: "langfuse.trace.name",
  OBSERVATION_TYPE: "langfuse.observation.type",
  LANGSMITH_SPAN_KIND: "langsmith.span.kind",
  WD_SESSION_ID: "wudao.session.id",
  WD_RUN_ID: "wudao.run.id",
  WD_SCHEMA_VERSION: "wudao.trace.schema_version",
  WD_RELEASE: "wudao.release",

  // —— 通用模型面 ——
  GEN_AI_OPERATION: "gen_ai.operation.name",
  GEN_AI_SYSTEM: "gen_ai.system",
  MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOTAL_TOKENS: "gen_ai.usage.total_tokens",
  REASONING_TOKENS: "gen_ai.usage.details.reasoning_tokens",
  INPUT: "langfuse.observation.input",
  OUTPUT: "langfuse.observation.output",

  // —— 工具面 ——
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  GEN_AI_TOOL_ARGUMENTS: "gen_ai.tool.call.arguments",
  GEN_AI_TOOL_RESULT: "gen_ai.tool.call.result",

  // —— 缓存取证（wudao 独有；M24 的核心观测面）——
  CACHE_HIT_TOKENS: "wudao.cache.hit_tokens",
  CACHE_MISS_TOKENS: "wudao.cache.miss_tokens",
  CACHE_WRITE_TOKENS: "wudao.cache.write_tokens",
  CACHE_HIT_RATIO: "wudao.cache.hit_ratio",
  CACHE_COLD_EXPECTED: "wudao.cache.cold_expected",
  CACHE_BREAK_ATTRIBUTION: "wudao.cache.break_attribution",
  REASONING_REPLAY_TOKENS: "wudao.cache.reasoning_replay_tokens",
  DURATION_MS: "wudao.duration_ms",
  RETRY_COUNT: "wudao.retry_count",

  // —— 压缩梯 ——
  COMPACT_TIER: "wudao.compact.tier",
  COMPACT_TRIGGER: "wudao.compact.trigger",
  COMPACT_REASON: "wudao.compact.reason",
  COMPACT_BEFORE_TOKENS: "wudao.compact.before_tokens",
  COMPACT_AFTER_TOKENS: "wudao.compact.after_tokens",
  COMPACT_WINDOW_INDEX: "wudao.compact.window_index",
  COMPACT_CARRIED_DEBT_TOKENS: "wudao.compact.carried_debt_tokens",
  COMPACT_BREAKEVEN_REQUESTS: "wudao.compact.breakeven_requests",

  // —— 循环守护 / 恢复梯 ——
  GUARD_KIND: "wudao.guard.kind",
  GUARD_EVIDENCE: "wudao.guard.evidence",
  GUARD_ATTEMPT: "wudao.guard.attempt",
  RECOVERY_KIND: "wudao.recovery.kind",
  RECOVERY_MAX_TOKENS: "wudao.recovery.max_tokens",
  RETRY_CLASS: "wudao.retry.class",
  RETRY_LEG: "wudao.retry.leg",

  // —— 运行终态 ——
  TURN: "wudao.turn",
  TURN_INDEX: "wudao.turn.index",
  TERMINAL_REASON: "wudao.terminal.reason",
  TOOL_CALL_COUNT: "wudao.turn.tool_calls",
  HAS_TOOL_CALLS: "wudao.model.has_tool_calls",
  REASONING_CHARS: "wudao.model.reasoning_chars",
  ANSWER_CHARS: "wudao.model.answer_chars",

  // —— 内容寻址（三档内容策略的承载字段）——
  CONTENT_MODE: "wudao.content.mode",
  CONTENT_SHA256: "wudao.content.sha256",
  CONTENT_BYTES: "wudao.content.bytes",
  CONTENT_PREVIEW: "wudao.content.preview",
} as const;

/** 内容策略三档（见 docs/research/135 §5.4）。
 *  off  = 只留结构 + 计数（最省、最保守）
 *  hash = 指纹 + 512 字符预览（默认）
 *  full = 全文（仍过脱敏）
 */
export type ContentMode = "off" | "hash" | "full";

export const DEFAULT_CONTENT_MODE: ContentMode = "hash";

/** 预览长度上限（字节计；UTF-8 边界安全截断在 truncateSafe 语义内）。 */
export const CONTENT_PREVIEW_MAX_CHARS = 512;

const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|passwd|credential|authorization)/i;

/** 脱敏：家目录 → `~`；敏感 key 的值 → `[REDACTED]`；私钥块整段 → `[REDACTED_PRIVATE_KEY]`。
 *  纯函数、幂等；永不抛。 */
export function redactText(text: string, homeDir?: string): string {
  let out = text;
  if (homeDir !== undefined && homeDir.length > 0) {
    out = out.split(homeDir).join("~");
  }
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|passwd|credential|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  );
  return out;
}

/** 键名是否为敏感类（对象走 JSON 序列化前的最后一道判断）。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
