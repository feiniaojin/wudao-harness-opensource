// M79b — the browser-side image support: composer drafts + the history-image
// cache. Two halves, one rule carried over from M79 (research 40 §1/§2): image
// BYTES never ride a session payload — the composer holds picked Files as
// blob-URL drafts (browser-only), exchanges them for durable refs through
// attachmentSave at submit, and history thumbnails re-fetch refs through
// attachmentGet into a generation-guarded blob-URL cache that is disposed
// wholesale when the session id changes (a ref's Chat UI pattern).
//
// Mirrors the store's admission numbers (packages/core/src/attachments.ts):
// maxImages 9, cumulative base64 budget 20MiB. The pre-flight here is UX, not
// enforcement — the driver's AttachmentStore re-checks fail-closed at
// admission, so a stale client can never sneak an over-limit batch through.

/** Mirrors core's DEFAULT_MAX_IMAGES (the store re-enforces at admission). */
export const MAX_COMPOSER_IMAGES = 9;

/** Mirrors core's DEFAULT_MAX_REQUEST_IMAGE_BYTES — counted in base64 (the
 *  encoded form is what request budgets count), like the store. */
export const MAX_IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;

/** The base64 length of `n` decoded bytes (standard padded base64) — the same
 *  arithmetic core's base64EncodedLength uses, mirrored so the client's
 *  pre-flight counts exactly what the server will. */
export function base64LengthOf(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/** One picked-but-unsent image. Browser-only state: `url` is a blob URL this
 *  module minted (revoked on remove / submit success / unmount), `file` stays
 *  for the submit-time base64 read. Never crosses a wire. */
export interface ComposerImageDraft {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  /** Decoded byte count (the File's size). */
  readonly byteLength: number;
  readonly url: string;
  readonly file: File;
}

let draftSeq = 0;

/** A fresh draft id — crypto.randomUUID where the platform has it, else a
 *  counter (jsdom-level determinism for tests). */
function nextDraftId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  draftSeq += 1;
  return `draft-${draftSeq}`;
}

/** The draft's share of the request budget: its base64 length. */
export function draftBudget(d: { readonly byteLength: number }): number {
  return base64LengthOf(d.byteLength);
}

/** r5-P3: one rejection KIND — a batch can mix them, and the notice lists
 *  every kind with its count (the old single-string rejection surfaced only
 *  the FIRST one, collapsing "2 张过大 + 1 张超数" into whichever came first). */
export type AttachmentRejectionKind = "type" | "count" | "budget";

/** Client-side pre-flight against the store's numbers, as a KIND. Returns
 *  null when the file may join the rail. Pure — callers own the notice
 *  surface. A non-image type is refused here (the hidden input's `accept`
 *  filters the picker, but an OS drag-drop can carry anything). */
export function attachmentRejectionKind(
  file: { readonly type: string; readonly size: number },
  current: readonly { readonly byteLength: number }[],
): AttachmentRejectionKind | null {
  if (!file.type.startsWith("image/")) return "type";
  if (current.length >= MAX_COMPOSER_IMAGES) return "count";
  const budget = current.reduce((sum, d) => sum + draftBudget(d), 0) + base64LengthOf(file.size);
  if (budget > MAX_IMAGE_BUDGET_BYTES) return "budget";
  return null;
}

/** r5-P3: the batch admission — every file pre-flighted against the GROWING
 *  rail (accepted files count toward the later ones' caps, like the old
 *  one-at-a-time loop). Returns the files that may join the rail (blob-URL
 *  minting stays with the caller) and a notice naming EVERY rejection kind
 *  with its count, joined by " · " in a fixed order (type → count → budget)
 *  — or null when everything passed. */
export function admitFiles(
  files: readonly File[],
  current: readonly { readonly byteLength: number }[],
): { readonly accepted: readonly File[]; readonly notice: string | null } {
  const accepted: File[] = [];
  const rail: { byteLength: number }[] = [...current];
  const counts = new Map<AttachmentRejectionKind, number>();
  let firstType: string | null = null;
  for (const f of files) {
    const kind = attachmentRejectionKind(f, rail);
    if (kind === null) {
      accepted.push(f);
      rail.push({ byteLength: f.size }); // the accepted file counts toward the later ones' caps
    } else {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (kind === "type" && firstType === null) firstType = f.type === "" ? "该文件" : f.type;
    }
  }
  if (counts.size === 0) return { accepted, notice: null };
  const parts: string[] = [];
  for (const kind of ["type", "count", "budget"] as const) {
    const n = counts.get(kind);
    if (n === undefined) continue;
    if (kind === "type") parts.push(`${n} 张不是图片(${firstType})—— 只能附加图片`);
    else if (kind === "count") parts.push(`${n} 张超出数量上限(最多同时附加 ${MAX_COMPOSER_IMAGES} 张)`);
    else parts.push(`${n} 张超过 20MiB 上限`);
  }
  return { accepted, notice: `⚠️ ${parts.join(" · ")}` };
}

/** r5-P4: the human name for an attachmentSave admission failure. The wire
 *  carries the store's MESSAGE (`errText` reads .message, not the typed
 *  error's .code), so both shapes are recognized — the code itself (a server
 *  that prefixes it) and core's prose ("N images exceed the per-request cap
 *  of 9" / "over the M-byte request budget"). Anything else passes through
 *  verbatim (network/protocol errors own their wording). */
const ADMISSION_MAP: readonly {
  readonly code: "TOO_MANY_IMAGES" | "IMAGES_TOO_LARGE";
  readonly re: RegExp;
  readonly zh: string;
}[] = [
  { code: "TOO_MANY_IMAGES", re: /TOO_MANY_IMAGES|exceed the per-request cap/i, zh: "图片数量超出上限" },
  { code: "IMAGES_TOO_LARGE", re: /IMAGES_TOO_LARGE|over the \d+-byte request budget/i, zh: "图片体积超出上限" },
];

export function attachmentSendErrorText(raw: string): string {
  for (const m of ADMISSION_MAP) {
    if (m.re.test(raw)) return `${m.zh}(${m.code})`;
  }
  return raw;
}

/** Mint the draft: a blob URL for the thumbnail (revoked by releaseDraft). */
export function createDraft(file: File): ComposerImageDraft {
  return {
    id: nextDraftId(),
    name: file.name,
    mediaType: file.type,
    byteLength: file.size,
    url: URL.createObjectURL(file),
    file,
  };
}

/** Release a draft's blob URL (remove / submit-success / unmount). */
export function releaseDraft(d: { readonly url: string }): void {
  URL.revokeObjectURL(d.url);
}

/** The submit-time exchange unit: base64 (no data: prefix) + media type —
 *  exactly attachmentSave's input shape. */
export interface ComposerImageInput {
  readonly data: string;
  readonly mediaType: string;
}

/** M79b: the composer's submit seam. Text-only calls keep the historical
 *  void shape (the buffer clears synchronously); an images-bearing call is a
 *  draft LEASE — resolve false (or reject) and the composer keeps its rail
 *  and text for retry, anything else releases them. ω99-55: file drafts ride
 *  the SAME lease as a third parameter (either lane alone may be present). */
export type SubmitWithImages = (
  text: string,
  images?: readonly ComposerImageInput[],
  files?: readonly ComposerFileInput[],
) => void | boolean | Promise<boolean | void>;

/** Read one file as base64 (FileReader — jsdom-safe). Resolves with the bare
 *  base64 (the data: URL prefix is stripped). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`read failed: ${file.name}`));
    r.onload = () => {
      const s = String(r.result ?? "");
      const i = s.indexOf(",");
      resolve(i === -1 ? s : s.slice(i + 1));
    };
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// ω99-55 — the FILE lane (the composer's second attachment lane). One
// attachment domain, two lanes: images keep the thumbnail pipeline above;
// ANY other file kind enters here. Mirrors core's saveFiles admission
// numbers (packages/core/src/attachments.ts): maxFiles 9, cumulative base64
// budget 50MiB, NO type whitelist (a ref: the harness stores bytes and lets
// the model read them lazily — a cap would govern transfer policy, not
// request safety). Pre-flight here is UX; the driver's store re-checks
// fail-closed.
// ---------------------------------------------------------------------------

/** Mirrors core's DEFAULT_MAX_FILES (the store re-enforces at admission). */
export const MAX_COMPOSER_FILES = 9;

/** Mirrors core's DEFAULT_MAX_REQUEST_FILE_BYTES — counted in base64 (the
 *  encoded form is what crosses the fileSave op), like the image lane. */
export const MAX_FILE_BUDGET_BYTES = 50 * 1024 * 1024;

/** The file lane's rejection kinds — count/budget only. There is NO "type"
 *  kind: any file kind may attach (the image lane above keeps its own
 *  stricter pre-flight for its own rail). */
export type FileRejectionKind = "count" | "budget";

/** Client-side pre-flight against the store's numbers. Pure. `type` is
 *  deliberately accepted-and-ignored (the File shape callers hold) — the
 *  file lane has no type whitelist. */
export function fileRejectionKind(
  file: { readonly type?: string; readonly size: number },
  current: readonly { readonly byteLength: number }[],
): FileRejectionKind | null {
  if (current.length >= MAX_COMPOSER_FILES) return "count";
  const budget = current.reduce((sum, d) => sum + draftBudget(d), 0) + base64LengthOf(file.size);
  if (budget > MAX_FILE_BUDGET_BYTES) return "budget";
  return null;
}

/** The file lane's batch admission — every file pre-flighted against the
 *  GROWING rail (accepted files count toward the later ones' caps). Returns
 *  the files that may join plus a notice naming EVERY rejection kind with
 *  its count (the r5-P3 shape), or null when everything passed. */
export function admitFileBatch(
  files: readonly File[],
  current: readonly { readonly byteLength: number }[],
): { readonly accepted: readonly File[]; readonly notice: string | null } {
  const accepted: File[] = [];
  const rail: { byteLength: number }[] = [...current];
  const counts = new Map<FileRejectionKind, number>();
  for (const f of files) {
    const kind = fileRejectionKind(f, rail);
    if (kind === null) {
      accepted.push(f);
      rail.push({ byteLength: f.size });
    } else {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return { accepted, notice: null };
  const parts: string[] = [];
  for (const kind of ["count", "budget"] as const) {
    const n = counts.get(kind);
    if (n === undefined) continue;
    if (kind === "count") parts.push(`${n} 个超出数量上限(最多同时附加 ${MAX_COMPOSER_FILES} 个)`);
    else parts.push(`${n} 个超过 50MiB 上限`);
  }
  return { accepted, notice: `⚠️ ${parts.join(" · ")}` };
}

/** One picked-but-unsent file. Browser-only state; NO blob URL — a file
 *  card shows name + size, nothing to preview (unlike an image thumb). */
export interface ComposerFileDraft {
  readonly id: string;
  readonly name: string;
  readonly byteLength: number;
  readonly file: File;
}

/** Mint the file draft (the createDraft shape, minus the blob URL). */
export function createFileDraft(file: File): ComposerFileDraft {
  return {
    id: nextDraftId(),
    name: file.name,
    byteLength: file.size,
    file,
  };
}

/** The submit-time exchange unit for the file lane: base64 + name — exactly
 *  fileSave's input shape. */
export interface ComposerFileInput {
  readonly data: string;
  readonly name: string;
}

/** The human name for a fileSave admission failure (the
 *  attachmentSendErrorText pattern: the code AND core's prose are both
 *  recognized; anything else passes through verbatim). */
const FILE_ADMISSION_MAP: readonly {
  readonly code: "TOO_MANY_FILES" | "FILES_TOO_LARGE";
  readonly re: RegExp;
  readonly zh: string;
}[] = [
  { code: "TOO_MANY_FILES", re: /TOO_MANY_FILES|files exceed the per-request cap/i, zh: "文件数量超出上限" },
  { code: "FILES_TOO_LARGE", re: /FILES_TOO_LARGE|over the \d+-byte request budget/i, zh: "文件体积超出上限" },
];

export function fileSendErrorText(raw: string): string {
  for (const m of FILE_ADMISSION_MAP) {
    if (m.re.test(raw)) return `${m.zh}(${m.code})`;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The history-image cache (generation counter + LRU cap)
// ---------------------------------------------------------------------------

/** LRU cap for resolved history images. A screen-full of bubbles is well
 *  under this; the cap bounds blob-URL leakage on long replays. */
export const IMAGE_CACHE_CAP = 50;

interface CacheEntry {
  readonly url: string;
}

/** The ref shape the cache resolves — structurally the wire's
 *  ImageAttachmentRefWire (kind tag included: the op echoes the ref). */
export interface AttachmentRefLike {
  readonly kind: "image";
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/** The resolve seam the cache calls — the client's attachmentGet (or a test
 *  double) returning the stored bytes. */
export type AttachmentFetcher = (ref: AttachmentRefLike) => Promise<{ readonly data: string; readonly mediaType: string }>;

/** The blob-URL cache for history images, guarded by a session generation
 *  counter (the upstream formatresearch 40 §2). One generation = one session id: switching
 *  sessions revokes every URL wholesale, and a load that lands after the
 *  bump is dropped (its blob URL revoked immediately) — a slow fetch for the
 *  OLD session can never hand the new session a stale URL. */
export class AttachmentImageCache {
  private generation = 0;
  private session: string | null = null;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  /** Align with the session being rendered. Returns the CURRENT generation —
   *  callers pass it back to resolve() so stale loads self-drop.
   *  (m79b-review NIT: the driver's /clear does NOT rotate the session id,
   *  so a clear does not dispose the cache — wiped images' blob URLs linger
   *  until the next session switch or LRU eviction, bounded at CAP. Accepted:
   *  revoking under a mounted <img> is worse than a bounded linger.) */
  ensureSession(sessionId: string): number {
    if (this.session !== sessionId) {
      this.dispose();
      this.session = sessionId;
    }
    return this.generation;
  }

  /** A cached URL, if already resolved (LRU-refreshed). No fetching. */
  peek(attachmentId: string): string | undefined {
    const hit = this.entries.get(attachmentId);
    if (hit === undefined) return undefined;
    // LRU refresh: re-insert at the MRU end.
    this.entries.delete(attachmentId);
    this.entries.set(attachmentId, hit);
    return hit.url;
  }

  /** Resolve one ref to a stable blob URL — cache hit, in-flight join, or a
   *  fetch. A load landing after `gen`'s generation was superseded returns
   *  null (and revokes what it minted): the caller re-resolves on the new
   *  generation. Rejections propagate (the bubble renders its error state);
   *  a failed id stays uncached so a later mount can retry. */
  async resolve(gen: number, ref: AttachmentRefLike, fetcher: AttachmentFetcher): Promise<string | null> {
    const hit = this.peek(ref.attachmentId);
    if (hit !== undefined) return hit;
    const pending = this.inFlight.get(ref.attachmentId);
    if (pending !== undefined) return pending;
    const load = (async () => {
      const res = await fetcher(ref);
      const bytes = base64ToBytes(res.data);
      const url = URL.createObjectURL(new Blob([bytes], { type: res.mediaType }));
      if (gen !== this.generation) {
        URL.revokeObjectURL(url); // the session moved on — this URL is dead
        return null;
      }
      this.entries.set(ref.attachmentId, { url });
      this.evictOverCap();
      return url;
    })();
    this.inFlight.set(ref.attachmentId, load);
    try {
      return await load;
    } finally {
      this.inFlight.delete(ref.attachmentId);
    }
  }

  private evictOverCap(): void {
    while (this.entries.size > IMAGE_CACHE_CAP) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (entry !== undefined) URL.revokeObjectURL(entry.url);
    }
  }

  /** Revoke every URL and advance the generation. The session-switch path
   *  (also the test reset). In-flight loads fizzle on their own (their gen
   *  check now fails); their dedupe entries are dropped so a post-switch
   *  resolve of the same id starts fresh instead of joining a doomed load. */
  dispose(): void {
    for (const [, e] of this.entries) URL.revokeObjectURL(e.url);
    this.entries.clear();
    this.inFlight.clear();
    this.generation += 1;
  }
}

/** The module-level singleton both shells share (one generation counter for
 *  the whole page — the session id is page state, not per-column state). */
export const attachmentImages = new AttachmentImageCache();

/** base64 → bytes (atob; every target browser and jsdom carry it). */
function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
