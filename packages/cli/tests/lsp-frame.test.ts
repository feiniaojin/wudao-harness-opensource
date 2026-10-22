// P2-9（96 队列 #9）LSP 帧协议单测 — Content-Length 分帧（纯函数，零进程）。
//
// LSP 与 MCP 的 newline-JSONL 帧不同：`Content-Length: N\r\n\r\n{json}`，
// N 是 body 的 UTF-8 字节数。这里钉死编解码的全部边界：粘包、半包、
// header/body 边界切分、body 内伪造头、多字节字符跨 chunk、字节帽。
import { describe, it, expect } from "vitest";
import { encodeLspFrame, LspFrameDecoder, LSP_MAX_MESSAGE_BYTES } from "../src/lsp/frame.js";

describe("encodeLspFrame", () => {
  it("writes Content-Length header with the UTF-8 byte length, CRLF CRLF, then the JSON body", () => {
    const frame = encodeLspFrame({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(frame).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });

  it("counts CJK content in bytes, not UTF-16 code units", () => {
    const frame = encodeLspFrame({ text: "悟道" });
    const body = JSON.stringify({ text: "悟道" });
    // "悟道" is 6 UTF-8 bytes but 2 JS string chars — the header must carry 6-inclusive length.
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
    expect(frame.startsWith(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`)).toBe(true);
    // Round-trip: a decoder fed the whole frame yields the message back.
    const decoder = new LspFrameDecoder();
    expect(decoder.push(Buffer.from(frame, "utf8"))).toEqual([{ text: "悟道" }]);
  });
});

describe("LspFrameDecoder", () => {
  it("decodes one complete message from one chunk", () => {
    const d = new LspFrameDecoder();
    const out = d.push(Buffer.from(encodeLspFrame({ id: 7, result: { ok: true } }), "utf8"));
    expect(out).toEqual([{ id: 7, result: { ok: true } }]);
  });

  it("splits two messages glued into one chunk (粘包)", () => {
    const d = new LspFrameDecoder();
    const glued = encodeLspFrame({ id: 1, result: "a" }) + encodeLspFrame({ id: 2, result: "b" });
    expect(d.push(Buffer.from(glued, "utf8"))).toEqual([
      { id: 1, result: "a" },
      { id: 2, result: "b" },
    ]);
  });

  it("reassembles a message fed one byte at a time (半包)", () => {
    const d = new LspFrameDecoder();
    const frame = Buffer.from(encodeLspFrame({ id: 3, result: { deep: true } }), "utf8");
    let messages: unknown[] = [];
    for (const byte of frame) {
      messages = [...messages, ...d.push(Buffer.from([byte]))];
    }
    expect(messages).toEqual([{ id: 3, result: { deep: true } }]);
  });

  it("holds a header-only chunk until the body arrives (boundary split)", () => {
    const d = new LspFrameDecoder();
    const frame = encodeLspFrame({ id: 4, result: null });
    const cut = frame.indexOf("\r\n\r\n") + 4; // end of the header block
    expect(d.push(Buffer.from(frame.slice(0, cut), "utf8"))).toEqual([]);
    expect(d.push(Buffer.from(frame.slice(cut), "utf8"))).toEqual([{ id: 4, result: null }]);
  });

  it("frames by length — a body containing a forged header string stays one message", () => {
    const evil = 'x\r\n\r\nContent-Length: 2\r\n\r\n{}';
    const d = new LspFrameDecoder();
    const out = d.push(Buffer.from(encodeLspFrame({ text: evil }), "utf8"));
    expect(out).toEqual([{ text: evil }]);
    expect(d.push(Buffer.from("00", "utf8"))).toEqual([]); // nothing follows — no phantom second frame
  });

  it("survives a chunk boundary that splits a multi-byte UTF-8 character", () => {
    const d = new LspFrameDecoder();
    const frame = Buffer.from(encodeLspFrame({ text: "a😀b" }), "utf8");
    // Split in the middle of the 4-byte emoji (find its first byte inside the body).
    const emojiAt = frame.indexOf(Buffer.from("a", "utf8"), 30) + 1;
    const head = frame.subarray(0, emojiAt + 1); // cuts inside 😀's byte sequence
    const tail = frame.subarray(emojiAt + 1);
    expect(d.push(head)).toEqual([]);
    expect(d.push(tail)).toEqual([{ text: "a😀b" }]);
  });

  it("accepts a lowercase content-length header (case-insensitive)", () => {
    const body = JSON.stringify({ id: 9 });
    const d = new LspFrameDecoder();
    expect(d.push(Buffer.from(`content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8")))
      .toEqual([{ id: 9 }]);
  });

  it("throws when a single message exceeds the byte cap (bounded memory)", () => {
    const d = new LspFrameDecoder();
    const body = JSON.stringify({ text: "y".repeat(LSP_MAX_MESSAGE_BYTES) });
    expect(() => d.push(Buffer.from(encodeLspFrame({ text: body }), "utf8"))).toThrow(/exceed|too large|too large/i);
  });

  it("a frame with a non-numeric Content-Length is rejected, not misparsed", () => {
    const d = new LspFrameDecoder();
    expect(() => d.push(Buffer.from("Content-Length: banana\r\n\r\n{}", "utf8"))).toThrow(/Content-Length/i);
  });
});
