import { describe, it, expect } from "vitest";
import {
  validateJsonSchemaSubset,
  extractStructuredOutput,
  type JsonSchemaSubset,
} from "../src/workflow/structured-output.js";

// ---------------------------------------------------------------------------
// JSON-Schema SUBSET validator (hand-written, zero deps): type / required /
// properties / items / enum.
// ---------------------------------------------------------------------------

describe("validateJsonSchemaSubset", () => {
  const s = (schema: JsonSchemaSubset, value: unknown) => validateJsonSchemaSubset(value, schema);

  it("type matrix: accepts every declared type", () => {
    expect(s({ type: "object" }, {})).toEqual([]);
    expect(s({ type: "array" }, [])).toEqual([]);
    expect(s({ type: "string" }, "x")).toEqual([]);
    expect(s({ type: "number" }, 1.5)).toEqual([]);
    expect(s({ type: "integer" }, 3)).toEqual([]);
    expect(s({ type: "boolean" }, true)).toEqual([]);
    expect(s({ type: "null" }, null)).toEqual([]);
  });

  it("type matrix: rejects mismatches with path + got-type", () => {
    expect(s({ type: "string" }, 42)).toEqual(['$: expected string, got number']);
    expect(s({ type: "object" }, [])).toEqual(['$: expected object, got array']);
    expect(s({ type: "object" }, null)).toEqual(['$: expected object, got null']);
    expect(s({ type: "integer" }, 1.5)).toEqual(['$: expected integer, got number']);
    expect(s({ type: "number" }, "3")).toEqual(['$: expected number, got string']);
    expect(s({ type: "boolean" }, 0)).toEqual(['$: expected boolean, got number']);
    expect(s({ type: "null" }, undefined)).toEqual(['$: expected null, got undefined']);
  });

  it("required: names every missing property", () => {
    const schema: JsonSchemaSubset = { type: "object", required: ["a", "b", "c"], properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" } } };
    const errors = s(schema, { a: "x" });
    expect(errors).toEqual(['$.b: missing required property', '$.c: missing required property']);
  });

  it("properties: nested validation with full paths, arrays indexed", () => {
    const schema: JsonSchemaSubset = {
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", properties: { n: { type: "integer" } } },
      },
    };
    const errors = s(schema, { name: 5, tags: ["ok", 7], meta: { n: "no" } });
    expect(errors).toEqual([
      '$.name: expected string, got number',
      '$.tags[1]: expected string, got number',
      '$.meta.n: expected integer, got string',
    ]);
  });

  it("enum: accepts members, rejects others (deep equality on JSON values)", () => {
    expect(s({ enum: ["red", "green"] }, "red")).toEqual([]);
    expect(s({ enum: [1, 2, 3] }, 2)).toEqual([]);
    expect(s({ enum: ["red", "green"] }, "blue")).toEqual(['$: value not in enum [red,green]']);
  });

  it("items without array type still applies when the value is an array", () => {
    const errors = s({ items: { type: "number" } }, [1, "two", 3]);
    expect(errors).toEqual(['$[1]: expected number, got string']);
  });

  it("empty schema {} accepts anything", () => {
    expect(s({}, { any: ["thing"] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Extraction: fenced-first, then brace-balanced scan. No syntax repair.
// ---------------------------------------------------------------------------

describe("extractStructuredOutput", () => {
  it("takes a fenced ```json block", () => {
    const out = extractStructuredOutput('Sure.\n```json\n{"a": 1}\n```\nthanks');
    expect(out).toEqual({ ok: true, value: { a: 1 } });
  });
  it("takes a bare fenced block (no language tag)", () => {
    const out = extractStructuredOutput("```\n[1, 2]\n```");
    expect(out).toEqual({ ok: true, value: [1, 2] });
  });
  it("prefers the LAST fenced block when several appear", () => {
    const text = '```json\n{"first": true}\n```\nintermediate prose\n```json\n{"second": true}\n```';
    expect(extractStructuredOutput(text)).toEqual({ ok: true, value: { second: true } });
  });
  it("falls back to a brace-balanced scan when no fenced block parses", () => {
    const out = extractStructuredOutput('The answer is {"a": {"b": 2}} — done.');
    expect(out).toEqual({ ok: true, value: { a: { b: 2 } } });
  });
  it("brace scan ignores braces inside strings and handles escapes", () => {
    const out = extractStructuredOutput('{"s": "close } brace \\" and { open", "n": 1}');
    expect(out).toEqual({ ok: true, value: { s: 'close } brace " and { open', n: 1 } });
  });
  it("prefers the LAST balanced object", () => {
    expect(extractStructuredOutput('first {"a":1} then {"b":2} end')).toEqual({ ok: true, value: { b: 2 } });
  });
  it("accepts a top-level array from the balanced scan", () => {
    expect(extractStructuredOutput("results: [1, [2, 3], 4]")).toEqual({ ok: true, value: [1, [2, 3], 4] });
  });
  it("prefers an object over an array when both are present", () => {
    expect(extractStructuredOutput('[0] then {"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it("unparsable candidate spans are skipped, not repaired", () => {
    // The first brace span is invalid JSON (trailing comma); the second is fine.
    expect(extractStructuredOutput('x {"a":1,} y {"b":2}')).toEqual({ ok: true, value: { b: 2 } });
  });
  it("no JSON anywhere → ok:false", () => {
    expect(extractStructuredOutput("no structure here at all")).toEqual({ ok: false, reason: "none" });
  });
  it("a bare scalar (number/word) is NOT structured output", () => {
    expect(extractStructuredOutput("42")).toEqual({ ok: false, reason: "none" });
  });
});
