import { describe, it, expect } from "vitest";
import { validateToolArguments } from "../src/tool.js";
import { isValidAgentMessage, isValidSessionEntry, repairOrphanedToolCalls } from "../src/session/validate.js";

const schema = {
  type: "object" as const,
  properties: {
    path: { type: "string" as const, description: "file path" },
    limit: { type: "number" as const },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("validateToolArguments", () => {
  it("accepts valid args with optional omitted", () => {
    const r = validateToolArguments(schema, { path: "a.txt" });
    expect(r.valid).toBe(true);
  });

  it("rejects missing required", () => {
    const r = validateToolArguments(schema, {});
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/path/);
  });

  it("rejects wrong type", () => {
    const r = validateToolArguments(schema, { path: 123 });
    expect(r.valid).toBe(false);
  });

  it("rejects unknown properties when additionalProperties is false", () => {
    const r = validateToolArguments(schema, { path: "a.txt", nope: 1 });
    expect(r.valid).toBe(false);
  });

  it("rejects non-object input", () => {
    const r = validateToolArguments(schema, "not-an-object");
    expect(r.valid).toBe(false);
  });
});

describe("isValidAgentMessage", () => {
  it("accepts the three valid shapes", () => {
    expect(isValidAgentMessage({ role: "user", content: "hi" })).toBe(true);
    expect(isValidAgentMessage({ role: "assistant", content: "ok", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a" } }] })).toBe(true);
    expect(isValidAgentMessage({ role: "tool", toolCallId: "1", name: "read_file", content: "data" })).toBe(true);
  });
  it("rejects garbage shapes", () => {
    expect(isValidAgentMessage(null)).toBe(false);
    expect(isValidAgentMessage({ role: "system", content: "x" })).toBe(false);
    expect(isValidAgentMessage({ role: "user", content: 42 })).toBe(false);
    expect(isValidAgentMessage({ role: "tool", name: "n", content: "c" })).toBe(false); // missing toolCallId
    expect(isValidAgentMessage("user")).toBe(false);
  });
});

describe("repairOrphanedToolCalls", () => {
  const call = (id: string) => ({ id, name: "read_file", arguments: { path: "a" } });
  it("injects synthetic tool results for toolCalls missing results", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [call("a"), call("b")] },
      { role: "tool", toolCallId: "a", name: "read_file", content: "data" },
    ] as const;
    const out = repairOrphanedToolCalls(msgs);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({ role: "tool", toolCallId: "b", name: "read_file", content: "[session resumed: previous tool result unavailable]" });
  });
  it("is a no-op when every call has its result", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read_file", content: "data" },
    ] as const;
    expect(repairOrphanedToolCalls(msgs)).toEqual(msgs);
  });
  it("is idempotent", () => {
    const msgs = [{ role: "assistant", content: "", toolCalls: [call("x")] }] as const;
    const once = repairOrphanedToolCalls(msgs);
    expect(repairOrphanedToolCalls(once)).toEqual(once);
  });
});

describe("isValidSessionEntry (M28 model-state entries)", () => {
  it("accepts well-formed model_change / thinking_level_change entries", () => {
    expect(isValidSessionEntry({ type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-08-16T00:00:00.000Z" })).toBe(true);
    expect(isValidSessionEntry({ type: "model_change", model: "deepseek-v4-flash", at: "2026-08-16T00:00:00.000Z" })).toBe(true);
    expect(isValidSessionEntry({ type: "thinking_level_change", level: "high" })).toBe(true);
  });
  it("accepts a well-formed session_name entry (M33 §3)", () => {
    expect(isValidSessionEntry({ type: "session_name", name: "fix-the-login-bug" })).toBe(true);
    expect(isValidSessionEntry({ type: "session_name", name: "帮我修复登录bug" })).toBe(true);
  });
  it("rejects a malformed session_name entry", () => {
    expect(isValidSessionEntry({ type: "session_name" })).toBe(false); // no name
    expect(isValidSessionEntry({ type: "session_name", name: 42 })).toBe(false); // name not a string
  });
  it("still accepts every valid AgentMessage shape", () => {
    expect(isValidSessionEntry({ role: "user", content: "hi" })).toBe(true);
    expect(isValidSessionEntry({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", arguments: {} }] })).toBe(true);
    expect(isValidSessionEntry({ role: "tool", toolCallId: "a", name: "t", content: "r" })).toBe(true);
  });
  it("rejects malformed entries", () => {
    expect(isValidSessionEntry({ type: "model_change", at: "2026-08-16T00:00:00.000Z" })).toBe(false); // no model
    expect(isValidSessionEntry({ type: "model_change", model: "m", provider: 7, at: "t" })).toBe(false); // provider not a string
    expect(isValidSessionEntry({ type: "model_change", model: "m" })).toBe(false); // no at
    expect(isValidSessionEntry({ type: "thinking_level_change" })).toBe(false); // no level
    expect(isValidSessionEntry({ type: "thinking_level_change", level: 3 })).toBe(false); // level not a string
    expect(isValidSessionEntry({ type: "compacted", summary: "x" })).toBe(false); // unknown entry type
    expect(isValidSessionEntry(null)).toBe(false);
    expect(isValidSessionEntry("model_change")).toBe(false);
  });
});
