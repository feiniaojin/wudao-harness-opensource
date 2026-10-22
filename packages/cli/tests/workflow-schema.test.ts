import { describe, it, expect } from "vitest";
import { parseWorkflow, extractStepRefs } from "../src/workflow/schema.js";

describe("parseWorkflow", () => {
  it("accepts a minimal valid workflow (steps only, defaults implied)", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [{ id: "a", prompt: "do thing" }],
    }));
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.workflow.name).toBeUndefined();
      expect(res.workflow.steps).toHaveLength(1);
      expect(res.workflow.steps[0]?.id).toBe("a");
      expect(res.workflow.steps[0]?.allowTools).toBeUndefined();
      expect(res.workflow.steps[0]?.maxTurns).toBeUndefined();
      expect(res.workflow.steps[0]?.expect).toBeUndefined();
    }
  });

  it("accepts a full workflow (name, allowTools, maxTurns, expect, back-refs)", () => {
    const res = parseWorkflow(JSON.stringify({
      name: "demo",
      steps: [
        { id: "write", prompt: "write a file", allowTools: ["write_file"], maxTurns: 4, expect: { toolUsed: "write_file", outputContains: "ok" } },
        { id: "verify", prompt: "check {{step.write.output}}", allowTools: ["read_file", "grep"], expect: { outputContains: "PASS" } },
      ],
    }));
    expect(res.valid).toBe(true);
  });

  it("rejects invalid JSON with a parse error", () => {
    const res = parseWorkflow("{not json");
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBeGreaterThan(0);
  });

  it("rejects a non-object root", () => {
    const res = parseWorkflow("[]");
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors[0]).toMatch(/object/);
  });

  it("requires a non-empty steps array", () => {
    for (const text of ['{}', '{"steps": []}', '{"steps": {}}']) {
      const res = parseWorkflow(text);
      expect(res.valid, text).toBe(false);
    }
  });

  it("rejects unknown root keys", () => {
    const res = parseWorkflow('{"steps": [{"id":"a","prompt":"p"}], "bogus": 1}');
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.join("\n")).toMatch(/bogus/);
  });

  it("rejects duplicate step ids, naming both offenders", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "dup", prompt: "first" },
        { id: "ok-step", prompt: "fine" },
        { id: "dup", prompt: "second" },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]).toContain("dup");
    }
  });

  it("rejects bad id characters and empty ids, naming the offending step", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "Bad_ID", prompt: "p" },
        { id: "", prompt: "p" },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBe(2);
  });

  it("rejects empty / non-string prompts", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "a", prompt: "" },
        { id: "b", prompt: 42 },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBe(2);
  });

  it("rejects bad allowTools (not an array, non-string entries) and bad maxTurns (<1, non-integer)", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "a", prompt: "p", allowTools: "read_file" },
        { id: "b", prompt: "p", allowTools: ["read_file", 3] },
        { id: "c", prompt: "p", maxTurns: 0 },
        { id: "d", prompt: "p", maxTurns: 1.5 },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBe(4);
  });

  it("rejects unknown keys at the step and expect levels", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "a", prompt: "p", extra: true },
        { id: "b", prompt: "p", expect: { toolUsed: "read_file", bogus: 1 } },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBe(2);
  });

  it("rejects forward references ({{step.<id>.output}} must point to an EARLIER step)", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "a", prompt: "uses {{step.b.output}} too early" },
        { id: "b", prompt: "p" },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors[0]).toContain("a");
      expect(res.errors[0]).toMatch(/b.*later|forward|earlier/);
    }
  });

  it("rejects references to unknown steps", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [{ id: "a", prompt: "uses {{step.ghost.output}}" }],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors[0]).toContain("ghost");
  });

  it("accepts self-chain references (each ref points to an earlier step)", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "a", prompt: "p" },
        { id: "b", prompt: "{{step.a.output}} and {{step.a.output}} again" },
      ],
    }));
    expect(res.valid).toBe(true);
  });

  it("collects EVERY offending step in one pass (does not stop at the first)", () => {
    const res = parseWorkflow(JSON.stringify({
      steps: [
        { id: "BAD", prompt: "" },
        { id: "good", prompt: "ok" },
        { id: "dup", prompt: "{{step.later.output}}" },
        { id: "dup", prompt: "p", maxTurns: -1 },
      ],
    }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      // BAD id + empty prompt + dup + dup id + forward ref + bad maxTurns
      expect(res.errors.length).toBeGreaterThanOrEqual(5);
      expect(res.errors.join("\n")).toContain("dup");
      expect(res.errors.join("\n")).toContain("later");
    }
  });
});

describe("extractStepRefs", () => {
  it("returns referenced step ids in order", () => {
    expect(extractStepRefs("x {{step.a.output}} y {{step.b.output}} {{step.a.output}}")).toEqual(["a", "b", "a"]);
  });
  it("ignores non-step templates", () => {
    expect(extractStepRefs("{{var}} {{ step.a.output }} {{step.x.y}}")).toEqual([]);
  });
});
