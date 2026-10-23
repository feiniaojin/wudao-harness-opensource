// ω99-49 — bounded streaming shell output: the sliding-window capture, the
// byte-budgeted adaptive publisher, and the streaming-face sanitizer.
//
// The streaming face is ADDITIVE to shell's terminal buffers: the
// terminal ToolResult keeps its byte-identical legacy path (capBuffer +
// finish()), while every chunk ALSO feeds this window so a live consumer can
// render long-running command output as it arrives. Three bounds:
//   memory  — the retained window never exceeds maxBytes*2 (trimmed to
//             maxBytes at UTF-8 code-point boundaries; a torn multibyte char
//             or surrogate pair can never survive a trim);
//   rate    — emissions obey the pi formula
//             nextEmitAt = now + max(minIntervalMs, bytes*1000/targetBps),
//             and append deltas are additionally SPLIT into at most one
//             min-interval budget share (C = targetBps*minIntervalMs/1000
//             bytes) per emission, so any 1s window delivers at most the
//             budget plus one share; rate-held tail bytes are re-sent in the
//             next window and the terminal flush (finish()) is forced, so
//             nothing inside the window is ever lost;
//   purity  — sanitizeShellOutput strips ANSI/OSC escapes, bare CR, stray
//             C0/DEL and interleave controls from DELTAS ONLY; the retained
//             raw window (the terminal face's source) is never rewritten.
import type { OutputDelta } from "../tool.js";

/** Live-view window budget (pi C3's default): the sliding retention target. */
export const STREAM_WINDOW_MAX_BYTES = 50 * 1024;
/** Rate floor: never more than one emission per this many ms. */
export const OUTPUT_MIN_EMIT_INTERVAL_MS = 100;
/** Byte budget: sustained delivery rate ceiling. */
export const OUTPUT_TARGET_BYTES_PER_SECOND = 100 * 1024;

// ---------------------------------------------------------------------------
// UTF-8 byte accounting (no-allocation code-point walks).
// ---------------------------------------------------------------------------

/** Byte length of a well-formed JS string under UTF-8 (Buffer.byteLength's
 *  answer without the allocation — called on every push). */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    n += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

/** Keep the LAST maxBytes bytes of text, cutting only at code-point
 *  boundaries (a trailing incomplete multibyte run is never left torn).
 *  Reports exactly how many bytes were dropped from the head. */
function trimHeadToBytes(text: string, maxBytes: number): { text: string; droppedBytes: number } {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text, droppedBytes: 0 };
  let kept = 0;
  let i = text.length;
  while (i > 0) {
    let start = i - 1;
    const cc = text.charCodeAt(start);
    if (start > 0 && cc >= 0xdc00 && cc <= 0xdfff) {
      const prev = text.charCodeAt(start - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) start -= 1; // low surrogate: step to the pair's head
    }
    const cp = text.codePointAt(start)!;
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (kept + size > maxBytes) break;
    kept += size;
    i = start;
  }
  return { text: text.slice(i), droppedBytes: total - kept };
}

/** Cut a prefix of at most maxBytes bytes at a code-point boundary. */
function takeHeadBytes(text: string, maxBytes: number): string {
  let kept = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (kept + size > maxBytes) break;
    kept += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.slice(0, i);
}

// ---------------------------------------------------------------------------
// sanitizeShellOutput — the streaming face only.
// ---------------------------------------------------------------------------

/** Strip what a terminal LIVE VIEW must never render: ANSI CSI/OSC escape
 *  sequences (including an incomplete trailing one — an escape split across
 *  chunks cannot leak through), bare CR, stray C0 controls and DEL (tab and
 *  newline stay), and the Unicode interleave controls. Pure; applied at
 *  delta-computation time over the full retained window, never to the raw
 *  buffer itself. */
export function sanitizeShellOutput(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next === 0x5b) {
        // CSI: ESC [ params(0x20-0x3f)* final(0x40-0x7e)
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++;
        i = j < text.length ? j + 1 : text.length; // unterminated → drop to end
      } else if (next === 0x5d) {
        // OSC: ESC ] ... (BEL | ESC \)
        let j = i + 2;
        while (j < text.length) {
          const c = text.charCodeAt(j);
          if (c === 0x07) { j += 1; break; }
          if (c === 0x1b && text.charCodeAt(j + 1) === 0x5c) { j += 2; break; }
          j++;
        }
        i = j;
      } else if (next >= 0x40 && next <= 0x5f) {
        i += 2; // two-character escape
      } else {
        i += 1; // lone/trailing ESC
      }
      continue;
    }
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const isControl = (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || cp === 0x7f || (cp >= 0xfff9 && cp <= 0xfffb);
    if (!isControl) out += text.slice(i, i + len);
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AdaptivePublisher — pi C3's formula with wudao's windowed-split extension.
// ---------------------------------------------------------------------------

export interface AdaptivePublisherOptions {
  /** The NEXT emission to publish (already split to the budget share), or
   *  undefined when nothing changed. Must be stateless/recomputable. */
  compute(): { delta: OutputDelta; more: boolean } | undefined;
  /** Deliver one delta. Its failure is isolated (observer, never a hook). */
  publish(delta: OutputDelta): void;
  /** Test seam — the package's `deps.now ?? Date.now` injection shape. */
  now?(): number;
  /** Test seam — single trailing timer; returns the canceller. */
  schedule?(cb: () => void, ms: number): () => void;
  minIntervalMs?: number;
  targetBytesPerSecond?: number;
}

/** Byte-budgeted emission pump. The first dirty state after idle publishes
 *  immediately; every emission then buys `max(minIntervalMs, bytes*1000/
 *  targetBps)` of silence. Because compute() splits append deltas into at
 *  most one min-interval budget share per emission, a saturated stream paces
 *  at exactly targetBps with minIntervalMs cadence. flush(true) is the
 *  terminal settle: forced, rate-bypassing, timer-clearing. */
export class AdaptivePublisher {
  readonly #compute: AdaptivePublisherOptions["compute"];
  readonly #publish: AdaptivePublisherOptions["publish"];
  readonly #now: () => number;
  readonly #schedule: (cb: () => void, ms: number) => () => void;
  readonly #minIntervalMs: number;
  readonly #targetBps: number;
  #nextEmitAt = 0;
  #cancel: (() => void) | undefined;
  #disposed = false;

  constructor(options: AdaptivePublisherOptions) {
    this.#compute = options.compute;
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); });
    this.#minIntervalMs = options.minIntervalMs ?? OUTPUT_MIN_EMIT_INTERVAL_MS;
    this.#targetBps = options.targetBytesPerSecond ?? OUTPUT_TARGET_BYTES_PER_SECOND;
    if (!Number.isFinite(this.#minIntervalMs) || this.#minIntervalMs <= 0) throw new TypeError("minIntervalMs must be positive");
    if (!Number.isFinite(this.#targetBps) || this.#targetBps <= 0) throw new TypeError("targetBytesPerSecond must be positive");
  }

  markDirty(): void {
    if (this.#disposed) return;
    if (this.#now() >= this.#nextEmitAt) this.flush();
    else this.#arm(this.#nextEmitAt - this.#now());
  }

  flush(force = false): void {
    if (this.#disposed) return;
    const now = this.#now();
    if (!force && now < this.#nextEmitAt) {
      this.#arm(this.#nextEmitAt - now);
      return;
    }
    if (this.#cancel !== undefined) { this.#cancel(); this.#cancel = undefined; }
    const next = this.#compute();
    if (next === undefined) return;
    const bytes = utf8ByteLength(next.delta.text);
    this.#nextEmitAt = now + Math.max(this.#minIntervalMs, (bytes * 1000) / this.#targetBps);
    // Commit pacing before delivery: a consumer that throws or re-enters must
    // never re-buy the delta it already saw (pi's commit-before-deliver).
    if (next.more) this.#arm(this.#nextEmitAt - now);
    try {
      this.#publish(next.delta);
    } catch { /* observer failure is isolated, never a hook */ }
  }

  dispose(): void {
    if (this.#cancel !== undefined) { this.#cancel(); this.#cancel = undefined; }
    this.#disposed = true;
  }

  #arm(wait: number): void {
    if (this.#cancel !== undefined) return; // single trailing timer
    this.#cancel = this.#schedule(() => {
      this.#cancel = undefined;
      this.flush();
    }, wait);
  }
}

// ---------------------------------------------------------------------------
// OutputCapture — the bounded sliding window plus its publisher.
// ---------------------------------------------------------------------------

export interface OutputCaptureOptions {
  /** Retention target; the retained window never exceeds 2× this. */
  readonly maxBytes?: number;
  /** The streaming consumer. Absent → a pure window (no publishing). */
  readonly onUpdate?: (delta: OutputDelta) => void;
  readonly now?: () => number;
  readonly schedule?: (cb: () => void, ms: number) => () => void;
  readonly minIntervalMs?: number;
  readonly targetBytesPerSecond?: number;
}

/** One logical live view over a command's interleaved stdout+stderr. Push
 *  chunks as they arrive (Buffers preferred — a streaming decoder keeps
 *  multibyte chars intact across chunk boundaries); the consumer receives
 *  sanitized append/snapshot deltas; finish() is the terminal forced flush.
 *  The raw retained window is never rewritten — sanitization happens only on
 *  the delta path, and droppedHeadBytes counts RAW head bytes actually
 *  trimmed (accepted = retained + dropped, always). */
export class OutputCapture {
  readonly #maxBytes: number;
  readonly #shareBytes: number;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #bufferBytes = 0;
  #accepted = 0;
  #dropped = 0;
  #view = ""; // last published (sanitized) view — advances on publish only
  #finished = false;
  readonly #publisher: AdaptivePublisher;
  readonly #onUpdate: OutputCaptureOptions["onUpdate"];

  constructor(options: OutputCaptureOptions = {}) {
    this.#maxBytes = options.maxBytes ?? STREAM_WINDOW_MAX_BYTES;
    if (!Number.isFinite(this.#maxBytes) || this.#maxBytes <= 0) throw new TypeError("maxBytes must be positive");
    this.#onUpdate = options.onUpdate;
    const minIntervalMs = options.minIntervalMs ?? OUTPUT_MIN_EMIT_INTERVAL_MS;
    const targetBps = options.targetBytesPerSecond ?? OUTPUT_TARGET_BYTES_PER_SECOND;
    this.#shareBytes = Math.max(1, Math.floor((targetBps * minIntervalMs) / 1000));
    this.#publisher = new AdaptivePublisher({
      compute: () => this.#diff(),
      publish: (delta) => this.#commit(delta),
      now: options.now,
      schedule: options.schedule,
      minIntervalMs,
      targetBytesPerSecond: targetBps,
    });
  }

  /** A stdout/stderr chunk. Buffer/Uint8Array input goes through a streaming
   *  decoder (multibyte chars split across chunks reassemble); a string is
   *  appended verbatim (any decoder carry is flushed ahead of it). */
  push(chunk: string | Uint8Array): void {
    if (this.#finished) return;
    if (typeof chunk === "string") {
      this.#appendText(this.#decoder.decode());
      this.#appendText(chunk);
      return;
    }
    this.#appendText(this.#decoder.decode(chunk, { stream: true }));
  }

  /** Terminal settle: flush the decoder, then FORCE the publisher so every
   *  still-pending byte inside the window is delivered (rate-bypassing). */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#appendText(this.#decoder.decode());
    this.#publisher.flush(true);
    this.#publisher.dispose();
  }

  /** Retained raw bytes (the §2.1 internal-accounting assertion surface). */
  retainedBytes(): number { return this.#bufferBytes; }
  /** Raw bytes accepted since creation. */
  acceptedBytes(): number { return this.#accepted; }
  /** Cumulative raw HEAD bytes trimmed by the window so far. */
  droppedHeadBytes(): number { return this.#dropped; }
  /** The raw retained window (terminal face's source — never sanitized). */
  retainedRaw(): string { return this.#buffer; }
  /** The consumer's current published view (sanitized). */
  view(): string { return this.#view; }

  #appendText(text: string): void {
    if (text === "") return;
    this.#accepted += utf8ByteLength(text);
    this.#buffer += text;
    this.#bufferBytes += utf8ByteLength(text);
    // Memory guard: past 2× the target the head is trimmed back down to the
    // target at a code-point boundary (UTF-8-safe; counts raw dropped bytes).
    if (this.#bufferBytes > this.#maxBytes * 2) {
      const trimmed = trimHeadToBytes(this.#buffer, this.#maxBytes);
      this.#dropped += trimmed.droppedBytes;
      this.#buffer = trimmed.text;
      this.#bufferBytes -= trimmed.droppedBytes;
    }
    this.#publisher.markDirty();
  }

  /** Statelessly compute the next emission: append-diffs are split into at
   *  most one budget share (the tail re-arms through the trailing timer);
   *  a window slide (or any sanitize non-monotonicity) emits an atomic
   *  snapshot carrying the cumulative dropped-byte count. */
  #diff(): { delta: OutputDelta; more: boolean } | undefined {
    const current = sanitizeShellOutput(this.#buffer);
    if (current === this.#view) return undefined;
    if (current.length > this.#view.length && current.slice(0, this.#view.length) === this.#view) {
      const suffix = current.slice(this.#view.length);
      const part = takeHeadBytes(suffix, this.#shareBytes);
      return { delta: { kind: "append", text: part }, more: part.length < suffix.length };
    }
    return { delta: { kind: "snapshot", text: current, droppedHeadBytes: this.#dropped }, more: false };
  }

  /** Commit-before-delivery: the view advances from the delta itself, BEFORE
   *  the consumer runs (a throwing/re-entering consumer never re-buys a
   *  delta it already saw). */
  #commit(delta: OutputDelta): void {
    this.#view = delta.kind === "append" ? this.#view + delta.text : delta.text;
    this.#onUpdate?.(delta);
  }
}
