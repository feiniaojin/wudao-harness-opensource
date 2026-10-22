# @wudao/providers

ModelClient 适配器（openai-compatible / anthropic / responses）+ 共享重试梯子 + provider 配置/注册表/persona 层。公共 API 的权威清单是 `src/index.ts`；本文件只注记增量批次的新导出。

## Exports (2026-08 R1a/R1b)

R1a = 加固批（计划：`docs/superpowers/plans/2026-08-24-providers-hardening-r1a.md`），R1b = SSE 行缓冲上限批。下表只列这两批在包根 `src/index.ts` 新增的导出。

| 符号 | 批次 (commit) | 用途 | 语义要点 |
| --- | --- | --- | --- |
| `withModelFallback(makeClient, config)` | R1a (`4272fee`) | 把单协议适配器的 per-model leg 工厂包成有序模型 fallback 链（三工厂共用的装饰器，`model-fallback.ts`） | 与 key 池正交：池在同一模型内换 key，链在 leg 的重试梯子放弃且错误 fallback-eligible（模型类 5xx/overload/404/transport；非 key 类 401/403、非 abort、非上下文溢出）后换模型。主模型连败 2 次起直接从第一个 fallback 开始，主模型成功才清零；`fallbackModels` 为空时是透传形状。只在失败路径生效，请求序列化零触碰（前缀缓存字节稳定） |
| `parseRetryAfterMs(headers)` / `RETRY_AFTER_FAIL_CAP_MS` | R1a (`87f8b6c`) | 429 Retry-After / retry-after-ms 响应头解析成毫秒等待值（三适配器共用，`retry-after.ts`） | fail-closed：畸形/负值/非有限/过去的 HTTP-date → `undefined`；标准头优先于 ms 方言；date 差向上取整、小数秒 ×1000 取整。梯子消费时 `retryAfterMs ?? exponential` 是**替换非叠加**（精确值、无 jitter、仍占一个梯子档位）；`> 60_000` 的期限 = 硬停不重试（恰好 60s 允许） |
| `StreamOverflowError` | R1b (`ce94e94`) | SSE 行缓冲超过 `MAX_ACCUM_CHARS` 仍无事件边界时 fail-loud 抛出（活跃流永不换行的无界增长，idle 看门狗管不住的洞） | 与 `StreamIdleError` 同族 retryable（无状态前缀的 Error 走 `isRetryableProviderError` 终判进梯子）；抛出前先 `reader.cancel()`；fail LOUD never truncate（截断的 SSE 行会伪造垃圾事件）；`err.maxChars` 携带上限 |
| `MaxTokensThinkingBudgetConflictError` | wire-r2 ①（本提交） | anthropic wire 上**显式** maxTokens（`input.maxTokens` 或 `config.maxTokens`）≤ `reasoningEffort` 推出的 thinking budget 时 fail-closed 抛出（`model-failure.ts`） | 消息三值齐备：显式 cap、budget、修法（raise maxTokens above the thinking budget or lower reasoningEffort）。在梯子**之前**抛（`validatedInputEffort` 同位；确定性配置冲突永不 sleep、永不触网），且 `isModelFallbackEligible` 判 false（换模型撞同一冲突）；适配器自身**隐式缺省** cap（4096）保留历史 budget+1024 抬升（回归 pin） |

关联类型随同批从包根导出：`ModelClientFactory`、`StreamingModelClient`（`model-fallback.ts`），`RetryAfterHeadersLike`（`retry-after.ts`）。

注记：R1a Task 2 的 `MAX_ACCUM_CHARS` / `capAccumulated` / `isCappedReasoning` 只从 `openai-compatible.ts` **模块级**导出——它们是 anthropic/responses 适配器复用的内部缝，不在包根公共面；外部消费请勿期待从包根导入它们。
