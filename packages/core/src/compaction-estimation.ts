// 拆分运动 C：从 compaction.ts 原样外提的 ω-1 脚本感知 token 估算域
//（CJK 加权估算、M76-ux2 §8 分段拆解、R5-I1 图片估算、消息字符计数族）。
// 纯函数模块：零包内依赖（attachments 的图片估算除外）。
import type { AgentMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import { estimateImageTokens } from "./attachments.js";

// ω-1 — script-aware estimation. The wudao target models are Chinese-first:
// CJK text compresses to ≈1 token per char, so the flat chars/4 ratio
// under-counted Chinese-heavy payloads 2–4× and delayed compaction past the
// real budget. Evidence: hive e418363d — window-derived ceilings measured
// ≈1 token per CJK char against real tokenizers. Over-estimation is the
// safe direction for compaction thresholds, so astral-plane CJK (ext-B
// surrogate pairs) counts once per code point.
export const CJK_TOKENS_PER_CHAR = 1;
export const NON_CJK_CHARS_PER_TOKEN = 4;

// BMP CJK blocks (Han, kana, Hangul, CJK punctuation/radicals/strokes,
// compatibility ideographs, fullwidth forms) plus the astral-plane CJK
// extensions B–H as surrogate pairs (a pair matches once = one code point).
const CJK_RE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-힯豈-﫿︰-﹏＀-￯]|[\uD840-\uD888][\uDC00-\uDFFF]/g;

/** ω-1 — the per-string script split behind every estimate: total UTF-16
 *  units, how many CJK code points they contain, and how many units those
 *  code points consume (2 for an astral-plane surrogate pair). */
export interface CharCount {
  readonly units: number;
  readonly cjkChars: number;
  readonly cjkUnits: number;
}

export function countChars(text: string): CharCount {
  let cjkChars = 0;
  let cjkUnits = 0;
  for (const m of text.matchAll(CJK_RE)) {
    cjkChars += 1;
    cjkUnits += m[0].length;
  }
  return { units: text.length, cjkChars, cjkUnits };
}

/** The script-aware token estimate of a CharCount: CJK code points at
 *  CJK_TOKENS_PER_CHAR each, every remaining unit at chars/4. Callers ceil
 *  once over the summed pools (a pure-ASCII input then estimates exactly as
 *  the historical chars/4 formula did). */
export function charCountTokens(c: CharCount): number {
  return c.cjkChars * CJK_TOKENS_PER_CHAR + (c.units - c.cjkUnits) / NON_CJK_CHARS_PER_TOKEN;
}

/** Rough token estimate (~4 chars/token) for the full request payload.
 *  R5-I1: images riding `m.images` count too — a flat base plus a
 *  byte-scaled term per image (IMAGE_TOKEN_ESTIMATE), so occupancy pressure
 *  sees the vision payload. Text-only inputs estimate exactly as before.
 *  ω-1: script-aware — see CJK_TOKENS_PER_CHAR below. */
export function estimateTokens(
  systemPrompt: string,
  tools: readonly ModelToolDefinition[],
  messages: readonly AgentMessage[],
): number {
  let units = 0;
  let cjkChars = 0;
  let cjkUnits = 0;
  const take = (c: CharCount): void => {
    units += c.units;
    cjkChars += c.cjkChars;
    cjkUnits += c.cjkUnits;
  };
  take(countChars(systemPrompt));
  for (const t of tools) take(countChars(JSON.stringify(t)));
  for (const m of messages) take(messageCharCount(m));
  return Math.ceil(cjkChars * CJK_TOKENS_PER_CHAR + (units - cjkUnits) / NON_CJK_CHARS_PER_TOKEN) + totalImageTokens(messages);
}

/** M76-ux2 §8 — the per-section estimates behind the StatusBar ctx hover
 *  (the ctxInfo op). Same script-aware accounting as estimateTokens (ω-1:
 *  CJK at CJK_TOKENS_PER_CHAR, the rest at chars/4), split by prompt
 *  section: system prompt, serialized tool schemas, message content,
 *  and (R5-I1) images. `total` is the COMBINED ceil (estimateTokens
 *  verbatim) so the hover can never disagree with the ctx watermark's
 *  occupancy measure; the per-section ceils may differ from that sum by
 *  rounding at most. */
export interface TokenBreakdown {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  /** R5-I1 — the image estimate across every `m.images` rider (0 when no
   *  message carries images; see IMAGE_TOKEN_ESTIMATE for the model). */
  readonly imagesTokens: number;
  readonly total: number;
}

/** The section split of estimateTokens (see TokenBreakdown). Pure. */
export function estimateTokensBreakdown(
  systemPrompt: string,
  tools: readonly ModelToolDefinition[],
  messages: readonly AgentMessage[],
): TokenBreakdown {
  const system = countChars(systemPrompt);
  let toolUnits = 0;
  let toolCjkChars = 0;
  let toolCjkUnits = 0;
  for (const t of tools) {
    const c = countChars(JSON.stringify(t));
    toolUnits += c.units;
    toolCjkChars += c.cjkChars;
    toolCjkUnits += c.cjkUnits;
  }
  let msgUnits = 0;
  let msgCjkChars = 0;
  let msgCjkUnits = 0;
  for (const m of messages) {
    const c = messageCharCount(m);
    msgUnits += c.units;
    msgCjkChars += c.cjkChars;
    msgCjkUnits += c.cjkUnits;
  }
  const imagesTokens = totalImageTokens(messages);
  return {
    systemTokens: Math.ceil(charCountTokens(system)),
    toolsTokens: Math.ceil(charCountTokens({ units: toolUnits, cjkChars: toolCjkChars, cjkUnits: toolCjkUnits })),
    messagesTokens: Math.ceil(charCountTokens({ units: msgUnits, cjkChars: msgCjkChars, cjkUnits: msgCjkUnits })),
    imagesTokens,
    total: Math.ceil(
      (system.cjkChars + toolCjkChars + msgCjkChars) * CJK_TOKENS_PER_CHAR
        + (system.units + toolUnits + msgUnits - system.cjkUnits - toolCjkUnits - msgCjkUnits) / NON_CJK_CHARS_PER_TOKEN,
    ) + imagesTokens,
  };
}

/** R5-I1 — the image tokens riding ONE message (0 when it carries none).
 *  Assistant messages never carry images (the provider gate fails closed on
 *  that shape), so the rider is read off the user/tool arms only. */
export function messageImagesTokens(m: AgentMessage): number {
  const images = m.role === "assistant" ? undefined : m.images;
  return images === undefined ? 0 : images.reduce((n, b) => n + estimateImageTokens(b.ref.byteLength), 0);
}

/** R5-I1 — the total image-token estimate across a message list: pure
 *  arithmetic over the durable refs' byteLength (the bytes are never read),
 *  so the estimate is deterministic and byte-stable across runs/resume. */
function totalImageTokens(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageImagesTokens(m);
  return n;
}

export function messageCharLength(m: AgentMessage): number {
  let n = m.content.length;
  if (m.role === "assistant") {
    if (m.toolCalls) for (const tc of m.toolCalls) n += JSON.stringify(tc.arguments).length;
  } else if (m.role === "tool") {
    n += m.name.length;
  }
  return n;
}

/** ω-1 — the script-aware CharCount over the SAME fields messageCharLength
 *  sums (content, serialized toolCall arguments, the tool result's name), so
 *  the estimator and every chars/4 sibling never disagree about what counts. */
export function messageCharCount(m: AgentMessage): CharCount {
  let units = 0;
  let cjkChars = 0;
  let cjkUnits = 0;
  const take = (text: string): void => {
    const c = countChars(text);
    units += c.units;
    cjkChars += c.cjkChars;
    cjkUnits += c.cjkUnits;
  };
  take(m.content);
  if (m.role === "assistant") {
    if (m.toolCalls) for (const tc of m.toolCalls) take(JSON.stringify(tc.arguments));
  } else if (m.role === "tool") {
    take(m.name);
  }
  return { units, cjkChars, cjkUnits };
}
