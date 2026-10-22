// M43-C suite 1 — the stdout protocol-line parser and the chunk scanner.
// These rules are mirrored by the Rust shell; keep both in sync.
import { describe, expect, it } from "vitest";
import { MIN_TOKEN_LENGTH, parseProtocolLine, ProtocolLineScanner } from "../src/sidecar-protocol.ts";

const TOKEN = "sq0x".repeat(11); // 44 chars, ≥ MIN_TOKEN_LENGTH

describe("parseProtocolLine", () => {
  it("parses the real `wudao ui` announce line", () => {
    const line = `open: http://127.0.0.1:39281/#${TOKEN}`;
    const hs = parseProtocolLine(line);
    expect(hs).not.toBeNull();
    expect(hs?.url).toBe(`http://127.0.0.1:39281/#${TOKEN}`);
    expect(hs?.port).toBe(39281);
    expect(hs?.token).toBe(TOKEN);
  });

  it("accepts a CRLF-terminated line's content after the scanner strips \\r", () => {
    const scanner = new ProtocolLineScanner();
    const lines = scanner.push(`open: http://127.0.0.1:1/#${TOKEN}\r\n`);
    expect(lines).toHaveLength(1);
    expect(parseProtocolLine(lines[0] ?? "")).not.toBeNull();
  });

  it("rejects banner and noise lines", () => {
    expect(parseProtocolLine("wudao ui v0.2.0 · model · session abc")).toBeNull();
    expect(parseProtocolLine("(loopback only · the token rides the URL fragment)")).toBeNull();
    expect(parseProtocolLine("")).toBeNull();
    expect(parseProtocolLine("open:")).toBeNull();
  });

  it("rejects non-loopback hosts (DNS-rebinding shape)", () => {
    expect(parseProtocolLine(`open: http://0.0.0.0:39281/#${TOKEN}`)).toBeNull();
    expect(parseProtocolLine(`open: http://localhost:39281/#${TOKEN}`)).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:39281/admin#${TOKEN}`)).toBeNull();
    expect(parseProtocolLine(`open: https://127.0.0.1:39281/#${TOKEN}`)).toBeNull();
  });

  it("rejects malformed ports", () => {
    expect(parseProtocolLine(`open: http://127.0.0.1:0/#${TOKEN}`)).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:65536/#${TOKEN}`)).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:/#${TOKEN}`)).toBeNull();
  });

  it("rejects short/absent tokens (fail-closed)", () => {
    expect(parseProtocolLine("open: http://127.0.0.1:39281/#")).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:39281/#${"a".repeat(MIN_TOKEN_LENGTH - 1)}`)).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:39281/${"a".repeat(44)}`)).toBeNull();
  });

  it("rejects a token carrying whitespace or extra path structure", () => {
    expect(parseProtocolLine(`open: http://127.0.0.1:39281/#${TOKEN} extra`)).toBeNull();
    expect(parseProtocolLine(`open: http://127.0.0.1:39281/#a/${TOKEN}`)).toBeNull();
  });
});

describe("ProtocolLineScanner", () => {
  it("splits complete lines and keeps a partial line buffered", () => {
    const scanner = new ProtocolLineScanner();
    expect(scanner.push("line one\nline two\n")).toEqual(["line one", "line two"]);
    expect(scanner.push("par")).toEqual([]);
    expect(scanner.push("tial\n")).toEqual(["partial"]);
  });

  it("reassembles a protocol line split across arbitrary chunk boundaries", () => {
    const full = `open: http://127.0.0.1:39281/#${TOKEN}\n`;
    for (let size = 1; size <= full.length; size++) {
      const scanner = new ProtocolLineScanner();
      const seen: string[] = [];
      for (let i = 0; i < full.length; i += size) {
        seen.push(...scanner.push(full.slice(i, i + size)));
      }
      const joined = seen.join("\n");
      expect(parseProtocolLine(joined)).not.toBeNull();
    }
  });

  it("handles CRLF line endings", () => {
    const scanner = new ProtocolLineScanner();
    const lines = scanner.push("one\r\ntwo\r\n");
    expect(lines).toEqual(["one", "two"]);
  });

  it("never emits a line before its newline arrives", () => {
    const scanner = new ProtocolLineScanner();
    expect(scanner.push("open: http://127.0.0.1:39281/#")).toEqual([]);
    expect(scanner.push(TOKEN.slice(0, 10))).toEqual([]);
    expect(scanner.push(`${TOKEN.slice(10)}\nnext`)).toEqual([
      `open: http://127.0.0.1:39281/#${TOKEN}`,
    ]);
  });
});
