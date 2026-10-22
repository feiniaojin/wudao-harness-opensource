/**
 * 波次 8 #42 (the upstream #24 `bounded_response.py`): bounded error-body read.
 *
 * The three protocol factories read a non-OK response's body for diagnostics.
 * A bare `await res.text()` is unbounded on BOTH axes:
 *   · bytes — a server that answers 500 with a multi-GB body buffers all of
 *     it into memory for a diagnostic string nobody reads past a few hundred
 *     chars;
 *   · wall clock — a server that opens the error body then STOPS sending
 *     parks the read in C/socket land; no outer timer cancels it and the
 *     request hangs well past every retry deadline.
 *
 * `readErrorBody` reads the (already-decompressed) body stream with a byte
 * cap and a wall-clock deadline; whichever trips first, the reader is
 * CANCELLED — undici tears down the connection instead of leaking the stalled
 * read — and the received prefix is returned. Mid-read stream errors return
 * the prefix too (more diagnostic value than the old catch→""), and the whole
 * function never throws (the `safeText` contract rides unchanged).
 */

/** Diagnostic bodies are shown truncated to a few hundred chars everywhere
 *  downstream; 64KB is generously past that and the upstream' chosen bound. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

/** Generous for a healthy error answer, but finite for a stalled one. */
export const ERROR_BODY_DEADLINE_MS = 5_000;

export interface ReadErrorBodyOptions {
  /** Byte cap; default {@link ERROR_BODY_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Wall-clock deadline, ms; default {@link ERROR_BODY_DEADLINE_MS}. */
  readonly deadlineMs?: number;
}

export async function readErrorBody(res: Response, opts: ReadErrorBodyOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? ERROR_BODY_MAX_BYTES;
  const deadlineMs = opts.deadlineMs ?? ERROR_BODY_DEADLINE_MS;
  try {
    const body = res.body;
    if (!body) return await res.text(); // no stream to bound — 204/304 shapes
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let bytes = 0;
    const deadline = Date.now() + deadlineMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // stalled — the prefix below is all we get
      // settle-safe: the losing side of the race must never surface as an
      // unhandled rejection when we abandon the read.
      const readP = reader.read().then(
        (r) => ({ kind: "read" as const, r }),
        (e) => ({ kind: "fail" as const, e }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gate = new Promise<"timer">((resolve) => { timer = setTimeout(() => resolve("timer"), remaining); });
      const winner = await Promise.race([readP, gate]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner === "timer") break;
      if (winner.kind === "fail") return out + decoder.decode(); // prefix, flushed
      const { done, value } = winner.r;
      if (done) return out + decoder.decode(); // clean end — flush multibyte tail
      if (value) {
        const room = maxBytes - bytes;
        const slice = value.byteLength > room ? value.subarray(0, Math.max(0, room)) : value;
        out += decoder.decode(slice, { stream: true });
        bytes += slice.byteLength;
        if (bytes >= maxBytes) break; // cap reached — the tail is worthless
      }
    }
    // Abandoning mid-stream (deadline or cap): cancel so the socket is freed
    // instead of parking the read forever.
    await reader.cancel().catch(() => {});
    return out + decoder.decode();
  } catch {
    return "";
  }
}
