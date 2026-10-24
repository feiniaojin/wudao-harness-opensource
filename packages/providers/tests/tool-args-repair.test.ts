import { describe, it, expect } from "vitest";
import { parseToolCallArguments, TRUNCATED_MARK } from "../src/openai-compatible.js";

// ---------------------------------------------------------------------------
// 波次 7 #33 (CodeWhale parse_json_with_repair + truncation salvage): the
// deterministic repair ladder for streamed tool-call arguments. The old
// parseArguments catch{} turned torn JSON into {} SILENTLY — the tool ran
// with no arguments (or a misleading "missing required field" validation
// error). The ladder salvages what is deterministically recoverable and
// falls back to the sibling providers' visible `_unparsed` convention
// (anthropic.ts / responses.ts), never a bare {}.
// ---------------------------------------------------------------------------

describe("parseToolCallArguments — strict fast path (zero-change pins)", () => {
  it("a valid object parses directly", () => {
    expect(parseToolCallArguments('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });
  it("empty string stays {} (stream edge before any fragment)", () => {
    expect(parseToolCallArguments("")).toEqual({});
  });
  it("arrays keep the legacy predicate (typeof object, returned as-is)", () => {
    expect(parseToolCallArguments("[1,2]")).toEqual([1, 2]);
  });
});

describe("parseToolCallArguments — CodeWhale ladder stages", () => {
  it("strips a ```json fence", () => {
    expect(parseToolCallArguments('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("extracts the first balanced payload from prose", () => {
    expect(parseToolCallArguments('Here is the JSON: {"a":1} hope it helps')).toEqual({ a: 1 });
  });
  it("skips an unparseable balanced payload and takes the next valid one", () => {
    // first container is balanced but poisoned, second is clean
    const raw = '{"code":"a RAW-NEWLINE b"} then {"a":1}';
    const withRaw = raw.replace("RAW-NEWLINE", "\n");
    expect(parseToolCallArguments(withRaw)).toEqual({ a: 1 });
  });
  it("delimiter flood stays bounded (no hang, no match beyond garbage)", () => {
    const flood = "{".repeat(5000);
    expect(parseToolCallArguments(flood)).toEqual({ _unparsed: flood });
  });
});

describe("parseToolCallArguments — wudao extension stages", () => {
  it("escapes literal control characters inside strings", () => {
    expect(parseToolCallArguments('{"code":"line1\nline2\tend"}')).toEqual({
      code: "line1\nline2\tend",
    });
  });
  it("escapes rare C0 controls as \\uXXXX", () => {
    expect(parseToolCallArguments('{"a":"x\x01y"}')).toEqual({ a: "x\x01y" });
  });
  it("closes a torn string value", () => {
    expect(parseToolCallArguments('{"path":"src/a')).toEqual({ path: "src/a" });
  });
  it("closes nested brackets in order", () => {
    expect(parseToolCallArguments('{"files":["a","b')).toEqual({ files: ["a", "b"] });
  });
  it("drops a dangling comma member before closing", () => {
    expect(parseToolCallArguments('{"a":1,')).toEqual({ a: 1 });
  });
  it("salvages the 2M-cap truncated prefix — the marker rides inside the value", () => {
    const raw = '{"code":"xx' + TRUNCATED_MARK;
    expect(parseToolCallArguments(raw)).toEqual({ code: "xx" + TRUNCATED_MARK });
  });
});

describe("parseToolCallArguments — unsalvageable → visible _unparsed", () => {
  it("torn mid-unquoted-token keeps the raw text visible, never a silent {}", () => {
    expect(parseToolCallArguments('{"path": src/a')).toEqual({ _unparsed: '{"path": src/a' });
  });
  it("no container at all (degenerate x-flood) keeps the raw visible", () => {
    const raw = "xxxx[not json]";
    expect(parseToolCallArguments(raw)).toEqual({ _unparsed: raw });
  });
  it("valid but non-object JSON is visible too, not {}", () => {
    expect(parseToolCallArguments('"hello"')).toEqual({ _unparsed: '"hello"' });
    expect(parseToolCallArguments("123")).toEqual({ _unparsed: "123" });
  });
});
