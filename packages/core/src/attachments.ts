// M79 §1 — the attachment domain: durable image refs + the AttachmentStore
// port. The dsh-verified split (research 40 §1): IMAGE BYTES NEVER ENTER THE
// SESSION LOG — messages carry only `ImageAttachmentRef`, and the transient
// `data:` URL exists solely during one request build. That keeps the M24
// cache invariants intact by construction: history stays append-only, the
// canonical serializer stays deterministic, and the persisted prefix bytes
// never move when an image rides a NEW user turn.
//
// Fail-closed admission (the Tool-interface discipline): count/size/media
// validation happens BEFORE any filesystem write, and the two typed errors
// (TOO_MANY_IMAGES / IMAGES_TOO_LARGE) carry stable codes the callers assert.

import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSipsDecoder, sniffBmffImageKind, type BmffDecoder } from "./attachments-heif.js";
import { resolveWorkspacePath } from "./tools/workspace.js";
import type { AgentMessage } from "./types.js";

/** The ONLY image shape that persists or crosses a wire boundary: a pointer
 *  into the AttachmentStore. `byteLength` is the DECODED byte count (the
 *  store measured it at admission); the base64 encoding of those bytes is
 *  `≈ 4/3 × byteLength` and is what request budgets count. */
export interface ImageAttachmentRef {
  readonly kind: "image";
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/** An image riding a message: user turns (the CLI `--image` flag, the web
 *  composer) and tool results (buffered by the provider serializer into a
 *  following synthetic user message — the `tool` wire role stays
 *  string-only). Assistant messages never carry images; the provider gate
 *  fails closed on that shape before any I/O. */
export interface ImageBlock {
  readonly kind: "image";
  readonly ref: ImageAttachmentRef;
}

// ---------------------------------------------------------------------------
// Limits + typed admission errors
// ---------------------------------------------------------------------------

/** Default per-request image count cap (dsh parity). */
export const DEFAULT_MAX_IMAGES = 9;

/** Default cumulative per-request image budget, counted in base64 bytes
 *  (dsh parity: 20 MiB). A batch whose encoded total exceeds this is
 *  rejected at admission; smaller per-request budgets offload oldest-first
 *  at request build instead (see offloadRequestImages). */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

export interface AttachmentLimits {
  readonly maxImages: number;
  readonly maxRequestImageBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxImages: DEFAULT_MAX_IMAGES,
  maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
};

/** Stable admission-failure codes (asserted by tests and surfaced by the
 *  server op) — thrown BEFORE any side effect. ω99-55: the file lane adds its
 *  own pair (separate ledger from the image budgets — one batch of each may
 *  pass independently). */
export type AttachmentErrorCode = "TOO_MANY_IMAGES" | "IMAGES_TOO_LARGE" | "TOO_MANY_FILES" | "FILES_TOO_LARGE";

export class AttachmentAdmissionError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentAdmissionError";
    this.code = code;
  }
}

/** M79 §2 — the capability/role gate's typed failure. Thrown by the provider
 *  adapter BEFORE any network call when (a) images are addressed to a model
 *  that does not declare the `image` input modality, or (b) an ImageBlock
 *  appears in system/assistant history (only user turns and tool results may
 *  carry images). R2 extends the vocabulary: (c) image-bearing input reaches
 *  a wire whose converters carry no image blocks at all (anthropic/responses
 *  in providers R2) — refused identically instead of silently dropped. */
export type UnsupportedContentReason =
  | "model-no-image-modality"
  | "image-in-unsupported-role"
  | "no-attachment-store"
  | "wire-no-images";

export class UnsupportedContentError extends Error {
  readonly code: "UNSUPPORTED_CONTENT";
  readonly reason: UnsupportedContentReason;

  constructor(reason: UnsupportedContentReason, message: string) {
    super(message);
    this.name = "UnsupportedContentError";
    this.code = "UNSUPPORTED_CONTENT";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The base64 length of `byteLength` decoded bytes (standard padded base64). */
export function base64EncodedLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/** R5-I1 — the constants behind the per-image TOKEN estimate. Vision models
 *  price an image as a FIXED embedding overhead plus a term that grows with
 *  the image's information content (the common family charges roughly
 *  w×h/750 tokens). Pixel dimensions never ride the durable ref, so the
 *  estimate models that cost from the only deterministic proxy the ref
 *  carries — `byteLength` — as the flat base plus a byte-scaled term
 *  (750 decoded bytes ≈ one scaled token; a ~1 MiB screenshot estimates
 *  ~1.5k tokens, the order the pixel formula charges a 720p frame). This is
 *  an occupancy-pressure approximation for the ctx meter and the compaction
 *  trigger, NOT a provider count; it is pure arithmetic on the ref (the
 *  bytes are never read), so estimates stay deterministic across runs. */
export const IMAGE_TOKEN_ESTIMATE = {
  /** Flat per-image cost: the fixed vision-embedding overhead. */
  base: 85,
  /** Decoded bytes per byte-scaled token (the w×h/750 family, bytes for pixels). */
  bytesPerToken: 750,
} as const;

/** R5-I1 — the per-image token estimate: base + ceil(byteLength/bytesPerToken).
 *  Pure — derives ONLY from the durable ref's byteLength. */
export function estimateImageTokens(byteLength: number): number {
  return IMAGE_TOKEN_ESTIMATE.base + Math.ceil(byteLength / IMAGE_TOKEN_ESTIMATE.bytesPerToken);
}

/** The fixed offload placeholder (dsh parity): deterministic bytes so two
 *  builds of the same input produce the same request. */
export function imageOffloadPlaceholder(ref: ImageAttachmentRef): string {
  return `[image omitted: ${ref.attachmentId}]`;
}

/** The request-build offload plan (M79 §2, dsh content.ts parity): when the
 *  cumulative base64 of `blocks` exceeds `budgetBytes`, replace images with
 *  the fixed text placeholder FROM THE OLDEST until the remainder fits. Pure
 *  and deterministic — same input, same output — and the omitted bytes are
 *  never read (the caller resolves data URLs for `kept` only).
 *
 *  Edge case: when even the newest image alone cannot fit, every image is
 *  offloaded (the request still ships, all placeholders — fail-closed on
 *  bytes, never on structure). */
export function offloadRequestImages(
  blocks: readonly ImageBlock[],
  budgetBytes: number,
): { kept: readonly ImageBlock[]; omitted: readonly ImageAttachmentRef[] } {
  if (blocks.length === 0) return { kept: [], omitted: [] };
  // Walk from the newest backwards, keeping while the running total fits;
  // everything older than the first keep-failure is omitted.
  const keptIdx: number[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b === undefined) continue;
    const size = base64EncodedLength(b.ref.byteLength);
    if (total + size > budgetBytes) break;
    total += size;
    keptIdx.push(i);
  }
  if (keptIdx.length === blocks.length) return { kept: [...blocks], omitted: [] };
  const keptSet = new Set(keptIdx);
  const kept = blocks.filter((_, i) => keptSet.has(i));
  const omitted = blocks.filter((_, i) => !keptSet.has(i)).map((b) => b.ref);
  return { kept, omitted };
}

/** Structural check of one persisted ref (session-load validation shares it). */
export function isValidImageAttachmentRef(v: unknown): v is ImageAttachmentRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.kind === "image"
    && typeof r.attachmentId === "string"
    && r.attachmentId !== ""
    && typeof r.mediaType === "string"
    && typeof r.byteLength === "number"
    && Number.isFinite(r.byteLength)
    && r.byteLength >= 0;
}

/** Structural check of one image block (or a bare ref — the wire submit
 *  envelope accepts both shapes and normalizes to blocks). */
export function isValidImageBlock(v: unknown): v is ImageBlock {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return b.kind === "image" && isValidImageAttachmentRef(b.ref);
}

// ---------------------------------------------------------------------------
// AttachmentStore port + the file-backed implementation
// ---------------------------------------------------------------------------

export interface ImageSaveInput {
  /** base64-encoded image bytes (the wire form the WS op receives). */
  readonly data: string;
  readonly mediaType: string;
}

/** The store port. Core owns the port; the file-backed implementation lives
 *  here too (workspace-relative, like every other .wudao store). Providers
 *  receive only the resolve seam at the HTTP boundary. */
export interface AttachmentStore {
  /** Admit a batch: count/mediaType/base64/size validation FIRST (typed
   *  AttachmentAdmissionError, zero files touched), then persist each image
   *  and return the refs in input order. */
  saveImages(inputs: readonly ImageSaveInput[], limits?: AttachmentLimits): Promise<ImageAttachmentRef[]>;
  /** ω99-55 — admit a generic-file batch: count/base64/size validation FIRST
   *  (typed AttachmentAdmissionError on the file codes, zero files touched),
   *  then persist content-addressed objects + one read-only hardlink alias
   *  per display name, returning the FileBlocks in input order. Equal bytes
   *  dedup to one object; there is no type whitelist (the store keeps bytes,
   *  the model reads lazily). */
  saveFiles(inputs: readonly FileSaveInput[], limits?: FileLimits): Promise<FileBlock[]>;
  /** Decoded bytes of one stored image (path-guarded by attachmentId). */
  getBytes(ref: ImageAttachmentRef): Promise<Uint8Array>;
  /** base64 of one stored image (the attachmentGet op's payload). */
  getBase64(ref: ImageAttachmentRef): Promise<string>;
  /** The TRANSIENT request form: `data:<mediaType>;base64,…`. Exists only
   *  during one request build — never persisted, never logged. */
  resolveDataUrl(ref: ImageAttachmentRef): Promise<string>;
}

/** Accepted media types (fail-closed: anything else is rejected at
 *  admission, before a file is written — EXCEPT the β2 lane below: bytes
 *  whose ftyp box sniffs as HEIC/HEIF/AVIF are DECODED to JPEG first and
 *  admitted by the decoded format, see attachments-heif.ts). */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** attachmentId shape the store reads accept (uuid v4 from randomUUID; the
 *  strict shape IS the path-traversal guard's first line — a `../x` id never
 *  matches). */
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where the store's files live inside a workspace. */
export function attachmentDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "attachments");
}

/** Injection seams for the file-backed store (β2 adds the first: tests
 *  inject a fake decoder so no real sips ever runs). */
export interface AttachmentStoreDeps {
  /** β2 — the BMFF (HEIC/HEIF/AVIF) admission decoder. Default: the macOS
   *  system sips decoder (typed fail-closed error off darwin / on sips
   *  failure — see attachments-heif.ts). */
  readonly decodeBmff?: BmffDecoder;
}

/** File-backed AttachmentStore: one file per image under
 *  `<workspaceRoot>/.wudao/attachments/<uuid>.<ext>`. Reads re-validate the
 *  id shape AND re-resolve through the workspace path guard, so a doctored
 *  ref can neither escape the workspace nor read a non-image file. */
export function createFileAttachmentStore(workspaceRoot: string, deps: AttachmentStoreDeps = {}): AttachmentStore {
  const dir = attachmentDir(workspaceRoot);
  const decodeBmff = deps.decodeBmff ?? createSipsDecoder();
  let dirEnsured = false;

  /** Resolve one ref to its guarded absolute path (throws on any escape). */
  const guardedPath = async (ref: ImageAttachmentRef): Promise<string> => {
    if (!ATTACHMENT_ID_RE.test(ref.attachmentId)) {
      throw new Error(`invalid attachment id: ${ref.attachmentId}`);
    }
    const ext = IMAGE_MEDIA_TYPES[ref.mediaType];
    if (ext === undefined) throw new Error(`unsupported media type: ${ref.mediaType}`);
    const rel = join(".wudao", "attachments", `${ref.attachmentId}${ext}`);
    const res = await resolveWorkspacePath(workspaceRoot, rel);
    if (!res.ok) throw new Error(res.error);
    return res.absPath;
  };

  return {
    async saveImages(inputs, limits = DEFAULT_ATTACHMENT_LIMITS) {
      // Admission — every check runs BEFORE the first write (fail-closed).
      if (inputs.length > limits.maxImages) {
        throw new AttachmentAdmissionError(
          "TOO_MANY_IMAGES",
          `${inputs.length} images exceed the per-request cap of ${limits.maxImages}`,
        );
      }
      const decoded: { bytes: Uint8Array; mediaType: string }[] = [];
      let totalB64 = 0;
      for (const input of inputs) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0) {
          throw new Error("image data is not well-formed base64");
        }
        let bytes: Uint8Array = Buffer.from(input.data, "base64");
        if (bytes.length === 0) throw new Error("image data is empty (zero-length base64)");
        let mediaType = input.mediaType;
        // 借鉴弧 β2 — sniff-authoritative HEIC/HEIF/AVIF admission (hermes
        // 0a545f7fa5): the ftyp box is read from the BYTES (the claimed
        // mediaType is never trusted), and a decodable family converts to
        // JPEG via the injected decoder — the batch then admits by the
        // DECODED format (image/jpeg; budget/ext/ref all follow the decoded
        // bytes). Decode failure is the typed HeifDecodeError: the whole
        // batch fails closed BEFORE the first workspace write, with the
        // honest reason (decode artifacts only ever lived under
        // mkdtemp(os.tmpdir()), never a user directory).
        const bmffKind = sniffBmffImageKind(bytes);
        if (bmffKind !== null) {
          bytes = await decodeBmff(bytes, bmffKind);
          mediaType = "image/jpeg";
        } else if (IMAGE_MEDIA_TYPES[mediaType] === undefined) {
          throw new Error(`unsupported image media type: ${mediaType} (expected one of: ${Object.keys(IMAGE_MEDIA_TYPES).join(", ")})`);
        }
        totalB64 += base64EncodedLength(bytes.length);
        decoded.push({ bytes, mediaType });
      }
      if (totalB64 > limits.maxRequestImageBytes) {
        throw new AttachmentAdmissionError(
          "IMAGES_TOO_LARGE",
          `images total ${totalB64} base64 bytes, over the ${limits.maxRequestImageBytes}-byte request budget`,
        );
      }
      // Persist (admission already passed — every image of the batch lands).
      if (!dirEnsured) {
        await mkdir(dir, { recursive: true });
        dirEnsured = true;
      }
      const refs: ImageAttachmentRef[] = [];
      for (const item of decoded) {
        const attachmentId = randomUUID();
        const ext = IMAGE_MEDIA_TYPES[item.mediaType] ?? "";
        await writeFile(join(dir, `${attachmentId}${ext}`), item.bytes);
        refs.push({ kind: "image", attachmentId, mediaType: item.mediaType, byteLength: item.bytes.length });
      }
      return refs;
    },

    async getBytes(ref) {
      const abs = await guardedPath(ref);
      return new Uint8Array(await readFile(abs));
    },

    async getBase64(ref) {
      const abs = await guardedPath(ref);
      return readFile(abs, { encoding: "base64" });
    },

    async resolveDataUrl(ref) {
      const b64 = await this.getBase64(ref);
      return `data:${ref.mediaType};base64,${b64}`;
    },

    async saveFiles(inputs, limits = DEFAULT_FILE_LIMITS) {
      // Admission — every check runs BEFORE the first write (fail-closed).
      if (inputs.length > limits.maxFiles) {
        throw new AttachmentAdmissionError(
          "TOO_MANY_FILES",
          `${inputs.length} files exceed the per-request cap of ${limits.maxFiles}`,
        );
      }
      const decoded: { bytes: Buffer; name: string }[] = [];
      let totalB64 = 0;
      for (const input of inputs) {
        if (typeof input.name !== "string" || input.name === "") {
          throw new Error("file name must be a non-empty string");
        }
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0) {
          throw new Error("file data is not well-formed base64");
        }
        const bytes = Buffer.from(input.data, "base64");
        if (bytes.length === 0) throw new Error("file data is empty (zero-length base64)");
        totalB64 += base64EncodedLength(bytes.length);
        decoded.push({ bytes, name: fileLeafName(input.name) });
      }
      if (totalB64 > limits.maxRequestFileBytes) {
        throw new AttachmentAdmissionError(
          "FILES_TOO_LARGE",
          `files total ${totalB64} base64 bytes, over the ${limits.maxRequestFileBytes}-byte request budget`,
        );
      }
      // Persist: one immutable object per digest (dedup on EEXIST-safe
      // rename-skip) + one read-only hardlink alias per display name. Both
      // paths re-resolve through the workspace guard (same audit posture as
      // the image reads).
      const blocks: FileBlock[] = [];
      for (const item of decoded) {
        const digest = createHash("sha256").update(item.bytes).digest("hex");
        const block: FileBlock = { kind: "file", name: item.name, bytes: item.bytes.length, attachmentId: `sha256:${digest}` };
        const objRes = await resolveWorkspacePath(workspaceRoot, fileObjectRelPath(digest));
        if (!objRes.ok) throw new Error(objRes.error);
        await mkdir(dirname(objRes.absPath), { recursive: true });
        let exists = true;
        try {
          await stat(objRes.absPath);
        } catch {
          exists = false;
        }
        if (!exists) {
          // Staged write + atomic rename: a torn write can never publish a
          // half-written object under the digest name.
          const tmp = `${objRes.absPath}.tmp-${randomUUID()}`;
          await writeFile(tmp, item.bytes);
          await rename(tmp, objRes.absPath);
        }
        const visRes = await resolveWorkspacePath(workspaceRoot, fileVisibleRelPath(block));
        if (!visRes.ok) throw new Error(visRes.error);
        await mkdir(dirname(visRes.absPath), { recursive: true });
        try {
          await link(objRes.absPath, visRes.absPath);
        } catch (err) {
          // The alias already exists (same digest+name re-uploaded): the
          // digest names the content, so EEXIST is the dedup hit, not a race
          // to resolve (this store is the only writer under .wudao).
          if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST")) throw err;
        }
        await chmod(visRes.absPath, 0o400);
        blocks.push(block);
      }
      return blocks;
    },
  };
}

// ---------------------------------------------------------------------------
// ω99-55 — the FILE attachment domain: content-addressed storage + the
// model-visible hardlink + the request-build text projection.
//
// One attachment domain, two lanes (dsh 2026-08-26-generic-file-upload):
// images ride the normalized pipeline above; ANY other file kind enters here
// as exact bytes, stored verbatim under a content-addressed digest —
//
//   object   .wudao/attachments/file-objects/<dd>/<sha256>      (the bytes)
//   visible  .wudao/attachments/files/<dd>/<sha256>/<name>      (hardlink)
//
// Equal bytes have ONE object (natural dedup); every display name is its own
// read-only hardlink alias, so the model reads a path that ENDS in the real
// filename. No provider ever receives file bytes: request assembly projects
// each FileBlock to deterministic handle TEXT naming the visible path
// (offloadRequestFiles — the file lane's offloadRequestImages), and the model
// reads it lazily with the ordinary file tools (their existing result
// budgets govern). Placing uploads under the workspace's `.wudao` root keeps
// the user's tree and git status clean (the dsh DSH_HOME rule, adapted to
// wudao's workspace-rooted store).
// ---------------------------------------------------------------------------

/** A generic uploaded file riding a user turn. FLAT like dsh's block (no
 *  ref wrapper): `attachmentId` is the content digest `sha256:<64 hex>`,
 *  `name` the sanitized display name, `bytes` the exact stored byte count.
 *  Only user turns carry files (no builtin tool emits them; the subagent
 *  lane refuses them — children receive the saved PATH in prompt text). */
export interface FileBlock {
  readonly kind: "file";
  readonly name: string;
  readonly bytes: number;
  readonly attachmentId: string;
}

/** The wire form one uploaded file crosses attachmentSave's file lane in
 *  (base64, like the image lane — the only place file bytes ever cross). */
export interface FileSaveInput {
  readonly data: string;
  readonly name: string;
}

/** Default per-request file count cap (mirrors the image lane's shape). */
export const DEFAULT_MAX_FILES = 9;

/** Default cumulative per-request file budget, counted in base64 bytes
 *  (what crosses the upload) — 50MiB encoded ≈ 37.5MiB raw. Files never ride
 *  a model request, so this bounds the upload crossing and disk, not the
 *  prompt; lazy reads stay governed by the read tools' own result budgets. */
export const DEFAULT_MAX_REQUEST_FILE_BYTES = 50 * 1024 * 1024;

/** The file lane's admission limits — same shape as AttachmentLimits, a
 *  SEPARATE ledger (an image batch and a file batch each get their full
 *  budget). */
export interface FileLimits {
  readonly maxFiles: number;
  readonly maxRequestFileBytes: number;
}

export const DEFAULT_FILE_LIMITS: FileLimits = {
  maxFiles: DEFAULT_MAX_FILES,
  maxRequestFileBytes: DEFAULT_MAX_REQUEST_FILE_BYTES,
};

/** attachmentId shape the file store accepts (`sha256:` + 64 lowercase hex;
 *  the strict shape IS the path guard — a traversal-shaped id never matches
 *  and the digest chars can never escape the store's subdirectories). */
const FILE_ATTACHMENT_ID_RE = /^sha256:([a-f0-9]{64})$/;

const FILE_DIGEST_RE = /^[a-f0-9]{64}$/;

/** Sanitize one caller display name into a safe stored leaf name: strip both
 *  separator styles by hand (a POSIX host treats `\` as an ordinary
 *  character, so path.basename would keep a Windows client's full path and
 *  leak it into the reference and the session log), drop control chars,
 *  replace Windows-refused characters, trim trailing dots/spaces, refuse
 *  Windows device names, cap at 255 UTF-8 bytes (dsh fileLeafName parity). */
export function fileLeafName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/u, "");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(clean.replace(/[. ]+$/u, ""))) clean = `_${clean}`;
  // 255-byte cap, applied on UTF-8 code points (never splits a multibyte char).
  let bytes = 0;
  let capped = "";
  for (const ch of clean) {
    bytes += Buffer.byteLength(ch);
    if (bytes > 255) break;
    capped += ch;
  }
  clean = capped.replace(/[. ]+$/u, "");
  return clean === "" || clean === "." || clean === ".." ? "file" : clean;
}

/** The workspace-relative object path for one digest (canonical, shared by
 *  every display name of the same bytes). */
export function fileObjectRelPath(digest: string): string {
  if (!FILE_DIGEST_RE.test(digest)) throw new Error(`invalid file digest: ${digest}`);
  return join(".wudao", "attachments", "file-objects", digest.slice(0, 2), digest);
}

/** The workspace-relative MODEL-VISIBLE path for one file block — a read-only
 *  hardlink whose leaf IS the sanitized display name. Pure derivation from
 *  the block (no fs); this is the path the handle text names and read_file
 *  resolves inside the ordinary workspace boundary. */
export function fileVisibleRelPath(block: FileBlock): string {
  const digest = FILE_ATTACHMENT_ID_RE.exec(block.attachmentId)?.[1];
  if (digest === undefined) throw new Error(`invalid file attachment id: ${block.attachmentId}`);
  if (block.name !== fileLeafName(block.name)) throw new Error(`invalid file attachment name: ${block.name}`);
  return join(".wudao", "attachments", "files", digest.slice(0, 2), digest, block.name);
}

/** Structural check of one file block (session-load validation + the submit
 *  envelope's admission share it). */
export function isValidFileBlock(v: unknown): v is FileBlock {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return b.kind === "file"
    && typeof b.name === "string"
    && b.name !== ""
    && typeof b.bytes === "number"
    && Number.isFinite(b.bytes)
    && b.bytes >= 0
    && typeof b.attachmentId === "string"
    && FILE_ATTACHMENT_ID_RE.test(b.attachmentId);
}

/** One file's deterministic handle text — the ONLY model-visible form a file
 *  ever takes (dsh fileHandleText parity, workspace-relative). Names the
 *  file, its size, its digest prefix, and the saved read-only path; teaches
 *  lazy reads (existing file tools), copy-before-edit, and path-based
 *  delegation (subagents read the PATH — they never receive blocks). */
export function fileHandleText(block: FileBlock): string {
  const digest = block.attachmentId.slice("sha256:".length);
  const path = fileVisibleRelPath(block);
  return `[attached file "${block.name}" (${block.bytes} bytes, sha256:${digest.slice(0, 12)}): read-only copy saved at ${path} — read it with your file tools when its contents are needed, copy to a writable location before modifying it; when delegating file work, include ${path} in the task prompt]`;
}

/** The request-build file projection (the file lane's offloadRequestImages
 *  — dsh projectFilesToText): every file-bearing user turn's content gains
 *  one handle line per file, and the `files` field drops before ANY wire
 *  converter sees it. Pure and deterministic; returns the SAME array
 *  reference when nothing rides files (text/image requests are untouched,
 *  byte for byte). An empty-caption file-only turn becomes handle-only text
 *  (no empty part is emitted). */
export function offloadRequestFiles(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  if (!messages.some((m) => m.role === "user" && Array.isArray((m as { files?: unknown }).files) && ((m as { files: readonly FileBlock[] }).files as readonly FileBlock[]).length > 0)) {
    return messages;
  }
  return messages.map((m) => {
    if (m.role !== "user") return m;
    const files = (m as { files?: readonly FileBlock[] }).files;
    if (!Array.isArray(files) || files.length === 0) return m;
    const handles = files.map((f) => fileHandleText(f)).join("\n");
    const out: AgentMessage = { ...m, content: m.content === "" ? handles : `${m.content}\n\n${handles}` };
    delete (out as { files?: readonly FileBlock[] }).files;
    return out;
  });
}
