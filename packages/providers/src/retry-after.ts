// packages/providers/src/retry-after.ts — r1a Task 4: 429 Retry-After 解析。
//
// 纯函数模块（零 openai-compatible 依赖，无环）：只读响应头，永不触碰请求
// 序列化（前缀缓存字节稳定红线）。上限裁决在梯子（RETRY_AFTER_FAIL_CAP_MS），
// 解析器对超过上限的值原样返回 —— ">60s 不重试"是梯子的决定。
//
// 支持的响应头（头名大小写不敏感 —— 既是 Headers.get 的既有语义，也是本
// 解析器自己的探测矩阵，duck-typed 的大小写敏感 get 实现同样受益）：
//   retry-after      IETF 标准（RFC 9110 §10.2.3）：整数秒，或 HTTP-date
//   retry-after-ms   网关方言：毫秒
// 标准头优先（两头同在时以 retry-after 为准）。
//
// 解析规则全部 fail-closed（→ undefined）：空串/畸形/非十进制数字 → undefined；
// 负值/NaN/非有限 → undefined；HTTP-date 在过去（差为负）→ undefined；
// HTTP-date → Date.parse 与 now 的差（向上取整 —— 绝不早于服务器期限）；
// 小数秒 × 1000 取整（r1b：Math.round —— 消浮点尘，如 0.5678×1000 的
// 567.8000…01；与 date 形态"取整、绝不早于期限"的精神对齐）。
// 0 是合法值（服务器明示"可立即重试"）。

/** The smallest structural need: a header lookup. Real `Headers` satisfies it
 *  (and is case-insensitive itself); test mocks may pass a plain object. */
export interface RetryAfterHeadersLike {
  get(name: string): string | null | undefined;
}

/** The ladder's fail cap: a server deadline beyond 60s is honored as a hard
 *  stop (no retry, the original error surfaces). Exactly 60_000 IS allowed —
 *  the comparison is `>`, not `>=`. */
export const RETRY_AFTER_FAIL_CAP_MS = 60_000;

/** Decimal seconds/ms only (`^\d+(\.\d+)?$` after trim): hex, exponents,
 *  signs, unit suffixes, and empty/whitespace values are all malformed. */
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/** 头名大小写变体：小写 / 首字母大写（HTTP 惯用拼写）/ 全大写（网关方言）。 */
function lookup(headers: RetryAfterHeadersLike, name: string): string | undefined {
  const variants = [name.toLowerCase(), name.toUpperCase(), name.replace(/(^|-)[a-z]/g, (c) => c.toUpperCase())];
  for (const v of variants) {
    const raw = headers.get(v);
    if (raw !== null && raw !== undefined && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

/** Parse a response's retry-after / retry-after-ms headers into a wait in ms.
 *  Fail-closed: anything unparseable, negative, or non-finite → undefined. */
export function parseRetryAfterMs(headers: RetryAfterHeadersLike | undefined): number | undefined {
  if (headers === undefined) return undefined;
  // The standard header first (seconds or HTTP-date); the ms dialect is the
  // fallback for gateways that send only it.
  const seconds = lookup(headers, "retry-after");
  if (seconds !== undefined) {
    // r1b: round the ×1000 product — the raw float64 multiply can leak sub-ms
    // dust (0.5678 → 567.8000…01) into the ladder's sleep. Whole ms, never
    // early beyond rounding (aligned with the date form's ceil spirit).
    if (DECIMAL_RE.test(seconds)) return Math.round(Number(seconds) * 1000);
    // HTTP-date form: wait until the given instant.
    const at = Date.parse(seconds);
    if (Number.isFinite(at)) {
      const diff = at - Date.now();
      if (Number.isFinite(diff) && diff >= 0) return Math.ceil(diff);
    }
    return undefined;
  }
  const ms = lookup(headers, "retry-after-ms");
  if (ms === undefined || !DECIMAL_RE.test(ms)) return undefined;
  return Number(ms);
}
