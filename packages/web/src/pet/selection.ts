// ω99-110 — the 划词助手 wire contract: the pet's selection intake card.
// Rust broadcasts {text,truncated,granted} on WUDAO_PET_SELECTION_EVENT
// (name pinned on BOTH sides, src/selection.rs); the card answers with the
// FINISHED prompt text (the family below builds it pet-side, so the relay
// lane stays a dumb trim+submit). PURE TS, no imports: relay.ts pulls this
// into the main index chunk (≤3kB gate in pet-selection.test.ts).
export const WUDAO_PET_SELECTION_EVENT = "wudao-pet-selection";
export const WUDAO_PET_SELECTION_SUBMIT_EVENT = "wudao-pet-selection-submit";

/** The intake card's content — Rust's selection payload, shape-guarded on
 *  arrival. text="" → the empty state; granted=false → the permission-guide
 *  card. */
export interface PetSelection {
  readonly text: string;
  readonly truncated: boolean;
  readonly granted: boolean;
}

/** Wire parse: three keys type-correct or the payload drops WHOLE (the
 *  readFrame discipline — extras tolerated, required strict). */
export function readSelectionPayload(p: unknown): PetSelection | null {
  if (typeof p !== "object" || p === null) return null;
  const s = p as Record<string, unknown>;
  if (typeof s.text !== "string") return null;
  if (typeof s.truncated !== "boolean") return null;
  if (typeof s.granted !== "boolean") return null;
  return { text: s.text, truncated: s.truncated, granted: s.granted };
}

// --- the prompt family（brief §2 逐字钉；改文案必改 brief）--------------------

/** 提问框空着直接发：泛化委托。 */
export function genericPrompt(text: string): string {
  return `帮我看看这段划选的文字：\n\n${text}`;
}

/** chip「翻译」：按原文方向中英互译。 */
export function translatePrompt(text: string): string {
  return `翻译这段划选的文字（按原文方向中英互译）：\n\n${text}`;
}

/** chip「解释」。 */
export function explainPrompt(text: string): string {
  return `解释这段划选的文字：\n\n${text}`;
}

/** 提问框有字：问题在前、选文括号附后。 */
export function questionPrompt(text: string, q: string): string {
  return `${q}\n\n（划选的文字：\n${text}\n）`;
}

/** ω99-113 第五成员：划的是不是网址——http(s):// 开头、trim 后判定；纯
 *  域名不带 scheme 不算、URL 在句中不算（宁缺勿误——误判的代价是把普通
 *  文字当网址开浏览器）。 */
export function isUrlSelection(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/** ω99-113 chip「读这个网页」话术（brief §1.B 逐字）；URL 经 trim。 */
export function urlPrompt(url: string): string {
  return `用浏览器打开 ${url.trim()}，把页面上主要讲了什么读给我听`;
}
