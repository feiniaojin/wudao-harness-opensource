// P2-12（96 队列 #12）ANSI/控制序列剥除单测 — 红线 1：模型可见输出永不含
// ANSI/控制序列。ring 存原始字节，出口（run 捕获 / read 渲染）剥除；剥除
// 永远发生在拼接后的完整文本上（转义序列可能跨 onData chunk 分裂，逐块
// 剥会漏掉跨块序列）。
import { describe, it, expect } from "vitest";
import { stripTerminalCodes } from "../src/terminal/ansi.js";

describe("stripTerminalCodes (红线 1 — 零 ANSI/控制序列出口)", () => {
  it("plain text and newlines pass through untouched", () => {
    expect(stripTerminalCodes("hello world\nsecond line\n")).toBe("hello world\nsecond line\n");
  });

  it("strips SGR color/bold sequences", () => {
    expect(stripTerminalCodes("\x1b[31mred\x1b[0m plain \x1b[1;32mbold-green\x1b[0m")).toBe("red plain bold-green");
  });

  it("strips cursor movement / erase sequences", () => {
    expect(stripTerminalCodes("abc\x1b[2D\x1b[Kdef\x1b[1A\x1b[2J")).toBe("abcdef");
  });

  it("strips private-mode sequences (bracketed paste, cursor visibility)", () => {
    expect(stripTerminalCodes("\x1b[?2004h$ \x1b[?2004l\x1b[?25l\x1b[?25h")).toBe("$ ");
  });

  it("strips OSC sequences terminated by BEL and by ST", () => {
    expect(stripTerminalCodes("\x1b]0;window title\x07visible\x1b]2;other\x1b\\tail")).toBe("visibletail");
  });

  it("strips charset / single-char escapes (ESC(B, ESC=, ESC>)", () => {
    expect(stripTerminalCodes("\x1b(Ba\x1b=b\x1b>c")).toBe("abc");
  });

  it("CRLF becomes LF; lone CR dropped; tab preserved", () => {
    expect(stripTerminalCodes("line1\r\nline2\r\tindented")).toBe("line1\nline2\tindented");
  });

  it("strips other C0 controls (BEL, BS, ETX, NUL) and DEL", () => {
    expect(stripTerminalCodes("a\x07b\x08c\x03d\x00e\x7ff")).toBe("abcdef");
  });

  it("keeps UTF-8 text intact", () => {
    expect(stripTerminalCodes("\x1b[32m悟道\x1b[0m 终端\n")).toBe("悟道 终端\n");
  });

  it("drops a trailing lone ESC (truncated sequence at capture edge)", () => {
    expect(stripTerminalCodes("abc\x1b")).toBe("abc");
  });

  it("handles sequences split across chunk boundaries (strip on JOINED text)", () => {
    // The ring concatenates raw chunks; stripping happens at the exit over the
    // joined string, so an ESC at one chunk's tail and its body at the next
    // chunk's head form one sequence and strip cleanly.
    const chunks = ["before \x1b", "[31m", "red\x1b", "[0m after"];
    expect(stripTerminalCodes(chunks.join(""))).toBe("before red after");
  });
});
