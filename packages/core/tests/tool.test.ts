import { describe, it, expect } from "vitest";
import {
  buildTool,
  formatToolError,
  type Tool,
  validateToolArguments,
} from "../src/tool.js";

describe("buildTool", () => {
  it("fills fail-closed defaults", async () => {
    const tool = buildTool({
      name: "ping",
      description: "ping",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "pong" }),
    });
    expect(tool.name).toBe("ping");
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    const res = await tool.execute({});
    expect(res.content).toBe("pong");
  });

  it("an explicit isReadOnly overrides the default", () => {
    const tool: Tool = buildTool({
      name: "peek",
      description: "peek",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "ok" }),
      isReadOnly: () => true,
    });
    expect(tool.isReadOnly?.({})).toBe(true);
  });
});

// M26 P3: the read_file-shaped schema every message-format assertion below
// keys off — the exact strings are the contract.
const readFileSchema = {
  type: "object" as const,
  properties: {
    path: { type: "string" as const, description: "the file to read" },
    limit: { type: "number" as const },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("formatToolError", () => {
  it("missing: names the argument, the tool, and the human-readable expectation", () => {
    expect(
      formatToolError({
        kind: "missing",
        toolName: "read_file",
        name: "path",
        param: { type: "string", description: "the file to read" },
      }),
    ).toBe('missing required argument "path" for read_file (expected: string — the file to read)');
  });

  it("missing: omits the tool clause and description when absent", () => {
    expect(
      formatToolError({ kind: "missing", name: "limit", param: { type: "number" } }),
    ).toBe('missing required argument "limit" (expected: number)');
  });

  it("type: quotes the received value and names its actual type", () => {
    expect(
      formatToolError({ kind: "type", name: "limit", expected: "number", value: "abc" }),
    ).toBe('argument "limit" must be a number (got "abc") — got: string');
  });

  it("type: primitives render unquoted; array takes 'an'", () => {
    expect(
      formatToolError({ kind: "type", name: "path", expected: "string", value: 123 }),
    ).toBe('argument "path" must be a string (got 123) — got: number');
    expect(
      formatToolError({ kind: "type", name: "todos", expected: "array", value: "x" }),
    ).toBe('argument "todos" must be an array (got "x") — got: string');
    expect(
      formatToolError({ kind: "type", name: "n", expected: "number", value: null }),
    ).toBe('argument "n" must be a number (got null) — got: null');
  });

  it("type: long values are head/tail truncated (120 + count marker + 40), never dumped", () => {
    const long = "x".repeat(300);
    const msg = formatToolError({ kind: "type", name: "path", expected: "number", value: long });
    expect(msg).toContain(`(got "${"x".repeat(120)}…(300 chars)… ${"x".repeat(40)}")`);
    expect(msg).not.toContain("x".repeat(121));
  });

  it("type: values within the 160-char budget pass through untruncated", () => {
    const v160 = "y".repeat(160);
    const msg = formatToolError({ kind: "type", name: "path", expected: "number", value: v160 });
    expect(msg).toContain(`(got "${v160}")`);
  });

  it("type: serialized objects/arrays are truncated too", () => {
    const big = { blob: "b".repeat(400) };
    const msg = formatToolError({ kind: "type", name: "path", expected: "string", value: big });
    expect(msg).toMatch(/…\(\d+ chars\)… /);
    expect(msg).not.toContain("b".repeat(121));
  });

  it("unknown: suggests the edit-distance <= 2 neighbor", () => {
    expect(
      formatToolError({ kind: "unknown", toolName: "read_file", name: "pth", known: ["path", "limit"] }),
    ).toBe('unknown argument "pth" for read_file — did you mean "path"?');
  });

  it("unknown: no suggestion clause when nothing is within distance 2", () => {
    expect(
      formatToolError({ kind: "unknown", toolName: "read_file", name: "zzzzz", known: ["path", "limit"] }),
    ).toBe('unknown argument "zzzzz" for read_file');
  });

  it("unknown: multiple candidates are offered nearest-first, capped at distance 2", () => {
    expect(
      formatToolError({ kind: "unknown", name: "pat", known: ["path", "patch", "limit"] }),
    ).toBe('unknown argument "pat" — did you mean "path" or "patch"?');
  });

  it("not-object: names the tool and what actually arrived", () => {
    expect(
      formatToolError({ kind: "not-object", toolName: "read_file", received: "nope" }),
    ).toBe("arguments for read_file must be a JSON object — got: string");
    expect(formatToolError({ kind: "not-object", received: [1] })).toBe(
      "arguments must be a JSON object — got: array",
    );
  });
});

describe("validateToolArguments", () => {
  it("rejects NaN and Infinity for number parameters", () => {
    const result = validateToolArguments(
      { type: "object", properties: { n: { type: "number", description: "" } }, required: ["n"] },
      { n: Number.NaN },
    );
    expect(result.valid).toBe(false);
    const inf = validateToolArguments(
      { type: "object", properties: { n: { type: "number", description: "" } }, required: ["n"] },
      { n: Number.POSITIVE_INFINITY },
    );
    expect(inf.valid).toBe(false);
  });

  it("missing required: message carries the tool name and the param description", () => {
    const r = validateToolArguments(readFileSchema, {}, "read_file");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error).toBe('missing required argument "path" for read_file (expected: string — the file to read)');
    }
  });

  it("type mismatch: message shows the received value and its actual type", () => {
    const r = validateToolArguments(readFileSchema, { path: "a.txt", limit: "abc" }, "read_file");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error).toBe('argument "limit" must be a number (got "abc") — got: string');
    }
  });

  it("unknown argument: suggests the nearest known name (edit distance <= 2)", () => {
    // A pure typo ({ pth } only) reports the missing-required error first —
    // the duplicate-typo shape is where the did-you-mean surfaces.
    const r = validateToolArguments(readFileSchema, { path: "a.txt", pth: "a.txt" }, "read_file");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error).toBe('unknown argument "pth" for read_file — did you mean "path"?');
    }
  });

  it("without a tool name the messages degrade gracefully", () => {
    const r = validateToolArguments(readFileSchema, {});
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error).toBe('missing required argument "path" (expected: string — the file to read)');
    }
  });
});
