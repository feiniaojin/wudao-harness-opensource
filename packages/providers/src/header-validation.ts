// packages/providers/src/header-validation.ts — ω99-50：用户自定义 header 的
// fetch 可表示性校验 + 凭证保留名可见性。
//
// 来源：dsh 候选 9（assertValidHeaders，commit 25e4527f5e）经队列 105 §3 池
// 第 6 项。wudao 裁定（brief §1，控制器预裁决）：
//   - 只校验用户输入面 —— persona wire.headers（5 触点的唯一来源）与 registry
//     行的 headers 列（持久化保留面，尚未上 wire）；适配器自带头不校验。
//   - 探针依据（node 24 实测）：`new Headers([[name, value]])` 与 fetch(undici)
//     请求时刻消费同一校验 —— LF/CR/NUL 值、>255 字节值（CJK）、空格/换行/
//     制表/空/非 ASCII 名全部抛 TypeError；空值与 latin-1 内字符合法。
//     加载期用它预测请求时刻的失败，错误早一步且指名（provider + header 名
//     + 原始 TypeError 文案）——dsh 形。
//   - 保留名（authorization/x-api-key）不采纳 dsh 的"harness 归属、拒绝用户"
//     ——wudao 里这两个键在 persona schema 加载期已拒、resolve 期防御性跳过
//     （FORBIDDEN_HEADER_KEYS —— ω99-69 起定义在本文件单一来源，schema.ts
//     re-export），根本到不了 wire；本弧只对"程序化构造绕过 schema"的兜底
//     路径加一次性 stderr 可见性（静默丢弃 → 告知丢弃），行为零变化。
//     anthropic-version 不在警告集：内置 claude-code persona 按设计钉它
//     （builtins.ts 身份仿真），警告即常态噪音。
//
// 红线：合法 header 请求字节零变化；`...(wire?.headers)` 仍在 auth 后 spread。
/** The credential headers the adapter's key pool owns. A persona header with
 *  one of these names is SKIPPED (never sent) by resolvePersonaHeaders — the
 *  once-per-process notice below is visibility for that silent drop, not a
 *  behavior change. Deliberately excludes anthropic-version (pinned by design
 *  on the claude-code builtin persona). */
export const RESERVED_CREDENTIAL_HEADER_KEYS: ReadonlySet<string> = new Set(["authorization", "x-api-key"]);

/** ω99-69（64 停泊 C1 收口）：persona 永不控制、hand-built 配置也永不覆盖的
 *  头全集——鉴权键（键池所有）+ hop-by-hop / 传输语义键（适配器所有）。
 *  定义唯一下沉到这里（header-validation.ts 单一来源，无 import 出边——依赖
 *  图无环）；persona/schema.ts re-export 保既有 import 面（registry/apply 的
 *  ABI 零 diff）。四个消费面同一堵墙：schema 加载期拒绝（checkHeaderMap）、
 *  registry 保存/加载期拒行（validateUserProviderEntry /
 *  readProviderRegistrySync）、resolvePersonaHeaders 防御性跳过（persona
 *  面）、gatewayExtraHeaders seam 跳过（hand-built 面）——64 裁定反转理由：
 *  registry 面（唯一用户面）已全集拦，hand-built 面与它的防御不对称没有
 *  架构理由，两入口同一堵墙。 */
export const FORBIDDEN_HEADER_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "content-type",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
]);

/** Probe: can this [name, value] pair ride a fetch wire? Returns the
 *  underlying TypeError message when the global Headers constructor refuses
 *  the pair (the same validation undici applies at request time), null when
 *  representable. Single probe source: the schema (load-time errors), the
 *  registry (save-time red), and the adapter seam (typed throw) all consume
 *  this one function. */
export function headerRepresentabilityError(name: string, value: string): string | null {
  const init: Array<[string, string]> = [[name, value]];
  try {
    new Headers(init);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The typed load-time rejection (dsh assertValidHeaders form). Deterministic
 *  — junk can never succeed on retry or on a sibling model — so BOTH error
 *  ladders fail fast on its name (isRetryableProviderError /
 *  isModelFallbackEligible), the validatedInputEffort/M58 §C discipline. */
export class HeaderValidationError extends Error {
  constructor(label: string, headerName: string, originalMessage: string) {
    super(`${label}: header "${headerName}" cannot be sent — ${originalMessage}`);
    this.name = "HeaderValidationError";
  }
}

/** Throw a named HeaderValidationError when any [name, value] in `headers`
 *  cannot ride a fetch wire. `label` names the source (provider/persona/card)
 *  so the error points at the fix instead of dying as an anonymous undici
 *  TypeError mid-request. */
export function assertValidHeaders(headers: Readonly<Record<string, string>>, label: string): void {
  for (const [name, value] of Object.entries(headers)) {
    const rep = headerRepresentabilityError(name, value);
    if (rep !== null) throw new HeaderValidationError(label, name, rep);
  }
}

/** ω99-64 → ω99-69: the registry/provider-card extra headers as they ride the
 *  adapter seam — FORBIDDEN keys (auth + transport-control, the full 14-key
 *  set) are skipped, never sent: the key pool owns auth and the adapter owns
 *  transport on the wire, structurally (both land BEFORE the user spreads at
 *  all five header-construction points, so an unfiltered key would silently
 *  REPLACE the adapter's own — a hand-built content-type used to clobber the
 *  JSON body's content-type). ω99-69 reverses 64's parking of the transport
 *  half ("loud self-injury"): the registry face (the only user-facing
 *  entrance) already refuses the full FORBIDDEN set at save AND load, so the
 *  hand-built face skipping only auth was a defense asymmetry with no
 *  architectural reason — one wall, both entrances (same posture as
 *  resolvePersonaHeaders, which already skips the full set; its skip is
 *  likewise silent for transport keys — no notice added here either).
 *  undefined → {} so an unconfigured config keeps its historical header
 *  bytes; an empty {} row spreads to nothing (§3.6 no-op). */
export function gatewayExtraHeaders(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (extra === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ω99-39 form: providers has no warn/notice channel, so the pre-authorized
// fallback applies — ONE stderr line per process, module-level guard. Tests
// re-arm with vi.resetModules + dynamic import (a fresh module instance).
let reservedHeaderNoticeShown = false;

/** One-line stderr tell that a persona header named a reserved credential
 *  key and was therefore IGNORED (the adapter's key-pool credentials own
 *  auth on the wire). Visibility only — the skip itself is unchanged. */
export function noticeReservedCredentialHeader(headerName: string, label: string): void {
  if (reservedHeaderNoticeShown) return;
  reservedHeaderNoticeShown = true;
  process.stderr.write(
    `wudao: ${label}: persona header "${headerName}" is ignored — auth headers are reserved for the key pool\n`,
  );
}
