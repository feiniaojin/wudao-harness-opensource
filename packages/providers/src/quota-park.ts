// 113-B3（the upstream project #2375 形 + 超越点）— 账户级配额 429 的识别与类型化
// 停摆错误。
//
// 马拉松三次实证的问题形态：glm-5.3 账户级配额 429，错误体自带重置时刻——
//   429 [1308][已达到 5 小时的使用上限。您的限额将在 2026-09-24 05:30:32 重置。]
// 在位者（r1a Task 4）的裁决：Retry-After/等待 >60s 帽=硬停直接抛错。小时级
// 配额窗下这个"硬停"就是"整 run 报废"——基准马拉松里烧穿了两批任务。本模块
// 只把这一类错从"匿名硬停"升级为带 resetAt 的类型化 QuotaParkError：识别在
// HTTP 边界（与 ContextLengthError/MandatoryReasoning 同位、在通用
// ProviderHttpError 之前），梯子不重试它（isRetryableProviderError 的 name
// 判）、fallback 链不换腿（账户级配额是 provider 域，换模型烧的还是同一账
// 户），上层的 CLI 驱动据 resetAt 停摆 run 并排一次性唤醒。
//
// 语义红线：不改 60s 帽语义。≤60s 的配额等待（Retry-After 短、或重置时刻
// 30s 后就到）不分类——仍走既有梯子路径（Retry-After 精确等待，429 可重
// 试）；无重置信息的普通 429 不误判——仍是 ProviderHttpError。只有"429 +
// 配额词表 + 可解析的重置时刻 + 距今 >60s"四条全中才升级。纯函数模块（只
// 依赖 retry-after 的帽常量，无环），永不触碰请求序列化（前缀缓存字节稳定）。

import { RETRY_AFTER_FAIL_CAP_MS } from "./retry-after.js";

/** The account/window-level usage-cap body vocabulary. Deliberately does NOT
 *  include bare "limit" — the context-length family ("maximum context
 *  length", "context_limit") shares the word, and those classify one branch
 *  earlier at the HTTP boundary (isContextLengthFailure) with disjoint
 *  statuses (413/400/500 vs this module's 429); pinning the vocabulary tight
 *  keeps the two families disjoint even if the ordering ever moves. */
export const QUOTA_BODY_SIGNATURES: readonly RegExp[] = [
  /使用上限/, // glm/bigmodel 1308：已达到 5 小时的使用上限
  /用量上限/,
  /已达到.{0,12}上限/,
  /限额将在/, // …您的限额将在 <时刻> 重置
  /配额/,
  /\bquota\b/i,
  /usage\s+limit/i,
  /rate\s*limit/i,
];

/** True when a 429 body carries a known account-quota signature. */
export function sniffQuotaBody(body: string): boolean {
  return QUOTA_BODY_SIGNATURES.some((re) => re.test(body));
}

/** The Chinese absolute reset wording: `将在 2026-09-24 05:30:32 重置`（本
 *  地墙钟——服务中文错误体的网关按用户所在时区报时；`new Date("…T…")` 无
 *  时区标记即按本地解析，正是这个语义）。秒可省。 */
const CN_RESET_RE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*重置/;

/** The English absolute wording: `resets at 2026-09-24T05:30:32Z` / `will
 *  reset on 2026-09-24 05:30:32`（带时区标记则尊重，缺省同中文款按本地）。 */
const EN_RESET_RE = /reset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?/i;

/** Body-relative reset seconds: `Reset-After: 3600` / `"reset_after": 3600`
 *  （JSON 或散文形，纯秒数——分/时单位的散文不猜，trusted-parse-only）。 */
const RESET_AFTER_BODY_RE = /reset[-_ ]?after["']?\s*[:=]\s*"?(\d{1,8})"?/i;

function parseWallClock(date: string, time: string, zone: string | undefined): Date | undefined {
  const at = Date.parse(zone !== undefined ? `${date}T${time}${zone === "UTC" ? "Z" : zone}` : `${date}T${time}`);
  return Number.isFinite(at) ? new Date(at) : undefined;
}

/** Parse the provider's reset moment out of a 429 body (and, as the last
 *  resort, the already-parsed Retry-After header wait). Sources, first match
 *  wins: the Chinese absolute wording, the English absolute wording, a body
 *  `reset-after` seconds figure, the Retry-After header. Fail-closed:
 *  unparseable/past instants and non-positive header waits yield undefined
 *  (a past instant is the server's "already reset" — not park material; the
 *  ordinary ladder path owns it). */
export function parseQuotaResetAt(body: string, retryAfterMs?: number, now: number = Date.now()): Date | undefined {
  const cn = CN_RESET_RE.exec(body);
  if (cn !== null) {
    const at = parseWallClock(cn[1] as string, cn[2] as string, undefined);
    if (at !== undefined && at.getTime() > now) return at;
  }
  const en = EN_RESET_RE.exec(body);
  if (en !== null) {
    const at = parseWallClock(en[1] as string, en[2] as string, en[3]);
    if (at !== undefined && at.getTime() > now) return at;
  }
  const rel = RESET_AFTER_BODY_RE.exec(body);
  if (rel !== null) {
    const seconds = Number(rel[1]);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(now + seconds * 1000);
  }
  if (retryAfterMs !== undefined && retryAfterMs > 0) return new Date(now + retryAfterMs);
  return undefined;
}

/** True iff the (status, body, deadline) triple is an account-level quota
 *  window past the 60s fail cap — the park candidate. All four gates must
 *  hold: HTTP 429, the quota vocabulary, a parseable reset moment, and a wait
 *  strictly beyond RETRY_AFTER_FAIL_CAP_MS (exactly-at-cap stays with the
 *  ladder — the existing `>` comparison). Everything else keeps today's
 *  semantics byte-for-byte. */
export function isQuotaParkFailure(
  status: number,
  body: string,
  retryAfterMs?: number,
  now: number = Date.now(),
): boolean {
  if (status !== 429) return false;
  if (!sniffQuotaBody(body)) return false;
  const resetAt = parseQuotaResetAt(body, retryAfterMs, now);
  return resetAt !== undefined && resetAt.getTime() - now > RETRY_AFTER_FAIL_CAP_MS;
}

/** The typed account-quota failure (113-B3). Carries the parsed reset moment
 *  and the failing leg's provider identity — the CLI driver parks the run
 *  until resetAt (+margin) and schedules a one-shot wake. Message keeps a
 *  NON-transport prefix (`provider quota reached:` — deliberately not
 *  `provider (request|stream) failed: <status>`, so no message-regex consumer
 *  can misread it as a retryable status), and the name check in
 *  isRetryableProviderError makes the ladder's skip explicit regardless. */
export class QuotaParkError extends Error {
  readonly status: number;
  readonly body: string;
  /** The parsed reset instant (see parseQuotaResetAt). */
  readonly resetAt: Date;
  /** v7 γ4 family: the failing leg's provider identity (registry id, or the
   *  baseURL host when the config carries no registry identity). */
  readonly provider: string;
  /** The failing leg's model id (the fallback chain swaps it — identity names
   *  the LEG). Omitted when unknown (omit-never-null). */
  declare readonly model?: string;

  constructor(
    which: "request" | "stream",
    status: number,
    body: string,
    resetAt: Date,
    provider: string,
    model?: string,
  ) {
    const tail = model !== undefined && model !== "" ? `/${model}` : "";
    super(
      `provider quota reached: ${status} ${body} — account usage cap, window resets at ${resetAt.toISOString()} (provider ${provider}${tail}); run parked until reset`,
    );
    this.name = "QuotaParkError";
    this.status = status;
    this.body = body;
    this.resetAt = resetAt;
    this.provider = provider;
    if (model !== undefined && model !== "") this.model = model;
  }
}

/** Classify at the HTTP boundary: build the typed QuotaParkError when the
 *  (status, body, deadline) triple is a park candidate, undefined otherwise
 *  (the caller falls through to the generic ProviderHttpError — today's
 *  semantics). */
export function tryQuotaParkError(
  which: "request" | "stream",
  status: number,
  body: string,
  retryAfterMs: number | undefined,
  identity: { readonly provider?: string; readonly model?: string },
  now: number = Date.now(),
): QuotaParkError | undefined {
  if (!isQuotaParkFailure(status, body, retryAfterMs, now)) return undefined;
  const resetAt = parseQuotaResetAt(body, retryAfterMs, now) as Date;
  return new QuotaParkError(
    which,
    status,
    body,
    resetAt,
    identity.provider !== undefined && identity.provider !== "" ? identity.provider : "unknown",
    identity.model,
  );
}
