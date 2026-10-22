// P2-9（96 队列 #9）LSP 帧协议 — Content-Length 分帧编解码（纯函数，零依赖）。
//
// LSP over stdio 的帧与 MCP 的 newline-JSONL 不同：
//   Content-Length: <utf8 字节数>\r\n\r\n<JSON body>
// 长度是 body 的 UTF-8 **字节**数（不是 JS 字符数），body 里可以合法出现
// \r\n\r\n 甚至伪造的 header 字样——分帧只认长度，绝不扫描定界符。
// 独立实现（JsonRpcClient 零改动）：字节缓冲、按长度切片、utf8 解码在
// 完整消息上做，多字节字符跨 chunk 由 Buffer 拼接保证。
// 单消息字节帽（16MB）防敌意/坏服务器撑爆内存——超帽抛错，由客户端
// fail-closed 收线。

/** One message larger than this is a hostile or broken server — throw. */
export const LSP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Serialize one message into its wire frame (header block + body). */
export function encodeLspFrame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

const HEADER_TERM = Buffer.from("\r\n\r\n", "ascii");

/**
 * Incremental Content-Length frame decoder. Feed arbitrary chunks (Buffer or
 * string); push() returns every COMPLETE message parsed in order and buffers
 * the remainder. Throws on an oversized message or a malformed header —
 * callers treat that as a dead connection (fail-closed), never a hang.
 */
export class LspFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Bytes currently buffered (partial frame — diagnostics/tests). */
  get bufferedBytes(): number {
    return this.buf.length;
  }

  push(chunk: Buffer | string): unknown[] {
    this.buf = Buffer.isBuffer(chunk) ? Buffer.concat([this.buf, chunk]) : Buffer.concat([this.buf, Buffer.from(chunk, "utf8")]);
    const out: unknown[] = [];
    // Loop: one chunk may carry several glued frames.
    for (;;) {
      const term = this.buf.indexOf(HEADER_TERM);
      if (term === -1) {
        // No complete header block yet. The cap must also guard the buffer
        // while it grows toward a header (a headerless firehose).
        if (this.buf.length > LSP_MAX_MESSAGE_BYTES) {
          throw new Error(`LSP message exceeded ${LSP_MAX_MESSAGE_BYTES} bytes (no complete header)`);
        }
        return out;
      }
      const headerBlock = this.buf.subarray(0, term).toString("ascii");
      const contentLength = parseContentLength(headerBlock);
      const bodyStart = term + HEADER_TERM.length;
      const bodyEnd = bodyStart + contentLength;
      if (bodyEnd > LSP_MAX_MESSAGE_BYTES) {
        throw new Error(`LSP message exceeded ${LSP_MAX_MESSAGE_BYTES} bytes (Content-Length: ${contentLength})`);
      }
      if (this.buf.length < bodyEnd) return out; // partial body — wait for more bytes
      const body = this.buf.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buf = this.buf.subarray(bodyEnd);
      out.push(JSON.parse(body));
    }
  }
}

/** Parse the header block for Content-Length (case-insensitive; CRLF-tolerant). */
function parseContentLength(headerBlock: string): number {
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== "content-length") continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`LSP frame has a malformed Content-Length header: ${line.trim()}`);
    }
    return value;
  }
  throw new Error("LSP frame is missing its Content-Length header");
}
