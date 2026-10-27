// packages/providers/src/persona/apply.ts
import type { PersonaRuntime, PersonaRuntimeSlots } from "./runtime.js";
import type { ProtocolId, ResolvedPersona } from "./types.js";
import { BODY_WHITELIST, FORBIDDEN_HEADER_KEYS } from "./schema.js";
import { RESERVED_CREDENTIAL_HEADER_KEYS, assertValidHeaders, noticeReservedCredentialHeader } from "../header-validation.js";

export function resolveTemplate(value: string, slots: PersonaRuntimeSlots): string {
  return value.replace(/\{\{(sessionId|uuid|iso8601)\}\}/g, (_m, slot: string) => {
    if (slot === "sessionId") {
      if (slots.sessionId === undefined || slots.sessionId === "") {
        throw new Error("persona template references {{sessionId}} but PersonaRuntime.slots has no session id");
      }
      return slots.sessionId;
    }
    if (slot === "uuid") return (slots.uuid ?? (() => crypto.randomUUID()))();
    return (slots.now ?? (() => new Date()))().toISOString();
  });
}

/** 层1：该协议头套 → 槽解析后的普通头对象（鉴权/传输控制键防御性跳过；schema 加载期已拒——程序化构造的定义仍走这里的兜底）。 */
export function resolvePersonaHeaders(persona: ResolvedPersona, protocol: ProtocolId, slots: PersonaRuntimeSlots): Record<string, string> {
  const out: Record<string, string> = {};
  if (!persona.layers.headers) return out;
  const map = persona.definition.headers[protocol];
  if (map === undefined) return out;
  for (const [k, v] of Object.entries(map)) {
    if (FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())) continue;
    out[k] = resolveTemplate(v, slots);
  }
  return out;
}

/** 层2：标量替换、对象一级深合并。确定性：键序 = base 原序，overlay 新键按 overlay 序追加。 */
export function mergeBodyOverlay<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown> | undefined): T {
  if (overlay === undefined) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const prev = out[k];
    out[k] =
      typeof prev === "object" && prev !== null && !Array.isArray(prev) &&
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? { ...(prev as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  return out as T;
}

export interface WirePersona {
  readonly headers: Record<string, string>;
  readonly bodyOverlay: Record<string, unknown> | undefined;
}

/** Final-review I4：程序化构造的 PersonaDefinition 是公开 API 面，绕过
 * schema 加载期校验——在 apply 时把 overlay 键重新过滤到该协议白名单
 * （与 schema 校验消费同一个 BODY_WHITELIST 常量，单一来源）。全部键被
 * 过滤掉 → 折叠为 undefined（该层对该协议无事可做）。 */
function whitelistedOverlay(protocol: ProtocolId, overlay: Record<string, unknown>): Record<string, unknown> | undefined {
  const allow = BODY_WHITELIST[protocol];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overlay)) {
    if (allow.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ω99-50：凭证保留名可见性（程序化构造兜底面）。schema 加载期已拒
 *  authorization/x-api-key（FORBIDDEN_HEADER_KEYS），resolvePersonaHeaders
 *  会防御性跳过它们——本函数只对这条"静默丢弃"补一次性告知，跳过行为
 *  零变化。首命中即止（guard 本身一进程一行）。 */
function noticeReservedCredentialHeadersIn(p: ResolvedPersona, protocol: ProtocolId, label: string): void {
  if (!p.layers.headers) return;
  const map = p.definition.headers?.[protocol];
  if (map === undefined) return;
  for (const k of Object.keys(map)) {
    if (RESERVED_CREDENTIAL_HEADER_KEYS.has(k.toLowerCase())) {
      noticeReservedCredentialHeader(k, label);
      return;
    }
  }
}

/** 适配器 fetch 入口的统一缝：读 runtime.current，产出该协议层1/2。无 persona / 两层全关 / 该协议未定义 → null。
 *  ω99-50：可选 `label`（provider 名，适配器传 config.provider）只用于错误/警告
 *  指名；缺省回退 persona id。persona 是逐请求可换的（适配器刻意不在工厂期
 *  缓存 runtime.current），所以加载期校验挂在本缝——fetch 字节发出前、5 触点
 *  的唯一上游。合法 header 走 assert 直通（零字节变化）；坏名字/坏值在此抛
 *  HeaderValidationError（typed，两梯快速失败），不等到 undici 的匿名 TypeError。 */
export function applyWirePersona(runtime: PersonaRuntime | undefined, protocol: ProtocolId, label?: string): WirePersona | null {
  if (runtime === undefined) return null;
  const p = runtime.current;
  if (p === null || p === undefined) return null;
  const who = label !== undefined && label !== "" ? `provider "${label}"` : `persona "${p.definition.id}"`;
  const headers = resolvePersonaHeaders(p, protocol, runtime.slots);
  assertValidHeaders(headers, who);
  noticeReservedCredentialHeadersIn(p, protocol, who);
  const overlayRaw = p.layers.body ? p.definition.body?.[protocol] : undefined;
  const overlay = overlayRaw !== undefined ? whitelistedOverlay(protocol, overlayRaw) : undefined;
  if (Object.keys(headers).length === 0 && overlay === undefined) return null;
  return { headers, bodyOverlay: overlay };
}
