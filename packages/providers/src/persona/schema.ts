// packages/providers/src/persona/schema.ts
import type { BodyStyleOverlay, LayerFlags, PersonaDefinition, ProtocolId, PromptStyle } from "./types.js";
import { FORBIDDEN_HEADER_KEYS, headerRepresentabilityError } from "../header-validation.js";

export const PROTOCOL_IDS: readonly ProtocolId[] = ["openai-chat", "anthropic", "responses"];

/** v1 冻结键集（spec §4 层2）。扩键 = 改本表，走评审。 */
export const BODY_WHITELIST: Readonly<Record<ProtocolId, ReadonlySet<string>>> = {
  "openai-chat": new Set(["temperature", "top_p", "top_k", "max_tokens", "reasoning_effort", "reasoning", "stop", "metadata"]),
  anthropic: new Set(["temperature", "top_p", "top_k", "max_tokens", "thinking", "stop_sequences", "metadata"]),
  responses: new Set(["temperature", "top_p", "max_completion_tokens", "reasoning", "instructions", "store", "metadata"]),
};

/** Final-review I3：persona 永不控制的头——鉴权键 + hop-by-hop / 传输语义头
 * （persona 头在适配器自带头之后 spread，工作区 JSON 若能写这些键就会
 * 覆盖适配器自身的传输头）。ω99-69：定义下沉 header-validation.ts（单一
 * 来源，四个消费面同一堵墙：schema 加载期拒绝、resolvePersonaHeaders 防
 * 御性跳过、registry 保存/加载期拒行、gatewayExtraHeaders seam 跳过）；
 * 此处 re-export 保既有 import 面（registry/apply 的 ABI 零 diff），下方
 * checkHeaderMap 消费的是同一 Set（顶部 import 即本 re-export 的源）。 */
export { FORBIDDEN_HEADER_KEYS } from "../header-validation.js";
const SLOT_RE = /^\{\{(sessionId|uuid|iso8601)\}\}$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkHeaderMap(where: string, raw: unknown, errors: string[]): void {
  if (!isRecord(raw)) { errors.push(`${where}: header map must be an object`); return; }
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())) { errors.push(`${where}.${k}: "${k.toLowerCase()}" is a forbidden persona header (auth/transport-control — the adapter owns it)`); continue; }
    if (typeof v !== "string") { errors.push(`${where}.${k}: header value must be a string`); continue; }
    // ω99-50：fetch 可表示性（加载期红）。换行值/非法字段名/非字节字符在
    // schema 期即拒——否则失败发生在请求时刻（undici 匿名 TypeError，不指名
    // 哪个 persona 哪个 header）。与 applyWirePersona 的 assertValidHeaders
    // 消费同一探针（header-validation.ts 单一来源）；savePersonaDefinition
    // 走本校验器，保存期即红随之而来。
    const rep = headerRepresentabilityError(k, v);
    if (rep !== null) { errors.push(`${where}.${k}: cannot ride the wire — ${rep}`); continue; }
    for (const part of v.split(/(\{\{[^}]*\}\})/).filter((s) => s.startsWith("{{"))) {
      if (!SLOT_RE.test(part)) errors.push(`${where}.${k}: unknown template slot ${part} (allowed: sessionId|uuid|iso8601)`);
    }
  }
}

function checkBodyOverlay(where: string, protocol: ProtocolId, raw: unknown, errors: string[]): void {
  if (!isRecord(raw)) { errors.push(`${where}: body overlay must be an object`); return; }
  const allow = BODY_WHITELIST[protocol];
  for (const k of Object.keys(raw)) {
    if (!allow.has(k)) errors.push(`${where}.${k}: key not in the ${protocol} body whitelist`);
  }
}

function checkPrompt(raw: unknown, errors: string[]): asserts raw is PromptStyle | undefined {
  if (raw === undefined) return;
  if (!isRecord(raw)) { errors.push("prompt: must be an object"); return; }
  for (const k of Object.keys(raw)) if (k !== "system" && k !== "toolNameMap") errors.push(`prompt.${k}: unknown key`);
  const seen = new Set<string>();
  if (raw.system !== undefined) {
    if (!isRecord(raw.system) || (raw.system.mode !== "snapshot" && raw.system.mode !== "prefix") || typeof raw.system.text !== "string") {
      errors.push("prompt.system: {mode: snapshot|prefix, text: string} required");
    }
  }
  if (raw.toolNameMap !== undefined) {
    if (!isRecord(raw.toolNameMap)) { errors.push("prompt.toolNameMap: must be an object"); return; }
    for (const [from, to] of Object.entries(raw.toolNameMap)) {
      if (typeof to !== "string" || to === "" || to === from) errors.push(`prompt.toolNameMap.${from}: must map to a different non-empty name`);
      if (typeof to === "string") {
        if (seen.has(to)) errors.push(`prompt.toolNameMap.${from}: display name "${to}" is already used (reverse map would be ambiguous)`);
        seen.add(to);
      }
    }
  }
}

export function validatePersonaDefinition(raw: unknown): { ok: true; persona: PersonaDefinition } | { ok: false; error: string } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, error: "persona: must be an object" };
  const allowed = new Set(["id", "displayName", "source", "defaultLayers", "headers", "body", "prompt", "confidence"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) errors.push(`unknown key "${k}"`);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errors.push("id: kebab-case required");
  if (typeof raw.displayName !== "string" || raw.displayName === "") errors.push("displayName: non-empty string required");
  if (!isRecord(raw.source) || (raw.source.kind !== "workspace-source" && raw.source.kind !== "external-research")
    || typeof raw.source.provenance !== "string" || raw.source.provenance === ""
    || typeof raw.source.pinnedVersion !== "string" || raw.source.pinnedVersion === "") {
    errors.push("source: {kind, provenance, pinnedVersion} all required (provenance/pinnedVersion non-empty)");
  }
  if (raw.confidence !== undefined && raw.confidence !== "byte-verified" && raw.confidence !== "community-reverse-engineered") {
    errors.push("confidence: byte-verified | community-reverse-engineered");
  }
  if (raw.defaultLayers !== undefined) {
    if (!isRecord(raw.defaultLayers)) errors.push("defaultLayers: must be an object");
    else for (const [k, v] of Object.entries(raw.defaultLayers)) {
      if (k !== "headers" && k !== "body" && k !== "prompt") errors.push(`defaultLayers.${k}: unknown layer`);
      else if (typeof v !== "boolean") errors.push(`defaultLayers.${k}: boolean required`);
    }
  }
  if (!isRecord(raw.headers)) errors.push("headers: object required (may be empty)");
  else for (const [proto, map] of Object.entries(raw.headers)) {
    if (!PROTOCOL_IDS.includes(proto as ProtocolId)) errors.push(`headers.${proto}: unknown protocol`);
    else checkHeaderMap(`headers.${proto}`, map, errors);
  }
  if (raw.body !== undefined) {
    if (!isRecord(raw.body)) errors.push("body: must be an object");
    else for (const [proto, overlay] of Object.entries(raw.body)) {
      if (!PROTOCOL_IDS.includes(proto as ProtocolId)) errors.push(`body.${proto}: unknown protocol`);
      else checkBodyOverlay(`body.${proto}`, proto as ProtocolId, overlay, errors);
    }
  }
  checkPrompt(raw.prompt, errors);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, persona: raw as unknown as PersonaDefinition };
}

/** 层集解析（spec §10.1，2026-08-23 迭代2 fix round 1）：
 *  - 无限定（override 缺省或全空）→ 缺省层集 {headers:true, body:true,
 *    prompt:false} ← persona.defaultLayers（与历史逐字节一致）。
 *  - 带显式限定（override 存在且至少一键有值）→ 限定列出的是**完整启用集**
 *    （mask）：未列出的层 = 关，persona.defaultLayers 不参与——
 *    `claude-code:headers` = 只启用 headers 层。 */
export function effectiveLayers(persona: PersonaDefinition, override?: Partial<LayerFlags>): LayerFlags {
  if (
    override !== undefined &&
    (override.headers !== undefined || override.body !== undefined || override.prompt !== undefined)
  ) {
    return { headers: override.headers === true, body: override.body === true, prompt: override.prompt === true };
  }
  const d = { headers: true, body: true, prompt: false, ...(persona.defaultLayers ?? {}) };
  return d;
}
