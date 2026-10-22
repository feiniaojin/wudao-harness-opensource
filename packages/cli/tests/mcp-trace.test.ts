// ω-5a I20 — WUDAO_MCP_TRACE parsing unit pins: every mode selection, the
// file/stderr sink split, body redaction (header NEVER writes params/result
// bytes), and the caps. Pure — the injected writeSync fake captures exactly
// what would hit the filesystem.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTraceEnv, TRACE_BODY_CAP, TRACE_DETAIL_CAP, capTraceBody, capTraceDetail, type McpFrameRecord } from "../src/mcp/trace.js";

describe("parseTraceEnv", () => {
  it("unset and empty → off (undefined)", () => {
    expect(parseTraceEnv(undefined)).toBeUndefined();
    expect(parseTraceEnv("")).toBeUndefined();
    expect(parseTraceEnv("   ")).toBeUndefined();
  });

  it("1/true/stderr → header mode on process.stderr", () => {
    for (const v of ["1", "true", "stderr"]) {
      const parsed = parseTraceEnv(v);
      expect(parsed?.mode).toBe("header");
    }
  });

  it("a tmp path → header mode writing JSON lines via the injected fs seam", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-trace-test-"));
    const path = join(dir, "trace.jsonl");
    const written: string[] = [];
    const parsed = parseTraceEnv(path, { writeSync: (_p, s) => written.push(s) });
    expect(parsed?.mode).toBe("header");
    const r: McpFrameRecord = { ts: "2026-08-22T00:00:00.000Z", dir: "→", method: "initialize", id: 1, bytes: 42, body: `{"params":{"secret":"x"}}` };
    parsed?.sink(r);
    expect(written).toHaveLength(1);
    // One parseable JSON line per record, newline-terminated.
    expect(written[0]?.endsWith("\n")).toBe(true);
    const parsedBack = JSON.parse((written[0] ?? "").trim()) as McpFrameRecord;
    expect(parsedBack.method).toBe("initialize");
    expect(parsedBack.id).toBe(1);
    // Header mode NEVER writes the body.
    expect("body" in parsedBack).toBe(false);
  });

  it("a bare .jsonl name without a slash is still a path token", () => {
    const written: string[] = [];
    const parsed = parseTraceEnv("frames.jsonl", { writeSync: (_p, s) => written.push(s) });
    expect(parsed?.mode).toBe("header");
    parsed?.sink({ ts: "t", dir: "←", bytes: 3 });
    expect(written).toHaveLength(1);
  });

  it("full variants set body inclusion: <value>:full and full@<path>", () => {
    const written: string[] = [];
    const bySuffix = parseTraceEnv("1:full");
    expect(bySuffix?.mode).toBe("full");
    const atPath = parseTraceEnv(join(tmpdir(), "x.jsonl"), { writeSync: (_p, s) => written.push(s) });
    expect(atPath?.mode).toBe("header"); // control: same path without full
    const fullAtPath = parseTraceEnv(`full@${join(tmpdir(), "y.jsonl")}`, { writeSync: (_p, s) => written.push(s) });
    expect(fullAtPath?.mode).toBe("full");
    fullAtPath?.sink({ ts: "t", dir: "→", method: "tools/call", bytes: 10, body: `{"params":{"secret":"x"}}` });
    const back = JSON.parse((written.at(-1) ?? "").trim()) as McpFrameRecord;
    expect(back.body).toBe(`{"params":{"secret":"x"}}`);
    expect(back.method).toBe("tools/call");
  });

  it("unrecognized tokens → off (fail-closed: nothing records anywhere)", () => {
    expect(parseTraceEnv("banana")).toBeUndefined();
    expect(parseTraceEnv("on")).toBeUndefined();
  });

  it("caps: body at 2048 chars, detail at 200 chars", () => {
    expect(TRACE_BODY_CAP).toBe(2048);
    expect(TRACE_DETAIL_CAP).toBe(200);
    expect(capTraceBody("x".repeat(3000))).toHaveLength(2048);
    expect(capTraceBody("short")).toBe("short");
    expect(capTraceDetail("y".repeat(300))).toHaveLength(200);
    expect(capTraceDetail("short")).toBe("short");
  });
});
