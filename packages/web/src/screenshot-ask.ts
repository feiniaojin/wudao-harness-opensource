// ω99-116 — the 截图快问 wire contract: the Rust half (apps/desktop/
// src-tauri/src/screenshot.rs) broadcasts {data,mediaType} on
// WUDAO_SCREENSHOT_EVENT after `screencapture -i`; this module is the
// receiving half's PURE layer — shape-guard the payload, decode the
// base64, mint the File. The rail arming (imageSeed) lives in App.tsx
// through the composer's parked-rail seam. PURE TS, no imports: App.tsx
// pulls this into the main index chunk, so it stays light (the
// pet/selection.ts discipline).
//
// Esc 取消: Rust NEVER emits on a cancelled capture (typed Cancelled →
// silent). The strict guard below is the second line of defense — a
// malformed or cancel-shaped payload reads as "nothing happened":
// 零草稿零报错.

/** 与 Rust 端 screenshot.rs 的 WUDAO_SCREENSHOT_EVENT 同名（有测试钉住）。 */
export const WUDAO_SCREENSHOT_EVENT = "wudao-screenshot";

/** The rail draft's display name (用户文案=收益——无实现术语). */
export const SCREENSHOT_DRAFT_NAME = "截图.png";

/** Rust 广播的一条截图载荷（data = RFC-4648 base64 png 字节）。 */
export interface ScreenshotWire {
  readonly data: string;
  readonly mediaType: string;
}

/** Wire parse: two keys type-correct or the payload drops WHOLE (the
 * readSelectionPayload discipline — extras tolerated, required strict).
 * data must be non-empty and mediaType must be image/*; anything else is
 * the silent no-op. */
export function parseScreenshotPayload(p: unknown): ScreenshotWire | null {
  if (typeof p !== "object" || p === null) return null;
  const s = p as Record<string, unknown>;
  if (typeof s.data !== "string" || s.data === "") return null;
  if (typeof s.mediaType !== "string" || !s.mediaType.startsWith("image/")) return null;
  return { data: s.data, mediaType: s.mediaType };
}

/** base64 → bytes (atob — every target browser and jsdom carry it; the
 * attachments.ts base64ToBytes mirror, kept local so this module stays
 * import-free). */
function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** The mint: payload → File (exactly the shape attachments.ts createDraft
 * takes — the M79b draft pipeline is the downstream). null on a malformed
 * payload OR a decode failure; never a throw. */
export function screenshotFileFromPayload(p: unknown): File | null {
  const w = parseScreenshotPayload(p);
  if (w === null) return null;
  try {
    return new File([decodeBase64(w.data)], SCREENSHOT_DRAFT_NAME, { type: w.mediaType });
  } catch {
    return null; // 非法 base64——静默丢弃，不惊扰
  }
}
