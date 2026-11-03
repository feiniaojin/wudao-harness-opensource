// M79 §4 — the CLI-side attachment ops behind the WS protocol's
// attachmentSave / attachmentGet. Thin wrappers over core's file-backed
// AttachmentStore (`.wudao/attachments/`): admission (count/media/base64/
// size, fail-closed BEFORE any write) and the typed errors live entirely in
// the store — this module adds no second policy. Same workspace-root
// discipline as the session store.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createFileAttachmentStore } from "@wudao-org/core";
import type { ImageAttachmentRef, ImageSaveInput, AttachmentLimits, FileBlock, FileSaveInput, FileLimits } from "@wudao-org/core";

export interface AttachmentOpsDeps {
  readonly workspaceRoot: string;
  /** Admission limits override (defaults: maxImages 9, 20MiB request budget). */
  readonly limits?: AttachmentLimits;
  /** ω99-55: the file lane's limits override (separate ledger; defaults
   *  maxFiles 9, 50MiB base64 request budget). */
  readonly fileLimits?: FileLimits;
}

export interface AttachmentOps {
  /** base64 batch → durable refs (input order). Throws the store's typed
   *  AttachmentAdmissionError (TOO_MANY_IMAGES / IMAGES_TOO_LARGE) or a
   *  validation Error — always before any file is written. */
  attachmentSave(inputs: readonly ImageSaveInput[]): Promise<ImageAttachmentRef[]>;
  /** One stored image back as base64 (for rendering). Unknown id / doctored
   *  ref / traversal-shaped id → the store's error. */
  attachmentGet(ref: ImageAttachmentRef): Promise<{ data: string; mediaType: string }>;
  /** ω99-55: base64 generic-file batch → content-addressed FileBlocks (input
   *  order). Typed admission (TOO_MANY_FILES / FILES_TOO_LARGE) fires before
   *  any object or hardlink is written. */
  fileSave(inputs: readonly FileSaveInput[]): Promise<FileBlock[]>;
}

export function createAttachmentOps(deps: AttachmentOpsDeps): AttachmentOps {
  const store = createFileAttachmentStore(deps.workspaceRoot);
  return {
    attachmentSave: (inputs) => store.saveImages(inputs, deps.limits),
    async attachmentGet(ref) {
      const data = await store.getBase64(ref);
      return { data, mediaType: ref.mediaType };
    },
    fileSave: (inputs) => store.saveFiles(inputs, deps.fileLimits),
  };
}

// M79 §5 — the one-shot `--image <path>` path: read image files from disk,
// admit them through the SAME store (so the WS op and the CLI flag share one
// admission policy and one on-disk layout), and return the ImageBlocks that
// ride the user turn. Pure errors (missing file, unknown type) throw BEFORE
// the batch is admitted.
const EXT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** One image file on disk → a save input (base64 + mediaType from the
 *  extension; fail-closed on unknown extensions and read errors). */
export async function imageFileToSaveInput(absPath: string): Promise<ImageSaveInput> {
  const mediaType = EXT_MEDIA_TYPES[extname(absPath).toLowerCase()];
  if (mediaType === undefined) {
    throw new Error(`unsupported image extension "${extname(absPath)}" (expected .png .jpg .jpeg .webp .gif): ${absPath}`);
  }
  let data: string;
  try {
    data = await readFile(absPath, { encoding: "base64" });
  } catch (err) {
    throw new Error(`cannot read image file: ${absPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (data === "") throw new Error(`image file is empty: ${absPath}`);
  return { data, mediaType };
}

/** The `--image` flag's whole pipeline: files → one admitted batch → blocks. */
export async function loadImageFiles(
  store: { saveImages(inputs: readonly ImageSaveInput[], limits?: AttachmentLimits): Promise<ImageAttachmentRef[]> },
  paths: readonly string[],
  limits?: AttachmentLimits,
): Promise<{ kind: "image"; ref: ImageAttachmentRef }[]> {
  if (paths.length === 0) return [];
  const inputs = await Promise.all(paths.map((p) => imageFileToSaveInput(p)));
  const refs = await store.saveImages(inputs, limits);
  return refs.map((ref) => ({ kind: "image" as const, ref }));
}
