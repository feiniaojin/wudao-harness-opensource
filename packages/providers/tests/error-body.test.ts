import { describe, it, expect } from "vitest";
import { readErrorBody, ERROR_BODY_MAX_BYTES } from "../src/index.js";

/** A Response whose body is a hand-rolled ReadableStream — the same shape
 *  undici hands the provider layer (already-decompressed byte stream). */
function resWithStream(make: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctl = c; make(c); },
  });
  // keep the controller reachable for late pushes
  (stream as unknown as { __ctl?: ReadableStreamDefaultController<Uint8Array> }).__ctl = ctl;
  return new Response(stream, { status: 503 });
}

function chunk(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("波次8 #42 readErrorBody (hermes #24: bounded error-body read)", () => {
  it("① parity: a normal small body reads exactly like res.text()", async () => {
    const res = resWithStream((c) => {
      c.enqueue(chunk('{"error":{"message":"server busy"}}'));
      c.close();
    });
    expect(await readErrorBody(res)).toBe('{"error":{"message":"server busy"}}');
  });

  it("② byte cap: a body larger than maxBytes returns only the capped prefix", async () => {
    const big = "x".repeat(ERROR_BODY_MAX_BYTES + 4096);
    const res = resWithStream((c) => {
      c.enqueue(chunk(big));
      c.close();
    });
    const out = await readErrorBody(res);
    expect(out.length).toBe(ERROR_BODY_MAX_BYTES);
  });

  it("③ stalling body: the wall-clock deadline returns the received prefix instead of hanging, and cancels the stream", async () => {
    let cancelled = false;
    // A stream that sends one chunk then stalls forever — the hermes incident
    // shape (server opens the error body, then stops sending).
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk("partial")); },
      cancel() { cancelled = true; },
    }), { status: 500 });
    const t0 = Date.now();
    const out = await readErrorBody(res, { deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000); // bounded, not hung
    expect(out).toBe("partial");
    expect(cancelled).toBe(true); // the connection is freed, not leaked
  });

  it("④ multibyte safety: an emoji split across chunks decodes as one character", async () => {
    const bytes = new TextEncoder().encode("错🎉误");
    const res = resWithStream((c) => {
      c.enqueue(bytes.slice(0, 2)); // first half of 错
      c.enqueue(bytes.slice(2, 5)); // second half of 错 + first byte of 🎉
      c.enqueue(bytes.slice(5));    // rest
      c.close();
    });
    expect(await readErrorBody(res)).toBe("错🎉误");
  });

  it("⑤ parity: a stream that errors mid-read never throws — the prefix is returned", async () => {
    // First pull delivers a chunk; the SECOND read rejects — the honest
    // mid-read error shape (enqueue-then-error in one start() discharges the
    // queue, so nothing was ever readable; res.text() is "" there too).
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk("so far")); },
      pull(c) { c.error(new Error("socket died")); },
    }), { status: 500 });
    expect(await readErrorBody(res)).toBe("so far");
  });

  it("⑥ null body (no stream): falls back to res.text() semantics", async () => {
    const res = new Response(null, { status: 204 });
    expect(await readErrorBody(res)).toBe("");
  });
});
