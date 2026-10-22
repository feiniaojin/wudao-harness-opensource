// 拆分运动 C：从 openai-compatible.ts 原样外提的 M79 §2 图片请求域
//（AttachmentResolver/ImageRequestContext、keep-K 窗口、imageWireMessages 走查）。
import { createHash } from "node:crypto";
import {
  UnsupportedContentError,
  imageOffloadPlaceholder,
  offloadRequestImages,
  type ImageAttachmentRef,
  type ImageBlock,
  type ModelInput,
} from "@wudao/core";
import type { ProviderConfig } from "./config.js";
import { resolveInputModalities, type InputModality } from "./models.js";
import { restoreToolCallId } from "./tool-call-ids.js";
import { toOpenAIMessage } from "./openai-messages.js";

/** M79 §2: what the engine needs from an attachment store at the HTTP
 *  boundary. Structural (the core AttachmentStore satisfies it). */
export interface AttachmentResolver {
  resolveDataUrl(ref: ImageAttachmentRef): Promise<string>;
}

/** Per-provider image request context (resolved once from options). */
export interface ImageRequestContext {
  readonly budgetBytes: number;
  readonly resolver?: AttachmentResolver;
}

// ---------------------------------------------------------------------------
// M79 §2 — image-bearing requests (a ref a ref parity; research 40 §1).
//
//   gate      images need a model that DECLARES the image input modality and
//             an assembled attachment resolver; assistant history carrying
//             images is structurally refused. All three fail with the typed
//             UnsupportedContentError BEFORE any network call (and before a
//             single image byte is read).
//   shape     a user turn with images → OpenAI-compatible content parts
//             (`image_url` carrying the TRANSIENT data URL); a pure-text
//             user turn keeps the compact string form, byte-identical to
//             pre-M79.
//   tool wire the `tool` role stays string-only: images riding tool results
//             buffer into ONE synthetic user message immediately following
//             the tool block, prefixed "Attached image(s) from tool result:".
//   offload   over the cumulative base64 budget, the OLDEST images become
//             fixed text placeholders (deterministic); omitted bytes are
//             never resolved.
// ---------------------------------------------------------------------------

/** Prefix of the synthetic user message that carries tool-result images. */
export const TOOL_IMAGE_NOTE = "Attached image(s) from tool result:";

/** ω99-138 keep-K — how many TOOL-RESULT images ride a request as image_url
 *  parts. The M79 byte budget (20MiB) bounds BYTES, not visual tokens: a long
 *  browser session's screenshots would all decode to image_url parts on EVERY
 *  request (40~200 images = the death spiral 135's risk list put first), so
 *  the request projection keeps a sliding window of the most recent K and
 *  stubs everything older with the FIXED text below. USER images are NOT
 *  windowed (zero drift — they keep their full M79 behavior).
 *
 *  ω99-244: #3 — K 2→3 (computer arc C's screenshot-history stub, brief
 *  N=3): the SAME request-build projection seam — turn-boundary timing
 *  unchanged (projection happens between turns, at request build, never
 *  mid-flight), window-slide semantics unchanged, only one slot wider.
 *  M24 cache cost (declared, not hidden): widening K flips the 3rd-newest
 *  tool image from stub to image_url for sessions spanning the upgrade —
 *  ONE cross-version cold turn (cold turn expected), never inside a session;
 *  the stub text below changes bytes in the same version, same single break;
 *  the M24 compensation narrative in imageWireMessages covers both. Within a
 *  session the window self-heals every request build (a stubbed image that
 *  re-enters the window renders again — no compaction-timing cliff). */
const TOOL_IMAGE_KEEP_K = 3;

/** The fixed stub for window-evicted tool images — literal-pinned by tests
 *  (deterministic bytes: two builds of the same history project identically).
 *  ω99-244: derived from K so the two can never drift apart. */
const TOOL_IMAGE_KEEP_K_STUB = `[更早的截图已略：仅保留最近 ${TOOL_IMAGE_KEEP_K} 张]`;

/** The content a tool message shows when its bytes went to the following
 *  synthetic user message (a ref a ref wire shape). */
const TOOL_IMAGE_CONTENT_FALLBACK = "(see attached image)";

// ---------------------------------------------------------------------------
// 借鉴弧 β1 — adjacent byte-dedup inside the keep-K window (the upstream
// 682b973b32, digest-b C2). The incumbent window bounds COUNT, not
// REDUNDANCE: a static capture→act→capture loop fills all K slots with
// byte-identical frames and burns K× the visual tokens for ONE screen.
//
// Dedup lives at THIS request-build projection seam only — the same seam
// ω99-138/244 established (turn-boundary timing, per-request self-healing,
// persisted history untouched). The window members' transient data URLs are
// resolved once and hashed (sha256 over the full `data:<mime>;base64,…`
// string ≡ sha256(mime+bytes) — the upstream's exact dedup key); a newest→oldest
// walk keeps the NEWEST frame of every identical-ADJACENT run and replaces
// older duplicates with the FIXED note below. USER images never take the
// note (zero drift, same as the window).
//
// M24 cache cost (declared, not hidden): the projection stays append-only —
// every ref remains in the JSONL, the note bytes are FIXED, so two builds of
// the same history project identically. When an adjacent duplicate lands,
// the previous anchor flips image_url → note: ONE additional deterministic
// flip at the same turn-boundary timing as the window slide (never
// mid-flight) — same cold-turn-expected class ω99-244 declared for K; in a
// static loop the request carries ONE image instead of K identical ones, so
// visual tokens strictly fall while request bytes get MORE stable (the
// multi-MiB duplicated blobs stop riding).
// ---------------------------------------------------------------------------

/** β1 — max consecutive adjacent-duplicate frames rendered as the note
 *  before a re-anchor image is forced (the upstream's 省略连击上限: staleness guard
 *  — the kept frame can never drift arbitrarily far from the newest state,
 *  and a compaction/window eviction of the anchor degrades at most cap
 *  notes, not an unbounded run). At K=3 the cap admits the two older slots
 *  of a fully static window as notes; K widened later re-anchors at every
 *  cap+1 frames automatically (the walk is K-agnostic). */
const TOOL_IMAGE_DEDUP_OMIT_CAP = 2;

/** β1 — the fixed note replacing an adjacent-duplicate frame (literal-pinned
 *  by tests; deterministic bytes: same history ⇒ same projection). */
const TOOL_IMAGE_DEDUP_STUB = "[截图未变：本帧与相邻截图逐字节相同，已省略图片——保留帧即当前屏幕状态]";

/** β1 — the pure newest→oldest dedup walk over one window's content hashes
 *  (input in HISTORY order, oldest→newest). Returns per-frame verdicts:
 *  true = renders as image_url, false = the fixed note. A frame is omitted
 *  only when its hash equals its immediate NEWER neighbor's AND the
 *  omission streak stays under `omitCap`. Exported so the policy itself is
 *  unit-testable at any window width (the seam below only feeds it hashes
 *  — at K=3 the re-anchor branch needs a 4-wide window to show, which only
 *  the direct test can see). */
export function sameImageKeepVerdicts(hashes: readonly string[], omitCap: number): boolean[] {
  const verdicts = new Array<boolean>(hashes.length);
  let streak = 0;
  for (let i = hashes.length - 1; i >= 0; i -= 1) {
    const newer = hashes[i + 1];
    if (newer !== undefined && hashes[i] === newer && streak < omitCap) {
      verdicts[i] = false;
      streak += 1;
    } else {
      verdicts[i] = true;
      streak = 0;
    }
  }
  return verdicts;
}

type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Does any message in the input carry image blocks? (Cheap pre-filter —
 *  the no-image path below is the byte-identical pre-M79 construction.) */
export function inputHasImages(input: ModelInput): boolean {
  return input.messages.some((m) => {
    const imgs = (m as { images?: unknown }).images;
    return Array.isArray(imgs) && imgs.length > 0;
  });
}

/** The pure pre-I/O capability/role gate. Throws the typed
 *  UnsupportedContentError — never retries (see isRetryableProviderError) —
 *  for (a) images addressed at a model without the `image` modality, and
 *  (b) ImageBlocks in assistant history (only user turns and tool results
 *  may carry images). Exported so the CLI can pre-check a submit. */
export function assertImagesSupported(input: ModelInput, modalities: readonly InputModality[]): void {
  let has = false;
  for (const m of input.messages) {
    const imgs = (m as { images?: unknown }).images;
    if (!Array.isArray(imgs) || imgs.length === 0) continue;
    has = true;
    if (m.role === "assistant") {
      throw new UnsupportedContentError(
        "image-in-unsupported-role",
        "images may ride user turns and tool results only — assistant history carries an ImageBlock",
      );
    }
  }
  if (has && !modalities.includes("image")) {
    throw new UnsupportedContentError(
      "model-no-image-modality",
      `model does not declare the image input modality (inputModalities: [${modalities.join(", ")}]) — refusing the image-bearing request`,
    );
  }
}

/** All image blocks of a request, in message order (oldest first). */
function collectRequestImages(input: ModelInput): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const m of input.messages) {
    const imgs = (m as { images?: readonly ImageBlock[] }).images;
    if (Array.isArray(imgs) && imgs.length > 0) out.push(...imgs);
  }
  return out;
}

/** The image-bearing message walk (system + per-message shaping + the
 *  synthetic tool-image user message). Only called when inputHasImages —
 *  the text-only path is toOpenAIRequest's, byte-identical. */
export async function imageWireMessages(
  config: ProviderConfig,
  input: ModelInput,
  imageCtx: ImageRequestContext,
): Promise<unknown[]> {
  // Gate BEFORE reading a single image byte (capability + role).
  assertImagesSupported(input, resolveInputModalities(config));
  if (imageCtx.resolver === undefined) {
    throw new UnsupportedContentError(
      "no-attachment-store",
      "no attachment resolver is assembled on this provider — image-bearing input cannot be built (images are never silently dropped)",
    );
  }
  // Offload plan from the DURABLE refs' sizes (pure); only the survivors'
  // bytes are ever resolved.
  //
  // ω99-138 keep-K window (M24: compensation ships BEFORE the feature).
  // TOOL-result images beyond the most recent K drop out of the projection
  // here — BEFORE the byte-budget offload plan — so an evicted image neither
  // resolves bytes nor spends budget; on the wire its part is the fixed stub
  // above (the carrier message keeps one part per image, position-stable).
  // CACHE COST (M24 format): the window lives ONLY in this request build —
  // persisted history keeps every ref (append-only, never rewritten). When
  // the window slides (the K+1-st tool image lands), the oldest window
  // member flips from image_url to the stub: the synthetic carrier's bytes
  // change at that point and break the prefix ONCE there = cold turn
  // expected. Turn-boundary timing holds by construction (projection happens
  // between turns, at request build, never mid-flight).
  const toolImageIdsInOrder: string[] = [];
  const toolImageIds = new Set<string>();
  const toolImageRefById = new Map<string, ImageAttachmentRef>();
  for (const m of input.messages) {
    if (m.role !== "tool") continue;
    const imgs = (m as { images?: readonly ImageBlock[] }).images;
    if (!Array.isArray(imgs)) continue;
    for (const b of imgs) {
      if (!toolImageIds.has(b.ref.attachmentId)) {
        toolImageIds.add(b.ref.attachmentId);
        toolImageIdsInOrder.push(b.ref.attachmentId);
        toolImageRefById.set(b.ref.attachmentId, b.ref);
      }
    }
  }
  const keepKIds = new Set(toolImageIdsInOrder.slice(-TOOL_IMAGE_KEEP_K));
  const isWindowStubbed = (b: ImageBlock): boolean =>
    toolImageIds.has(b.ref.attachmentId) && !keepKIds.has(b.ref.attachmentId);
  // β1 byte-dedup (see the block comment above the constants): resolve each
  // WINDOW member once — the resolution doubles as the content hash source —
  // then let the pure newest→oldest walk decide which frames still render.
  // Hashing is an OPTIMIZATION seam and fails OPEN here (an unresolvable
  // frame simply never dedups): the render path below keeps its exact
  // pre-β1 surface (a kept frame resolves again and throws there if truly
  // broken; an offloaded one never resolves, as ever).
  const windowIds = toolImageIdsInOrder.slice(-TOOL_IMAGE_KEEP_K);
  const urlById = new Map<string, string>();
  const hashById = new Map<string, string>();
  for (const id of windowIds) {
    const r = toolImageRefById.get(id);
    if (r === undefined) continue;
    try {
      const url = await imageCtx.resolver.resolveDataUrl(r);
      urlById.set(id, url);
      hashById.set(id, createHash("sha256").update(url).digest("hex"));
    } catch {
      // No hash for this frame — the sentinel below keeps it unique, so it
      // rides (or offloads) exactly as it would have without β1.
    }
  }
  const verdicts = sameImageKeepVerdicts(
    windowIds.map((id) => hashById.get(id) ?? ` unresolved:${id}`),
    TOOL_IMAGE_DEDUP_OMIT_CAP,
  );
  const dedupOmitIds = new Set<string>();
  windowIds.forEach((id, i) => {
    if (verdicts[i] === false) dedupOmitIds.add(id);
  });
  const isDedupStubbed = (b: ImageBlock): boolean =>
    toolImageIds.has(b.ref.attachmentId) && dedupOmitIds.has(b.ref.attachmentId);
  // Dedup survivors only: a note consumes no image budget, so a static loop
  // also stops pressuring the M79 offload ladder (the bytes it would have
  // spent are simply never resolved).
  const blocks = collectRequestImages(input)
    .filter((b) => !isWindowStubbed(b))
    .filter((b) => !isDedupStubbed(b));
  const { kept } = offloadRequestImages(blocks, imageCtx.budgetBytes);
  const keptIds = new Set(kept.map((b) => b.ref.attachmentId));
  for (const b of kept) {
    if (!urlById.has(b.ref.attachmentId)) {
      urlById.set(b.ref.attachmentId, await imageCtx.resolver.resolveDataUrl(b.ref));
    }
  }
  const partFor = (b: ImageBlock, fromTool: boolean): WireContentPart => {
    // ω99-138: an evicted tool image renders as the fixed stub — same
    // position, deterministic bytes (user images never take this branch).
    if (fromTool && isWindowStubbed(b)) return { type: "text", text: TOOL_IMAGE_KEEP_K_STUB };
    // β1: an adjacent byte-duplicate renders as the fixed dedup note — same
    // position-stable discipline (user images never take this branch either).
    if (fromTool && isDedupStubbed(b)) return { type: "text", text: TOOL_IMAGE_DEDUP_STUB };
    return keptIds.has(b.ref.attachmentId)
      ? { type: "image_url", image_url: { url: urlById.get(b.ref.attachmentId)! } }
      : { type: "text", text: imageOffloadPlaceholder(b.ref) };
  };

  const replay = config.reasoningReplay ?? "never";
  const out: unknown[] = [{ role: "system", content: input.systemPrompt }];
  let toolImages: ImageBlock[] = [];
  const flushToolImages = (): void => {
    if (toolImages.length === 0) return;
    out.push({
      role: "user",
      // ω99-138: each part follows its block's window verdict (image_url for
      // the kept K, the fixed stub for the evicted ones — positions stable).
      content: [{ type: "text", text: TOOL_IMAGE_NOTE }, ...toolImages.map((b) => partFor(b, true))],
    });
    toolImages = [];
  };
  for (const m of input.messages) {
    const imgs = (m as { images?: readonly ImageBlock[] }).images;
    const carries = Array.isArray(imgs) && imgs.length > 0;
    if (m.role === "tool") {
      out.push({
        role: "tool",
        // ω-1a: same outbound restore as toOpenAIMessage's tool case.
        tool_call_id: restoreToolCallId(m.toolCallId, m.name),
        content: carries ? (m.content !== "" ? m.content : TOOL_IMAGE_CONTENT_FALLBACK) : m.content,
      });
      if (carries) toolImages.push(...imgs!);
      continue;
    }
    // The synthetic carrier follows the tool block it answers.
    flushToolImages();
    if (m.role === "user" && carries) {
      // r5-C1: an image-ONLY turn (empty caption) omits the empty text part —
      // a bare {type:"text",text:""} is rejected by several strict
      // OpenAI-compatible endpoints; images alone are a well-formed content
      // array.
      const parts = m.content === "" ? [] : [{ type: "text", text: m.content }];
      // ω99-138: user images are OUTSIDE the keep-K window — fromTool=false
      // is the byte-for-byte M79 path (zero drift).
      out.push({ role: "user", content: [...parts, ...imgs!.map((b) => partFor(b, false))] });
      continue;
    }
    out.push(toOpenAIMessage(m, replay));
  }
  // Trailing tool results (a run cut mid-tool-phase) still carry their images.
  flushToolImages();
  return out;
}
