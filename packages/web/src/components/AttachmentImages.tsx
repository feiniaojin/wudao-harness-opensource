// M79b §3 — history-image rendering. HistoryItem's user bubble gains an
// image rail: every `ImageBlockWire` the entry carries resolves through the
// generation-counter cache (src/attachments.ts) into a blob URL. The client +
// session id arrive through a context so the deep, memoized HistoryItem tree
// never threads them as props — context changes pierce memo exactly when the
// session id moves, which is the one input the generation guard cares about.
import { createContext, useContext, useEffect, useState } from "react";
import type { ImageBlockWire, FileBlockWire, WudaoClient } from "../protocol.js";
import { attachmentImages } from "../attachments.js";
import { Icon } from "./Icon.js";

/** The resolve surface a thumb needs (the client's attachmentGet seam — a
 *  structural pick so tests double it without a socket). */
export interface AttachmentSourceValue {
  readonly client: Pick<WudaoClient, "attachmentGet">;
  readonly sessionId: string;
}

/** Null when no provider mounts (HistoryItem rendered standalone) — the rail
 *  degrades to quiet placeholders instead of fetching. */
export const AttachmentSource = createContext<AttachmentSourceValue | null>(null);

export type ThumbState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly url: string }
  | { readonly phase: "error"; readonly message: string };

/** Resolve one block's ref to a stable blob URL (the cache dedupes; a session
 *  switch mid-load drops the stale result and re-resolves on the new
 *  generation). */
export function useAttachmentThumb(
  block: ImageBlockWire,
  source: AttachmentSourceValue | null,
): ThumbState {
  const [state, setState] = useState<ThumbState>({ phase: "loading" });

  useEffect(() => {
    if (source === null) return; // no source: keep the placeholder
    let cancelled = false;
    const gen = attachmentImages.ensureSession(source.sessionId);
    const cached = attachmentImages.peek(block.ref.attachmentId);
    if (cached !== undefined) {
      setState({ phase: "ready", url: cached });
      return;
    }
    setState({ phase: "loading" });
    void attachmentImages
      .resolve(gen, block.ref, (ref) => source.client.attachmentGet(ref))
      .then((url) => {
        if (cancelled) return;
        if (url === null) return; // generation moved: the next effect owns it
        setState({ phase: "ready", url });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // block.ref identity is stable per entry; the fields are the real deps.
  }, [source, block.ref.attachmentId, block.ref.mediaType, block.ref.byteLength]);

  return state;
}

function AttachmentThumb({ block, index }: { readonly block: ImageBlockWire; readonly index: number }): React.JSX.Element {
  const source = useContext(AttachmentSource);
  const thumb = useAttachmentThumb(block, source);
  if (thumb.phase === "ready") {
    // m79b-review NIT: the ref's uuid means nothing to a screen reader — label
    // by the message's image ordinal instead.
    return <img className="img-bub" src={thumb.url} alt={`图片 ${index + 1}`} loading="lazy" />;
  }
  if (thumb.phase === "error") {
    return (
      <span className="img-bub err" title={thumb.message} role="img" aria-label="图片加载失败">
        {/* 116 弧 C：🖼? 位图泡 → image 细线字形 + ?（danger 色随 .img-bub.err）。 */}
        <Icon name="image" size={16} />?
      </span>
    );
  }
  // Loading (or no provider mounted): the quiet placeholder keeps the bubble's
  // shape stable while the bytes land.
  return <span className="img-bub pending" aria-hidden={true} />;
}

/** The user bubble's image rail (the message slot — research 40 §2). */
export function AttachmentImages({ images }: { readonly images: readonly ImageBlockWire[] }): React.JSX.Element {
  if (images.length === 0) return <></>;
  return (
    <div className="img-rail">
      {images.map((b, i) => (
        <AttachmentThumb key={`${b.ref.attachmentId}#${i}`} block={b} index={i} />
      ))}
    </div>
  );
}

/** ω99-55 — the user bubble's file chips: one per FileBlockWire, name +
 *  human size, no fetching (the block IS the display data — bytes live in
 *  the content-addressed store, the model read them lazily at the time). */
export function AttachmentFiles({ files }: { readonly files: readonly FileBlockWire[] }): React.JSX.Element {
  if (files.length === 0) return <></>;
  return (
    <div className="hist-file-rail">
      {files.map((b, i) => (
        <span key={`${b.attachmentId}#${i}`} className="hist-file-chip" title={`${b.name} · ${b.attachmentId.slice(0, 19)}…`}>
          <span aria-hidden={true}><Icon name="file-text" size={12} /></span>
          <span className="name">{b.name}</span>
          <span className="size">{histSize(b.bytes)}</span>
        </span>
      ))}
    </div>
  );
}

/** One history chip's human byte size (B → KB → MB, 1 fraction digit). */
function histSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
